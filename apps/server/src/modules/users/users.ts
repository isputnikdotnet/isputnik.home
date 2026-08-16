import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity, publicUser, type User } from "../../db.js";
import { hashPassword } from "../../crypto.js";
import { currentSessionHash } from "../../auth.js";
import { getDefaultTheme } from "../../core/app-config.js";
import { parseBody, passwordPolicyField } from "../../core/shared.js";
import { resetMfa } from "../../core/mfa-routes.js";
import { clearPasskeys } from "../../core/webauthn.js";
import { isAccountLocked, clearAccountLockout } from "../../core/security.js";
import {
  listLiveWindows,
  normalizeWindowMinutes,
  openLinkWindow,
  revokeLinkWindow,
  MAX_WINDOW_MINUTES,
  MIN_WINDOW_MINUTES
} from "../../core/device-link.js";
import { alertNewAdmin, alertMfaDisabled, alertPasswordChanged } from "../../core/security-alerts.js";

const roleSchema = z.object({
  role: z.enum(["admin", "member"])
});

// How long the admin wants the registration window open for. Optional, because a
// caller with no opinion should get the default rather than an error.
const deviceLinkWindowSchema = z.object({
  minutes: z.number().int().min(MIN_WINDOW_MINUTES).max(MAX_WINDOW_MINUTES).optional()
});

const createUserSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
  displayName: z.string().trim().min(2).max(80),
  password: passwordPolicyField(),
  role: z.enum(["admin", "member"]).default("member")
});

const updateUserSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
  displayName: z.string().trim().min(2).max(80),
  role: z.enum(["admin", "member"])
});

const passwordSchema = z.object({
  password: passwordPolicyField()
});

interface UserListRow extends User {
  active_sessions: number;
  passkey_count: number;
}

