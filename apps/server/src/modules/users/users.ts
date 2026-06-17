import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity, publicUser, type User } from "../../db.js";
import { hashPassword } from "../../crypto.js";
import { currentSessionHash } from "../../auth.js";
import { getDefaultTheme } from "../../core/app-config.js";
import { parseBody } from "../../core/shared.js";

const roleSchema = z.object({
  role: z.enum(["admin", "member"])
});

const createUserSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
  displayName: z.string().trim().min(2).max(80),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  role: z.enum(["admin", "member"]).default("member")
});

const updateUserSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
  displayName: z.string().trim().min(2).max(80),
  role: z.enum(["admin", "member"])
});

const passwordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters").max(200)
});

interface UserListRow extends User {
  active_sessions: number;
}

export async function usersPlugin(app: FastifyInstance) {
  app.get("/api/users", { preHandler: app.requireAdmin }, async () => {
    const users = db.prepare(`
      SELECT
        users.*,
        COUNT(sessions.id) AS active_sessions
      FROM users
      LEFT JOIN sessions ON sessions.user_id = users.id
        AND sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > datetime('now')
      WHERE users.deleted_at IS NULL
      GROUP BY users.id
      ORDER BY datetime(users.created_at) ASC
    `).all() as UserListRow[];

    return {
      users: users.map((user) => ({
        ...publicUser(user),
        activeSessions: user.active_sessions
      }))
    };
  });

  app.post("/api/users", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(createUserSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid account details", details: parsed.error });
      return;
    }

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(parsed.data.email);
    if (existing) {
      reply.code(409).send({ error: "An account with this email already exists" });
      return;
    }

    const userId = nanoid(16);
    const passwordHash = await hashPassword(parsed.data.password);
    const user = db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, display_name, role, theme)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, parsed.data.email, passwordHash, parsed.data.displayName, parsed.data.role, getDefaultTheme());
      return db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as User;
    })();

    logActivity({
      event: "user.created",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: userId,
      detail: `Created ${user.display_name}'s account.`,
      ipAddress: request.ip
    });
    reply.code(201).send({ user: { ...publicUser(user), activeSessions: 0 } });
  });

  app.patch("/api/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(updateUserSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid account details", details: parsed.error });
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    const duplicate = db.prepare("SELECT id FROM users WHERE email = ? AND id <> ?").get(parsed.data.email, id);
    if (duplicate) {
      reply.code(409).send({ error: "Another account already uses this email" });
      return;
    }

    if (parsed.data.role !== user.role && (user.protected_from_delete || id === request.user!.id)) {
      reply.code(409).send({ error: "This administrator role cannot be changed here" });
      return;
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
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
    reply.send({ user: publicUser(updated) });
  });

  app.patch("/api/users/:id/role", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(roleSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid account role", details: parsed.error });
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    if (user.protected_from_delete || id === request.user!.id) {
      reply.code(409).send({ error: "This administrator role cannot be changed here" });
      return;
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
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
    reply.send({ user: publicUser(updated) });
  });

  app.patch("/api/users/:id/password", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(passwordSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid password", details: parsed.error });
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
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

    logActivity({
      event: "user.password_changed",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Changed password for ${user.display_name}.`,
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  app.delete("/api/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id) as User | undefined;
    if (!user) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    if (user.protected_from_delete) {
      reply.code(409).send({ error: "This protected setup admin cannot be deleted" });
      return;
    }

    if (user.id === request.user!.id) {
      reply.code(409).send({ error: "You cannot deactivate your current account" });
      return;
    }

    db.transaction(() => {
      db.prepare("UPDATE users SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), is_active = 0 WHERE id = ?").run(id);
      db.prepare("UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?").run(id);
    })();

    logActivity({
      event: "user.deactivated",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: id,
      detail: `Deactivated ${user.display_name}'s account.`,
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });
}
