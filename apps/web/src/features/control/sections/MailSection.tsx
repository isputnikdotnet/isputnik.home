import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { api } from "../../../api";
import { ActionRow, GroupedList, InputRow, ToggleRow } from "../../../shared/GroupedList";
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

interface MailForm {
  host: string;
  port: string;
  secure: boolean;
  username: string;
  fromAddress: string;
  fromName: string;
}

const toForm = (mail: MailDto): MailForm => ({
  host: mail.host,
  port: String(mail.port || 587),
  secure: mail.secure,
  username: mail.username,
  fromAddress: mail.fromAddress,
  fromName: mail.fromName
});

const sameForm = (a: MailForm, b: MailForm) =>
  a.host.trim() === b.host.trim() &&
  (Number(a.port) || 587) === (Number(b.port) || 587) &&
  a.secure === b.secure &&
  a.username.trim() === b.username.trim() &&
  a.fromAddress.trim() === b.fromAddress.trim() &&
  a.fromName.trim() === b.fromName.trim();

// Admin SMTP settings for outgoing mail (powers "Send to e-reader"), laid out as
// grouped rows — Server · Account · Sender — like a phone's mail account page.
// Unlike the other grouped pages this one keeps a Save: half-typed relay settings
// saved field by field would break sending in between, so the page saves them
// together, and the test (which uses what is saved) waits until there is nothing
// unsaved. The password is write-only: the server never returns it, only whether
// one is stored, so the field stays blank and an empty save keeps the secret.
export function MailSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [saved, setSavedForm] = useState<MailForm | null>(null);
  const [form, setForm] = useState<MailForm | null>(null);
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(false);

  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [testError, setTestError] = useState("");

  const applyDto = (mail: MailDto) => {
    const next = toForm(mail);
    setSavedForm(next);
    setForm(next);
    setHasPassword(mail.hasPassword);
    setPassword("");
  };

  useEffect(() => {
    api<{ mail: MailDto; configured: boolean }>("/api/config/mail")
      .then((payload) => applyDto(payload.mail))
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("controlAdmin:mail.loadFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  const dirty = Boolean(form && saved && (!sameForm(form, saved) || password));
  const edit = (patch: Partial<MailForm>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setJustSaved(false);
    setTested(false);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setJustSaved(false);
    setSaveError("");
    setTested(false);
    setTestError("");
    try {
      const body: Record<string, unknown> = {
        host: form.host.trim(),
        port: Number(form.port) || 587,
        secure: form.secure,
        username: form.username.trim(),
        fromAddress: form.fromAddress.trim(),
        fromName: form.fromName.trim()
      };
      // Only send the password when the admin typed a new one — blank keeps the stored value.
      if (password) body.password = password;
      const payload = await api<{ mail: MailDto; configured: boolean }>("/api/config/mail", {
        method: "PUT",
        body: JSON.stringify(body)
      });
      applyDto(payload.mail);
      setJustSaved(true);
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

      <div className="grouped-page">
        {loadError && <MessageBox tone="error" title={t("controlAdmin:mail.settingsTitle")}>{loadError}</MessageBox>}

        {loading || !form ? (
          !loadError && <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : (
          <form
            className="grouped-page"
            onSubmit={(event) => {
              event.preventDefault();
              if (dirty && !saving) void save();
            }}
          >
            <GroupedList title={t("controlAdmin:mail.groupServer")}>
              <InputRow
                label={t("controlAdmin:mail.smtpHost")}
                value={form.host}
                onChange={(host) => edit({ host })}
                placeholder="smtp.example.com"
                wide
              />
              <InputRow
                label={t("controlAdmin:mail.port")}
                type="number"
                value={form.port}
                onChange={(port) => edit({ port })}
                placeholder="587"
                min={1}
                max={65535}
              />
              <ToggleRow
                label={t("controlAdmin:mail.tlsLabel")}
                sub={t("controlAdmin:mail.implicitTls")}
                checked={form.secure}
                onChange={(secure) => edit({ secure })}
              />
            </GroupedList>

            <GroupedList title={t("controlAdmin:mail.groupAccount")} note={t("controlAdmin:mail.intro")}>
              <InputRow
                label={t("controlAdmin:ui.username")}
                value={form.username}
                onChange={(username) => edit({ username })}
                placeholder="login@example.com"
                wide
              />
              <InputRow
                label={t("common.password")}
                type="password"
                value={password}
                onChange={(next) => { setPassword(next); setJustSaved(false); }}
                placeholder={hasPassword ? t("controlAdmin:mail.passwordUnchanged") : t("controlAdmin:mail.passwordPlaceholder")}
                autoComplete="new-password"
                wide
              />
            </GroupedList>

            <GroupedList title={t("controlAdmin:mail.groupSender")}>
              <InputRow
                label={t("controlAdmin:mail.fromAddress")}
                type="email"
                value={form.fromAddress}
                onChange={(fromAddress) => edit({ fromAddress })}
                placeholder="library@example.com"
                wide
              />
              <InputRow
                label={t("controlAdmin:mail.fromName")}
                value={form.fromName}
                onChange={(fromName) => edit({ fromName })}
                placeholder={t("controlAdmin:mail.fromNamePlaceholder")}
                wide
              />
            </GroupedList>

            {saveError && <MessageBox tone="error" title={t("errors.unableToSave")}>{saveError}</MessageBox>}
            {justSaved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:mail.savedBody")}</MessageBox>}
            {testError && <MessageBox tone="error" title={t("controlAdmin:mail.testFailedTitle")}>{testError}</MessageBox>}
            {tested && <MessageBox tone="success" title={t("controlAdmin:mail.testSentTitle")}>{t("controlAdmin:mail.testSentBody")}</MessageBox>}

            <GroupedList note={t("controlAdmin:mail.testNote")}>
              <ActionRow
                label={saving ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
                onClick={() => void save()}
                disabled={!dirty || saving}
              />
              <ActionRow
                label={testing ? t("controlAdmin:mail.sending") : t("controlAdmin:mail.sendTest")}
                onClick={() => void sendTest()}
                disabled={dirty || testing || saving}
              />
            </GroupedList>
          </form>
        )}
      </div>
    </>
  );
}
