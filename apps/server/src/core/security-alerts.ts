import type { FastifyRequest } from "fastify";
import { db, logActivity, type MfaMethod, type User } from "../db.js";
import { isMailConfigured, sendMail } from "./mail.js";
import { renderEmail, type EmailBlock } from "./email-template.js";
import {
  getSecurityPolicy,
  isTrustedIp,
  maybeAutoBlockIp,
  noteSignInNetwork,
  recordAbuseAttempt,
  recentMfaFailureCount,
  MFA_FAILURE_ALERT_THRESHOLD,
  MFA_FAILURE_WINDOW_MINUTES,
  type AutoBlockOutcome
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

// The where-and-when every alert carries. A table rather than two sentences: an
// IP address and a timestamp are reference data, read by eye and compared against
// something else, and prose is the wrong shape for that.
function context(ip: string | null | undefined, ...extra: { label: string; value: string }[]): EmailBlock {
  return {
    kind: "facts",
    rows: [...extra, { label: "Source IP", value: ip ?? "unknown" }, { label: "When", value: stamp() }]
  };
}

/** A bare string is a paragraph; anything richer says so. */
type AlertPart = string | EmailBlock;

async function notify(recipients: string[], subject: string, parts: AlertPart[]): Promise<void> {
  if (!isMailConfigured() || recipients.length === 0) return;
  const { html, text } = renderEmail({
    title: subject,
    blocks: parts
      .filter((part) => typeof part !== "string" || part.trim() !== "")
      .map((part) => (typeof part === "string" ? { kind: "text", text: part } as EmailBlock : part)),
    footnote: "Automated security alert from your iSputnik server."
  });
  try {
    await sendMail({ to: recipients.join(", "), subject: `[iSputnik security] ${subject}`, text, html });
  } catch {
    // Best-effort: swallow delivery errors.
  }
}

async function notifyAdmins(subject: string, parts: AlertPart[]): Promise<void> {
  await notify(adminEmails(), subject, parts);
}

// `hasAccount` is false when the address that crossed the threshold has no account
// behind it. That is worth saying rather than smoothing over: the lockout is keyed on
// what was typed, so a household member with a mistyped email locks out an address
// nobody can find in the user list, and the alert is the one place an admin would
// otherwise be told an "account" is under attack that does not exist.
export function alertAccountLocked(email: string, ip: string | null, hasAccount = true): void {
  const { lockoutMinutes } = getSecurityPolicy();
  if (throttled(`lock:${email.toLowerCase()}`, lockoutMinutes * 60_000)) return;
  if (!hasAccount) {
    void notifyAdmins("Repeated failed sign-ins for an address with no account", [
      context(ip, { label: "Address tried", value: email }),
      `No account uses this address, so nothing of yours is locked. Either someone is guessing, or a member of the household is typing their own email slightly wrong — compare it with their account under Control panel → Members → Users.`
    ]);
    return;
  }
  void notifyAdmins("An account was locked after repeated failed sign-ins", [
    context(ip, { label: "Account", value: email }),
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
export function flagAbusiveRequest(request: FastifyRequest, kind: "probe" | "token"): void {
  if (request.abuseFlagged) return;
  request.abuseFlagged = true;
  if (!request.ip || isTrustedIp(request.ip)) return;
  recordAbuseAttempt(request.ip, kind);
  const blocked = maybeAutoBlockIp(request.ip);
  if (blocked) alertIpAutoBlocked(request.ip, blocked);
}

// The middle sentence is the one that matters: an all-probes block is routine
// internet background noise, and saying so spares the admin the "who is trying
// my passwords?" scare — while a block with real sign-in attempts in it is
// exactly that scare, and earns the plain warning.
export function alertIpAutoBlocked(ip: string, outcome: AutoBlockOutcome): void {
  if (throttled(`autoblock:${ip}`, 30 * 60_000)) return;
  void notifyAdmins("A source IP was automatically blocked", [
    "It crossed the suspicious-request threshold and is blocked for a cooldown period.",
    context(ip, { label: "What was counted", value: outcome.description }),
    outcome.counts.signin === 0
      ? "No account password was tried — this was an automated scanner sweeping for software you don't run, the kind every internet-facing server sees. The block expires on its own; nothing else is needed."
      : "Some of these were real sign-in attempts against an account, so it is worth a look.",
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

  const device = String(request.headers["user-agent"] ?? "unknown device");
  const facts = (extra: { label: string; value: string }[] = []): EmailBlock => ({
    kind: "facts",
    rows: [
      ...extra,
      { label: "IP address", value: `${ip} (network ${seen.key})` },
      { label: "Device", value: device },
      { label: "When", value: stamp() }
    ]
  });

  void notify([user.email], "A sign-in from a new location", [
    `Someone signed in to your iSputnik account (${user.email}) from a network it has never been used from before.`,
    facts(),
    "If this was you — travelling, a new device, or a changed internet connection — nothing more is needed.",
    "If it wasn't, change your password now and turn on two-factor authentication in your profile."
  ]);

  void notify(adminEmailsExcept(user.email), "An account signed in from a new location", [
    facts([{ label: "Account", value: `${user.display_name} <${user.email}>` }]),
    "The account owner has been emailed as well. Review it in Control panel → Security."
  ]);
}

export function alertNewAdmin(newAdminEmail: string, createdBy: string): void {
  void notifyAdmins("A new administrator account was created", [
    {
      kind: "facts",
      rows: [
        { label: "New admin", value: newAdminEmail },
        { label: "Created via", value: createdBy },
        { label: "When", value: stamp() }
      ]
    },
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

  const facts = context(ip,
    { label: "Account", value: `${user.display_name} <${user.email}>` },
    { label: "Rejected codes", value: `${failures} in the last ${MFA_FAILURE_WINDOW_MINUTES} minutes` });

  void notify([user.email], "Someone has your password but not your second factor", [
    "Your iSputnik account has just refused several two-factor codes.",
    "Reaching the code step means the password was accepted — so whoever is trying knows it.",
    facts,
    user.mfa_method === "email"
      ? "If this was you mistyping a code, nothing is wrong."
      : "If this was you fumbling a code, or your authenticator's clock has drifted, nothing is wrong.",
    "If it wasn't, change your password now: the second factor is the only thing still holding."
  ]);

  void notify(adminEmailsExcept(user.email), "Repeated two-factor failures on an account", [
    "An account has refused several two-factor codes in a row. The password was accepted first,",
    "so the credential is likely known to someone other than the owner.",
    facts,
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
    context(ip),
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
    context(ip),
    "Any other devices you were signed in on have been signed out.",
    byAdmin
      ? "If you didn't ask for this, check with your server's administrator."
      : "If this wasn't you, whoever did it knows your old password — contact your server's administrator."
  ]);
}

// The mirror of alertMfaDisabled: an attacker enrolling their own authenticator
// locks the owner out just as effectively as switching two-factor off.
export function alertMfaEnabled(email: string, ip: string | null, method: MfaMethod = "totp"): void {
  if (throttled(`mfaon:${email.toLowerCase()}`, CHANGE_THROTTLE_MS)) return;
  void notify([email], "Two-factor authentication was turned on", [
    "Two-factor authentication is now on for your iSputnik account. Sign-ins will ask for a code",
    method === "email" ? "sent to this address." : "from the authenticator app that was just enrolled.",
    context(ip),
    method === "email"
      ? "If you didn't set this up, someone else knows your password — contact your server's administrator immediately."
      : "If you didn't set this up, the codes are going to someone else's device — contact your server's administrator immediately."
  ]);
}

export function alertMfaBackupCodesRegenerated(email: string, ip: string | null): void {
  if (throttled(`mfacodes:${email.toLowerCase()}`, CHANGE_THROTTLE_MS)) return;
  void notify([email], "Your two-factor backup codes were replaced", [
    "A new set of two-factor backup codes was generated for your iSputnik account.",
    "Any codes you saved or printed before now no longer work.",
    context(ip),
    "If you didn't do this, contact your server's administrator immediately."
  ]);
}

// ── Linked devices ───────────────────────────────────────────────────────────

// A linked display is a session that lives for a year in a room, minted without a
// password ever being typed on the device itself. The owner approved it, so this
// is not a warning — it is the receipt, and the one thing that catches an approval
// given to a code someone else was holding. Not throttled per account, because
// each link is a distinct device and a burst of them is exactly what should be
// noticed; the flow's own rate limits bound how many can arrive.
export function alertDeviceLinked(user: User, request: FastifyRequest, label: string): void {
  void notify([user.email], "A new device was linked to your account", [
    `"${label}" can now use your iSputnik account without signing in again.`,
    context(request.ip, { label: "Device", value: label }),
    "You approved this from a device you were already signed in on.",
    "Remove it any time from Profile → Devices, which is also where you can rename it.",
    "If you didn't approve this, revoke it there now and change your password."
  ]);
}

// A device was linked from OUTSIDE the house, during a window an admin opened.
// Goes to the admins rather than the owner — the owner already gets the receipt
// above, and this is the other half: they granted an exception, and should see it
// land rather than having to go looking in the log for whether it was used.
export function alertRemoteDeviceLinked(user: User, request: FastifyRequest, label: string): void {
  void notifyAdmins("A device was linked from outside the home network", [
    `${user.display_name} used the registration window you opened, and "${label}" is now signed in to their account.`,
    context(request.ip, { label: "Account", value: user.email }, { label: "Device", value: label }),
    "The window is now closed — another device would need a new one.",
    "They can remove the device themselves from Profile → Devices, and you can end its session from Control panel → Members → Sessions."
  ]);
}

// A device asked to be linked and the server refused before creating anything.
// Goes to admins, not the owner: nobody owns it yet, and both reasons are the
// admin's to act on — widen the policy deliberately, or fix TRUST_PROXY_HOPS.
export function alertDeviceLinkRejected(ip: string | null, reason: "scope" | "proxy"): void {
  if (throttled(`devlink:${reason}:${ip ?? "none"}`, 30 * 60_000)) return;
  void notifyAdmins("A device was refused permission to link", [
    reason === "proxy"
      ? "A device asked to be linked, and the server could not tell where it was asking from: a proxy is in front but TRUST_PROXY_HOPS is unset, so every request appears to come from the proxy's own address."
      : "A device outside your home network asked to be linked, and device linking is set to accept local devices only.",
    context(ip),
    reason === "proxy"
      ? "Set TRUST_PROXY_HOPS to the number of proxies in front (usually 1) and device linking will work again. Until then it refuses every request rather than treating the whole internet as local. See docs/users/exposing-to-the-internet.md."
      : "If this was you, linking from outside can be allowed in Control panel → Security → Policies. Read what it says there first: it is the setting that lets a stranger start a request and talk someone into approving it."
  ]);
}

export function alertMfaDisabled(targetEmail: string, byAdmin: boolean): void {
  void notifyAdmins("Two-factor authentication was turned off", [
    {
      kind: "facts",
      rows: [
        { label: "Account", value: targetEmail },
        { label: "Turned off by", value: byAdmin ? "An administrator" : "The account owner" },
        { label: "When", value: stamp() }
      ]
    },
    "If this was unexpected, secure the account."
  ]);
}
