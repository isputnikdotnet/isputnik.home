import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { db, logActivity, publicUser, type User } from "../db.js";
import { parseBody } from "./shared.js";

const roleSchema = z.object({
  role: z.enum(["admin", "member"])
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
        AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
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

    db.prepare("UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(parsed.data.role, id);
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
      db.prepare("UPDATE users SET deleted_at = CURRENT_TIMESTAMP, is_active = 0 WHERE id = ?").run(id);
      db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(id);
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
