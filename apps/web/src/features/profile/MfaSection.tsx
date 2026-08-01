import { useState, useEffect, type FormEvent } from "react";
import { api, type MfaMethod } from "../../api";
import { Button } from "../../shared/Button";
import { ChoiceGroup } from "../../shared/ChoiceGroup";
import { Field } from "../../shared/Field";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";

interface MfaStatus {
  enabled: boolean;
  method: MfaMethod;
  backupCodesRemaining: number;
  // Whether the server can send email at all — the email method is unofferable
  // without it, and an admin has to set SMTP up in Control panel → Settings → Email.
  emailAvailable: boolean;
  emailAddress: string;
}

// The setup call answers differently per method: a secret to scan, or the masked
// address a code was just mailed to.
type SetupData =
  | { method: "totp"; secret: string; otpauthUri: string; qrDataUrl: string }
  | { method: "email"; sentTo: string; expiresInMinutes: number };

type Mode = null | "setup" | "regenerate" | "disable";

// Offer the codes as a text file so they can be saved somewhere safe.
function downloadCodes(codes: string[]) {
  const blob = new Blob([`${codes.join("\n")}\n`], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "isputnik-backup-codes.txt";
  anchor.click();
  URL.revokeObjectURL(url);
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <ul className="mfa-backup-codes">
      {codes.map((code) => (
        <li key={code}><code>{code}</code></li>
      ))}
    </ul>
  );
}

