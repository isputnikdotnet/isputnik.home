import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity, nowIso, publicUser, type MfaMethod, type User } from "../db.js";
import { config } from "../config.js";
import { hostCookieName } from "./cookies.js";
import { verifyPassword } from "../crypto.js";
import { issueSession } from "../auth.js";
import { parseBody } from "./shared.js";
import { isMailConfigured, sendMail } from "./mail.js";
import { renderEmail } from "./email-template.js";
import {
  alertAccountLocked,
  alertIpAutoBlocked,
  alertMfaBackupCodesRegenerated,
  alertMfaDisabled,
  alertMfaEnabled,
  alertMfaFailures,
  reviewSignInLocation
} from "./security-alerts.js";
import { isAccountLocked, isTrustedRequest, maybeAutoBlockIp, recordLoginAttempt } from "./security.js";
import {
  encryptSecret,
  decryptSecret,
  generateTotpSecret,
  totpKeyUri,
  totpQrDataUrl,
  verifyTotp,
  isLegacyTotpSecret,
  generateBackupCodes,
  hashBackupCode,
  generateEmailCode,
  hashEmailCode,
  verifyEmailCode,
  maskEmail,
  EMAIL_CODE_MINUTES,
  EMAIL_CODE_MAX_SENDS,
  EMAIL_CODE_RESEND_SECONDS
} from "./mfa.js";

// Two-factor enrollment, management, and the login second-factor step, for both
// methods: a rolling TOTP code from an authenticator app, or a one-time code
// emailed at sign-in. A user picks one — `users.mfa_method` — and backup codes
// rescue either. Service functions are exported and unit-tested directly (see
// test/mfa-routes.test.ts); the plugin routes are thin wrappers that add
// password-gating, cookies, and logging — mirroring api-tokens.ts.

// __Host-prefixed on secure deployments (see core/cookies.ts). Short-lived, so a
// plain rename is enough — set and read use this one constant.
const MFA_COOKIE = hostCookieName("isputnik_mfa", config.cookieSecure);
const MFA_CHALLENGE_MINUTES = 5;
export const MFA_MAX_ATTEMPTS = 5;

// A challenge either completes a sign-in or confirms an email enrollment. Both
// want the same expiry / attempt cap / resend budget, so they share the table —
// one row per user per purpose.
export type ChallengePurpose = "login" | "enroll";

export interface MfaChallenge {
  id: string;
  user_id: string;
  purpose: ChallengePurpose;
  attempts: number;
  code_hash: string | null;
  sends: number;
  last_sent_at: string | null;
}

const CHALLENGE_COLUMNS = "id, user_id, purpose, attempts, code_hash, sends, last_sent_at";

export function getMfaMethod(userId: string): MfaMethod {
  const row = db.prepare("SELECT mfa_method FROM users WHERE id = ?").get(userId) as { mfa_method: MfaMethod } | undefined;
  return row?.mfa_method ?? "totp";
}

// How long a challenge lives. Email needs the slack: a TOTP code is already on
// the phone, a mailed one has to be delivered first.
function challengeMinutes(method: MfaMethod): number {
  return method === "email" ? EMAIL_CODE_MINUTES : MFA_CHALLENGE_MINUTES;
}

// ── Enrollment / management ──────────────────────────────────────────────────

export interface MfaStatus {
  enabled: boolean;
  method: MfaMethod;
  backupCodesRemaining: number;
}

export function getMfaStatus(userId: string): MfaStatus {
  const row = db.prepare("SELECT mfa_enabled, mfa_method, mfa_backup_codes FROM users WHERE id = ?").get(userId) as
    | { mfa_enabled: number; mfa_method: MfaMethod; mfa_backup_codes: string | null }
    | undefined;
  if (!row) return { enabled: false, method: "totp", backupCodesRemaining: 0 };
  const codes = row.mfa_backup_codes ? (JSON.parse(row.mfa_backup_codes) as string[]) : [];
  return { enabled: Boolean(row.mfa_enabled), method: row.mfa_method, backupCodesRemaining: codes.length };
}

export type MfaSetup =
  | { method: "totp"; secret: string; otpauthUri: string }
  | { method: "email"; email: string; code: string };

