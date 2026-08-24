import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, ApiError } from "../api";
import { Button } from "../shared/Button";
import { MessageBox } from "../shared/MessageBox";
import { navigate } from "../router";

// What a TV, wall display or kiosk shows while it waits to be linked. Everything
// on it is sized for a ten-foot read: this is the one screen in the app someone
// looks at from a sofa, and the code has to be transcribable from there.
//
// The device holds its device code in memory only. It is a bearer secret with a
// ten-minute life, and persisting it would outlive both the request and the
// reason to keep it.

interface StartResponse {
  deviceCode: string;
  userCode: string;
  userCodeDisplay: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresAt: string;
  interval: number;
}

type PollStatus = "pending" | "approved" | "denied" | "expired" | "consumed" | "unknown";

// How many times the panel may mint itself a fresh code after one expires. A
// display left on overnight should not spend the night creating requests, but a
// household that walks away mid-way and comes back in twenty minutes should not
// find a dead screen either.
const MAX_AUTO_RENEWALS = 3;

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function DeviceLinkPage({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [request, setRequest] = useState<StartResponse | null>(null);
  const [status, setStatus] = useState<PollStatus>("pending");
  const [error, setError] = useState("");
  const [refusal, setRefusal] = useState<"scope" | "proxy" | null>(null);
  const [remaining, setRemaining] = useState(0);
  const renewals = useRef(0);

  const start = useCallback(async () => {
    setError("");
    setRefusal(null);
    setStatus("pending");
    try {
      const created = await api<StartResponse>("/api/auth/device/start", { method: "POST", body: "{}" });
      setRequest(created);
      setRemaining(secondsLeft(created.expiresAt));
    } catch (err) {
      // A refusal is not a failure of the device — it is the server saying where
      // devices may be linked from, and the two reasons need different answers.
      const reason = err instanceof ApiError ? (err.body as { reason?: "scope" | "proxy" })?.reason : undefined;
      if (reason) setRefusal(reason);
      setError(err instanceof Error ? err.message : "Unable to start");
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  // Ask the server, on its own schedule. Stops the moment there is an answer, so
  // a denied or expired screen isn't still talking to the server behind the text.
  useEffect(() => {
    if (!request || status !== "pending") return undefined;
    const timer = window.setInterval(async () => {
      try {
        const result = await api<{ status: PollStatus }>("/api/auth/device/poll", {
          method: "POST",
          body: JSON.stringify({ deviceCode: request.deviceCode })
        });
        if (result.status === "approved") {
          setStatus("approved");
          // The poll that answers "approved" is the one that sets the session
          // cookie, so the app is already signed in by the time we get here.
          await onSignedIn();
          navigate("/");
          return;
        }
        if (result.status !== "pending") setStatus(result.status);
      } catch (err) {
        // A 404 means this code is gone; anything else is a blip worth riding out,
        // because a display should survive the server restarting under it.
        if (err instanceof ApiError && err.status === 404) setStatus("expired");
      }
    }, (request.interval || 3) * 1000);
    return () => window.clearInterval(timer);
  }, [request, status, onSignedIn]);

  // The countdown, and what happens when it runs out: quietly ask for a new code
  // a few times, then stop and let someone press the button.
  useEffect(() => {
    if (!request || status !== "pending") return undefined;
    const timer = window.setInterval(() => {
      const left = secondsLeft(request.expiresAt);
      setRemaining(left);
      if (left === 0) {
        if (renewals.current < MAX_AUTO_RENEWALS) {
          renewals.current += 1;
          void start();
        } else {
          setStatus("expired");
        }
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [request, status, start]);

  const retry = () => {
    renewals.current = 0;
    void start();
  };

  if (refusal) {
    return (
      <DeviceLinkFrame>
        <MessageBox tone="warning" title="This device can't be linked here">
          {refusal === "proxy"
            ? "The server can't tell which network this device is on, because something is forwarding requests to it without being configured to say where they came from. Ask whoever runs the server to set TRUST_PROXY (or TRUST_PROXY_HOPS)."
            : "Devices can only be linked from your home network, and this one appears to be somewhere else. Ask whoever runs the server if you need to link a device from outside."}
        </MessageBox>
        <div className="device-link-actions">
          <Button variant="secondary" onClick={() => navigate("/login")}>Back to sign in</Button>
        </div>
      </DeviceLinkFrame>
    );
  }

  if (status === "denied" || status === "expired" || status === "consumed") {
    return (
      <DeviceLinkFrame>
        <MessageBox
          tone={status === "denied" ? "warning" : "info"}
          title={status === "denied" ? "That request was refused" : "That code has expired"}
        >
          {status === "denied"
            ? "Someone chose not to authorize this device. Nothing has changed, and you can ask again."
            : "Nobody authorized this device in time. Codes last ten minutes so an unattended screen isn't left open."}
        </MessageBox>
        <div className="device-link-actions">
          <Button variant="primary" onClick={retry}>Show a new code</Button>
          <Button variant="secondary" onClick={() => navigate("/login")}>Back to sign in</Button>
        </div>
      </DeviceLinkFrame>
    );
  }

  if (status === "approved") {
    return (
      <DeviceLinkFrame>
        <p className="device-link-lead">Authorized — signing this device in…</p>
      </DeviceLinkFrame>
    );
  }

  if (error && !request) {
    return (
      <DeviceLinkFrame>
        <MessageBox tone="error" title="Unable to start">{error}</MessageBox>
        <div className="device-link-actions">
          <Button variant="primary" onClick={retry}>Try again</Button>
          <Button variant="secondary" onClick={() => navigate("/login")}>Back to sign in</Button>
        </div>
      </DeviceLinkFrame>
    );
  }

  if (!request) {
    return <DeviceLinkFrame><p className="device-link-lead">Preparing a code…</p></DeviceLinkFrame>;
  }

  return (
    <DeviceLinkFrame>
      <div className="device-link-grid">
        <div className="device-link-qr">
          <QRCodeSVG value={request.verificationUrlComplete} size={260} bgColor="#ffffff" fgColor="#031116" />
        </div>

        <div className="device-link-steps">
          <p className="device-link-lead">Scan this with your phone</p>
          {/* The one thing that silently breaks this: a phone on mobile data and a
              server that only answers on the house network. Said up front rather
              than left to be discovered as "the QR doesn't work". */}
          <p className="device-link-note">Your phone needs to be on the same network as this server.</p>

          <p className="device-link-or">or open this address and enter the code</p>
          <p className="device-link-url">{request.verificationUrl}</p>
          <p className="device-link-code" aria-label={`Device code ${request.userCode.split("").join(" ")}`}>
            {request.userCodeDisplay}
          </p>

          <p className="device-link-expiry">
            Expires in {formatCountdown(remaining)}
          </p>
        </div>
      </div>

      <div className="device-link-actions">
        <Button variant="secondary" onClick={() => navigate("/login")}>Cancel</Button>
      </div>
    </DeviceLinkFrame>
  );
}

// Its own full-bleed layout rather than the sign-in panel: that panel is 500px of
// card designed to be read at a desk, and everything here has to carry across a
// room. Same background, so it is recognisably the same app.
function DeviceLinkFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="device-link-page">
      <div className="auth-scene" aria-hidden="true">
        <span className="auth-orbit auth-orbit-a"></span>
        <span className="auth-orbit auth-orbit-b"></span>
        <span className="auth-orbit auth-orbit-c"></span>
      </div>
      <section className="device-link-panel">
        <header className="device-link-head">
          <img src="/Assets/brand/isputnik-logo-sputnik-earth-mark.svg" alt="" />
          <div>
            <p className="eyebrow">Link a device</p>
            <h1>Sign in to isputnik</h1>
          </div>
        </header>
        {children}
      </section>
    </main>
  );
}
