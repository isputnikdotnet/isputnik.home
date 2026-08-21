import { useEffect, useState, type FormEvent } from "react";
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
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Unable to load notification settings"))
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
      setSaveError(err instanceof Error ? err.message : "Unable to save notification settings");
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
        description="What the app may email people about, beyond the mail they asked for."
      />

      <section className="config-block">
        <p className="muted">
          These are switched off until you turn them on. Security alerts, sign-in codes and
          “Send to e-reader” are unaffected either way — those are either asked for or too
          important to be optional.
        </p>

        {loadError && <MessageBox tone="error" title="Notification settings">{loadError}</MessageBox>}

        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <form className="mail-form" onSubmit={save}>
            {locked && (
              <MessageBox tone="warning" title="No email server yet">
                Notifications need somewhere to send from. Set up an outgoing mail server under{" "}
                <a href={controlHref("email")}>Settings → Email</a>, then come back here.
              </MessageBox>
            )}

            <fieldset className="notify-fieldset" disabled={locked || saving}>
              <legend className="mail-subhead">Sharing</legend>
              <label className="mail-check">
                <input
                  type="checkbox"
                  checked={shareNotifications && !locked}
                  onChange={(event) => setShareNotifications(event.target.checked)}
                />
                <span>
                  Email someone when a photo, book, or album is shared with them. The message says
                  who shared what and links to “Shared with me”; it never carries the file itself.
                </span>
              </label>
            </fieldset>

            <fieldset className="notify-fieldset" disabled={locked || saving}>
              <legend className="mail-subhead">Send to</legend>
              <label className="mail-check">
                <input
                  type="checkbox"
                  checked={recommendationNotifications && !locked}
                  onChange={(event) => setRecommendationNotifications(event.target.checked)}
                />
                <span>
                  Email someone when a family member sends them a book, photo or person. They see
                  it in the app either way — this is only for households that would rather not have
                  to look.
                </span>
              </label>
            </fieldset>

            {saveError && <MessageBox tone="error" title="Unable to save">{saveError}</MessageBox>}
            {saved && <MessageBox tone="success" title="Saved">Notification settings updated.</MessageBox>}

            <div className="mail-actions">
              <Button variant="primary" type="submit" disabled={saving || locked}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}
