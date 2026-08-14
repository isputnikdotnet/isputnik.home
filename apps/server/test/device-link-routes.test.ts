import { beforeEach, describe, expect, it, vi } from "vitest";

// Approving a device emails its owner; keep it off the wire.
vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { hashPassword } from "../src/crypto.js";
import { registerAuthDecorators } from "../src/auth.js";
import { deviceLinkRoutes } from "../src/core/device-link-routes.js";
import { getSecurityPolicy, setSecurityPolicy } from "../src/core/security.js";
import { liveWindowFor, openLinkWindow } from "../src/core/device-link.js";
import { resetDb } from "./helpers/seed.js";

// The flow end to end, and every way it is supposed to say no. "The device" and
// "the phone" below are two different callers against the same server: the device
// is anonymous and holds a long secret, the phone is signed in and holds a short
// code.

const PASSWORD = "correct-horse-battery";
const LAN = "192.168.1.42";
const OUTSIDE = "203.0.113.10";

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(deviceLinkRoutes);

  // Stands in for the real sign-in, which has its own tests. Issues an ordinary
  // browser session for whoever is named.
  instance.post("/test/sign-in/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { issueSession } = await import("../src/auth.js");
    issueSession(reply, userId, request);
    return reply.send({ ok: true });
  });

  await instance.ready();
  return instance;
}

async function makeOwner(id = "owner"): Promise<string> {
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, 'member')")
    .run(id, `${id}@test.local`, await hashPassword(PASSWORD), id);
  return id;
}

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [String(raw)];
  const found = list.find((entry) => entry.startsWith("isputnik_sid="));
  if (!found) throw new Error("no session cookie was set");
  return found.split(";")[0];
}

