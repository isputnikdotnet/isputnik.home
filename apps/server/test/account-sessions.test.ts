import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { issueSession, registerAuthDecorators } from "../src/auth.js";
import { sessionsPlugin } from "../src/core/sessions.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// Everyone's own sessions, which is what Profile → Devices reads. The rule running
// through all of it: the id in the path can only ever reach a row the caller
// already owns, and someone else's id is a 404 rather than a 403 — the caller has
// no business learning that it exists.

const CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1";

let app: FastifyInstance;

interface SessionPayload {
  id: string;
  kind: "browser" | "device";
  name: string;
  label: string | null;
  current: boolean;
}

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(sessionsPlugin);

  instance.post("/test/sign-in/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const kind = (request.query as { kind?: string }).kind === "device" ? "device" : "browser";
    const label = (request.query as { label?: string }).label ?? null;
    const id = issueSession(reply, userId, request, { kind, label });
    return reply.send({ id });
  });

  await instance.ready();
  return instance;
}

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

async function signIn(
  userId: string,
  opts: { kind?: "device"; label?: string; userAgent?: string } = {}
): Promise<{ id: string; cookie: string }> {
  const query = new URLSearchParams();
  if (opts.kind) query.set("kind", opts.kind);
  if (opts.label) query.set("label", opts.label);
  const res = await app.inject({
    method: "POST",
    url: `/test/sign-in/${userId}${query.size ? `?${query}` : ""}`,
    headers: { "user-agent": opts.userAgent ?? CHROME_LINUX }
  });
  return { id: (res.json() as { id: string }).id, cookie: cookieFrom(res.headers as Record<string, unknown>) };
}

function listFor(cookieHeader: string) {
  return app.inject({ method: "GET", url: "/api/account/sessions", headers: { cookie: cookieHeader } });
}

beforeEach(async () => {
  resetDb();
  app = await buildApp();
});

describe("listing", () => {
  it("shows the caller their own sessions and nobody else's", async () => {
    makeUser("me");
    makeUser("them");
    const mine = await signIn("me");
    await signIn("me", { kind: "device", label: "Living Room TV" });
    await signIn("them");

    const res = await listFor(mine.cookie);
    const { sessions } = res.json() as { sessions: SessionPayload[] };

    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.id !== undefined)).toBe(true);
    expect((res.json() as { sessions: { userId: string }[] }).sessions.every((s) => s.userId === "me")).toBe(true);
  });

  it("marks which one the caller is asking with", async () => {
    makeUser("me");
    const first = await signIn("me");
    await signIn("me");

    const { sessions } = (await listFor(first.cookie)).json() as { sessions: SessionPayload[] };
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.find((s) => s.current)?.id).toBe(first.id);
  });

  it("puts linked devices at the top, where the reason for the page is", async () => {
    makeUser("me");
    const browser = await signIn("me");
    await signIn("me", { kind: "device", label: "Kitchen display" });

    const { sessions } = (await listFor(browser.cookie)).json() as { sessions: SessionPayload[] };
    expect(sessions[0].kind).toBe("device");
    expect(sessions[1].kind).toBe("browser");
  });

  it("names a device by its label, and everything else by a readable guess", async () => {
    makeUser("me");
    const browser = await signIn("me", { userAgent: SAFARI_IPHONE });
    await signIn("me", { kind: "device", label: "Kitchen display" });

    const { sessions } = (await listFor(browser.cookie)).json() as { sessions: SessionPayload[] };
    expect(sessions.find((s) => s.kind === "device")?.name).toBe("Kitchen display");
    expect(sessions.find((s) => s.kind === "browser")?.name).toBe("Safari on iPhone");
  });

  it("leaves out sessions that are over", async () => {
    makeUser("me");
    const mine = await signIn("me");
    const stale = await signIn("me");
    db.prepare("UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(stale.id);

    const { sessions } = (await listFor(mine.cookie)).json() as { sessions: SessionPayload[] };
    expect(sessions.map((s) => s.id)).toEqual([mine.id]);
  });

  it("is not for anonymous callers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/account/sessions" });
    expect(res.statusCode).toBe(401);
  });
});

