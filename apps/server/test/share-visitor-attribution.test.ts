// Opening a share link is recorded against the visitor when we can tell who they
// are. A share link authenticates nobody by design, so this is never a condition
// of being served — it only decides whether the log entry carries a name.
//
// optionalUser is what makes that possible: the same session lookup `authenticate`
// does, but answering null instead of 401. The properties that matter are the ones
// that keep it from behaving like a login — it must not sign anybody out, and it
// must not make a share link look like account activity.
import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { optionalUser } from "../src/auth.js";
import { resetDb, makeUser, futureIso, pastIso } from "./helpers/seed.js";

// Only the cookies are read, so this is all a request needs to be.
function requestWith(token?: string): FastifyRequest {
  return { cookies: token ? { isputnik_sid: token } : {} } as unknown as FastifyRequest;
}

function makeSession(opts: {
  token: string;
  userId: string;
  expiresAt?: string;
  revoked?: boolean;
  lastSeenAt?: string;
}): void {
  db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, expires_at, revoked_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
  `).run(
    `sess-${opts.token}`,
    sha256(opts.token),
    opts.userId,
    opts.expiresAt ?? futureIso(),
    opts.revoked ? new Date().toISOString() : null,
    opts.lastSeenAt ?? null
  );
}

const lastSeen = (token: string): string =>
  (db.prepare("SELECT last_seen_at FROM sessions WHERE token_hash = ?").get(sha256(token)) as { last_seen_at: string }).last_seen_at;

beforeEach(() => {
  resetDb();
  makeUser("viewer");
});

describe("naming the visitor behind a share link", () => {
  it("resolves a signed-in visitor from the cookie the share page already carries", () => {
    // The share page is same-origin, so a household member's session rides along
    // even though the route never asks for it. That is the whole mechanism.
    makeSession({ token: "live", userId: "viewer" });

    expect(optionalUser(requestWith("live"))?.id).toBe("viewer");
  });

  it("says nobody for a visitor with no session", () => {
    // A stranger with the link. They are still served; the log just records an IP.
    expect(optionalUser(requestWith())).toBeNull();
  });

  it("says nobody for an unknown token rather than trusting it", () => {
    makeSession({ token: "live", userId: "viewer" });
    expect(optionalUser(requestWith("not-a-real-token"))).toBeNull();
  });

  it("says nobody for an expired session", () => {
    makeSession({ token: "old", userId: "viewer", expiresAt: pastIso() });
    expect(optionalUser(requestWith("old"))).toBeNull();
  });

  it("says nobody for a revoked session", () => {
    // Revoking a device from Profile → Devices must stop attributing to it too.
    makeSession({ token: "gone", userId: "viewer", revoked: true });
    expect(optionalUser(requestWith("gone"))).toBeNull();
  });

  it("says nobody for a deactivated account", () => {
    makeSession({ token: "live", userId: "viewer" });
    db.prepare("UPDATE users SET is_active = 0 WHERE id = 'viewer'").run();
    expect(optionalUser(requestWith("live"))).toBeNull();
  });

  it("says nobody for a deleted account", () => {
    makeSession({ token: "live", userId: "viewer" });
    db.prepare("UPDATE users SET deleted_at = ? WHERE id = 'viewer'").run(new Date().toISOString());
    expect(optionalUser(requestWith("live"))).toBeNull();
  });

  it("does not touch the session's last-seen clock", () => {
    // Following a link anyone could have is not the account being used. Refreshing
    // last_seen_at here would keep a device showing as live in Profile → Devices,
    // and on the dashboard's "still signed in" list, on the strength of a share
    // link — which is exactly the signal an owner checks when something looks off.
    const before = "2020-01-01T00:00:00.000Z";
    makeSession({ token: "live", userId: "viewer", lastSeenAt: before });

    optionalUser(requestWith("live"));

    expect(lastSeen("live")).toBe(before);
  });

  it("leaves a stale session in place rather than signing its holder out", () => {
    // authenticate clears the cookie when a session no longer resolves. Doing that
    // here would mean opening a share link with an expired session silently logged
    // you out of the app — a public route must never have that power. optionalUser
    // takes no reply at all, so it cannot; the row simply stays as it was.
    makeSession({ token: "old", userId: "viewer", expiresAt: pastIso() });

    expect(optionalUser(requestWith("old"))).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").get(sha256("old"))).toEqual({ n: 1 });
  });
});
