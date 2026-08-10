import { db } from "../db.js";
import { isMailConfigured } from "./mail.js";

// Which of the messages the app can send to ordinary members it is allowed to
// send. Stored apart from the SMTP settings on purpose: those say whether mail
// CAN go out, these say whether it SHOULD, and an admin who has a working relay
// for security alerts has not thereby agreed to mail the household about routine
// activity.
//
// Every flag defaults OFF. Notifications are the kind of thing that has to be
// asked for — an upgrade that quietly starts emailing five family members is a
// worse outcome than one where the admin has to find the switch.
//
// Each is gated on isMailConfigured() as well, so nothing here can be true in a
// way that matters until there is somewhere to send it. The Control panel greys
// the whole tab out in that state rather than letting someone set a flag that
// does nothing.

export const NOTIFICATION_SETTINGS_KEY = "notification_settings";

export interface NotificationSettings {
  /** Email the recipient when a photo, book or album is shared with their account. */
  shareNotifications: boolean;
}

const EMPTY: NotificationSettings = {
  shareNotifications: false
};

export function getNotificationSettings(): NotificationSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(NOTIFICATION_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(row.value) as Partial<NotificationSettings>) };
  } catch {
    return { ...EMPTY };
  }
}

export function setNotificationSettings(next: NotificationSettings, updatedBy: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(NOTIFICATION_SETTINGS_KEY, JSON.stringify(next), updatedBy);
}

/** The one question a notifying feature asks: switched on, and deliverable. */
export function shareNotificationsEnabled(): boolean {
  return getNotificationSettings().shareNotifications && isMailConfigured();
}