// Stash the pending configuration for the chosen method without switching MFA on —
// it's only enabled once the user proves the factor reaches them (activateMfa).
// For TOTP that's an encrypted secret to scan; for email, a code mailed to the
// address they sign in with (the caller sends it — see the setup route).
export function beginMfaSetup(userId: string, method: MfaMethod = "totp"): MfaSetup {
  const user = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined;
  if (!user) throw new Error("User not found");

  if (method === "email") {
    // No shared secret for this method — clear any half-finished TOTP enrollment.
    db.prepare("UPDATE users SET mfa_method = 'email', mfa_secret = NULL WHERE id = ?").run(userId);
    const { code } = createMfaChallenge(userId, "enroll");
    // createMfaChallenge mints a code because the method is now 'email'.
    return { method: "email", email: user.email, code: code! };
  }

  db.prepare("DELETE FROM mfa_challenges WHERE user_id = ? AND purpose = 'enroll'").run(userId);
  const secret = generateTotpSecret();
  db.prepare("UPDATE users SET mfa_method = 'totp', mfa_secret = ? WHERE id = ?").run(encryptSecret(secret), userId);
  return { method: "totp", secret, otpauthUri: totpKeyUri(secret, user.email) };
}

// Confirm a code against the pending enrollment; on success enable MFA and return
// the one-time backup codes (shown once). Returns null when there's nothing pending
// or the code doesn't match.
export function activateMfa(userId: string, token: string): string[] | null {
  const row = db.prepare("SELECT mfa_method, mfa_secret FROM users WHERE id = ?").get(userId) as
    | { mfa_method: MfaMethod; mfa_secret: string | null }
    | undefined;
  if (!row) return null;

  if (row.mfa_method === "email") {
    const challenge = resolveEnrollChallenge(userId);
    if (!challenge?.code_hash) return null;
    if (!verifyEmailCode(challenge.code_hash, token)) {
      failMfaChallenge(challenge.id);
      return null;
    }
    clearMfaChallenge(challenge.id);
  } else {
    if (!row.mfa_secret) return null;
    let secret: string;
    try {
      secret = decryptSecret(row.mfa_secret);
    } catch {
      return null;
    }
    if (!verifyTotp(secret, token)) return null;
  }

  const { plain, hashes } = generateBackupCodes();
  db.prepare("UPDATE users SET mfa_enabled = 1, mfa_backup_codes = ? WHERE id = ?").run(JSON.stringify(hashes), userId);
  return plain;
}

export function regenerateBackupCodes(userId: string): string[] {
  const { plain, hashes } = generateBackupCodes();
  db.prepare("UPDATE users SET mfa_backup_codes = ? WHERE id = ?").run(JSON.stringify(hashes), userId);
  return plain;
}

// Consume a backup code single-use: remove its hash from the stored set on a match.
export function consumeBackupCode(userId: string, code: string): boolean {
  const row = db.prepare("SELECT mfa_backup_codes FROM users WHERE id = ?").get(userId) as { mfa_backup_codes: string | null } | undefined;
  if (!row?.mfa_backup_codes) return false;
  const hashes = JSON.parse(row.mfa_backup_codes) as string[];
  const index = hashes.indexOf(hashBackupCode(code));
  if (index === -1) return false;
  hashes.splice(index, 1);
  db.prepare("UPDATE users SET mfa_backup_codes = ? WHERE id = ?").run(JSON.stringify(hashes), userId);
  return true;
}

// Full teardown: clears the flag, method, secret, backup codes, and any pending
// challenge. Used by self-service disable and by an admin rescuing a locked-out
// account — the next enrollment starts from a clean slate, method included.
export function resetMfa(userId: string): void {
  db.prepare(
    "UPDATE users SET mfa_enabled = 0, mfa_method = 'totp', mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?"
  ).run(userId);
  db.prepare("DELETE FROM mfa_challenges WHERE user_id = ?").run(userId);
}

// ── Challenges ───────────────────────────────────────────────────────────────

