import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { db, publicUser, type User } from "./db.js";
import { sha256 } from "./crypto.js";

const cookieName = "isputnik_sid";

export function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

export function issueSession(reply: FastifyReply, userId: string, request: FastifyRequest) {
  const token = nanoid(48);
  const sessionId = nanoid(24);
  const expiresAt = addDays(config.sessionDays).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, expires_at, device_name, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, sha256(token), userId, expiresAt, request.headers["user-agent"] ?? null, request.ip);

  reply.setCookie(cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt)
  });
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(cookieName, { path: "/" });
}

export async function registerAuthDecorators(app: FastifyInstance) {
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[cookieName];
    if (!token) {
      reply.code(401).send({ error: "Not authenticated" });
      return;
    }

    const tokenHash = sha256(token);
    const row = db.prepare(`
      SELECT users.*
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
        AND users.deleted_at IS NULL
        AND users.is_active = 1
    `).get(tokenHash) as User | undefined;

    if (!row) {
      clearSession(reply);
      reply.code(401).send({ error: "Not authenticated" });
      return;
    }

    db.prepare("UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?").run(tokenHash);
    request.user = row;
  });

  app.decorate("requireAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) {
      return;
    }

    if (request.user?.role !== "admin") {
      reply.code(403).send({ error: "Admin access required" });
    }
  });
}

export function currentUserPayload(request: FastifyRequest) {
  return request.user ? publicUser(request.user) : null;
}

export function revokeCurrentSession(request: FastifyRequest) {
  const token = request.cookies[cookieName];
  if (token) {
    db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(sha256(token));
  }
}

export function currentSessionHash(request: FastifyRequest) {
  const token = request.cookies[cookieName];
  return token ? sha256(token) : null;
}
