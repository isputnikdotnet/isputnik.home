import { useState, type FormEvent } from "react";
import { api, type PublicUser } from "../../api";
import { Button } from "../../shared/Button";
import { Field } from "../../shared/Field";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";

export function ChangeEmailSection({ email, onChanged }: { email: string; onChanged: (user: PublicUser) => void }) {
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const close = () => {
    setOpen(false);
    setNewEmail("");
    setCurrentPassword("");
    setError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = await api<{ user: PublicUser }>("/api/profile/email", {
        method: "PATCH",
        body: JSON.stringify({ currentPassword, newEmail: newEmail.trim() })
      });
      onChanged(payload.user);
      close();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change email");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="email-section" aria-labelledby="email-heading">
      <h2 id="email-heading">Email</h2>
      <p className="email-intro">The address you sign in with. Changing it needs your current password.</p>
      <p className="email-current"><strong>{email}</strong></p>
      {done && <MessageBox tone="success" title="Email changed">Your sign-in email has been updated.</MessageBox>}
      <div className="email-actions">
        <Button variant="secondary" onClick={() => { setDone(false); setOpen(true); }}>Change email</Button>
      </div>

      {open && (
        <Modal
          variant="card"
          className="email-form-modal"
          title="Change email"
          busy={saving}
          onClose={close}
          onSubmit={submit}
        >
          <Field label="New email" type="email" value={newEmail} onChange={setNewEmail} autoComplete="email" />
          <Field label="Current password" type="password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" />
          {error && <MessageBox tone="error" title="Unable to change email">{error}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={close} disabled={saving}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={saving || newEmail.trim().length < 3 || currentPassword.length < 1}>
              {saving ? "Changing…" : "Change email"}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
