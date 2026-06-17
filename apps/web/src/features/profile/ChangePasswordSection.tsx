import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";

export function ChangePasswordSection() {
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
      setError("The new passwords don't match.");
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
      setError(err instanceof Error ? err.message : "Unable to change password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="password-section" aria-labelledby="password-heading">
      <h2 id="password-heading">Password</h2>
      <p className="password-intro">Change the password you use to sign in. Your other devices will be signed out.</p>
      {done && <MessageBox tone="success" title="Password changed">Your password has been updated.</MessageBox>}
      <div className="password-actions">
        <Button variant="secondary" onClick={() => { setDone(false); setOpen(true); }}>Change password</Button>
      </div>

      {open && (
        <Modal
          variant="card"
          className="password-form-modal"
          title="Change password"
          busy={saving}
          onClose={close}
          onSubmit={submit}
        >
          <Field label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" />
          <Field label="New password" type="password" minLength={8} value={next} onChange={setNext} autoComplete="new-password" />
          <Field label="Confirm new password" type="password" minLength={8} value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {error && <MessageBox tone="error" title="Unable to change password">{error}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={close} disabled={saving}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={saving || current.length < 1 || next.length < 8}>
              {saving ? "Changing…" : "Change password"}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
