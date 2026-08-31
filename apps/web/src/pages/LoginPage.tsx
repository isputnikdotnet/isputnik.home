import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, MonitorSmartphone } from "lucide-react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api, type MfaMethod } from "../api";
import { Shell } from "../app/Shell";
import { Button } from "../shared/Button";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { useConnectionStatus } from "../pwa/useOnlineStatus";
import { navigate, takePathAfterSignIn } from "../router";

export function LoginPage({
  onSignedIn,
  passkeysAvailable,
  deviceLinkAvailable
}: {
  onSignedIn: () => Promise<void>;
  /** Whether the SERVER can do passkeys (HTTPS at a domain). The browser half is
   *  checked separately — both have to be true for the button to mean anything. */
  passkeysAvailable: boolean;
  /** Whether a device may be linked from this address right now. False outside the
   *  house unless an admin has opened a registration window, and the option is then
   *  left out rather than shown and refused. */
  deviceLinkAvailable: boolean;
}) {
  const { t } = useTranslation();
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
        setError(err instanceof Error ? err.message : t("login.passkeyFailed"));
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
      setError(err instanceof Error ? err.message : t("login.failedTitle"));
    }
  };

  const resendCode = async () => {
    setResending(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ sentTo: string }>("/api/auth/mfa/resend", { method: "POST" });
      setEmailSent(true);
      setNotice(t("mfa.sentBody", { address: result.sentTo }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mfa.resendFailed"));
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
      setError(err instanceof Error ? err.message : t("mfa.verifyError"));
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
          <p className="eyebrow">{t("mfa.eyebrow")}</p>
          <h1>{t("mfa.title")}</h1>
          {method === "email" ? (
            <p>{t("mfa.emailIntro", { address: sentTo || t("mfa.yourEmail") })}</p>
          ) : (
            <p>{t("mfa.totpIntro")}</p>
          )}
          {method === "email" && !emailSent && (
            <MessageBox tone="warning" title={t("mfa.noEmailTitle")}>
              {t("mfa.noEmailBody")}
            </MessageBox>
          )}
          <Field label={t("mfa.codeLabel")} value={code} onChange={setCode} autoComplete="one-time-code" />
          {notice && <MessageBox tone="info" title={t("mfa.sentTitle")}>{notice}</MessageBox>}
          {blocked ? (
            <MessageBox tone="warning" title={t("login.blockedTitle")}>{t("network.blocked", { host: window.location.host })}</MessageBox>
          ) : (
            error && <MessageBox tone="error" title={t("mfa.verifyFailed")}>{error}</MessageBox>
          )}
          <button className="primary-button">{t("mfa.verify")}</button>
          {method === "email" && (
            <button type="button" className="text-button" onClick={resendCode} disabled={resending}>
              {resending ? t("mfa.sending") : t("mfa.sendAnother")}
            </button>
          )}
          <button type="button" className="text-button" onClick={backToCredentials}>{t("mfa.back")}</button>
        </form>
      </Shell>
    );
  }

  return (
    <Shell>
      <form className="stack" onSubmit={submitCredentials}>
        <p className="eyebrow">{t("login.welcomeBack")}</p>
        <h1>{t("login.title")}</h1>

        {canUsePasskey && (
          <div className="login-passkey">
            <button type="button" className="passkey-button" onClick={signInWithPasskey} disabled={passkeyBusy}>
              <KeyRound size={18} aria-hidden="true" />
              {passkeyBusy ? t("login.passkeyWaiting") : t("login.passkey")}
            </button>
            <span className="login-divider"><span>{t("common.or")}</span></span>
          </div>
        )}

        <Field label={t("common.email")} type="email" value={email} onChange={setEmail} autoComplete="username" />
        <Field
          label={t("common.password")}
          type="password"
          value={password}
          onChange={setPassword}
          minLength={8}
          autoComplete="current-password"
        />
        {blocked ? (
          <MessageBox tone="warning" title={t("login.blockedTitle")}>{t("network.blocked", { host: window.location.host })}</MessageBox>
        ) : (
          error && <MessageBox tone="error" title={t("login.failedTitle")}>{error}</MessageBox>
        )}
        <button className="primary-button">{t("login.submit")}</button>

        {/* For the device that can't type this form: a TV, a wall display, a
            kiosk. It shows a code, and a phone that IS signed in authorizes it.
            Below the password form deliberately — this is the unusual path.
            Hidden outside the house, where linking is refused unless an admin has
            opened a registration window: a button that answers 403 teaches people
            to click through refusals. */}
        {deviceLinkAvailable && (
          <div className="login-link-device">
            <span className="login-device-divider"><span>{t("common.or")}</span></span>
            <Button variant="text" onClick={() => navigate("/link")}>
              <MonitorSmartphone size={16} aria-hidden="true" />
              {t("login.linkDevice")}
            </Button>
          </div>
        )}

      </form>
    </Shell>
  );
}
