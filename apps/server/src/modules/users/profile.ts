import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity, publicUser, THEME_PREFERENCES, type User } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { hashPassword, verifyPassword } from "../../crypto.js";
import { currentSessionHash } from "../../auth.js";

const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  theme: z.enum(THEME_PREFERENCES)
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword: z.string().min(8, "Password must be at least 8 characters").max(200)
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

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(request.user!.id) as User;
    logActivity({
      event: "profile.updated",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      detail: "Updated profile settings.",
      ipAddress: request.ip
    });
    reply.send({ user: publicUser(user) });
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
}
