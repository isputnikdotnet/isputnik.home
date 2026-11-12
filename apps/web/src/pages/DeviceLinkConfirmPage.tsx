import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { MonitorSmartphone } from "lucide-react";
import { api, ApiError, type MfaMethod } from "../api";
import i18n from "../i18n";
import { Button } from "../shared/Button";
import { Field } from "../shared/Field";
import { MessageBox } from "../shared/MessageBox";
import { Shell } from "../app/Shell";
import { navigate, profileAnchorHref } from "../router";

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
  if (seconds < 60) return i18n.t("deviceLinkConfirm.justNow");
  const minutes = Math.round(seconds / 60);
  return i18n.t("deviceLinkConfirm.minutesAgo", { count: minutes });
}

// The code as the TV shows it (ABCD-EFGH), from the address alone: a signed-out
// phone can't ask the server about the request, but it can still compare codes.
// Same split as formatUserCode on the server.
function displayCode(raw: string): string {
  const code = raw.replace(/[^0-9a-z]/gi, "").toUpperCase();
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

export function DeviceLinkConfirmPage({
  userCode,
  signedIn,
  onSignedIn
}: {
  userCode: string;
  /** False when the phone opened the TV's link signed out: the page then signs in
   *  and links in one step, through the real sign-in endpoints (lockouts, MFA). */
  signedIn: boolean;
  onSignedIn: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [details, setDetails] = useState<RequestDetails | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | "signin" | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  // Signed out only: the sign-in half of the one-step form.
  const [email, setEmail] = useState("");
  const [mfa, setMfa] = useState<{ method: MfaMethod; sentTo: string } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  // Signed in by this page but the link itself failed: the session is real, so
  // the app is told, and the page carries on as a signed-in one.
  const [signedInHere, setSignedInHere] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetails(await api<RequestDetails>(`/api/auth/device/${encodeURIComponent(userCode)}`));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("deviceLinkConfirm.readError"));
    }
  }, [userCode, t]);

  // Not once answered: leaving after a sign-in here refreshes the session, which
  // flips signedIn, and the request it would look up is already spent.
  useEffect(() => {
    if (signedIn && !done) void load();
  }, [load, signedIn, done]);

  // The app's own session is refreshed only once the person leaves this page:
  // refreshing it sooner redraws the app around the page and loses the result.
  const leave = async (path: string) => {
    if (!signedIn) await onSignedIn();
    navigate(path);
  };

  const approveWith = async (currentPassword: string) => {
    await api(`/api/auth/device/${encodeURIComponent(userCode)}/approve`, {
      method: "POST",
      body: JSON.stringify({ currentPassword })
    });
    setDone("approved");
  };

  // Signed out: sign in (asking for the second factor here if the account needs
  // one), then approve with the password just typed. A wrong password is the
  // sign-in's answer, with the sign-in's lockout; the request itself is untouched.
  const signInAndLink = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("signin");
    setError("");
    let signedInNow = false;
    try {
      if (mfa) {
        await api("/api/auth/mfa/verify", { method: "POST", body: JSON.stringify({ token: mfaCode }) });
      } else {
        const result = await api<{ mfaRequired?: boolean; method?: MfaMethod; sentTo?: string }>(
          "/api/auth/login",
          { method: "POST", body: JSON.stringify({ email, password }) }
        );
        if (result.mfaRequired) {
          setMfa({ method: result.method ?? "totp", sentTo: result.sentTo ?? "" });
          return;
        }
      }
      signedInNow = true;
      setBusy("approve");
      await approveWith(password);
    } catch (err) {
      if (signedInNow) {
        setSignedInHere(true);
        setPassword("");
        setError(err instanceof Error ? err.message : t("deviceLinkConfirm.authorizeFailed"));
        void load();
      } else {
        setError(err instanceof Error ? err.message : t("login.failedTitle"));
      }
    } finally {
      setBusy(null);
    }
  };

  const approve = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("approve");
    setError("");
    try {
      await approveWith(password);
    } catch (err) {
      setPassword("");
      // A wrong password is answered with how many tries are left, because the
      // request dies before the account does and that is worth knowing.
      const remaining = err instanceof ApiError ? (err.body as { remaining?: number })?.remaining : undefined;
      setError(
        err instanceof Error
          ? remaining !== undefined && remaining > 0
            ? `${err.message} ${t("deviceLinkConfirm.triesLeft", { count: remaining })}`
            : err.message
          : t("deviceLinkConfirm.authorizeFailed")
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
      setError(err instanceof Error ? err.message : t("deviceLinkConfirm.denyFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <Shell>
        <div className="stack">
          <p className="eyebrow">{t("deviceLink.eyebrow")}</p>
          <h1>{done === "approved" ? t("deviceLinkConfirm.approvedTitle") : t("deviceLinkConfirm.refusedTitle")}</h1>
          <MessageBox
            tone={done === "approved" ? "success" : "info"}
            title={done === "approved" ? t("deviceLinkConfirm.signingInNow") : t("deviceLinkConfirm.nothingChanged")}
          >
            {done === "approved"
              ? t("deviceLinkConfirm.approvedBody", { device: details?.device ?? t("deviceLinkConfirm.genericDevice") })
              : t("deviceLinkConfirm.deniedBody")}
          </MessageBox>
          {/* Not an automatic redirect: the next thing anyone wants after
              approving something is confirmation that it did what they think. */}
          <div className="device-confirm-actions">
            <Button variant="secondary" onClick={() => void leave(profileAnchorHref("devices"))}>{t("deviceLinkConfirm.yourDevices")}</Button>
            <Button variant="text" onClick={() => void leave("/")}>{t("common.done")}</Button>
          </div>
        </div>
      </Shell>
    );
  }

  if (loadError) {
    return (
      <Shell>
        <div className="stack">
          <p className="eyebrow">{t("deviceLink.eyebrow")}</p>
          <h1>{t("deviceLinkConfirm.codeInvalidTitle")}</h1>
          <MessageBox tone="warning" title={t("deviceLinkConfirm.nothingWaiting")}>{loadError}</MessageBox>
          <p className="device-confirm-hint">
            {t("deviceLinkConfirm.codeHint")}
          </p>
          <div className="device-confirm-actions">
            <Button variant="secondary" onClick={() => void leave("/")}>{t("deviceLinkConfirm.backToApp")}</Button>
          </div>
        </div>
      </Shell>
    );
  }

  // Signed out: the code from the address, then sign in and link in one press.
  // Nothing about the device is shown yet (the server tells that only to an
  // account), but the code to compare with the TV is the evidence that matters.
  if (!signedIn && !signedInHere) {
    return (
      <Shell>
        <form className="stack" onSubmit={signInAndLink}>
          <p className="eyebrow">{t("deviceLink.eyebrow")}</p>
          <h1>{t("deviceLinkConfirm.authorizeTitle")}</h1>

          <div className="device-confirm-match">
            <span>{t("deviceLinkConfirm.matchLabel")}</span>
            <strong>{displayCode(userCode)}</strong>
          </div>

          {mfa ? (
            <>
              <p>{mfa.method === "email" ? t("mfa.emailIntro", { address: mfa.sentTo || t("mfa.yourEmail") }) : t("mfa.totpIntro")}</p>
              <Field label={t("mfa.codeLabel")} value={mfaCode} onChange={setMfaCode} autoComplete="one-time-code" />
            </>
          ) : (
            <>
              <p className="device-confirm-hint">{t("deviceLinkConfirm.signInLead")}</p>
              <Field label={t("common.email")} type="email" value={email} onChange={setEmail} autoComplete="username" />
              <Field label={t("common.password")} type="password" value={password} onChange={setPassword} autoComplete="current-password" />
            </>
          )}

          {error && <MessageBox tone="error" title={t("login.failedTitle")}>{error}</MessageBox>}

          <div className="device-confirm-actions">
            <Button
              variant="primary"
              type="submit"
              disabled={busy !== null || (mfa ? mfaCode.trim().length === 0 : email.trim().length === 0 || password.length === 0)}
            >
              {busy === "signin" ? t("deviceLinkConfirm.signingIn") : busy === "approve" ? t("deviceLinkConfirm.linking") : mfa ? t("mfa.verify") : t("deviceLinkConfirm.signInAndLink")}
            </Button>
            <Button variant="secondary" onClick={() => navigate("/login")} disabled={busy !== null}>{t("common.cancel")}</Button>
          </div>
        </form>
      </Shell>
    );
  }

  if (!details) {
    return <Shell><p className="status">{t("deviceLinkConfirm.loading")}</p></Shell>;
  }

  return (
    <Shell>
      <form className="stack" onSubmit={approve}>
        <p className="eyebrow">{t("deviceLink.eyebrow")}</p>
        <h1>{t("deviceLinkConfirm.authorizeTitle")}</h1>

        <div className="device-confirm-card">
          <MonitorSmartphone size={22} aria-hidden="true" />
          <div>
            {/* Everything in here is what the device said about itself, described
                rather than echoed — see describeUserAgent on the server. */}
            <strong>{details.device}</strong>
            <span>{details.network}{details.ipAddress ? ` · ${details.ipAddress}` : ""}</span>
            <span>{t("deviceLinkConfirm.askedAgo", { ago: requestedAgo(details.requestedAt) })}</span>
          </div>
        </div>

        <div className="device-confirm-match">
          <span>{t("deviceLinkConfirm.matchLabel")}</span>
          <strong>{details.userCodeDisplay}</strong>
        </div>

        <Field
          label={t("deviceLinkConfirm.passwordLabel")}
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <p className="device-confirm-hint">
          {t("deviceLinkConfirm.passwordHint")}
        </p>

        {error && (
          <MessageBox tone="error" title={signedInHere ? t("deviceLinkConfirm.signedInButFailed") : t("deviceLinkConfirm.unableToAuthorize")}>
            {error}
          </MessageBox>
        )}

        <div className="device-confirm-actions">
          <Button variant="primary" type="submit" disabled={busy !== null || password.length === 0}>
            {busy === "approve" ? t("deviceLinkConfirm.authorizing") : t("deviceLinkConfirm.authorize")}
          </Button>
          <Button variant="secondary" onClick={deny} disabled={busy !== null}>
            {busy === "deny" ? t("deviceLinkConfirm.refusing") : t("deviceLinkConfirm.deny")}
          </Button>
        </div>
      </form>
    </Shell>
  );
}
