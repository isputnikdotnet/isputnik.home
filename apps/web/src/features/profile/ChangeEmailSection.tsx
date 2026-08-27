import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, type PublicUser } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";

export function ChangeEmailSection({
  email,
  mfaEnabled,
  onChanged
}: {
  email: string;
  mfaEnabled: boolean;
  onChanged: (user: PublicUser) => void;
}) {
  const { t } = useTranslation(["common", "misc"]);
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const close = () => {
    setOpen(false);
    setNewEmail("");
    setCurrentPassword("");
    setCode("");
    setError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = await api<{ user: PublicUser }>("/api/profile/email", {
        method: "PATCH",
        body: JSON.stringify({
          currentPassword,
          newEmail: newEmail.trim(),
          ...(mfaEnabled ? { code: code.trim() } : {})
        })
      });
      onChanged(payload.user);
      close();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("misc:changeEmail.unableToChange"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="email-section" aria-labelledby="email-heading">
      <h2 id="email-heading">{t("misc:changeEmail.heading")}</h2>
      <p className="email-intro">
        {mfaEnabled ? t("misc:changeEmail.introMfa") : t("misc:changeEmail.intro")}
      </p>
      <p className="email-current"><strong>{email}</strong></p>
      {done && <MessageBox tone="success" title={t("misc:changeEmail.changedTitle")}>{t("misc:changeEmail.changedBody")}</MessageBox>}
      <div className="email-actions">
        <Button variant="secondary" onClick={() => { setDone(false); setOpen(true); }}>{t("misc:changeEmail.changeButton")}</Button>
      </div>

      {open && (
        <Modal
          variant="card"
          className="email-form-modal"
          title={t("misc:changeEmail.changeButton")}
          busy={saving}
          onClose={close}
          onSubmit={submit}
        >
          <Field label={t("misc:changeEmail.newEmailLabel")} type="email" value={newEmail} onChange={setNewEmail} autoComplete="email" />
          <Field label={t("misc:common.currentPassword")} type="password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
          {mfaEnabled && (
            <Field
              label={t("misc:common.twoFactorCode")}
              value={code}
              onChange={setCode}
              placeholder={t("misc:common.codePlaceholder")}
              autoComplete="one-time-code"
            />
          )}
          {error && <MessageBox tone="error" title={t("misc:changeEmail.unableToChange")}>{error}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={close} disabled={saving}>{t("common:common.cancel")}</Button>
            <Button
              variant="primary"
              type="submit"
              disabled={saving || newEmail.trim().length < 3 || currentPassword.length < 1 || (mfaEnabled && code.trim().length < 6)}
            >
              {saving ? t("misc:changeEmail.submitBusy") : t("misc:changeEmail.changeButton")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