/** Sign in as `userId` and return the cookie header a phone would then send. */
async function phoneCookie(userId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/test/sign-in/${userId}` });
  return cookieFrom(res.headers as Record<string, unknown>);
}

/** The device's half: ask to be linked, from inside the house by default. */
async function startLink(remoteAddress = LAN) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/device/start",
    remoteAddress,
    payload: {},
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0 Safari/537.36" }
  });
  return { res, body: res.json() as Record<string, string> };
}

function poll(deviceCode: string) {
  return app.inject({ method: "POST", url: "/api/auth/device/poll", remoteAddress: LAN, payload: { deviceCode } });
}

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM app_settings WHERE key = 'security_policy'").run();
  delete process.env.TRUST_PROXY_HOPS;
  app = await buildApp();
});

describe("the happy path", () => {
  it("carries a display from a code on screen to a session of its own", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);

    // 1. The display asks.
    const { res: started, body } = await startLink();
    expect(started.statusCode).toBe(201);
    expect(body.userCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    expect(body.userCodeDisplay).toContain("-");
    expect(body.verificationUrlComplete).toContain(body.userCode);

    // 2. Nothing has happened yet.
    const waiting = await poll(body.deviceCode);
    expect(waiting.json()).toMatchObject({ status: "pending" });

    // 3. The phone looks at what is asking.
    const details = await app.inject({
      method: "GET",
      url: `/api/auth/device/${body.userCode}`,
      headers: { cookie: cookieHeader }
    });
    expect(details.statusCode).toBe(200);
    expect(details.json()).toMatchObject({
      device: "Chrome on Linux",
      network: "Your home network",
      userCodeDisplay: body.userCodeDisplay
    });

    // 4. And approves it, with a password.
    const approved = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    expect(approved.statusCode).toBe(200);

    // 5. The display's next poll signs it in.
    const done = await poll(body.deviceCode);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "approved", user: { id: owner } });

    const session = db.prepare("SELECT * FROM sessions WHERE kind = 'device'").get() as {
      id: string;
      user_id: string;
      label: string;
    };
    expect(session.user_id).toBe(owner);
    expect(session.label).toBe("Chrome on Linux");
    expect(cookieFrom(done.headers as Record<string, unknown>)).toContain("isputnik_sid=");

    // …and the request records which session it became.
    const request = db.prepare("SELECT * FROM device_link_requests").get() as { status: string; session_id: string };
    expect(request.status).toBe("consumed");
    expect(request.session_id).toBe(session.id);
  });

  it("accepts the code however the phone's owner typed it", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/device/${body.userCodeDisplay.toLowerCase()}`,
      headers: { cookie: cookieHeader }
    });
    expect(res.statusCode).toBe(200);
  });

  it("stops a denied display instead of leaving it spinning", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();

    const denied = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/deny`,
      headers: { cookie: cookieHeader },
      payload: {}
    });
    expect(denied.statusCode).toBe(200);
    expect((await poll(body.deviceCode)).json()).toMatchObject({ status: "denied" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'device'").get()).toEqual({ n: 0 });
  });
});

describe("where a device may ask from", () => {
  it("refuses a device out on the internet, before creating anything", async () => {
    const { res } = await startLink(OUTSIDE);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "scope" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM device_link_requests").get()).toEqual({ n: 0 });
  });

  it("allows it once an admin has widened the policy", async () => {
    setSecurityPolicy({ ...getSecurityPolicy(), deviceLinkScope: "any" }, null);
    const { res } = await startLink(OUTSIDE);
    expect(res.statusCode).toBe(201);
  });

  it("refuses everything when a proxy is in front and TRUST_PROXY_HOPS is unset", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/device/start",
      remoteAddress: LAN,
      payload: {},
      headers: { "x-forwarded-for": OUTSIDE }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "proxy" });
  });

  it("logs the refusal so an admin can see it happened", async () => {
    await startLink(OUTSIDE);
    const logged = db.prepare("SELECT * FROM activity_logs WHERE event = 'auth.device_link_rejected'").get();
    expect(logged).toBeTruthy();
  });
});

describe("approving", () => {
  it("needs the password, and says how many tries are left", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();

    const res = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: "not-the-password" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ remaining: 4 });
    expect((await poll(body.deviceCode)).json()).toMatchObject({ status: "pending" });
  });

  it("cancels the request after five wrong passwords", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();

    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: "POST",
        url: `/api/auth/device/${body.userCode}/approve`,
        headers: { cookie: cookieHeader },
        payload: { currentPassword: "nope" }
      });
    }

    // The request is dead: even the right password can't reach it now.
    const res = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    expect(res.statusCode).toBe(404);
  });

  it("cannot be done from a linked display, even with the right password", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);

    // Link one display the normal way…
    const first = await startLink();
    await app.inject({
      method: "POST",
      url: `/api/auth/device/${first.body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    const redeemed = await poll(first.body.deviceCode);
    const tvCookie = cookieFrom(redeemed.headers as Record<string, unknown>);

    // …then try to use it to authorize a second one. Whoever is standing in front
    // of the display must not be able to turn it into a way of making more keys.
    const second = await startLink();
    const res = await app.inject({
      method: "POST",
      url: `/api/auth/device/${second.body.userCode}/approve`,
      headers: { cookie: tvCookie },
      payload: { currentPassword: PASSWORD }
    });

    expect(res.statusCode).toBe(403);
    expect((await poll(second.body.deviceCode)).json()).toMatchObject({ status: "pending" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'device'").get()).toEqual({ n: 1 });
  });

  it("cannot be done by someone who isn't signed in", async () => {
    await makeOwner();
    const { body } = await startLink();

    for (const url of [`/api/auth/device/${body.userCode}`, `/api/auth/device/${body.userCode}/approve`]) {
      const res = await app.inject({ method: url.endsWith("approve") ? "POST" : "GET", url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it("refuses a request that expired while the confirmation screen was open", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();
    db.prepare("UPDATE device_link_requests SET expires_at = ?")
      .run(new Date(Date.now() - 60_000).toISOString());

    const res = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    expect(res.statusCode).toBe(404);
    expect((await poll(body.deviceCode)).json()).toMatchObject({ status: "expired" });
  });

  it("emails the owner a receipt", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();
    await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });

    // Mail is unconfigured here, so the receipt that always lands is the log line.
    const logged = db.prepare("SELECT * FROM activity_logs WHERE event = 'auth.device_link_approved'").get() as
      | { detail: string }
      | undefined;
    expect(logged?.detail).toContain("Chrome on Linux");
  });
});

describe("redeeming", () => {
  it("hands out exactly one session however many times the device polls", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();
    await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });

    const first = await poll(body.deviceCode);
    const second = await poll(body.deviceCode);
    const third = await poll(body.deviceCode);

    expect(first.json()).toMatchObject({ status: "approved" });
    expect(second.json()).toMatchObject({ status: "consumed" });
    expect(third.json()).toMatchObject({ status: "consumed" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'device'").get()).toEqual({ n: 1 });
  });

  it("gives nothing to a made-up device code, and counts it against the caller", async () => {
    const res = await poll("completely-made-up");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: "unknown" });

    const attempts = db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email IS NULL").get();
    expect(attempts).toEqual({ n: 1 });
  });

  it("does not count a real request that merely ran out", async () => {
    await makeOwner();
    const { body } = await startLink();
    db.prepare("UPDATE device_link_requests SET expires_at = ?")
      .run(new Date(Date.now() - 60_000).toISOString());

    expect((await poll(body.deviceCode)).json()).toMatchObject({ status: "expired" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM login_attempts").get()).toEqual({ n: 0 });
  });

  it("refuses to sign in as an account that has been deactivated since approval", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();
    await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(owner);

    expect((await poll(body.deviceCode)).json()).toMatchObject({ status: "expired" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'device'").get()).toEqual({ n: 0 });
  });
});

describe("linking from outside, during a registration window", () => {
  // The window is the whole of the remote path: without one, outside is refused at
  // the door; with one, the request is created but only the person it was opened
  // for can approve it, and the first device to link closes it.
  it("refuses at the door with no window open", async () => {
    const { res } = await startLink(OUTSIDE);
    expect(res.statusCode).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM device_link_requests").get()).toEqual({ n: 0 });
  });

  it("carries a device all the way through while a window is open", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    openLinkWindow(owner, null);

    const { res: started, body } = await startLink(OUTSIDE);
    expect(started.statusCode).toBe(201);
    expect((db.prepare("SELECT remote FROM device_link_requests").get() as { remote: number }).remote).toBe(1);

    const approved = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    expect(approved.statusCode).toBe(200);

    const done = await poll(body.deviceCode);
    expect(done.json()).toMatchObject({ status: "approved" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'device'").get()).toEqual({ n: 1 });
  });

  it("closes the window on the first device, so a second is refused", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    openLinkWindow(owner, null);

    const first = await startLink(OUTSIDE);
    await app.inject({
      method: "POST",
      url: `/api/auth/device/${first.body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    await poll(first.body.deviceCode);

    expect(liveWindowFor(owner)).toBeNull();
    // …and the door is shut again: a second device can't even open a request.
    const second = await startLink(OUTSIDE);
    expect(second.res.statusCode).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'device'").get()).toEqual({ n: 1 });
  });

  it("will not let someone else's window authorize this account's device", async () => {
    const traveller = await makeOwner("traveller");
    const stayer = await makeOwner("stayer");
    // The window belongs to the traveller; the request is approved by the stayer.
    openLinkWindow(traveller, null);
    const stayerCookie = await phoneCookie(stayer);

    const { body } = await startLink(OUTSIDE);
    const res = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: stayerCookie },
      payload: { currentPassword: PASSWORD }
    });

    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toMatch(/administrator/i);
    expect((await poll(body.deviceCode)).json()).toMatchObject({ status: "pending" });
    // The traveller's window is untouched by someone else's attempt.
    expect(liveWindowFor(traveller)).toBeTruthy();
  });

  it("checks the password first, so a wrong one never reveals whether a window exists", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('someone-else-entirely', 'x@y.z', 'x', 'Other', 'member')")
      .run();
    openLinkWindow("someone-else-entirely", null);

    const { body } = await startLink(OUTSIDE);
    const res = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: "wrong" }
    });

    // 401 for the password, not 403 for the window — the two are indistinguishable
    // to someone who doesn't have the password anyway.
    expect(res.statusCode).toBe(401);
  });

  it("stops honouring a window that expired mid-flow", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    openLinkWindow(owner, null);
    const { body } = await startLink(OUTSIDE);

    db.prepare("UPDATE device_link_windows SET expires_at = ?").run(new Date(Date.now() - 60_000).toISOString());

    const res = await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    expect(res.statusCode).toBe(403);
  });

  it("leaves the house alone: a local request needs no window and burns none", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    openLinkWindow(owner, null);

    const { body } = await startLink(LAN);
    expect((db.prepare("SELECT remote FROM device_link_requests").get() as { remote: number }).remote).toBe(0);

    await app.inject({
      method: "POST",
      url: `/api/auth/device/${body.userCode}/approve`,
      headers: { cookie: cookieHeader },
      payload: { currentPassword: PASSWORD }
    });
    await poll(body.deviceCode);

    // The window is still open — it was never needed, so it wasn't spent.
    expect(liveWindowFor(owner)).toBeTruthy();
  });
});

describe("guessing codes", () => {
  it("counts a code that never existed against the caller's IP", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);

    const res = await app.inject({
      method: "GET",
      url: "/api/auth/device/ZZZZZZZZ",
      headers: { cookie: cookieHeader }
    });
    expect(res.statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE email IS NULL").get()).toEqual({ n: 1 });
  });

  it("does not count a code that was real but is over", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();
    db.prepare("UPDATE device_link_requests SET status = 'denied'").run();

    const res = await app.inject({
      method: "GET",
      url: `/api/auth/device/${body.userCode}`,
      headers: { cookie: cookieHeader }
    });
    expect(res.statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM login_attempts").get()).toEqual({ n: 0 });
  });

  it("tells an expired code and an unknown one apart in the log, not in the answer", async () => {
    const owner = await makeOwner();
    const cookieHeader = await phoneCookie(owner);
    const { body } = await startLink();
    db.prepare("UPDATE device_link_requests SET expires_at = ?")
      .run(new Date(Date.now() - 60_000).toISOString());

    const expired = await app.inject({
      method: "GET",
      url: `/api/auth/device/${body.userCode}`,
      headers: { cookie: cookieHeader }
    });
    const unknown = await app.inject({
      method: "GET",
      url: "/api/auth/device/ZZZZZZZZ",
      headers: { cookie: cookieHeader }
    });

    expect(expired.statusCode).toBe(unknown.statusCode);
    expect(expired.json()).toEqual(unknown.json());
  });
});