// Opens a challenge for the user's chosen method. Returns the plaintext code to
// mail when that method is email (it is stored only as a hash) and null for TOTP,
// where the factor is the user's own secret and nothing needs sending.
// `methodOverride` exists for the outside-MFA policy: an account that never
// enrolled still gets an emailed code, whatever its stored (default) method says.
// The challenge row itself then carries the truth — a code_hash marks an email
// challenge — so verify and resend read the row, not the enrollment.
export function createMfaChallenge(
  userId: string,
  purpose: ChallengePurpose = "login",
  methodOverride?: MfaMethod
): { id: string; code: string | null } {
  const method = methodOverride ?? getMfaMethod(userId);
  const id = nanoid(24);
  const expiresAt = new Date(Date.now() + challengeMinutes(method) * 60_000).toISOString();
  const code = method === "email" ? generateEmailCode() : null;
  // One pending challenge per user per purpose — supersede any earlier one.
  db.prepare("DELETE FROM mfa_challenges WHERE user_id = ? AND purpose = ?").run(userId, purpose);
  db.prepare(
    "INSERT INTO mfa_challenges (id, user_id, purpose, expires_at, code_hash, sends, last_sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, userId, purpose, expiresAt, code ? hashEmailCode(code) : null, code ? 1 : 0, code ? nowIso() : null);
  return { id, code };
}

export function resolveMfaChallenge(id: string, purpose: ChallengePurpose = "login"): MfaChallenge | null {
  const row = db
    .prepare(
      `SELECT ${CHALLENGE_COLUMNS} FROM mfa_challenges
       WHERE id = ? AND purpose = ? AND datetime(expires_at) > datetime('now')`
    )
    .get(id, purpose) as MfaChallenge | undefined;
  return row ?? null;
}

// The enrollment challenge is never handed to the browser — it's looked up from
// the authenticated user instead of a cookie.
export function resolveEnrollChallenge(userId: string): MfaChallenge | null {
  const row = db
    .prepare(
      `SELECT ${CHALLENGE_COLUMNS} FROM mfa_challenges
       WHERE user_id = ? AND purpose = 'enroll' AND datetime(expires_at) > datetime('now')`
    )
    .get(userId) as MfaChallenge | undefined;
  return row ?? null;
}

export type ResendOutcome =
  | { ok: true; code: string }
  | { ok: false; reason: "cooldown" | "limit" };

// Mint a replacement code for a live email challenge when the first didn't arrive.
// Bounded two ways: a cooldown between sends and a per-challenge budget, so a
// caller holding the password can't turn the sign-in screen into an inbox flood.
// The challenge's own expiry is NOT extended — a resend buys a code, not more time.
export function rotateEmailCode(challengeId: string): ResendOutcome {
  const challenge = resolveMfaChallenge(challengeId);
  if (!challenge) return { ok: false, reason: "limit" };
  if (challenge.sends >= EMAIL_CODE_MAX_SENDS) return { ok: false, reason: "limit" };
  const since = challenge.last_sent_at ? Date.now() - Date.parse(challenge.last_sent_at) : Infinity;
  if (since < EMAIL_CODE_RESEND_SECONDS * 1000) return { ok: false, reason: "cooldown" };

  const code = generateEmailCode();
  db.prepare("UPDATE mfa_challenges SET code_hash = ?, sends = sends + 1, last_sent_at = ? WHERE id = ?").run(
    hashEmailCode(code),
    nowIso(),
    challengeId
  );
  return { ok: true, code };
}

// Record a failed code; once the cap is hit the challenge is destroyed so the user
// must re-enter their password. Returns the new attempt count.
export function failMfaChallenge(id: string): number {
  db.prepare("UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = ?").run(id);
  const row = db.prepare("SELECT attempts FROM mfa_challenges WHERE id = ?").get(id) as { attempts: number } | undefined;
  const attempts = row?.attempts ?? MFA_MAX_ATTEMPTS;
  if (attempts >= MFA_MAX_ATTEMPTS) {
    db.prepare("DELETE FROM mfa_challenges WHERE id = ?").run(id);
  }
  return attempts;
}

export function clearMfaChallenge(id: string): void {
  db.prepare("DELETE FROM mfa_challenges WHERE id = ?").run(id);
}

export function setMfaChallengeCookie(reply: FastifyReply, challengeId: string, method: MfaMethod = "totp"): void {
  reply.setCookie(MFA_COOKIE, challengeId, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: challengeMinutes(method) * 60
  });
}

export function clearMfaChallengeCookie(reply: FastifyReply): void {
  reply.clearCookie(MFA_COOKIE, { path: "/" });
}

// ── Delivering a code ────────────────────────────────────────────────────────

