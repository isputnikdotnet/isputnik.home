import { useState, useEffect, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["common", "misc"]);
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<Mode>(null);

  const refresh = async () => {
    try {
      setStatus(await api<MfaStatus>("/api/profile/mfa"));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("misc:mfa.unableToLoadFallback"));
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
      <h2 id="mfa-heading">{t("misc:mfa.heading")}</h2>
      <p className="mfa-intro">
        {t("misc:mfa.intro")}
      </p>
      {loadError && <MessageBox tone="error" title={t("misc:common.unableToLoad")}>{loadError}</MessageBox>}

      {status?.enabled && (
        <>
          <MessageBox tone="success" title={t("misc:mfa.onTitle")}>
            {status.method === "email"
              ? t("misc:mfa.onBodyEmail", { email: status.emailAddress })
              : t("misc:mfa.onBodyTotp")}
            {status.backupCodesRemaining > 0
              ? t("misc:mfa.backupRemaining", { count: status.backupCodesRemaining })
              : t("misc:mfa.noBackupCodes")}
          </MessageBox>
          {status.method === "email" && !status.emailAvailable && (
            <MessageBox tone="warning" title={t("misc:mfa.noEmailTitle")}>
              {t("misc:mfa.noEmailBody")}
            </MessageBox>
          )}
          <div className="mfa-actions">
            <Button variant="secondary" onClick={() => setMode("regenerate")}>{t("misc:mfa.regenerateButton")}</Button>
            <Button variant="danger" onClick={() => setMode("disable")}>{t("misc:mfa.turnOffButton")}</Button>
          </div>
        </>
      )}

      {status && !status.enabled && (
        <div className="mfa-actions">
          <Button variant="primary" onClick={() => setMode("setup")}>{t("misc:mfa.setUpButton")}</Button>
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
  const { t } = useTranslation(["common", "misc"]);
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
      setError(err instanceof Error ? err.message : t("misc:mfa.unableToStartSetup"));
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
      setError(err instanceof Error ? err.message : t("misc:mfa.unableToEnable"));
    } finally {
      setBusy(false);
    }
  };

  if (step === "password") {
    return (
      <Modal variant="card" title={t("misc:mfa.setupTitle")} busy={busy} onClose={onClose} onSubmit={startSetup}>
        <ChoiceGroup
          legend={t("misc:mfa.methodLegend")}
          value={method}
          onChange={setMethod}
          disabled={busy}
          options={[
            {
              value: "totp",
              label: t("misc:mfa.methodTotpLabel"),
              description: t("misc:mfa.methodTotpDesc")
            },
            {
              value: "email",
              label: t("misc:mfa.methodEmailLabel"),
              description: t("misc:mfa.methodEmailDesc", { email: emailAddress }),
              disabled: !emailAvailable,
              note: emailAvailable
                ? t("misc:mfa.methodEmailNoteAvailable")
                : t("misc:mfa.methodEmailNoteUnavailable")
            }
          ]}
        />
        <Field label={t("misc:common.currentPassword")} type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <MessageBox tone="error" title={t("misc:mfa.continueErrorTitle")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy || password.length < 1}>
            {busy ? t("misc:mfa.checkingBusy") : t("misc:mfa.continueButton")}
          </Button>
        </div>
      </Modal>
    );
  }

  if (step === "confirm" && setupData?.method === "totp") {
    return (
      <Modal variant="card" title={t("misc:mfa.scanTitle")} busy={busy} onClose={onClose} onSubmit={confirmCode}>
        <p>
          {t("misc:mfa.scanIntro")}
        </p>
        <div className="mfa-qr">
          <img src={setupData.qrDataUrl} alt={t("misc:mfa.qrAlt")} width={180} height={180} />
        </div>
        <p className="mfa-secret">
          {t("misc:mfa.manualEntryIntro")}
          <br />
          <code>{setupData.secret}</code>
        </p>
        <Field label={t("misc:common.twoFactorCode")} value={code} onChange={setCode} autoComplete="one-time-code" />
        {error && <MessageBox tone="error" title={t("misc:mfa.turnOnErrorTitle")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy || code.trim().length < 6}>
            {busy ? t("misc:mfa.verifyingBusy") : t("misc:mfa.turnOnButton")}
          </Button>
        </div>
      </Modal>
    );
  }

  if (step === "confirm" && setupData?.method === "email") {
    return (
      <Modal variant="card" title={t("misc:mfa.emailStepTitle")} busy={busy} onClose={onClose} onSubmit={confirmCode}>
        <p>
          <Trans
            i18nKey="mfa.emailStepIntro"
            ns="misc"
            count={setupData.expiresInMinutes}
            values={{ email: setupData.sentTo }}
            components={{ bold: <strong /> }}
          />
        </p>
        <Field label={t("misc:common.twoFactorCode")} value={code} onChange={setCode} autoComplete="one-time-code" />
        {error && <MessageBox tone="error" title={t("misc:mfa.turnOnErrorTitle")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="text" onClick={() => startSetup()} disabled={busy}>{t("misc:mfa.sendAnother")}</Button>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy || code.trim().length < 6}>
            {busy ? t("misc:mfa.verifyingBusy") : t("misc:mfa.turnOnButton")}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal variant="card" title={t("misc:mfa.codesTitle")} onClose={onDone}>
      <MessageBox tone="warning" title={t("misc:mfa.saveNowTitle")}>
        {t("misc:mfa.saveNowBodySetup")}
      </MessageBox>
      <BackupCodes codes={backupCodes} />
      <div className="modal-actions">
        <Button variant="secondary" onClick={() => downloadCodes(backupCodes)}>{t("misc:mfa.download")}</Button>
        <Button variant="primary" onClick={onDone}>{t("common:common.done")}</Button>
      </div>
    </Modal>
  );
}

function MfaRegenerateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(["common", "misc"]);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
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
        body: JSON.stringify({ currentPassword: password, code: code.trim() })
      });
      setCodes(payload.backupCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("misc:mfa.unableToRegenerate"));
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <Modal variant="card" title={t("misc:mfa.newCodesTitle")} onClose={onDone}>
        <MessageBox tone="warning" title={t("misc:mfa.saveNowTitle")}>
          {t("misc:mfa.newCodesBody")}
        </MessageBox>
        <BackupCodes codes={codes} />
        <div className="modal-actions">
          <Button variant="secondary" onClick={() => downloadCodes(codes)}>{t("misc:mfa.download")}</Button>
          <Button variant="primary" onClick={onDone}>{t("common:common.done")}</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal variant="card" title={t("misc:mfa.regenerateTitle")} busy={busy} onClose={onClose} onSubmit={submit}>
      <p>{t("misc:mfa.regenerateIntro")}</p>
      <Field label={t("misc:common.currentPassword")} type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      <Field
        label={t("misc:common.twoFactorCode")}
        value={code}
        onChange={setCode}
        placeholder={t("misc:common.codePlaceholder")}
        autoComplete="one-time-code"
      />
      {error && <MessageBox tone="error" title={t("misc:mfa.regenerateErrorTitle")}>{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy || password.length < 1 || code.trim().length < 6}>
          {busy ? t("misc:mfa.generatingBusy") : t("misc:mfa.regenerateSubmit")}
        </Button>
      </div>
    </Modal>
  );
}

function MfaDisableModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(["common", "misc"]);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/profile/mfa/disable", {
        method: "POST",
        body: JSON.stringify({ currentPassword: password, code: code.trim() })
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("misc:mfa.unableToDisable"));
      setBusy(false);
    }
  };

  return (
    <Modal variant="card" title={t("misc:mfa.disableTitle")} alert busy={busy} onClose={onClose} onSubmit={submit}>
      <p>
        {t("misc:mfa.disableIntro")}
      </p>
      <Field label={t("misc:common.currentPassword")} type="password" value={password} onChange={setPassword} autoComplete="current-password" />
      <Field
        label={t("misc:common.twoFactorCode")}
        value={code}
        onChange={setCode}
        placeholder={t("misc:common.codePlaceholder")}
        autoComplete="one-time-code"
      />
      {error && <MessageBox tone="error" title={t("misc:mfa.disableErrorTitle")}>{error}</MessageBox>}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="danger" type="submit" disabled={busy || password.length < 1 || code.trim().length < 6}>
          {busy ? t("misc:mfa.turningOffBusy") : t("misc:mfa.turnOffButton")}
        </Button>
      </div>
    </Modal>
  );
}
