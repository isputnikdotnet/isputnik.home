import type { FastifyInstance } from "fastify";
import { db, logActivity } from "../db.js";
import { currentSessionHash } from "../auth.js";

interface SessionListRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen: string;
  device_name: string | null;
  ip_address: string | null;
  user_id: string;
  display_name: string;
  email: string;
}

export async function sessionsPlugin(app: FastifyInstance) {
  app.get("/api/sessions", { preHandler: app.requireAdmin }, async (request) => {
    const rows = db.prepare(`
      SELECT
        sessions.id,
        sessions.token_hash,
        sessions.created_at,
        sessions.expires_at,
        sessions.last_seen,
        sessions.device_name,
        sessions.ip_address,
        users.id AS user_id,
        users.display_name,
        users.email
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
        AND users.deleted_at IS NULL
      ORDER BY datetime(sessions.last_seen) DESC
    `).all() as SessionListRow[];
    const tokenHash = currentSessionHash(request);

    return {
      sessions: rows.map((session) => ({
        id: session.id,
        userId: session.user_id,
        displayName: session.display_name,
        email: session.email,
        createdAt: session.created_at,
        expiresAt: session.expires_at,
        lastSeen: session.last_seen,
        deviceName: session.device_name,
        ipAddress: session.ip_address,
        current: session.token_hash === tokenHash
      }))
    };
  });

  app.delete("/api/sessions/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = db.prepare("SELECT id, token_hash, user_id FROM sessions WHERE id = ? AND revoked_at IS NULL").get(id) as {
      id: string;
      token_hash: string;
      user_id: string;
    } | undefined;
    if (!session) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }

    if (session.token_hash === currentSessionHash(request)) {
      reply.code(409).send({ error: "Use sign out to end your current session" });
      return;
    }

    db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    logActivity({
      event: "session.revoked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: session.user_id,
      detail: "Revoked an active session.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });
}
