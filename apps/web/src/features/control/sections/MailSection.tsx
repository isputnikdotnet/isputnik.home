import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { ControlSectionHead } from "../ControlSectionHead";

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
  const { t } = useTranslation(["common", "controlAdmin"]);
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
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("controlAdmin:mail.loadFailed")))
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
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:mail.saveFailed"));
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
      setTestError(err instanceof Error ? err.message : t("controlAdmin:mail.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section="email"
        icon={<Mail size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:mail.headDescription")}
      />

      <section className="config-block">
        <p className="muted">
          {t("controlAdmin:mail.intro")}
        </p>

        {loadError && <MessageBox tone="error" title={t("controlAdmin:mail.settingsTitle")}>{loadError}</MessageBox>}

        {loading ? (
          <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : (
          <form className="mail-form" onSubmit={save}>
            <Field label={t("controlAdmin:mail.smtpHost")} value={host} onChange={setHost} placeholder="smtp.example.com" autoComplete="off" required={false} />
            <Field label={t("controlAdmin:mail.port")} value={port} onChange={setPort} type="number" placeholder="587" autoComplete="off" required={false} />

            <label className="mail-check">
              <input type="checkbox" checked={secure} onChange={(event) => setSecure(event.target.checked)} />
              <span>{t("controlAdmin:mail.implicitTls")}</span>
            </label>

            <Field label={t("controlAdmin:ui.username")} value={username} onChange={setUsername} placeholder="login@example.com" autoComplete="off" required={false} />
            <Field
              label={t("common.password")}
              value={password}
              onChange={setPassword}
              type="password"
              placeholder={hasPassword ? t("controlAdmin:mail.passwordUnchanged") : t("controlAdmin:mail.passwordPlaceholder")}
              autoComplete="new-password"
              required={false}
            />

            <Field label={t("controlAdmin:mail.fromAddress")} value={fromAddress} onChange={setFromAddress} type="email" placeholder="library@example.com" autoComplete="off" required={false} />
            <Field label={t("controlAdmin:mail.fromName")} value={fromName} onChange={setFromName} placeholder={t("controlAdmin:mail.fromNamePlaceholder")} autoComplete="off" required={false} />

            {saveError && <MessageBox tone="error" title={t("errors.unableToSave")}>{saveError}</MessageBox>}
            {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:mail.savedBody")}</MessageBox>}
            {testError && <MessageBox tone="error" title={t("controlAdmin:mail.testFailedTitle")}>{testError}</MessageBox>}
            {tested && <MessageBox tone="success" title={t("controlAdmin:mail.testSentTitle")}>{t("controlAdmin:mail.testSentBody")}</MessageBox>}

            <div className="mail-actions">
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
              </Button>
              <Button variant="secondary" type="button" onClick={sendTest} disabled={testing || saving}>
                {testing ? t("controlAdmin:mail.sending") : t("controlAdmin:mail.sendTest")}
              </Button>
            </div>
            <p className="muted">{t("controlAdmin:mail.testNote")}</p>
          </form>
        )}
      </section>
    </>
  );
}
