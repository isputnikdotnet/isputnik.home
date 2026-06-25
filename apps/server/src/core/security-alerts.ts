import { db } from "../db.js";
import { isMailConfigured, sendMail } from "./mail.js";
import { getSecurityPolicy } from "./security.js";

// Best-effort email alerts to admins on suspicious activity. Every entry point is
// fire-and-forget (`void alert…()`): a mail failure or missing SMTP config must
// never affect the action that triggered it. Repeatable events are throttled so a
// burst can't flood inboxes.

const cooldowns = new Map<string, number>();

function throttled(key: string, windowMs: number): boolean {
  const now = Date.now();
  if (now - (cooldowns.get(key) ?? 0) < windowMs) return true;
  cooldowns.set(key, now);
  return false;
}

function adminEmails(): string[] {
  return (
    db
      .prepare("SELECT email FROM users WHERE role = 'admin' AND is_active = 1 AND deleted_at IS NULL")
      .all() as { email: string }[]
  ).map((row) => row.email);
}

async function notifyAdmins(subject: string, lines: string[]): Promise<void> {
  if (!isMailConfigured()) return;
  const recipients = adminEmails();
  if (recipients.length === 0) return;
  try {
    await sendMail({
      to: recipients.join(", "),
      subject: `[iSputnik security] ${subject}`,
      text: `${lines.join("\n")}\n\n— Automated security alert from your iSputnik server.`
    });
  } catch {
    // Best-effort: swallow delivery errors.
  }
}

export function alertAccountLocked(email: string, ip: string | null): void {
  const { lockoutMinutes } = getSecurityPolicy();
  if (throttled(`lock:${email.toLowerCase()}`, lockoutMinutes * 60_000)) return;
  void notifyAdmins("An account was locked after repeated failed sign-ins", [
    `Account: ${email}`,
    `Source IP: ${ip ?? "unknown"}`,
    `The account is locked for ${lockoutMinutes} minutes. If this wasn't the owner, their password may be under attack.`
  ]);
}

export function alertIpAutoBlocked(ip: string): void {
  if (throttled(`autoblock:${ip}`, 30 * 60_000)) return;
  void notifyAdmins("A source IP was automatically blocked", [
    `IP address: ${ip}`,
    "It crossed the failed-sign-in threshold and is blocked for a cooldown period.",
    "Review it in Control panel → Security."
  ]);
}

export function alertNewAdmin(newAdminEmail: string, createdBy: string): void {
  void notifyAdmins("A new administrator account was created", [
    `New admin: ${newAdminEmail}`,
    `Created via: ${createdBy}`,
    "If you didn't expect this, review your accounts immediately."
  ]);
}

export function alertMfaDisabled(targetEmail: string, byAdmin: boolean): void {
  void notifyAdmins("Two-factor authentication was turned off", [
    `Account: ${targetEmail}`,
    byAdmin ? "Reset by an administrator." : "Turned off by the account owner.",
    "If this was unexpected, secure the account."
  ]);
}
