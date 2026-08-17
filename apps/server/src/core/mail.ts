import nodemailer from "nodemailer";
import { db } from "../db.js";
import { renderEmail } from "./email-template.js";
import { openSecret } from "./mfa.js";

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
    const parsed = { ...EMPTY, ...(JSON.parse(row.value) as Partial<MailSettings>) };
    // The password is sealed at rest (see mfa.sealSecret); un-seal it for use.
    // A legacy plaintext value passes through unchanged.
    return { ...parsed, password: openSecret(parsed.password) };
  } catch {
    return { ...EMPTY };
  }
}

// The raw (still-sealed) SMTP password straight from storage, without opening it.
// The "blank = keep" save path uses this so a transiently unreadable key doesn't
// wipe the stored password by re-sealing openSecret's empty result.
export function getStoredMailPasswordRaw(): string {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(MAIL_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return "";
  try {
    return (JSON.parse(row.value) as Partial<MailSettings>).password ?? "";
  } catch {
    return "";
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
  /** Always required: the alternative for text-only clients, and the fallback
   *  when a reader refuses HTML. Build both from core/email-template.ts rather
   *  than writing them separately, so they cannot say different things. */
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const settings = getMailSettings();
  if (!isMailConfigured(settings)) throw new Error("Email is not configured.");
  // Both parts go out as multipart/alternative; the client picks. Sending HTML
  // with no text part is what gets a message scored as spam.
  await createTransport(settings).sendMail({
    from: fromHeader(settings),
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: mail.attachments
  });
}

export async function sendTestEmail(to: string): Promise<void> {
  const { html, text } = renderEmail({
    title: "Your email settings work",
    preheader: "A test message from your iSputnik server.",
    blocks: [
      { kind: "text", text: "This is a test message from your iSputnik server. Receiving it means the SMTP settings you saved are correct and the server can send mail." },
      { kind: "note", text: "Nothing else was changed. You can close the Email settings page." }
    ]
  });
  await sendMail({ to, subject: "iSputnik test email", text, html });
}
