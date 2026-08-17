import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../db.js";
import { currentSessionHash } from "../auth.js";
import { describeUserAgent } from "./device-link.js";
import { parseBody } from "./shared.js";

// Live sessions, from two directions: an admin's view of everyone's (the original
// use — spotting a sign-in that shouldn't be there), and each user's view of their
// own, which is what Profile → Devices reads. The self-service half exists because
// a linked display is a session that outlives every browser session by a year, and
// the person who approved it is the one who should be able to end it.

interface SessionRow {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen: string;
  device_name: string | null;
  ip_address: string | null;
  kind: "browser" | "device";
  label: string | null;
  user_id: string;
  display_name: string;
  email: string;
}

const SESSION_COLUMNS = `
  sessions.id,
  sessions.token_hash,
  sessions.created_at,
  sessions.expires_at,
  sessions.last_seen_at AS last_seen,
  sessions.device_name,
  sessions.ip_address,
  sessions.kind,
  sessions.label,
  users.id AS user_id,
  users.display_name,
  users.email
`;

const LIVE_SESSION_SQL = `
  FROM sessions
  JOIN users ON users.id = sessions.user_id
  WHERE sessions.revoked_at IS NULL
    AND datetime(sessions.expires_at) > datetime('now')
    AND users.deleted_at IS NULL
`;

// One shape for both audiences. `name` is what to put on the row: the owner's own
// word for the device if they have given one, and otherwise the best guess from
// the user agent — never the raw agent string, which is unreadable.
function serializeSession(session: SessionRow, currentHash: string | null) {
  return {
    id: session.id,
    userId: session.user_id,
    displayName: session.display_name,
    email: session.email,
    createdAt: session.created_at,
    expiresAt: session.expires_at,
    lastSeen: session.last_seen,
    kind: session.kind,
    label: session.label,
    name: session.label ?? describeUserAgent(session.device_name),
    deviceName: session.device_name,
    ipAddress: session.ip_address,
    current: session.token_hash === currentHash
  };
}

const labelSchema = z.object({
  label: z.string().trim().max(60).nullable()
});

export async function sessionsPlugin(app: FastifyInstance) {
  app.get("/api/sessions", { preHandler: app.requireAdmin }, async (request) => {
    const rows = db.prepare(`
      SELECT ${SESSION_COLUMNS}
      ${LIVE_SESSION_SQL}
      ORDER BY datetime(sessions.last_seen_at) DESC
    `).all() as SessionRow[];
    const tokenHash = currentSessionHash(request);

    return { sessions: rows.map((session) => serializeSession(session, tokenHash)) };
  });

  // untrustedAllow: revoking a session protects the account — never refused,
  // even under the deletions-only-from-trusted-networks policy.
  app.delete("/api/sessions/:id", { preHandler: app.requireAdmin, config: { untrustedAllow: true } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = db.prepare("SELECT id, token_hash, user_id FROM sessions WHERE id = ? AND revoked_at IS NULL").get(id) as {
      id: string;
      token_hash: string;
      user_id: string;
    } | undefined;
    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }

    if (session.token_hash === currentSessionHash(request)) {
      return reply.code(409).send({ error: "Use sign out to end your current session" });
    }

    db.prepare("UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    logActivity({
      event: "session.revoked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: session.user_id,
      detail: "Revoked an active session.",
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  // ── The caller's own sessions ──────────────────────────────────────────────
  //
  // Every query below is scoped by user_id, so the id in the path can only ever
  // reach a row the caller already owns: an id belonging to someone else is a 404,
  // not a 403, because the caller has no business knowing it exists.

  app.get("/api/account/sessions", { preHandler: app.authenticate }, async (request) => {
    const rows = db.prepare(`
      SELECT ${SESSION_COLUMNS}
      ${LIVE_SESSION_SQL}
        AND sessions.user_id = ?
      ORDER BY sessions.kind = 'device' DESC, datetime(sessions.last_seen_at) DESC
    `).all(request.user!.id) as SessionRow[];
    const tokenHash = currentSessionHash(request);

    return { sessions: rows.map((session) => serializeSession(session, tokenHash)) };
  });

  // Naming a device is the other half of linking one: "Chrome on Linux" is what
  // the server can work out, "Kitchen display" is what makes the list readable.
  app.patch("/api/account/sessions/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(labelSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid device name", details: parsed.error });
    }

    const label = parsed.data.label && parsed.data.label.length > 0 ? parsed.data.label : null;
    const changed = db.prepare(
      "UPDATE sessions SET label = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
    ).run(label, id, request.user!.id).changes;
    if (!changed) {
      return reply.code(404).send({ error: "Device not found" });
    }

    return reply.send({ ok: true, label });
  });

  // untrustedAllow: "sign out that device" is exactly what a travelling user
  // reaches for when something looks wrong — see deletionBlocked.
  app.delete("/api/account/sessions/:id", { preHandler: app.authenticate, config: { untrustedAllow: true } }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const session = db.prepare(
      "SELECT id, token_hash, kind, label, device_name FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
    ).get(id, request.user!.id) as
      | { id: string; token_hash: string; kind: string; label: string | null; device_name: string | null }
      | undefined;
    if (!session) {
      return reply.code(404).send({ error: "Device not found" });
    }

    // Same rule the admin route has: ending the session you are asking with is
    // signing out, and that has its own button which also clears the cookie.
    if (session.token_hash === currentSessionHash(request)) {
      return reply.code(409).send({ error: "Use sign out to end your current session" });
    }

    db.prepare("UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
    logActivity({
      event: session.kind === "device" ? "auth.device_unlinked" : "session.revoked",
      actorUserId: request.user!.id,
      targetType: "user",
      targetId: request.user!.id,
      detail: session.kind === "device"
        ? `Removed the linked device "${session.label ?? describeUserAgent(session.device_name)}".`
        : "Signed out one of their own sessions.",
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });
}
