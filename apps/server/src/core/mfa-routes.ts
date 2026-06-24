import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity, publicUser, type User } from "../db.js";
import { config } from "../config.js";
import { verifyPassword } from "../crypto.js";
import { issueSession } from "../auth.js";
import { parseBody } from "./shared.js";
import {
  encryptSecret,
  decryptSecret,
  generateTotpSecret,
  totpKeyUri,
  totpQrDataUrl,
  verifyTotp,
  generateBackupCodes,
  hashBackupCode
} from "./mfa.js";

// Two-factor (TOTP) enrollment, management, and the login second-factor step.
// Service functions are exported and unit-tested directly (see test/mfa-routes.test.ts);
// the plugin routes are thin wrappers that add password-gating, cookies, and logging —
// mirroring api-tokens.ts.

const MFA_COOKIE = "isputnik_mfa";
const MFA_CHALLENGE_MINUTES = 5;
export const MFA_MAX_ATTEMPTS = 5;

// ── Enrollment / management ──────────────────────────────────────────────────

export function getMfaStatus(userId: string): { enabled: boolean; backupCodesRemaining: number } {
  const row = db.prepare("SELECT mfa_enabled, mfa_backup_codes FROM users WHERE id = ?").get(userId) as
    | { mfa_enabled: number; mfa_backup_codes: string | null }
    | undefined;
  if (!row) return { enabled: false, backupCodesRemaining: 0 };
  const codes = row.mfa_backup_codes ? (JSON.parse(row.mfa_backup_codes) as string[]) : [];
  return { enabled: Boolean(row.mfa_enabled), backupCodesRemaining: codes.length };
}

// Generate a fresh secret and stash it encrypted but NOT yet enabled — the secret is
// only switched on once the user proves their authenticator works (activateMfa).
export function beginMfaSetup(userId: string): { secret: string; otpauthUri: string } {
  const user = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined;
  if (!user) throw new Error("User not found");
  const secret = generateTotpSecret();
  db.prepare("UPDATE users SET mfa_secret = ? WHERE id = ?").run(encryptSecret(secret), userId);
  return { secret, otpauthUri: totpKeyUri(secret, user.email) };
}

