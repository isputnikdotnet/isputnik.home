import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { BellRing } from "lucide-react";
import { api } from "../../../api";
import { GroupedList, ToggleRow } from "../../../shared/GroupedList";
import { MessageBox } from "../../../shared/MessageBox";
import { controlHref, followRoute } from "../../../router";
import { ControlSectionHead } from "../ControlSectionHead";

interface NotificationsDto {
  shareNotifications: boolean;
  recommendationNotifications: boolean;
}

// What the app is allowed to email ordinary members about. Deliberately apart
// from the Email tab: that one is the relay — whether mail CAN leave — and this
// one is consent, whether it SHOULD. An admin who set up SMTP for two-factor
// codes has not thereby agreed to mail the household about routine activity.
//
// Each switch saves when it is moved, as on a phone (control panel v2's grouped
// rows). Everything here needs a working relay, so with none configured the
// switches are off and locked, and the page says where to go. The server refuses
// the same combination, so this is the explanation rather than the enforcement.
export function NotificationsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mailConfigured, setMailConfigured] = useState(false);
  const [settings, setSettings] = useState<NotificationsDto>({ shareNotifications: false, recommendationNotifications: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    api<{ notifications: NotificationsDto; mailConfigured: boolean }>("/api/config/notifications")
      .then((payload) => {
        setSettings(payload.notifications);
        setMailConfigured(payload.mailConfigured);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("controlAdmin:notifications.loadFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  const change = async (patch: Partial<NotificationsDto>) => {
    const previous = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    setSaving(true);
    setSaveError("");
    try {
      const payload = await api<{ notifications: NotificationsDto; mailConfigured: boolean }>(
        "/api/config/notifications",
        { method: "PUT", body: JSON.stringify(next) }
      );
      setSettings(payload.notifications);
      setMailConfigured(payload.mailConfigured);
    } catch (err) {
      setSettings(previous);
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:notifications.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const locked = !mailConfigured;
  const emailHref = controlHref("email");

  return (
    <>
      <ControlSectionHead
        section="notifications"
        icon={<BellRing size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:notifications.headDescription")}
      />

      <div className="grouped-page">
        {loadError && <MessageBox tone="error" title={t("controlAdmin:notifications.settingsTitle")}>{loadError}</MessageBox>}
        {saveError && <MessageBox tone="error" title={t("errors.unableToSave")}>{saveError}</MessageBox>}

        {loading ? (
          <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : (
          <>
            {locked && (
              <MessageBox tone="warning" title={t("controlAdmin:notifications.noMailTitle")}>
                <Trans
                  i18nKey="notifications.noMailBody"
                  ns="controlAdmin"
                  components={{ lnk: <a href={emailHref} onClick={(event) => followRoute(event, emailHref)} /> }}
                />
              </MessageBox>
            )}

            <GroupedList title={t("controlAdmin:notifications.sharingLegend")} note={t("controlAdmin:notifications.shareDesc")}>
              <ToggleRow
                label={t("controlAdmin:notifications.shareLabel")}
                checked={settings.shareNotifications && !locked}
                disabled={locked || saving}
                onChange={(next) => void change({ shareNotifications: next })}
              />
            </GroupedList>

            <GroupedList title={t("controlAdmin:notifications.sendToLegend")} note={t("controlAdmin:notifications.recommendDesc")}>
              <ToggleRow
                label={t("controlAdmin:notifications.recommendLabel")}
                checked={settings.recommendationNotifications && !locked}
                disabled={locked || saving}
                onChange={(next) => void change({ recommendationNotifications: next })}
              />
            </GroupedList>

            <p className="grouped-list-note">{t("controlAdmin:notifications.intro")}</p>
          </>
        )}
      </div>
    </>
  );
}
