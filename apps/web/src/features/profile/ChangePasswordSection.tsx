import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";

export function ChangePasswordSection() {
  const { t } = useTranslation(["common", "misc"]);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const close = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setError(t("misc:changePassword.mismatch"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api("/api/profile/password", {
        method: "PATCH",
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
      close();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("misc:changePassword.unableToChange"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="password-section" aria-labelledby="password-heading">
      <h2 id="password-heading">{t("misc:changePassword.heading")}</h2>
      <p className="password-intro">{t("misc:changePassword.intro")}</p>
      {done && <MessageBox tone="success" title={t("misc:changePassword.changedTitle")}>{t("misc:changePassword.changedBody")}</MessageBox>}
      <div className="password-actions">
        <Button variant="secondary" onClick={() => { setDone(false); setOpen(true); }}>{t("misc:changePassword.changeButton")}</Button>
      </div>

      {open && (
        <Modal
          variant="card"
          className="password-form-modal"
          title={t("misc:changePassword.changeButton")}
          busy={saving}
          onClose={close}
          onSubmit={submit}
        >
          <Field label={t("misc:common.currentPassword")} type="password" value={current} onChange={setCurrent} autoComplete="current-password" />
          <Field label={t("misc:changePassword.newPasswordLabel")} type="password" minLength={8} value={next} onChange={setNext} autoComplete="new-password" />
          <Field label={t("misc:changePassword.confirmPasswordLabel")} type="password" minLength={8} value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {error && <MessageBox tone="error" title={t("misc:changePassword.unableToChange")}>{error}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={close} disabled={saving}>{t("common:common.cancel")}</Button>
            <Button variant="primary" type="submit" disabled={saving || current.length < 1 || next.length < 8}>
              {saving ? t("misc:common.changing") : t("misc:changePassword.changeButton")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
