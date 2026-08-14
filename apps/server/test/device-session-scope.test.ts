import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { issueSession, registerAuthDecorators } from "../src/auth.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// A session minted by linking a display is not the same thing as a session minted
// by someone typing a password, and the difference has to survive the round trip
// through the cookie: issueSession writes it, authenticate reads it back, and
// requireAdmin acts on it. Anything less and "the TV can't administer the server"
// is a comment rather than a control.

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);

  instance.post("/test/sign-in/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const id = issueSession(reply, userId, request);
    return reply.send({ id });
  });

  instance.post("/test/link-device/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const id = issueSession(reply, userId, request, {
      kind: "device",
      label: "Living Room TV",
      days: config.deviceSessionDays
    });
    return reply.send({ id });
  });

  instance.get("/test/private", { preHandler: instance.authenticate }, async (request) => ({
    ok: true,
    kind: request.sessionKind ?? null
  }));

  instance.get("/test/admin", { preHandler: instance.requireAdmin }, async () => ({ ok: true }));

  await instance.ready();
  return instance;
}

/** The session cookie out of a Set-Cookie header, ready to send back. */
function sessionCookie(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

beforeEach(async () => {
  resetDb();
  app = await buildApp();
});

describe("issueSession", () => {
  it("mints an ordinary browser session by default", async () => {
    makeUser("u1", "member");
    const res = await app.inject({ method: "POST", url: "/test/sign-in/u1" });
    const { id } = res.json() as { id: string };

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row.kind).toBe("browser");
    expect(row.label).toBeNull();
    expect(res.statusCode).toBe(200);
  });

  it("returns the session id it created, so a caller can record it", async () => {
    makeUser("u1", "member");
    const res = await app.inject({ method: "POST", url: "/test/sign-in/u1" });
    const { id } = res.json() as { id: string };
    expect(id).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(id)).toEqual({ n: 1 });
  });

  it("marks and names a device session, and gives it the longer life", async () => {
    makeUser("u1", "member");
    const res = await app.inject({ method: "POST", url: "/test/link-device/u1" });
    const { id } = res.json() as { id: string };

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as { kind: string; label: string; expires_at: string };
    expect(row.kind).toBe("device");
    expect(row.label).toBe("Living Room TV");

    // Comfortably past what a browser session would have got (14 days by default).
    const days = (new Date(row.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(config.sessionDays + 1);
    expect(Math.round(days)).toBe(config.deviceSessionDays);
  });

  it("stores only the hash of the token it put in the cookie", async () => {
    makeUser("u1", "member");
    const res = await app.inject({ method: "POST", url: "/test/sign-in/u1" });
    const token = sessionCookie(res.headers as Record<string, unknown>).split("=")[1];

    const stored = db.prepare("SELECT token_hash FROM sessions").get() as { token_hash: string };
    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toHaveLength(64);
  });
});

describe("authenticate", () => {
  it("reports the kind of session the caller is holding", async () => {
    makeUser("u1", "member");
    const signedIn = await app.inject({ method: "POST", url: "/test/sign-in/u1" });
    const linked = await app.inject({ method: "POST", url: "/test/link-device/u1" });

    const asBrowser = await app.inject({
      method: "GET",
      url: "/test/private",
      headers: { cookie: sessionCookie(signedIn.headers as Record<string, unknown>) }
    });
    const asDevice = await app.inject({
      method: "GET",
      url: "/test/private",
      headers: { cookie: sessionCookie(linked.headers as Record<string, unknown>) }
    });

    expect(asBrowser.json()).toEqual({ ok: true, kind: "browser" });
    expect(asDevice.json()).toEqual({ ok: true, kind: "device" });
  });

  it("lets a linked device use the ordinary app", async () => {
    makeUser("u1", "member");
    const linked = await app.inject({ method: "POST", url: "/test/link-device/u1" });
    const res = await app.inject({
      method: "GET",
      url: "/test/private",
      headers: { cookie: sessionCookie(linked.headers as Record<string, unknown>) }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("requireAdmin", () => {
  it("refuses a device session even when the account is an admin", async () => {
    makeUser("boss", "admin");
    const linked = await app.inject({ method: "POST", url: "/test/link-device/boss" });
    const res = await app.inject({
      method: "GET",
      url: "/test/admin",
      headers: { cookie: sessionCookie(linked.headers as Record<string, unknown>) }
    });

    expect(res.statusCode).toBe(403);
    // The message has to say what to do about it, not just "no".
    expect((res.json() as { error: string }).error).toMatch(/sign in on your own device/i);
  });

  it("still admits the same admin from their own browser", async () => {
    makeUser("boss", "admin");
    const signedIn = await app.inject({ method: "POST", url: "/test/sign-in/boss" });
    const res = await app.inject({
      method: "GET",
      url: "/test/admin",
      headers: { cookie: sessionCookie(signedIn.headers as Record<string, unknown>) }
    });
    expect(res.statusCode).toBe(200);
  });

  it("still refuses a member, device or not", async () => {
    makeUser("kid", "member");
    const signedIn = await app.inject({ method: "POST", url: "/test/sign-in/kid" });
    const res = await app.inject({
      method: "GET",
      url: "/test/admin",
      headers: { cookie: sessionCookie(signedIn.headers as Record<string, unknown>) }
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/admin access required/i);
  });

  it("refuses a revoked device session outright, before the kind is even considered", async () => {
    makeUser("boss", "admin");
    const linked = await app.inject({ method: "POST", url: "/test/link-device/boss" });
    const cookieHeader = sessionCookie(linked.headers as Record<string, unknown>);
    db.prepare("UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();

    const res = await app.inject({ method: "GET", url: "/test/private", headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(401);
  });
});