// Sign-in codes are not security alerts, so they don't go through the throttled
// fire-and-forget helpers in security-alerts.ts — a code the user is waiting for
// must either be sent or reported as failed.
export async function sendMfaCodeEmail(to: string, code: string, purpose: ChallengePurpose): Promise<void> {
  const { html, text } = renderEmail({
    title: purpose === "enroll" ? "Finish turning on two-factor authentication" : "Your sign-in code",
    // The code leads the preview line as well as the subject: on a phone, the
    // notification is often the only place it needs to be read.
    preheader: `${code} — expires in ${EMAIL_CODE_MINUTES} minutes.`,
    blocks: [
      {
        kind: "text",
        text: purpose === "enroll"
          ? "Enter this code to confirm this address and finish setting up two-factor authentication by email."
          : "Enter this code to finish signing in to iSputnik."
      },
      { kind: "code", code, caption: `Expires in ${EMAIL_CODE_MINUTES} minutes, and works once.` },
      {
        kind: "note",
        text: purpose === "enroll"
          ? "If you didn't set this up, someone else is in your account — change your password now and tell your server's administrator."
          : "If you didn't try to sign in, someone else knows your password — change it now and tell your server's administrator."
      }
    ],
    footnote: "Nobody at iSputnik will ever ask you for this code."
  });
  await sendMail({ to, subject: `${code} is your iSputnik code`, text, html });
}

// ── Routes ───────────────────────────────────────────────────────────────────

const passwordGateSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  method: z.enum(["totp", "email"]).optional()
});
const codeSchema = z.object({ token: z.string().trim().min(6).max(40) });
// Password plus an optional current second factor, for the destructive
// MFA-management actions (disable, regenerate backup codes). The code is required
// only while MFA is on — enforced in the handler, not the schema, so a first-time
// (MFA-off) caller never has to supply one.
const passwordAndCodeSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  code: z.string().trim().min(6).max(40).optional()
});

// Verify a currently-valid second factor for an already-authenticated user: their
// authenticator code if they use TOTP, or a single-use backup code (which email-
// method users rely on here — there's no live email challenge to check against on
// a self-service management action, and an admin MFA reset is the recovery path if
// the codes are lost). Only tries a backup code if TOTP didn't match, so a valid
// app code never burns one. This is what stops a stolen password plus a live
// session from being enough to strip the second factor.
export function verifyCurrentSecondFactor(user: User, code: string): boolean {
  let ok = false;
  if (user.mfa_secret) {
    try {
      ok = verifyTotp(decryptSecret(user.mfa_secret), code);
    } catch {
      ok = false;
    }
  }
  if (!ok) ok = consumeBackupCode(user.id, code);
  return ok;
}

export const SECOND_FACTOR_REQUIRED = "Enter a code from your authenticator app or one of your backup codes.";
export const SECOND_FACTOR_WRONG = "That code didn't match. Enter a current authenticator code or a backup code.";

// An enrollment predating 3.10.3 holds an 80-bit secret, short of the 128-bit
// minimum RFC 4226 sets and the current library enforces, so its codes can no
// longer be checked at all. Say that plainly instead of "wrong code" — the app is
// rejecting every code it will ever be shown. Worded to fit both places it can
// surface: signing in, and confirming a sensitive change once already signed in.
// A backup code still works in both, because it never involved the secret.
export const TOTP_SECRET_OUTDATED =
  "Your authenticator setup predates this version's security requirements, so its codes can no longer be accepted. Enter one of your backup codes instead, then turn two-factor off and set it up again to get a fresh QR code.";

/** True when this account's TOTP enrollment is the unverifiable pre-3.10.3 kind. */
export function hasOutdatedTotpEnrollment(user: Pick<User, "mfa_method" | "mfa_secret">): boolean {
  if (user.mfa_method !== "totp" || !user.mfa_secret) return false;
  try {
    return isLegacyTotpSecret(decryptSecret(user.mfa_secret));
  } catch {
    // Undecryptable (a restored backup without its key) is a different problem
    // with its own message; don't mislabel it as an outdated secret.
    return false;
  }
}

/** "Wrong code" is misleading when no code could ever be right — say which it is. */
export function secondFactorWrongMessage(user: Pick<User, "mfa_method" | "mfa_secret">): string {
  return hasOutdatedTotpEnrollment(user) ? TOTP_SECRET_OUTDATED : SECOND_FACTOR_WRONG;
}

