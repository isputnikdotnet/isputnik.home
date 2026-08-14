import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { db, selfUser, type User } from "./db.js";
import { sha256 } from "./crypto.js";

const cookieName = "isputnik_sid";

export function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

// A session minted by someone signing in here ('browser') or by a display being
// linked from a phone ('device'). The difference matters twice: a device session
// lives far longer, and it is refused on admin routes — see requireAdmin below.
export type SessionKind = "browser" | "device";

export interface SessionOptions {
  kind?: SessionKind;
  /** What the owner calls this device; browser sessions leave it null. */
  label?: string | null;
  /** Lifetime override in days. Defaults to config.sessionDays. */
  days?: number;
}

/** Mints a session, sets the cookie, and returns the new session's id. */
export function issueSession(
  reply: FastifyReply,
  userId: string,
  request: FastifyRequest,
  opts: SessionOptions = {}
): string {
  const token = nanoid(48);
  const sessionId = nanoid(24);
  const expiresAt = addDays(opts.days ?? config.sessionDays).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, expires_at, device_name, ip_address, kind, label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    sha256(token),
    userId,
    expiresAt,
    request.headers["user-agent"] ?? null,
    request.ip,
    opts.kind ?? "browser",
    opts.label ?? null
  );

  reply.setCookie(cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt)
  });

  return sessionId;
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(cookieName, { path: "/" });
}

export async function registerAuthDecorators(app: FastifyInstance) {
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[cookieName];
    if (!token) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    const tokenHash = sha256(token);
    const row = db.prepare(`
      SELECT users.*, sessions.kind AS session_kind
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.revoked_at IS NULL
        AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
        AND users.deleted_at IS NULL
        AND users.is_active = 1
    `).get(tokenHash) as (User & { session_kind: SessionKind }) | undefined;

    if (!row) {
      clearSession(reply);
      // Returning the reply, not just sending it, for the same reason every
      // handler does — see core/compression.ts.
      return reply.code(401).send({ error: "Not authenticated" });
    }

    db.prepare("UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ?").run(tokenHash);
    const { session_kind: sessionKind, ...user } = row;
    request.user = user as User;
    request.sessionKind = sessionKind;
  });

  app.decorate("requireAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) {
      return;
    }

    // A linked display is barred from the control panel whatever its account's
    // role. The session is long-lived and sits in a room anyone can walk into, so
    // "signed in as an admin" must not mean "can administer the server from the
    // sofa". The owner's own devices still can — this is about the session, not
    // the person.
    if (request.sessionKind === "device") {
      return reply.code(403).send({ error: "This device can't use admin features. Sign in on your own device." });
    }

    if (request.user?.role !== "admin") {
      return reply.code(403).send({ error: "Admin access required" });
    }
  });
}

// The signed-in user as they see themselves, plus how they are signed in. The
// kind rides along here because the app has to know: a linked display is refused
// on admin routes (see requireAdmin), and without this the UI would keep offering
// it a control panel that answers 403 to everything on it.
export function currentUserPayload(request: FastifyRequest) {
  return request.user
    ? { ...selfUser(request.user), sessionKind: request.sessionKind ?? "browser" }
    : null;
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