describe("renaming", () => {
  it("gives a device the name its owner uses for it", async () => {
    makeUser("me");
    const phone = await signIn("me");
    const tv = await signIn("me", { kind: "device" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/account/sessions/${tv.id}`,
      headers: { cookie: phone.cookie },
      payload: { label: "  Living Room TV  " }
    });
    expect(res.statusCode).toBe(200);

    const { sessions } = (await listFor(phone.cookie)).json() as { sessions: SessionPayload[] };
    expect(sessions.find((s) => s.id === tv.id)?.name).toBe("Living Room TV");
  });

  it("falls back to the readable guess when the name is cleared", async () => {
    makeUser("me");
    const phone = await signIn("me");
    const tv = await signIn("me", { kind: "device", label: "Old name" });

    await app.inject({
      method: "PATCH",
      url: `/api/account/sessions/${tv.id}`,
      headers: { cookie: phone.cookie },
      payload: { label: null }
    });

    const { sessions } = (await listFor(phone.cookie)).json() as { sessions: SessionPayload[] };
    expect(sessions.find((s) => s.id === tv.id)?.name).toBe("Chrome on Linux");
  });

  it("refuses a name longer than the field", async () => {
    makeUser("me");
    const phone = await signIn("me");
    const tv = await signIn("me", { kind: "device" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/account/sessions/${tv.id}`,
      headers: { cookie: phone.cookie },
      payload: { label: "x".repeat(61) }
    });
    expect(res.statusCode).toBe(400);
  });

  it("cannot reach into someone else's account", async () => {
    makeUser("me");
    makeUser("them");
    const mine = await signIn("me");
    const theirs = await signIn("them", { kind: "device" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/account/sessions/${theirs.id}`,
      headers: { cookie: mine.cookie },
      payload: { label: "Mine now" }
    });
    expect(res.statusCode).toBe(404);
    expect((db.prepare("SELECT label FROM sessions WHERE id = ?").get(theirs.id) as { label: string | null }).label)
      .toBeNull();
  });
});

describe("revoking", () => {
  it("ends another of the caller's own sessions", async () => {
    makeUser("me");
    const phone = await signIn("me");
    const tv = await signIn("me", { kind: "device", label: "Living Room TV" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/account/sessions/${tv.id}`,
      headers: { cookie: phone.cookie }
    });
    expect(res.statusCode).toBe(200);

    const { sessions } = (await listFor(phone.cookie)).json() as { sessions: SessionPayload[] };
    expect(sessions.map((s) => s.id)).toEqual([phone.id]);
  });

  it("takes effect on the device's very next request", async () => {
    makeUser("me");
    const phone = await signIn("me");
    const tv = await signIn("me", { kind: "device" });

    expect((await listFor(tv.cookie)).statusCode).toBe(200);
    await app.inject({ method: "DELETE", url: `/api/account/sessions/${tv.id}`, headers: { cookie: phone.cookie } });
    expect((await listFor(tv.cookie)).statusCode).toBe(401);
  });

  it("says to use sign out for the session you are holding", async () => {
    makeUser("me");
    const phone = await signIn("me");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/account/sessions/${phone.id}`,
      headers: { cookie: phone.cookie }
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/sign out/i);
  });

  it("cannot reach into someone else's account", async () => {
    makeUser("me");
    makeUser("them");
    const mine = await signIn("me");
    const theirs = await signIn("them", { kind: "device" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/account/sessions/${theirs.id}`,
      headers: { cookie: mine.cookie }
    });
    expect(res.statusCode).toBe(404);
    expect((await listFor(theirs.cookie)).statusCode).toBe(200);
  });

  it("records removing a device as its own event, naming what was removed", async () => {
    makeUser("me");
    const phone = await signIn("me");
    const tv = await signIn("me", { kind: "device", label: "Living Room TV" });

    await app.inject({ method: "DELETE", url: `/api/account/sessions/${tv.id}`, headers: { cookie: phone.cookie } });

    const logged = db.prepare("SELECT * FROM activity_logs WHERE event = 'auth.device_unlinked'").get() as
      | { detail: string }
      | undefined;
    expect(logged?.detail).toContain("Living Room TV");
  });

  it("records ending an ordinary session as an ordinary revoke", async () => {
    makeUser("me");
    const phone = await signIn("me");
    const laptop = await signIn("me");

    await app.inject({ method: "DELETE", url: `/api/account/sessions/${laptop.id}`, headers: { cookie: phone.cookie } });

    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'session.revoked'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'auth.device_unlinked'").get()).toEqual({ n: 0 });
  });
});