export function MfaSection() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<Mode>(null);

  const refresh = async () => {
    try {
      setStatus(await api<MfaStatus>("/api/profile/mfa"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unable to load two-factor status");
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const done = () => {
    setMode(null);
    refresh();
  };

  return (
    <section className="mfa-section" aria-labelledby="mfa-heading">
      <h2 id="mfa-heading">Two-factor authentication</h2>
      <p className="mfa-intro">
        Ask for a one-time code at sign-in — from an authenticator app or sent to your email — so a stolen password
        alone can't reach your account.
      </p>
      {loadError && <MessageBox tone="error" title="Unable to load">{loadError}</MessageBox>}

      {status?.enabled && (
        <>
          <MessageBox tone="success" title="Two-factor is on">
            {status.method === "email"
              ? `You'll enter a code sent to ${status.emailAddress} when you sign in. `
              : "You'll enter a code from your authenticator app when you sign in. "}
            {status.backupCodesRemaining > 0
              ? `${status.backupCodesRemaining} backup code${status.backupCodesRemaining === 1 ? "" : "s"} remaining.`
              : "No backup codes left — regenerate a set."}
          </MessageBox>
          {status.method === "email" && !status.emailAvailable && (
            <MessageBox tone="warning" title="This server can't send email">
              Your codes have nowhere to go until an administrator sets email up again. Use a backup code to sign in
              meanwhile.
            </MessageBox>
          )}
          <div className="mfa-actions">
            <Button variant="secondary" onClick={() => setMode("regenerate")}>Regenerate backup codes</Button>
            <Button variant="danger" onClick={() => setMode("disable")}>Turn off</Button>
          </div>
        </>
      )}

      {status && !status.enabled && (
        <div className="mfa-actions">
          <Button variant="primary" onClick={() => setMode("setup")}>Set up two-factor</Button>
        </div>
      )}

      {mode === "setup" && status && (
        <MfaSetupModal
          emailAvailable={status.emailAvailable}
          emailAddress={status.emailAddress}
          onClose={() => setMode(null)}
          onDone={done}
        />
      )}
      {mode === "regenerate" && <MfaRegenerateModal onClose={() => setMode(null)} onDone={done} />}
      {mode === "disable" && <MfaDisableModal onClose={() => setMode(null)} onDone={done} />}
    </section>
  );
}

// Enrollment wizard: pick a method + confirm password → prove the factor reaches
// you (scan a QR, or read the emailed code) → save backup codes.
function MfaSetupModal({
  emailAvailable,
  emailAddress,
  onClose,
  onDone
}: {
  emailAvailable: boolean;
  emailAddress: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<"password" | "confirm" | "codes">("password");
  const [method, setMethod] = useState<MfaMethod>("totp");
  const [password, setPassword] = useState("");
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Also the resend for the email method: asking again mints and mails a new code.
  const startSetup = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<SetupData>("/api/profile/mfa/setup", {
        method: "POST",
        body: JSON.stringify({ currentPassword: password, method })
      });
      setSetupData(data);
      setCode("");
      setStep("confirm");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start setup");
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ backupCodes: string[] }>("/api/profile/mfa/enable", {
        method: "POST",
        body: JSON.stringify({ token: code })
      });
      setBackupCodes(payload.backupCodes);
      setStep("codes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to turn on two-factor");
    } finally {
      setBusy(false);
    }
  };

  if (step === "password") {
    return (
      <Modal variant="card" title="Set up two-factor" busy={busy} onClose={onClose} onSubmit={startSetup}>
        <ChoiceGroup
          legend="How you'll get your codes"
          value={method}
          onChange={setMethod}
          disabled={busy}
          options={[
            {
              value: "totp",
              label: "Authenticator app",
              description:
                "A rolling code from Google Authenticator, Authy, Apple Passwords… Works offline and never leaves your phone."
            },
            {
              value: "email",
              label: "Email",
              description: `A one-time code sent to ${emailAddress} each time you sign in. Nothing to install.`,
              disabled: !emailAvailable,
              note: emailAvailable
                ? "Less secure: codes travel by email, so anyone who can read that inbox can get in."
                : "Unavailable — this server can't send email. An administrator sets it up in Control panel → Settings → Email."
            }
          ]}
        />
        <Field label="Current password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <MessageBox tone="error" title="Unable to continue">{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || password.length < 1}>
            {busy ? "Checking…" : "Continue"}
          </Button>
        </div>
      </Modal>
    );
  }

  if (step === "confirm" && setupData?.method === "totp") {
    return (
      <Modal variant="card" title="Scan the QR code" busy={busy} onClose={onClose} onSubmit={confirmCode}>
        <p>
          Scan this with your authenticator app (Google Authenticator, Authy, Apple Passwords…), then enter the 6-digit
          code it shows to confirm.
        </p>
        <div className="mfa-qr">
          <img src={setupData.qrDataUrl} alt="Two-factor setup QR code" width={180} height={180} />
        </div>
        <p className="mfa-secret">
          Can't scan? Enter this key manually:
          <br />
          <code>{setupData.secret}</code>
        </p>
        <Field label="6-digit code" value={code} onChange={setCode} autoComplete="one-time-code" />
        {error && <MessageBox tone="error" title="Unable to turn on two-factor">{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || code.trim().length < 6}>
            {busy ? "Verifying…" : "Turn on two-factor"}
          </Button>
        </div>
      </Modal>
    );
  }

  if (step === "confirm" && setupData?.method === "email") {
    return (
      <Modal variant="card" title="Check your email" busy={busy} onClose={onClose} onSubmit={confirmCode}>
        <p>
          We sent a 6-digit code to <strong>{setupData.sentTo}</strong>. Enter it to confirm the address can reach you.
          It expires in {setupData.expiresInMinutes} minutes.
        </p>
        <Field label="6-digit code" value={code} onChange={setCode} autoComplete="one-time-code" />
        {error && <MessageBox tone="error" title="Unable to turn on two-factor">{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="text" onClick={() => startSetup()} disabled={busy}>Send another code</Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || code.trim().length < 6}>
            {busy ? "Verifying…" : "Turn on two-factor"}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal variant="card" title="Save your backup codes" onClose={onDone}>
      <MessageBox tone="warning" title="Save these now">
        Each code lets you sign in once if your second factor is out of reach — a lost authenticator, or an inbox you
        can't get to. They won't be shown again.
      </MessageBox>
      <BackupCodes codes={backupCodes} />
      <div className="modal-actions">
        <Button variant="secondary" onClick={() => downloadCodes(backupCodes)}>Download</Button>
        <Button variant="primary" onClick={onDone}>Done</Button>
      </div>
    </Modal>
  );
}

function MfaRegenerateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ backupCodes: string[] }>("/api/profile/mfa/backup-codes", {
        method: "POST",
        body: JSON.stringify({ currentPassword: password })
      });
      setCodes(payload.backupCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to regenerate codes");
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <Modal variant="card" title="New backup codes" onClose={onDone}>
        <MessageBox tone="warning" title="Save these now">
          These replace your old codes, which no longer work. They won't be shown again.
        </MessageBox>
        <BackupCodes codes={codes} />
        <div className="modal-actions">
          <Button variant="secondary" onClick={() => downloadCodes(codes)}>Download</Button>
          <Button variant="primary" onClick={onDone}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal variant="card" title="Regenerate backup codes" busy={busy} onClose={onClose} onSubmit={submit}>
      <p>Confirm your password. This replaces your existing backup codes with a fresh set.</p>
      <Field label="Current password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      {error && <MessageBox tone="error" title="Unable to regenerate">{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={busy || password.length < 1}>
          {busy ? "Generating…" : "Regenerate"}
        </Button>
      </div>
    </Modal>
  );
}

function MfaDisableModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/profile/mfa/disable", {
        method: "POST",
        body: JSON.stringify({ currentPassword: password })
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to turn off two-factor");
      setBusy(false);
    }
  };

  return (
    <Modal variant="card" title="Turn off two-factor authentication?" alert busy={busy} onClose={onClose} onSubmit={submit}>
      <p>Your account will be protected by your password alone. Confirm your password to turn two-factor off.</p>
      <Field label="Current password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      {error && <MessageBox tone="error" title="Unable to turn off">{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" type="submit" disabled={busy || password.length < 1}>
          {busy ? "Turning off…" : "Turn off"}
        </Button>
      </div>
    </Modal>
  );
}
