import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { BellRing } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { controlHref } from "../../../router";
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
// Everything here needs a working relay, so with none configured the whole tab
// is read-only and says where to go. The server refuses the same combination, so
// this is the explanation rather than the enforcement.
export function NotificationsSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mailConfigured, setMailConfigured] = useState(false);

  const [shareNotifications, setShareNotifications] = useState(false);
  const [recommendationNotifications, setRecommendationNotifications] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    api<{ notifications: NotificationsDto; mailConfigured: boolean }>("/api/config/notifications")
      .then((payload) => {
        setShareNotifications(payload.notifications.shareNotifications);
        setRecommendationNotifications(payload.notifications.recommendationNotifications);
        setMailConfigured(payload.mailConfigured);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("controlAdmin:notifications.loadFailed")))
      .finally(() => setLoading(false));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const payload = await api<{ notifications: NotificationsDto; mailConfigured: boolean }>(
        "/api/config/notifications",
        { method: "PUT", body: JSON.stringify({ shareNotifications, recommendationNotifications }) }
      );
      setShareNotifications(payload.notifications.shareNotifications);
      setRecommendationNotifications(payload.notifications.recommendationNotifications);
      setMailConfigured(payload.mailConfigured);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("controlAdmin:notifications.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const locked = !mailConfigured;

  return (
    <>
      <ControlSectionHead
        section="notifications"
        icon={<BellRing size={30} />}
        iconClassName="blue"
        description={t("controlAdmin:notifications.headDescription")}
      />

      <section className="config-block">
        <p className="muted">
          {t("controlAdmin:notifications.intro")}
        </p>

        {loadError && <MessageBox tone="error" title={t("controlAdmin:notifications.settingsTitle")}>{loadError}</MessageBox>}

        {loading ? (
          <p className="muted">{t("controlAdmin:ui.loading")}</p>
        ) : (
          <form className="mail-form" onSubmit={save}>
            {locked && (
              <MessageBox tone="warning" title={t("controlAdmin:notifications.noMailTitle")}>
                <Trans
                  i18nKey="notifications.noMailBody"
                  ns="controlAdmin"
                  components={{ lnk: <a href={controlHref("email")} /> }}
                />
              </MessageBox>
            )}

            <fieldset className="notify-fieldset" disabled={locked || saving}>
              <legend className="mail-subhead">{t("controlAdmin:notifications.sharingLegend")}</legend>
              <label className="mail-check">
                <input
                  type="checkbox"
                  checked={shareNotifications && !locked}
                  onChange={(event) => setShareNotifications(event.target.checked)}
                />
                <span>
                  {t("controlAdmin:notifications.shareDesc")}
                </span>
              </label>
            </fieldset>

            <fieldset className="notify-fieldset" disabled={locked || saving}>
              <legend className="mail-subhead">{t("controlAdmin:notifications.sendToLegend")}</legend>
              <label className="mail-check">
                <input
                  type="checkbox"
                  checked={recommendationNotifications && !locked}
                  onChange={(event) => setRecommendationNotifications(event.target.checked)}
                />
                <span>
                  {t("controlAdmin:notifications.recommendDesc")}
                </span>
              </label>
            </fieldset>

            {saveError && <MessageBox tone="error" title={t("errors.unableToSave")}>{saveError}</MessageBox>}
            {saved && <MessageBox tone="success" title={t("controlAdmin:ui.saved")}>{t("controlAdmin:notifications.savedBody")}</MessageBox>}

            <div className="mail-actions">
              <Button variant="primary" type="submit" disabled={saving || locked}>
                {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
              </Button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
