import { useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { KeyRound, MonitorSmartphone } from "lucide-react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api, NETWORK_BLOCK_MESSAGE, type MfaMethod } from "../api";
import { Shell } from "../app/Shell";
import { Button } from "../shared/Button";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { useConnectionStatus } from "../pwa/useOnlineStatus";
import { navigate, takePathAfterSignIn } from "../router";

export function LoginPage({
  onSignedIn,
  passkeysAvailable
}: {
  onSignedIn: () => Promise<void>;
  /** Whether the SERVER can do passkeys (HTTPS at a domain). The browser half is
   *  checked separately — both have to be true for the button to mean anything. */
  passkeysAvailable: boolean;
}) {
  const [stage, setStage] = useState<"credentials" | "mfa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  // Set from the challenge response: which factor to ask for, and — for emailed
  // codes — the masked address it went to and whether sending was even attempted.
  const [method, setMethod] = useState<MfaMethod>("totp");
  const [sentTo, setSentTo] = useState("");
  const [emailSent, setEmailSent] = useState(true);
  const [notice, setNotice] = useState("");
  const [resending, setResending] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  // A filtered network is the one sign-in failure with nothing wrong on either end:
  // the page loads from cache or CDN, then every API call is answered by the proxy.
  // Without this the screen just says the sign-in failed, and the obvious suspects —
  // the password, the browser, the server — are all innocent.
  const blocked = useConnectionStatus() === "blocked";

  // Both halves have to hold: the server needs HTTPS at a domain, and the browser
  // needs WebAuthn — which it only exposes in a secure context anyway.
  const canUsePasskey = passkeysAvailable && browserSupportsWebAuthn();

  const finish = async () => {
    await onSignedIn();
    // Back to whatever they were interrupted doing — today, approving a device
    // whose QR they scanned while signed out. Every sign-in path ends here, so
    // password, second factor and passkey all resume the same way.
    navigate(takePathAfterSignIn() ?? "/");
  };

  // One button, no email typed: the passkeys are discoverable, so the browser
  // offers whichever accounts this device holds for this site.
  const signInWithPasskey = async () => {
    setPasskeyBusy(true);
    setError("");
    try {
      const { options } = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        "/api/auth/passkey/options",
        { method: "POST", body: "{}" }
      );
      const response = await startAuthentication({ optionsJSON: options });
      await api("/api/auth/passkey/verify", { method: "POST", body: JSON.stringify({ response }) });
      await finish();
    } catch (err) {
      // Cancelling the system prompt throws too, and that isn't a failure worth
      // shouting about — the password form is still sitting right there.
      const name = err instanceof Error ? err.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Unable to sign in with a passkey");
      }
    } finally {
      setPasskeyBusy(false);
    }
  };

  const submitCredentials = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ mfaRequired?: boolean; method?: MfaMethod; sentTo?: string; emailSent?: boolean }>(
        "/api/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) }
      );
      // With MFA on, the password only earns a challenge — collect the code next.
      if (result.mfaRequired) {
        setMethod(result.method ?? "totp");
        setSentTo(result.sentTo ?? "");
        setEmailSent(result.emailSent !== false);
        setNotice("");
        setStage("mfa");
        return;
      }
      await finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in");
    }
  };

  const resendCode = async () => {
    setResending(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ sentTo: string }>("/api/auth/mfa/resend", { method: "POST" });
      setEmailSent(true);
      setNotice(`A new code is on its way to ${result.sentTo}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send another code");
    } finally {
      setResending(false);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await api("/api/auth/mfa/verify", { method: "POST", body: JSON.stringify({ token: code }) });
      await finish();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify the code");
    }
  };

  const backToCredentials = () => {
    setStage("credentials");
    setCode("");
    setError("");
    setNotice("");
  };

  if (stage === "mfa") {
    return (
      <Shell>
        <form className="stack" onSubmit={submitCode}>
          <p className="eyebrow">Two-factor authentication</p>
          <h1>Enter your code</h1>
          {method === "email" ? (
            <p>
              We sent a 6-digit code to {sentTo || "your email address"}. It expires in a few minutes. You can also use
              a backup code.
            </p>
          ) : (
            <p>Open your authenticator app and enter the 6-digit code. You can also use a backup code.</p>
          )}
          {method === "email" && !emailSent && (
            <MessageBox tone="warning" title="We couldn't email a code">
              This server can't send email right now. Use one of your backup codes, or ask your administrator.
            </MessageBox>
          )}
          <Field label="Authentication code" value={code} onChange={setCode} autoComplete="one-time-code" />
          {notice && <MessageBox tone="info" title="Code sent">{notice}</MessageBox>}
          {blocked ? (
            <MessageBox tone="warning" title="Blocked by your network">{NETWORK_BLOCK_MESSAGE}</MessageBox>
          ) : (
            error && <MessageBox tone="error" title="Unable to verify">{error}</MessageBox>
          )}
          <button className="primary-button">Verify</button>
          {method === "email" && (
            <button type="button" className="text-button" onClick={resendCode} disabled={resending}>
              {resending ? "Sending…" : "Send another code"}
            </button>
          )}
          <button type="button" className="text-button" onClick={backToCredentials}>Back to sign in</button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <form className="stack" onSubmit={submitCredentials}>
        <p className="eyebrow">Welcome back</p>
        <h1>Sign in</h1>

        {canUsePasskey && (
          <div className="login-passkey">
            <button type="button" className="passkey-button" onClick={signInWithPasskey} disabled={passkeyBusy}>
              <KeyRound size={18} aria-hidden="true" />
              {passkeyBusy ? "Waiting for your device…" : "Sign in with a passkey"}
            </button>
            <span className="login-divider"><span>or</span></span>
          </div>
        )}

        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          minLength={8}
          autoComplete="current-password"
        />
        {blocked ? (
          <MessageBox tone="warning" title="Blocked by your network">{NETWORK_BLOCK_MESSAGE}</MessageBox>
        ) : (
          error && <MessageBox tone="error" title="Unable to sign in">{error}</MessageBox>
        )}
        <button className="primary-button">Sign in</button>

        {/* For the device that can't type this form: a TV, a wall display, a
            kiosk. It shows a code, and a phone that IS signed in authorizes it.
            Below the password form deliberately — this is the unusual path. */}
        <div className="login-link-device">
          <Button variant="text" onClick={() => navigate("/link")}>
            <MonitorSmartphone size={16} aria-hidden="true" />
            Link a TV or display instead
          </Button>
        </div>

        <div className="login-qr">
          <div className="login-qr-code">
            <QRCodeSVG value={window.location.href} size={128} bgColor="#ffffff" fgColor="#031116" />
          </div>
          <span>Scan to open this page on another device</span>
        </div>
      </form>
    </Shell>
  );
}
