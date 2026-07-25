import type { FastifyRequest } from "fastify";
import { db, logActivity, type User } from "../db.js";
import { isMailConfigured, sendMail } from "./mail.js";
import {
  getSecurityPolicy,
  isTrustedIp,
  maybeAutoBlockIp,
  noteSignInNetwork,
  recordAbuseAttempt,
  recentMfaFailureCount,
  MFA_FAILURE_ALERT_THRESHOLD,
  MFA_FAILURE_WINDOW_MINUTES
} from "./security.js";

// Best-effort email alerts on suspicious activity — to admins, and for a sign-in
// from a new network to the account owner too. Every entry point is
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

// Admins minus the account the alert is about, so an admin acting on their own
// account doesn't receive both halves of a two-audience alert.
function adminEmailsExcept(email: string): string[] {
  return adminEmails().filter((address) => address.toLowerCase() !== email.toLowerCase());
}

function stamp(): string {
  return `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function context(ip: string | null | undefined): string[] {
  return [`Source IP: ${ip ?? "unknown"}`, `When: ${stamp()}`];
}

async function notify(recipients: string[], subject: string, lines: string[]): Promise<void> {
  if (!isMailConfigured() || recipients.length === 0) return;
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

async function notifyAdmins(subject: string, lines: string[]): Promise<void> {
  await notify(adminEmails(), subject, lines);
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

declare module "fastify" {
  interface FastifyRequest {
    // Set once flagAbusiveRequest has counted this request, so a route that
    // resolves the same bad token twice can't count it twice.
    abuseFlagged?: boolean;
  }
}

// Count a request that can only be a scan or a guess against its source IP, and
// auto-block once it crosses the same threshold failed sign-ins use. This is what
// extends the block from the login route to the rest of the surface: probe paths
// and tokens that match nothing. Trusted networks are never counted or blocked.
export function flagAbusiveRequest(request: FastifyRequest): void {
  if (request.abuseFlagged) return;
  request.abuseFlagged = true;
  if (!request.ip || isTrustedIp(request.ip)) return;
  recordAbuseAttempt(request.ip);
  if (maybeAutoBlockIp(request.ip)) alertIpAutoBlocked(request.ip);
}

export function alertIpAutoBlocked(ip: string): void {
  if (throttled(`autoblock:${ip}`, 30 * 60_000)) return;
  void notifyAdmins("A source IP was automatically blocked", [
    `IP address: ${ip}`,
    "It crossed the failed-sign-in threshold and is blocked for a cooldown period.",
    "Review it in Control panel → Security."
  ]);
}

// Called at every completed sign-in. Records the source network (always, so the
// history stays warm even while the alert is off), logs a first-sight from an
// untrusted network, and — when the admin has opted in — emails the account owner
// and the admins. Trusted networks are recorded but never alerted on.
export function reviewSignInLocation(user: User, request: FastifyRequest): void {
  const ip = request.ip;
  const seen = noteSignInNetwork(user.id, ip);
  if (!seen || !seen.isNew || isTrustedIp(ip)) return;

  logActivity({
    event: "auth.new_network",
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    detail: `First sign-in from network ${seen.key}.`,
    ipAddress: ip
  });

  if (!getSecurityPolicy().alertNewIpSignIn) return;
  if (throttled(`newnet:${user.id}:${seen.key}`, 12 * 60 * 60_000)) return;

  const device = request.headers["user-agent"] ?? "unknown device";
  const facts = [`IP address: ${ip} (network ${seen.key})`, `Device: ${device}`, `When: ${stamp()}`];

  void notify([user.email], "A sign-in from a new location", [
    `Someone signed in to your iSputnik account (${user.email}) from a network it has never been used from before.`,
    "",
    ...facts,
    "",
    "If this was you — travelling, a new device, or a changed internet connection — nothing more is needed.",
    "If it wasn't, change your password now and turn on two-factor authentication in your profile."
  ]);

  void notify(adminEmailsExcept(user.email), "An account signed in from a new location", [
    `Account: ${user.display_name} <${user.email}>`,
    ...facts,
    "",
    "The account owner has been emailed as well. Review it in Control panel → Security."
  ]);
}

export function alertNewAdmin(newAdminEmail: string, createdBy: string): void {
  void notifyAdmins("A new administrator account was created", [
    `New admin: ${newAdminEmail}`,
    `Created via: ${createdBy}`,
    "If you didn't expect this, review your accounts immediately."
  ]);
}

// Raised after a second factor is rejected. Call it once the failure has been
// written to the activity log — the count includes the failure that triggered it.
// Goes to the owner and the admins: the password behind these attempts is known
// to someone, so the owner should change it and the admins should watch the IP.
export function alertMfaFailures(user: User, ip: string | null): void {
  const failures = recentMfaFailureCount(user.id);
  if (failures < MFA_FAILURE_ALERT_THRESHOLD) return;
  if (throttled(`mfafail:${user.id}`, MFA_FAILURE_WINDOW_MINUTES * 60_000)) return;

  const facts = [
    `Account: ${user.display_name} <${user.email}>`,
    `Rejected codes: ${failures} in the last ${MFA_FAILURE_WINDOW_MINUTES} minutes`,
    ...context(ip)
  ];

  void notify([user.email], "Someone has your password but not your phone", [
    "Your iSputnik account has just refused several two-factor codes.",
    "",
    "Reaching the code step means the password was accepted — so whoever is trying knows it.",
    "",
    ...facts,
    "",
    "If this was you fumbling a code, or your authenticator's clock has drifted, nothing is wrong.",
    "If it wasn't, change your password now: the second factor is the only thing still holding."
  ]);

  void notify(adminEmailsExcept(user.email), "Repeated two-factor failures on an account", [
    "An account has refused several two-factor codes in a row. The password was accepted first,",
    "so the credential is likely known to someone other than the owner.",
    "",
    ...facts,
    "",
    "The owner has been emailed. Consider blocking the source IP in Control panel → Security."
  ]);
}

// ── Account-security changes ─────────────────────────────────────────────────
//
// The four moves an attacker makes right after getting into an account: take over
// the address that receives password resets, change the password, enrol their own
// second factor, or invalidate the owner's backup codes. Each is legitimate and
// routine when the owner does it, so these go to the owner — the one person who
// can say "that wasn't me". All are password-gated actions, so the light throttle
// is only a guard against a client looping, not against an outsider.

const CHANGE_THROTTLE_MS = 10 * 60_000;

// The account's login address is also its password-reset address, so a change
// here is the step that locks the real owner out. Mail both sides: the old
// address is the one that can still object, the new one confirms the switch.
export function alertEmailChanged(oldEmail: string, newEmail: string, ip: string | null): void {
  if (throttled(`email:${oldEmail.toLowerCase()}`, CHANGE_THROTTLE_MS)) return;
  void notify([oldEmail, newEmail], "The email address on your account was changed", [
    `The sign-in address for your iSputnik account was changed from ${oldEmail} to ${newEmail}.`,
    "",
    ...context(ip),
    "",
    "From now on, sign in with the new address.",
    "If you didn't make this change, contact your server's administrator immediately — whoever made it",
    "can now use it to take over the account."
  ]);
}

export function alertPasswordChanged(email: string, byAdmin: boolean, ip: string | null): void {
  if (throttled(`pw:${email.toLowerCase()}`, CHANGE_THROTTLE_MS)) return;
  void notify([email], "Your account password was changed", [
    byAdmin
      ? "An administrator set a new password on your iSputnik account."
      : "The password on your iSputnik account was changed.",
    "",
    ...context(ip),
    "",
    "Any other devices you were signed in on have been signed out.",
    byAdmin
      ? "If you didn't ask for this, check with your server's administrator."
      : "If this wasn't you, whoever did it knows your old password — contact your server's administrator."
  ]);
}

// The mirror of alertMfaDisabled: an attacker enrolling their own authenticator
// locks the owner out just as effectively as switching two-factor off.
export function alertMfaEnabled(email: string, ip: string | null): void {
  if (throttled(`mfaon:${email.toLowerCase()}`, CHANGE_THROTTLE_MS)) return;
  void notify([email], "Two-factor authentication was turned on", [
    "Two-factor authentication is now on for your iSputnik account. Sign-ins will ask for a code",
    "from the authenticator app that was just enrolled.",
    "",
    ...context(ip),
    "",
    "If you didn't set this up, the codes are going to someone else's device — contact your",
    "server's administrator immediately."
  ]);
}

export function alertMfaBackupCodesRegenerated(email: string, ip: string | null): void {
  if (throttled(`mfacodes:${email.toLowerCase()}`, CHANGE_THROTTLE_MS)) return;
  void notify([email], "Your two-factor backup codes were replaced", [
    "A new set of two-factor backup codes was generated for your iSputnik account.",
    "Any codes you saved or printed before now no longer work.",
    "",
    ...context(ip),
    "",
    "If you didn't do this, contact your server's administrator immediately."
  ]);
}

export function alertMfaDisabled(targetEmail: string, byAdmin: boolean): void {
  void notifyAdmins("Two-factor authentication was turned off", [
    `Account: ${targetEmail}`,
    byAdmin ? "Reset by an administrator." : "Turned off by the account owner.",
    "If this was unexpected, secure the account."
  ]);
}
