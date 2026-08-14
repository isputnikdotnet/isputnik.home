import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MonitorSmartphone } from "lucide-react";
import { api, ApiError } from "../api";
import { Button } from "../shared/Button";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { Shell } from "../app/Shell";
import { navigate } from "../router";

// The screen the phone lands on, from the QR or from typing the code. Its whole
// job is to let someone answer one question honestly: is the thing asking to be
// linked the thing standing in front of me?
//
// So it shows what the server knows about the asking device, and it shows the
// code — because the QR carried the code invisibly, and a code that matches the
// screen across the room is the only evidence that the request is the one the
// person meant to approve rather than one a stranger sent them.

interface RequestDetails {
  userCode: string;
  userCodeDisplay: string;
  device: string;
  network: string;
  ipAddress: string | null;
  requestedAt: string;
  expiresAt: string;
}

function requestedAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

export function DeviceLinkConfirmPage({ userCode }: { userCode: string }) {
  const [details, setDetails] = useState<RequestDetails | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);

  const load = useCallback(async () => {
    try {
      setDetails(await api<RequestDetails>(`/api/auth/device/${encodeURIComponent(userCode)}`));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unable to read that code");
    }
  }, [userCode]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("approve");
    setError("");
    try {
      await api(`/api/auth/device/${encodeURIComponent(userCode)}/approve`, {
        method: "POST",
        body: JSON.stringify({ currentPassword: password })
      });
      setDone("approved");
    } catch (err) {
      setPassword("");
      // A wrong password is answered with how many tries are left, because the
      // request dies before the account does and that is worth knowing.
      const remaining = err instanceof ApiError ? (err.body as { remaining?: number })?.remaining : undefined;
      setError(
        err instanceof Error
          ? remaining !== undefined && remaining > 0
            ? `${err.message} ${remaining} ${remaining === 1 ? "try" : "tries"} left.`
            : err.message
          : "Unable to authorize this device"
      );
    } finally {
      setBusy(null);
    }
  };

  const deny = async () => {
    setBusy("deny");
    setError("");
    try {
      await api(`/api/auth/device/${encodeURIComponent(userCode)}/deny`, { method: "POST", body: "{}" });
      setDone("denied");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to refuse this device");
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <Shell>
        <div className="stack">
          <p className="eyebrow">Link a device</p>
          <h1>{done === "approved" ? "Device authorized" : "Device refused"}</h1>
          <MessageBox tone={done === "approved" ? "success" : "info"} title={done === "approved" ? "It's signing in now" : "Nothing was changed"}>
            {done === "approved"
              ? `${details?.device ?? "The device"} can now use your account. It appears in Profile → Devices, where you can rename it or remove it at any time.`
              : "That device was not given access to your account."}
          </MessageBox>
          {/* Not an automatic redirect: the next thing anyone wants after
              approving something is confirmation that it did what they think. */}
          <div className="device-confirm-actions">
            <Button variant="secondary" onClick={() => navigate("/profile/devices")}>Your devices</Button>
            <Button variant="text" onClick={() => navigate("/")}>Done</Button>
          </div>
        </div>
      </Shell>
    );
  }

  if (loadError) {
    return (
      <Shell>
        <div className="stack">
          <p className="eyebrow">Link a device</p>
          <h1>That code doesn't work</h1>
          <MessageBox tone="warning" title="Nothing is waiting for this code">{loadError}</MessageBox>
          <p className="device-confirm-hint">
            Codes last ten minutes. Ask the device to show a new one, then scan or type it again.
          </p>
          <div className="device-confirm-actions">
            <Button variant="secondary" onClick={() => navigate("/")}>Back to iSputnik</Button>
          </div>
        </div>
      </Shell>
    );
  }

  if (!details) {
    return <Shell><p className="status">Looking up that code…</p></Shell>;
  }

  return (
    <Shell>
      <form className="stack" onSubmit={approve}>
        <p className="eyebrow">Link a device</p>
        <h1>Authorize this device?</h1>

        <div className="device-confirm-card">
          <MonitorSmartphone size={22} aria-hidden="true" />
          <div>
            {/* Everything in here is what the device said about itself, described
                rather than echoed — see describeUserAgent on the server. */}
            <strong>{details.device}</strong>
            <span>{details.network}{details.ipAddress ? ` · ${details.ipAddress}` : ""}</span>
            <span>Asked {requestedAgo(details.requestedAt)}</span>
          </div>
        </div>

        <div className="device-confirm-match">
          <span>Check this matches the code on that screen</span>
          <strong>{details.userCodeDisplay}</strong>
        </div>

        <Field
          label="Your password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <p className="device-confirm-hint">
          Authorizing signs that device in and keeps it signed in. Your password is asked for the same
          reason it is when you change your two-factor settings.
        </p>

        {error && <MessageBox tone="error" title="Unable to authorize">{error}</MessageBox>}

        <div className="device-confirm-actions">
          <Button variant="primary" type="submit" disabled={busy !== null || password.length === 0}>
            {busy === "approve" ? "Authorizing…" : "Authorize device"}
          </Button>
          <Button variant="secondary" onClick={deny} disabled={busy !== null}>
            {busy === "deny" ? "Refusing…" : "Deny"}
          </Button>
        </div>
      </form>
    </Shell>
  );
}