// A wrong second factor on a management action (disable, regenerate codes, change
// email) is recorded like a failed sign-in — so it feeds account lockout, which is
// IP-independent and ENFORCED by secondFactorThrottled below (closing the
// multi-source-IP guess a per-IP rate limit alone can't) — and logged, so the
// channel is audited. Trusted networks are exempt from the lockout/auto-block
// (only audited), matching the login and MFA-verify failure paths.
export function recordSecondFactorFailure(request: FastifyRequest, user: User): void {
  logActivity({
    event: "auth.second_factor_failed",
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    detail: "A two-factor–protected account change was refused: wrong code.",
    ipAddress: request.ip
  });
  if (isTrustedRequest(request)) return;
  recordLoginAttempt(user.email, request.ip, false);
  maybeAutoBlockIp(request.ip);
}

// The account-level lock the failures feed, enforced on the management routes so a
// guesser spreading attempts across many IPs is stopped account-wide, not just
// per-IP. Trusted networks skip it (they never accumulate failures above).
export function secondFactorThrottled(request: FastifyRequest, user: User): boolean {
  return !isTrustedRequest(request) && isAccountLocked(user.email);
}

// Clear the failure tally after a legitimate second-factor-gated action, so an
// ordinary typo or two on the way doesn't strand the account's future sign-ins.
export function clearSecondFactorTally(request: FastifyRequest, user: User): void {
  recordLoginAttempt(user.email, request.ip, true);
}

// Shared rate limit for the second-factor-gated management routes.
export const MFA_MANAGE_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
const SECOND_FACTOR_LOCKED = "Too many attempts. Wait a few minutes and try again.";

