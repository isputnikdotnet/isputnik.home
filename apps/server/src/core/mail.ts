import nodemailer from "nodemailer";
import { db } from "../db.js";

// Platform mail infrastructure: SMTP settings storage + a thin nodemailer wrapper.
// Lives in core because it carries no product knowledge — like logging/status. The
// product feature that emails a book ("Send to e-reader") lives in modules/library.
//
// Settings are stored as one JSON blob in app_settings under MAIL_SETTINGS_KEY. The
// password is part of that blob (plaintext at rest in the local SQLite, same box) and
// must never be returned to the browser — the routes strip it and expose `hasPassword`.

export const MAIL_SETTINGS_KEY = "mail_settings";

export interface MailSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  // Whether the server may email ordinary members about things that happened to
  // them (today: something was shared with them). Off leaves only the mail the
  // account owner asked for or must see — codes, security alerts, e-reader sends.
  userNotifications: boolean;
}

const EMPTY: MailSettings = {
  host: "",
  port: 587,
  secure: false,
  username: "",
  password: "",
  fromAddress: "",
  fromName: "",
  userNotifications: true
};

export function getMailSettings(): MailSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(MAIL_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(row.value) as Partial<MailSettings>) };
  } catch {
    return { ...EMPTY };
  }
}

// Enough to attempt delivery: a host to connect to and a from-address to send as.
export function isMailConfigured(settings: MailSettings = getMailSettings()): boolean {
  return Boolean(settings.host && settings.port && settings.fromAddress);
}

// The gate every member-facing notification checks: mail has to work AND the
// admin has to have left notifications on. Kept here so a feature that notifies
// asks one question rather than two, and so "off" is impossible to forget.
export function userNotificationsEnabled(settings: MailSettings = getMailSettings()): boolean {
  return settings.userNotifications && isMailConfigured(settings);
}

function createTransport(settings: MailSettings) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.username ? { user: settings.username, pass: settings.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000
  });
}

function fromHeader(settings: MailSettings): string {
  return settings.fromName ? `"${settings.fromName.replace(/"/g, "")}" <${settings.fromAddress}>` : settings.fromAddress;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const settings = getMailSettings();
  if (!isMailConfigured(settings)) throw new Error("Email is not configured.");
  await createTransport(settings).sendMail({
    from: fromHeader(settings),
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    attachments: mail.attachments
  });
}

export async function sendTestEmail(to: string): Promise<void> {
  await sendMail({
    to,
    subject: "iSputnik test email",
    text: "This is a test email from your iSputnik server. If you received it, your SMTP settings are working."
  });
}