export async function usersPlugin(app: FastifyInstance) {
  app.get("/api/users", { preHandler: app.requireAdmin }, async () => {
    const users = db.prepare(`
      SELECT
        users.*,
        COUNT(sessions.id) AS active_sessions,
        -- Counted as a subquery, not a second LEFT JOIN: joining two one-to-many
        -- tables at once multiplies the rows and would inflate both tallies.
        (SELECT COUNT(*) FROM webauthn_credentials WHERE webauthn_credentials.user_id = users.id) AS passkey_count
      FROM users
      LEFT JOIN sessions ON sessions.user_id = users.id
        AND sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > datetime('now')
      WHERE users.deleted_at IS NULL
      GROUP BY users.id
      ORDER BY datetime(users.created_at) ASC
    `).all() as UserListRow[];

    // One query for every open registration window, rather than one per row: there
    // are almost never any, and when there is one it is a single row.
    const windows = new Map(listLiveWindows().map((window) => [window.user_id, window.expires_at]));

    return {
      users: users.map((user) => ({
        ...publicUser(user),
        activeSessions: user.active_sessions,
        mfaEnabled: Boolean(user.mfa_enabled),
        mfaMethod: user.mfa_method,
        passkeyCount: user.passkey_count,
        locked: isAccountLocked(user.email),
        // When this person may link a device from outside the house, or null —
        // which is almost always, and is the point.
        deviceLinkWindowExpiresAt: windows.get(user.id) ?? null
      }))
    };
  });

  app.post("/api/users", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createUserSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid account details", details: parsed.error });
    }

    // Deleting an account is a soft delete (see the DELETE route): the row stays so
    // the things it created — libraries, collections, shares — keep their owner. The
    // email column is UNIQUE, so that tombstone would otherwise reserve the address
    // forever against an admin who can no longer see the account anywhere. Reuse the
    // row instead, which also keeps every reference to it intact.
    const existing = db
      .prepare("SELECT id, deleted_at FROM users WHERE email = ?")
      .get(parsed.data.email) as { id: string; deleted_at: string | null } | undefined;
    if (existing && !existing.deleted_at) {
      return reply.code(409).send({ error: "An account with this email already exists" });
    }

    const restored = Boolean(existing);
    const userId = existing?.id ?? nanoid(16);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = db.transaction(() => {
      if (existing) {
        // Re-issuing the account, not undeleting a person: the second factor and
        // passkeys are credentials of whoever held it before, and only the new
        // password is meant to open it. They re-enroll after signing in.
        db.prepare(`
          UPDATE users
          SET password_hash = ?, display_name = ?, role = ?, is_active = 1, deleted_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?
        `).run(passwordHash, parsed.data.displayName, parsed.data.role, existing.id);
        resetMfa(existing.id);
        clearPasskeys(existing.id);
      } else {
        db.prepare(`
          INSERT INTO users (id, email, password_hash, display_name, role, theme)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, parsed.data.email, passwordHash, parsed.data.displayName, parsed.data.role, getDefaultTheme());
      }
      return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
    })();

    // Failed sign-ins are counted per email, not per account, so an address that was
    // locked out before it was deleted would hand the lockout straight to whoever
    // holds it next (see core/security.ts).
    clearAccountLockout(parsed.data.email);

    logActivity({
      event: "user.created",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: userId,
      detail: restored
        ? `Created ${user.display_name}'s account, reusing a deleted account with the same email.`
        : `Created ${user.display_name}'s account.`,
      ipAddress: request.ip
    });
    if (parsed.data.role === "admin") alertNewAdmin(parsed.data.email, `admin ${request.user!.display_name}`);
    return reply.code(201).send({ user: { ...publicUser(user), activeSessions: 0 }, restored });
  });

  app.patch("/api/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(updateUserSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid account details", details: parsed.error });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    const duplicate = db.prepare("SELECT id FROM users WHERE email = ? AND id <> ?").get(parsed.data.email, id);
    if (duplicate) {
      return reply.code(409).send({ error: "Another account already uses this email" });
    }

    if (parsed.data.role !== user.role && (user.protected_from_delete || id === request.user!.id)) {
      return reply.code(409).send({ error: "This administrator role cannot be changed here" });
    }

    db.prepare(`
      UPDATE users
      SET email = ?, display_name = ?, role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(parsed.data.email, parsed.data.displayName, parsed.data.role, id);

    logActivity({
      event: "user.updated",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Updated ${parsed.data.displayName}'s account.`,
      ipAddress: request.ip
    });
    if (parsed.data.role === "admin" && user.role !== "admin") {
      alertNewAdmin(parsed.data.email, `admin ${request.user!.display_name}`);
    }
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
    return reply.send({ user: publicUser(updated) });
  });

  app.patch("/api/users/:id/role", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(roleSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid account role", details: parsed.error });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    if (user.protected_from_delete || id === request.user!.id) {
      return reply.code(409).send({ error: "This administrator role cannot be changed here" });
    }

    db.prepare("UPDATE users SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(parsed.data.role, id);
    logActivity({
      event: "user.role_changed",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Changed ${user.display_name}'s role to ${parsed.data.role}.`,
      ipAddress: request.ip
    });
    if (parsed.data.role === "admin" && user.role !== "admin") {
      alertNewAdmin(user.email, `admin ${request.user!.display_name}`);
    }
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
    return reply.send({ user: publicUser(updated) });
  });

  app.patch("/api/users/:id/password", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(passwordSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid password", details: parsed.error });
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const sessionHash = currentSessionHash(request);
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(passwordHash, id);
      db.prepare(`
        UPDATE sessions
        SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ?
          AND revoked_at IS NULL
          AND (? IS NULL OR token_hash <> ?)
      `).run(id, id === request.user!.id ? sessionHash : null, sessionHash ?? "");
    })();

    // A new password is no use to someone the lockout is still refusing, and the
    // window runs 30 minutes by default — long enough that the admin reads it as the
    // reset having failed. Handing out a password is the same rescue as unlocking.
    clearAccountLockout(user.email);

    alertPasswordChanged(user.email, request.user!.id !== id, request.ip);
    logActivity({
      event: "user.password_changed",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Changed password for ${user.display_name}.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  // Rescue a member locked out of their second factor (lost authenticator, or an
  // inbox they can't reach) with no backup codes left — there's no self-service
  // recovery, so an admin clears MFA and the user re-enrolls after signing in.
  app.post("/api/users/:id/mfa/reset", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    resetMfa(id);
    if (user.mfa_enabled) alertMfaDisabled(user.email, true);
    logActivity({
      event: "user.mfa_reset",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Reset two-factor authentication for ${user.display_name}.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  // Linking a device is refused from outside the house, and the app doesn't offer
  // it there. This is the exception: one person, one hour, one device — after which
  // it closes itself. Deliberately not a setting that stays on; the global
  // "allow from anywhere" policy already exists for anyone who truly wants a door
  // with no name on it, and this is the alternative to reaching for it.
  app.post("/api/users/:id/device-link-window", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }
    if (!user.is_active) {
      return reply.code(409).send({ error: "That account is deactivated." });
    }

    const parsed = parseBody(deviceLinkWindowSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Pick between 1 and 60 minutes", details: parsed.error });
    }

    const minutes = normalizeWindowMinutes(parsed.data.minutes);
    const window = openLinkWindow(id, request.user!.id, minutes);
    logActivity({
      event: "user.device_link_window_opened",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Allowed ${user.display_name} to link one device from outside the home network for ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      ipAddress: request.ip
    });
    return reply.send({ expiresAt: window.expires_at, minutes });
  });

  app.delete("/api/users/:id/device-link-window", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }
    if (!revokeLinkWindow(id)) {
      // Already spent, already expired, or never opened — all the same to the
      // caller, whose intent ("make sure it is shut") is satisfied either way.
      return reply.send({ ok: true, closed: false });
    }

    logActivity({
      event: "user.device_link_window_cancelled",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Cancelled ${user.display_name}'s permission to link a device from outside.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true, closed: true });
  });

  // The passkey counterpart of the MFA rescue above: a member who lost every device
  // holding a passkey has stale credentials they can never use or remove. Clearing
  // them costs nothing — password + two-factor is untouched and still gets them in,
  // and they can enrol a new device afterwards.
  app.post("/api/users/:id/passkeys/reset", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    const cleared = clearPasskeys(id);
    logActivity({
      event: "user.passkeys_reset",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Removed ${cleared} passkey${cleared === 1 ? "" : "s"} for ${user.display_name}.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true, cleared });
  });

  // Admin rescue: clear a brute-force sign-in lockout so the user can try again
  // immediately instead of waiting out the lockout window. The lock is derived from
  // recent failed attempts (see core/security.ts), so this just clears them.
  app.post("/api/users/:id/unlock", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    const cleared = clearAccountLockout(user.email);
    logActivity({
      event: "user.unlocked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Cleared the sign-in lockout for ${user.display_name}.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true, cleared });
  });

  app.delete("/api/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    if (user.protected_from_delete) {
      return reply.code(409).send({ error: "This protected setup admin cannot be deleted" });
    }

    if (user.id === request.user!.id) {
      return reply.code(409).send({ error: "You cannot deactivate your current account" });
    }

    db.transaction(() => {
      db.prepare("UPDATE users SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), is_active = 0 WHERE id = ?").run(id);
      db.prepare("UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?").run(id);
      // Failed sign-ins are keyed on the email, so they outlive the account and would
      // meet whoever is given that address next.
      clearAccountLockout(user.email);
    })();

    logActivity({
      event: "user.deactivated",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Deactivated ${user.display_name}'s account.`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });
}