export async function mfaRoutes(app: FastifyInstance) {
  app.get("/api/profile/mfa", { preHandler: app.authenticate }, async (request) => ({
    ...getMfaStatus(request.user!.id),
    // The email method is only offerable when the server can actually send mail.
    emailAvailable: isMailConfigured(),
    emailAddress: maskEmail(request.user!.email)
  }));

  // Step 1 of enrollment: prove the password, then either get a secret + QR to
  // scan (TOTP) or receive a code in the inbox (email).
  app.post("/api/profile/mfa/setup", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(passwordGateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Enter your current password", details: parsed.error });
    }
    const user = request.user!;
    const method = parsed.data.method ?? "totp";
    if (user.mfa_enabled) {
      return reply.code(409).send({ error: "Two-factor authentication is already on. Turn it off first to re-enroll." });
    }
    if (method === "email" && !isMailConfigured()) {
      return reply.code(409).send({ error: "This server can't send email yet. An administrator has to set up email first." });
    }
    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      return reply.code(403).send({ error: "Your current password is incorrect." });
    }

    const setup = beginMfaSetup(user.id, method);
    if (setup.method === "email") {
      try {
        await sendMfaCodeEmail(setup.email, setup.code, "enroll");
      } catch {
        // Nothing is enabled yet, so a delivery failure just ends the attempt —
        // but don't leave a pending email enrollment the user can't complete.
        resetMfa(user.id);
        return reply.code(502).send({ error: "We couldn't send the code. Check the email settings and try again." });
      }
      return reply.send({ method: "email", sentTo: maskEmail(setup.email), expiresInMinutes: EMAIL_CODE_MINUTES });
    }

    const qrDataUrl = await totpQrDataUrl(setup.secret, user.email);
    return reply.send({ method: "totp", secret: setup.secret, otpauthUri: setup.otpauthUri, qrDataUrl });
  });

  // Step 2 of enrollment: confirm a code, switch MFA on, reveal backup codes once.
  app.post("/api/profile/mfa/enable", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(codeSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Enter the 6-digit code", details: parsed.error });
    }
    const method = getMfaMethod(request.user!.id);
    const codes = activateMfa(request.user!.id, parsed.data.token);
    if (!codes) {
      return reply.code(400).send({
        error:
          method === "email"
            ? "That code didn't match, or it expired. Start again to get a fresh one."
            : "That code didn't match. Make sure the clock is right, then enter a fresh code."
      });
    }
    alertMfaEnabled(request.user!.email, request.ip, method);
    logActivity({
      event: "profile.mfa_enabled",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail:
        method === "email"
          ? "Turned on two-factor authentication (codes by email)."
          : "Turned on two-factor authentication (authenticator app).",
      ipAddress: request.ip
    });
    return reply.send({ backupCodes: codes });
  });

  app.post("/api/profile/mfa/disable", { preHandler: app.authenticate, ...MFA_MANAGE_RATE_LIMIT }, async (request, reply) => {
    const parsed = parseBody(passwordAndCodeSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Enter your current password", details: parsed.error });
    }
    const user = request.user!;
    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      return reply.code(403).send({ error: "Your current password is incorrect." });
    }
    // Turning two-factor off is exactly what a thief with the password wants; make
    // them prove a second factor too, so a stolen password plus a live session
    // isn't enough. `needsSecondFactor` lets the UI show the code field.
    if (user.mfa_enabled) {
      if (secondFactorThrottled(request, user)) {
        return reply.code(429).send({ error: SECOND_FACTOR_LOCKED });
      }
      const code = parsed.data.code ?? "";
      if (!code) {
        return reply.code(400).send({ error: SECOND_FACTOR_REQUIRED, needsSecondFactor: true });
      }
      if (!verifyCurrentSecondFactor(user, code)) {
        recordSecondFactorFailure(request, user);
        return reply.code(403).send({ error: secondFactorWrongMessage(user) });
      }
      clearSecondFactorTally(request, user);
    }
    resetMfa(user.id);
    alertMfaDisabled(user.email, false);
    logActivity({
      event: "profile.mfa_disabled",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Turned off two-factor authentication.",
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  app.post("/api/profile/mfa/backup-codes", { preHandler: app.authenticate, ...MFA_MANAGE_RATE_LIMIT }, async (request, reply) => {
    const parsed = parseBody(passwordAndCodeSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Enter your current password", details: parsed.error });
    }
    const user = request.user!;
    if (!user.mfa_enabled) {
      return reply.code(409).send({ error: "Two-factor authentication isn't on." });
    }
    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      return reply.code(403).send({ error: "Your current password is incorrect." });
    }
    // A second factor is required here too, not just on disable: otherwise a
    // password-only attacker could mint fresh backup codes and use one to strip
    // MFA, sidestepping the disable gate above.
    if (secondFactorThrottled(request, user)) {
      return reply.code(429).send({ error: SECOND_FACTOR_LOCKED });
    }
    const code = parsed.data.code ?? "";
    if (!code) {
      return reply.code(400).send({ error: SECOND_FACTOR_REQUIRED, needsSecondFactor: true });
    }
    if (!verifyCurrentSecondFactor(user, code)) {
      recordSecondFactorFailure(request, user);
      return reply.code(403).send({ error: secondFactorWrongMessage(user) });
    }
    clearSecondFactorTally(request, user);
    const codes = regenerateBackupCodes(user.id);
    alertMfaBackupCodesRegenerated(request.user!.email, request.ip);
    logActivity({
      event: "profile.mfa_backup_regenerated",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Regenerated two-factor backup codes.",
      ipAddress: request.ip
    });
    return reply.send({ backupCodes: codes });
  });

  // Email method only: send a replacement code when the first didn't arrive.
  // Answers identically whatever the pending challenge is — it is reachable
  // without a session, so it must not report whose sign-in is in progress.
  app.post(
    "/api/auth/mfa/resend",
    { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const challengeId = request.cookies[MFA_COOKIE];
      const challenge = challengeId ? resolveMfaChallenge(challengeId) : null;
      if (!challenge) {
        clearMfaChallengeCookie(reply);
        return reply.code(401).send({ error: "Your sign-in expired. Enter your password again." });
      }

      const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1").get(
        challenge.user_id
      ) as User | undefined;
      // An email challenge is recognised by its own code_hash, not the account's
      // enrollment — the outside-MFA fallback mails codes to accounts that never
      // enrolled, and those must be resendable like any other.
      if (!user || !challenge.code_hash) {
        return reply.code(409).send({ error: "This sign-in doesn't use emailed codes." });
      }

      const outcome = rotateEmailCode(challenge.id);
      if (!outcome.ok) {
        return reply.code(429).send({
          error:
            outcome.reason === "cooldown"
              ? `Wait ${EMAIL_CODE_RESEND_SECONDS} seconds before asking for another code.`
              : "No more codes for this sign-in. Enter your password again to start over."
        });
      }

      try {
        await sendMfaCodeEmail(user.email, outcome.code, "login");
      } catch {
        return reply.code(502).send({ error: "We couldn't send the code. Use a backup code, or ask your administrator." });
      }
      logActivity({
        event: "auth.mfa_code_resent",
        targetType: "user",
        targetId: user.id,
        detail: "Resent a two-factor code by email.",
        ipAddress: request.ip
      });
      return reply.send({ sentTo: maskEmail(user.email) });
    }
  );

  // Login step 2: complete the pending challenge with a code (from the app or the
  // email, per the account's method) or a backup code.
  app.post(
    "/api/auth/mfa/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const challengeId = request.cookies[MFA_COOKIE];
      if (!challengeId) {
        return reply.code(401).send({ error: "No sign-in is in progress. Start again." });
      }
      const challenge = resolveMfaChallenge(challengeId);
      if (!challenge) {
        clearMfaChallengeCookie(reply);
        return reply.code(401).send({ error: "Your sign-in expired. Enter your password again." });
      }

      const parsed = parseBody(codeSchema, request.body);
      if (parsed.error) {
        return reply.code(400).send({ error: "Enter your 6-digit code or a backup code", details: parsed.error });
      }

      const user = db
        .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1")
        .get(challenge.user_id) as User | undefined;
      // Which factor to check is the challenge's own shape: a code_hash marks an
      // email challenge — enrolled email accounts and the outside-MFA fallback
      // alike (the fallback's account has mfa_enabled = 0, so the enrollment
      // can't be the gate). A TOTP challenge still needs the enrollment intact.
      const viaEmailCode = Boolean(challenge.code_hash);
      const ready = viaEmailCode || Boolean(user?.mfa_enabled && user?.mfa_secret);
      if (!user || !ready) {
        clearMfaChallenge(challengeId);
        clearMfaChallengeCookie(reply);
        return reply.code(401).send({ error: "Enter your password again." });
      }

      let ok = false;
      try {
        ok = viaEmailCode
          ? verifyEmailCode(challenge.code_hash!, parsed.data.token)
          : verifyTotp(decryptSecret(user.mfa_secret!), parsed.data.token);
      } catch {
        ok = false;
      }
      // Either method falls back to a backup code — that's what they're for.
      if (!ok) ok = consumeBackupCode(user.id, parsed.data.token);

      const trusted = isTrustedRequest(request);

      // A pre-3.10.3 enrollment can't be verified at all, so every code it is
      // shown fails. Worth naming once the code has actually been rejected —
      // a valid backup code above still signs them in without ever seeing this.
      const outdatedTotp = !viaEmailCode && hasOutdatedTotpEnrollment(user);

      if (!ok) {
        const attempts = failMfaChallenge(challengeId);
        logActivity({
          event: "auth.mfa_failed",
          targetType: "user",
          targetId: user.id,
          detail: outdatedTotp
            ? "A two-factor code was rejected: this enrollment predates 3.10.3 and can no longer be verified. The account has to re-enroll."
            : "A two-factor code was rejected.",
          ipAddress: request.ip
        });
        // After the log write, so this failure counts toward the tally.
        alertMfaFailures(user, request.ip);
        // A rejected code is a failed sign-in like any other: it feeds the account
        // lockout and the per-IP auto-block. Without this an attacker holding a
        // working password could keep guessing codes indefinitely — the per-
        // challenge cap is no limit when re-entering the password mints a new one.
        recordLoginAttempt(user.email, request.ip, false);
        if (!trusted) {
          const blocked = maybeAutoBlockIp(request.ip);
          if (blocked) alertIpAutoBlocked(request.ip, blocked);
          if (isAccountLocked(user.email)) {
            // The live challenge would otherwise still be good for its remaining
            // attempts, letting the guessing continue past the lock.
            alertAccountLocked(user.email, request.ip);
            clearMfaChallenge(challengeId);
            clearMfaChallengeCookie(reply);
            return reply.code(429).send({ error: "Too many failed attempts. Please try again in a few minutes." });
          }
        }
        if (attempts >= MFA_MAX_ATTEMPTS) {
          clearMfaChallengeCookie(reply);
          return reply.code(401).send({ error: "Too many attempts. Enter your password again." });
        }
        return reply.code(401).send({ error: outdatedTotp ? TOTP_SECRET_OUTDATED : "Invalid code" });
      }

      clearMfaChallenge(challengeId);
      clearMfaChallengeCookie(reply);
      // The sign-in is complete: clear the failure tally the same way a successful
      // password does (accountFailureCount only counts failures after a success).
      recordLoginAttempt(user.email, request.ip, true);
      issueSession(reply, user.id, request);
      reviewSignInLocation(user, request);
      logActivity({
        event: "auth.mfa_verified",
        actorUserId: user.id,
        targetType: "user",
        targetId: user.id,
        detail: "Completed two-factor sign-in.",
        ipAddress: request.ip
      });
      return reply.send({ user: publicUser(user) });
    }
  );
}
