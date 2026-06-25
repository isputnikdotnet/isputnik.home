import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity, selfUser, THEME_PREFERENCES, type User } from "../../db.js";
import { parseBody, passwordPolicyField } from "../../core/shared.js";
import { hashPassword, verifyPassword } from "../../crypto.js";
import { currentSessionHash } from "../../auth.js";

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  theme: z.enum(THEME_PREFERENCES),
  // Optional: omitted = leave unchanged; "" = clear; otherwise a valid address.
  ereaderEmail: z.union([z.literal(""), z.string().trim().email().max(254)]).optional()
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword: passwordPolicyField()
});

const emailSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newEmail: z.string().trim().email("Enter a valid email address").max(254).transform((value) => value.toLowerCase())
});

export async function profilePlugin(app: FastifyInstance) {
  app.patch("/api/profile", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(profileSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid profile details", details: parsed.error });
      return;
    }

    db.prepare(`
      UPDATE users
      SET display_name = ?, theme = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(parsed.data.displayName, parsed.data.theme, request.user!.id);

    // E-reader email is updated only when present in the payload (empty clears it).
    if (parsed.data.ereaderEmail !== undefined) {
      db.prepare("UPDATE users SET ereader_email = ? WHERE id = ?")
        .run(parsed.data.ereaderEmail === "" ? null : parsed.data.ereaderEmail, request.user!.id);
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(request.user!.id) as User;
    logActivity({
      event: "profile.updated",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Updated profile settings.",
      ipAddress: request.ip
    });
    reply.send({ user: selfUser(user) });
  });

  // Self-service password change: the caller must prove their current password.
  // On success every OTHER session is revoked (a password change should sign out
  // other devices) while the caller's current session stays valid.
  app.patch("/api/profile/password", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(passwordSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid password", details: parsed.error });
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(request.user!.id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      reply.code(403).send({ error: "Your current password is incorrect." });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.newPassword);
    const sessionHash = currentSessionHash(request);
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(passwordHash, user.id);
      db.prepare(`
        UPDATE sessions
        SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ?
          AND revoked_at IS NULL
          AND (? IS NULL OR token_hash <> ?)
      `).run(user.id, sessionHash, sessionHash ?? "");
    })();

    logActivity({
      event: "profile.password_changed",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Changed their account password.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  // Self-service email change: the email is the login identity, so the caller must
  // prove their current password (mirrors the password change). Sessions are
  // token-based and stay valid — changing the login email doesn't sign devices out.
  app.patch("/api/profile/email", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(emailSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid email", details: parsed.error });
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(request.user!.id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    if (!(await verifyPassword(parsed.data.currentPassword, user.password_hash))) {
      reply.code(403).send({ error: "Your current password is incorrect." });
      return;
    }

    // No-op when it already matches (emails are stored lower-cased) — succeed quietly
    // rather than write a misleading "changed email" log entry.
    if (parsed.data.newEmail === user.email.toLowerCase()) {
      reply.send({ user: selfUser(user) });
      return;
    }

    // The email UNIQUE index spans every row (including soft-deleted users), so check
    // against all of them and return a friendly conflict instead of a raw constraint.
    const taken = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ?").get(parsed.data.newEmail, user.id);
    if (taken) {
      reply.code(409).send({ error: "That email address is already in use." });
      return;
    }

    try {
      db.prepare("UPDATE users SET email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .run(parsed.data.newEmail, user.id);
    } catch {
      reply.code(409).send({ error: "That email address is already in use." });
      return;
    }

    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as User;
    logActivity({
      event: "profile.email_changed",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: `Changed their account email to ${parsed.data.newEmail}.`,
      ipAddress: request.ip
    });
    reply.send({ user: selfUser(updated) });
  });
}