// Confirm a code against the pending secret; on success enable MFA and return the
// one-time backup codes (shown once). Returns null when there's no pending secret or
// the code doesn't match.
export function activateMfa(userId: string, token: string): string[] | null {
  const row = db.prepare("SELECT mfa_secret FROM users WHERE id = ?").get(userId) as { mfa_secret: string | null } | undefined;
  if (!row?.mfa_secret) return null;
  let secret: string;
  try {
    secret = decryptSecret(row.mfa_secret);
  } catch {
    return null;
  }
  if (!verifyTotp(secret, token)) return null;

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

// Full teardown: clears the flag, secret, backup codes, and any pending challenge.
// Used by self-service disable and by an admin rescuing a locked-out account.
export function resetMfa(userId: string): void {
  db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?").run(userId);
  db.prepare("DELETE FROM mfa_challenges WHERE user_id = ?").run(userId);
}

// ── Login challenge ──────────────────────────────────────────────────────────

export function createMfaChallenge(userId: string): string {
  const id = nanoid(24);
  const expiresAt = new Date(Date.now() + MFA_CHALLENGE_MINUTES * 60_000).toISOString();
  // One pending challenge per user — supersede any earlier one.
  db.prepare("DELETE FROM mfa_challenges WHERE user_id = ?").run(userId);
  db.prepare("INSERT INTO mfa_challenges (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, expiresAt);
  return id;
}

export function resolveMfaChallenge(id: string): { id: string; user_id: string; attempts: number } | null {
  const row = db
    .prepare("SELECT id, user_id, attempts FROM mfa_challenges WHERE id = ? AND datetime(expires_at) > datetime('now')")
    .get(id) as { id: string; user_id: string; attempts: number } | undefined;
  return row ?? null;
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

export function setMfaChallengeCookie(reply: FastifyReply, challengeId: string): void {
  reply.setCookie(MFA_COOKIE, challengeId, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: MFA_CHALLENGE_MINUTES * 60
  });
}

export function clearMfaChallengeCookie(reply: FastifyReply): void {
  reply.clearCookie(MFA_COOKIE, { path: "/" });
}

// ── Routes ───────────────────────────────────────────────────────────────────

const passwordGateSchema = z.object({ currentPassword: z.string().min(1, "Enter your current password").max(200) });
const codeSchema = z.object({ token: z.string().trim().min(6).max(40) });

export async function mfaRoutes(app: FastifyInstance) {
  app.get("/api/profile/mfa", { preHandler: app.authenticate }, async (request) => getMfaStatus(request.user!.id));

  // Step 1 of enrollment: prove the password, get a secret + QR to scan.
  app.post("/api/profile/mfa/setup", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(passwordGateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Enter your current password", details: parsed.error });
      return;
    }
    const user = request.user!;
    if (user.mfa_enabled) {
      reply.code(409).send({ error: "Two-factor authentication is already on. Turn it off first to re-enroll." });
      return;
    }
    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      reply.code(403).send({ error: "Your current password is incorrect." });
      return;
    }
    const { secret, otpauthUri } = beginMfaSetup(user.id);
    const qrDataUrl = await totpQrDataUrl(secret, user.email);
    reply.send({ secret, otpauthUri, qrDataUrl });
  });

  // Step 2 of enrollment: confirm a code, switch MFA on, reveal backup codes once.
  app.post("/api/profile/mfa/enable", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(codeSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Enter the 6-digit code", details: parsed.error });
      return;
    }
    const codes = activateMfa(request.user!.id, parsed.data.token);
    if (!codes) {
      reply.code(400).send({ error: "That code didn't match. Make sure the clock is right, then enter a fresh code." });
      return;
    }
    logActivity({
      event: "profile.mfa_enabled",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Turned on two-factor authentication.",
      ipAddress: request.ip
    });
    reply.send({ backupCodes: codes });
  });

  app.post("/api/profile/mfa/disable", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(passwordGateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Enter your current password", details: parsed.error });
      return;
    }
    if (!(await verifyPassword(parsed.data.currentPassword, request.user!.password_hash))) {
      reply.code(403).send({ error: "Your current password is incorrect." });
      return;
    }
    resetMfa(request.user!.id);
    logActivity({
      event: "profile.mfa_disabled",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Turned off two-factor authentication.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.post("/api/profile/mfa/backup-codes", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(passwordGateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Enter your current password", details: parsed.error });
      return;
    }
    if (!request.user!.mfa_enabled) {
      reply.code(409).send({ error: "Two-factor authentication isn't on." });
      return;
    }
    if (!(await verifyPassword(parsed.data.currentPassword, request.user!.password_hash))) {
      reply.code(403).send({ error: "Your current password is incorrect." });
      return;
    }
    const codes = regenerateBackupCodes(request.user!.id);
    logActivity({
      event: "profile.mfa_backup_regenerated",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: "Regenerated two-factor backup codes.",
      ipAddress: request.ip
    });
    reply.send({ backupCodes: codes });
  });

  // Login step 2: complete the pending challenge with a TOTP or backup code.
  app.post(
    "/api/auth/mfa/verify",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const challengeId = request.cookies[MFA_COOKIE];
      if (!challengeId) {
        reply.code(401).send({ error: "No sign-in is in progress. Start again." });
        return;
      }
      const challenge = resolveMfaChallenge(challengeId);
      if (!challenge) {
        clearMfaChallengeCookie(reply);
        reply.code(401).send({ error: "Your sign-in expired. Enter your password again." });
        return;
      }

      const parsed = parseBody(codeSchema, request.body);
      if (parsed.error) {
        reply.code(400).send({ error: "Enter your 6-digit code or a backup code", details: parsed.error });
        return;
      }

      const user = db
        .prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1")
        .get(challenge.user_id) as User | undefined;
      if (!user || !user.mfa_enabled || !user.mfa_secret) {
        clearMfaChallenge(challengeId);
        clearMfaChallengeCookie(reply);
        reply.code(401).send({ error: "Enter your password again." });
        return;
      }

      let ok = false;
      try {
        ok = verifyTotp(decryptSecret(user.mfa_secret), parsed.data.token);
      } catch {
        ok = false;
      }
      if (!ok) ok = consumeBackupCode(user.id, parsed.data.token);

      if (!ok) {
        const attempts = failMfaChallenge(challengeId);
        logActivity({
          event: "auth.mfa_failed",
          targetType: "user",
          targetId: user.id,
          detail: "A two-factor code was rejected.",
          ipAddress: request.ip
        });
        if (attempts >= MFA_MAX_ATTEMPTS) {
          clearMfaChallengeCookie(reply);
          reply.code(401).send({ error: "Too many attempts. Enter your password again." });
        } else {
          reply.code(401).send({ error: "Invalid code" });
        }
        return;
      }

      clearMfaChallenge(challengeId);
      clearMfaChallengeCookie(reply);
      issueSession(reply, user.id, request);
      logActivity({
        event: "auth.mfa_verified",
        actorUserId: user.id,
        targetType: "user",
        targetId: user.id,
        detail: "Completed two-factor sign-in.",
        ipAddress: request.ip
      });
      reply.send({ user: publicUser(user) });
    }
  );
}
