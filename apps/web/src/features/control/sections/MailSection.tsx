import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";

interface MailDto {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string;
  hasPassword: boolean;
}

// Admin SMTP settings for outgoing mail (powers "Send to e-reader"). The password
// is write-only: the server never returns it, only whether one is stored, so the
// field stays blank and an empty save keeps the existing secret.
export function MailSection() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [fromAddress, setFromAddress] = useState("");
  const [fromName, setFromName] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [testError, setTestError] = useState("");

  const applyDto = (mail: MailDto) => {
    setHost(mail.host);
    setPort(String(mail.port || 587));
    setSecure(mail.secure);
    setUsername(mail.username);
    setFromAddress(mail.fromAddress);
    setFromName(mail.fromName);
    setHasPassword(mail.hasPassword);
    setPassword("");
  };

  useEffect(() => {
    api<{ mail: MailDto; configured: boolean }>("/api/config/mail")
      .then((payload) => applyDto(payload.mail))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Unable to load email settings"))
      .finally(() => setLoading(false));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError("");
    setTested(false);
    setTestError("");
    try {
      const body: Record<string, unknown> = {
        host: host.trim(),
        port: Number(port) || 587,
        secure,
        username: username.trim(),
        fromAddress: fromAddress.trim(),
        fromName: fromName.trim()
      };
      // Only send the password when the admin typed a new one — blank keeps the stored value.
      if (password) body.password = password;
      const payload = await api<{ mail: MailDto; configured: boolean }>("/api/config/mail", {
        method: "PUT",
        body: JSON.stringify(body)
      });
      applyDto(payload.mail);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Unable to save email settings");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setTested(false);
    setTestError("");
    try {
      await api("/api/config/mail/test", { method: "POST" });
      setTested(true);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Unable to send test email");
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="config-block">
      <h2>Email (SMTP)</h2>
      <p className="muted">
        Outgoing mail for “Send to e-reader”. Point this at your mail provider or relay (e.g. a Gmail app
        password, Fastmail, or your own SMTP server). The password is stored on the server and never shown again.
      </p>

      {loadError && <MessageBox tone="error" title="Email settings">{loadError}</MessageBox>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="mail-form" onSubmit={save}>
          <Field label="SMTP host" value={host} onChange={setHost} placeholder="smtp.example.com" autoComplete="off" required={false} />
          <Field label="Port" value={port} onChange={setPort} type="number" placeholder="587" autoComplete="off" required={false} />

          <label className="mail-secure">
            <input type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} />
            <span>Use implicit TLS (port 465). Leave off for STARTTLS on 587.</span>
          </label>

          <Field label="Username" value={username} onChange={setUsername} placeholder="login@example.com" autoComplete="off" required={false} />
          <Field
            label="Password"
            value={password}
            onChange={setPassword}
            type="password"
            placeholder={hasPassword ? "•••••••• (unchanged)" : "SMTP password"}
            autoComplete="new-password"
            required={false}
          />

          <Field label="From address" value={fromAddress} onChange={setFromAddress} type="email" placeholder="library@example.com" autoComplete="off" required={false} />
          <Field label="From name" value={fromName} onChange={setFromName} placeholder="iSputnik Library" autoComplete="off" required={false} />

          {saveError && <MessageBox tone="error" title="Unable to save">{saveError}</MessageBox>}
          {saved && <MessageBox tone="success" title="Saved">Email settings updated.</MessageBox>}
          {testError && <MessageBox tone="error" title="Test failed">{testError}</MessageBox>}
          {tested && <MessageBox tone="success" title="Test sent">A test email was sent to your account address. Check your inbox.</MessageBox>}

          <div className="mail-actions">
            <Button variant="primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" type="button" onClick={sendTest} disabled={testing || saving}>
              {testing ? "Sending…" : "Send test email"}
            </Button>
          </div>
          <p className="muted">The test uses the last saved settings, so save before testing.</p>
        </form>
      )}
    </section>
  );
}
