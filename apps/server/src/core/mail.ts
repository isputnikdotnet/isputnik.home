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
}

const EMPTY: MailSettings = {
  host: "",
  port: 587,
  secure: false,
  username: "",
  password: "",
  fromAddress: "",
  fromName: ""
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
