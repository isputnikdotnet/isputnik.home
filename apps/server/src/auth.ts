import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { db, selfUser, type User } from "./db.js";
import { sha256 } from "./crypto.js";
import { hostCookieName } from "./core/cookies.js";

// On a secure deployment the session cookie carries the __Host- prefix (see
// core/cookies.ts). Existing sessions were issued under the bare name, so reads
// fall back to it: nobody is logged out by the rename, and a session migrates to
// the prefixed name the next time it is issued (sign-in). Logout clears both.
const LEGACY_SESSION_COOKIE = "isputnik_sid";
const cookieName = hostCookieName(LEGACY_SESSION_COOKIE, config.cookieSecure);

function readSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[cookieName] ?? request.cookies[LEGACY_SESSION_COOKIE];
}

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
  // Also clear any cookie left under the bare pre-__Host- name, so a stale legacy
  // cookie can't keep a signed-out browser authenticating via the read fallback.
  if (cookieName !== LEGACY_SESSION_COOKIE) {
    reply.clearCookie(LEGACY_SESSION_COOKIE, { path: "/" });
  }
}

export async function registerAuthDecorators(app: FastifyInstance) {
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = readSessionToken(request);
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
  const token = readSessionToken(request);
  if (token) {
    db.prepare("UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(sha256(token));
  }
}

// Who is making this request, when the route does not require anyone to be.
//
// For public routes — a share link is the case this exists for — where the visitor
// may or may not have a session. It answers null instead of 401, never touches the
// reply, and never clears a cookie, so an expired or bogus session is simply "not
// signed in" rather than a sign-out for whoever holds it. It also leaves
// last_seen_at alone: opening a share link is not the account being used, and
// letting it refresh the session's clock would keep a device looking alive on the
// strength of a link anyone could follow.
//
// Same-origin is what makes it work at all: the share page is served from this
// app, so a signed-in visitor's cookie rides along on the request even though the
// route never asks for it.
export function optionalUser(request: FastifyRequest): User | null {
  const token = readSessionToken(request);
  if (!token) return null;

  const row = db.prepare(`
    SELECT users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.revoked_at IS NULL
      AND datetime(sessions.expires_at) > CURRENT_TIMESTAMP
      AND users.deleted_at IS NULL
      AND users.is_active = 1
  `).get(sha256(token)) as User | undefined;

  return row ?? null;
}

export function currentSessionHash(request: FastifyRequest) {
  const token = readSessionToken(request);
  return token ? sha256(token) : null;
}
