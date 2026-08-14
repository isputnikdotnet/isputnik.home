import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

import { db } from "../src/db.js";
import { issueSession, registerAuthDecorators } from "../src/auth.js";
import { usersPlugin } from "../src/modules/users/users.js";
import { setupPlugin } from "../src/core/setup.js";
import { liveWindowFor, openLinkWindow, DEFAULT_WINDOW_MINUTES } from "../src/core/device-link.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// The admin's half — granting and cancelling a registration window — and the
// public probe the sign-in screen uses to decide whether to offer linking at all.

const LAN = "192.168.1.42";
const OUTSIDE = "203.0.113.10";

let app: FastifyInstance;

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(cookie);
  await registerAuthDecorators(instance);
  await instance.register(usersPlugin);
  await instance.register(setupPlugin);

  instance.post("/test/sign-in/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    issueSession(reply, userId, request);
    return reply.send({ ok: true });
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

async function signIn(userId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/test/sign-in/${userId}` });
  return cookieFrom(res.headers as Record<string, unknown>);
}

function probe(remoteAddress: string) {
  return app.inject({ method: "GET", url: "/api/setup/status", remoteAddress });
}

beforeEach(async () => {
  resetDb();
  delete process.env.TRUST_PROXY_HOPS;
  makeUser("boss", "admin");
  makeUser("traveller");
  app = await buildApp();
});

describe("granting a window", () => {
  it("defaults to an hour and says when it ends", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: await signIn("boss") },
      payload: {}
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ minutes: DEFAULT_WINDOW_MINUTES });
    expect(liveWindowFor("traveller")).toBeTruthy();
  });

  it("opens one for as long as the admin asked", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: await signIn("boss") },
      payload: { minutes: 5 }
    });

    expect(res.json()).toMatchObject({ minutes: 5 });
    const life = Math.round((Date.parse(liveWindowFor("traveller")!.expires_at) - Date.now()) / 60_000);
    expect(life).toBe(5);
  });

  it("refuses a duration outside the range instead of quietly clamping it", async () => {
    // Clamping is the last line of defence (normalizeWindowMinutes); the schema
    // rejects first, so an admin who types 600 is told, not silently given 60.
    const bossCookie = await signIn("boss");
    for (const minutes of [0, -5, 61, 1440]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/users/traveller/device-link-window",
        headers: { cookie: bossCookie },
        payload: { minutes }
      });
      expect(res.statusCode, `minutes=${minutes}`).toBe(400);
    }
    expect(liveWindowFor("traveller")).toBeNull();
  });

  it("records who granted it, and to whom", async () => {
    await app.inject({
      method: "POST",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: await signIn("boss") },
      payload: {}
    });

    expect(liveWindowFor("traveller")?.created_by).toBe("boss");
    const logged = db.prepare("SELECT * FROM activity_logs WHERE event = 'user.device_link_window_opened'").get() as
      | { actor_user_id: string; target_id: string }
      | undefined;
    expect(logged?.actor_user_id).toBe("boss");
    expect(logged?.target_id).toBe("traveller");
  });

  it("is admins only", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/users/boss/device-link-window",
      headers: { cookie: await signIn("traveller") },
      payload: {}
    });
    expect(res.statusCode).toBe(403);
    expect(liveWindowFor("boss")).toBeNull();
  });

  it("refuses for an unknown or deactivated account", async () => {
    const bossCookie = await signIn("boss");
    expect((await app.inject({
      method: "POST",
      url: "/api/users/nobody/device-link-window",
      headers: { cookie: bossCookie },
      payload: {}
    })).statusCode).toBe(404);

    db.prepare("UPDATE users SET is_active = 0 WHERE id = 'traveller'").run();
    expect((await app.inject({
      method: "POST",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: bossCookie },
      payload: {}
    })).statusCode).toBe(409);
  });

  it("shows up on the user list, so the admin can see it is open", async () => {
    const bossCookie = await signIn("boss");
    await app.inject({
      method: "POST",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: bossCookie },
      payload: {}
    });

    const { users } = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: bossCookie } }))
      .json() as { users: { id: string; deviceLinkWindowExpiresAt: string | null }[] };

    expect(users.find((u) => u.id === "traveller")?.deviceLinkWindowExpiresAt).toBeTruthy();
    expect(users.find((u) => u.id === "boss")?.deviceLinkWindowExpiresAt).toBeNull();
  });
});

describe("cancelling a window", () => {
  it("closes it immediately", async () => {
    const bossCookie = await signIn("boss");
    openLinkWindow("traveller", "boss");

    const res = await app.inject({
      method: "DELETE",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: bossCookie }
    });

    expect(res.json()).toMatchObject({ ok: true, closed: true });
    expect(liveWindowFor("traveller")).toBeNull();
  });

  it("is content when there was nothing open", async () => {
    // The caller's intent is "make sure it is shut", and it is.
    const res = await app.inject({
      method: "DELETE",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: await signIn("boss") }
    });
    expect(res.json()).toMatchObject({ ok: true, closed: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'user.device_link_window_cancelled'").get())
      .toEqual({ n: 0 });
  });

  it("is admins only", async () => {
    openLinkWindow("traveller", "boss");
    const res = await app.inject({
      method: "DELETE",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: await signIn("traveller") }
    });
    expect(res.statusCode).toBe(403);
    expect(liveWindowFor("traveller")).toBeTruthy();
  });
});

describe("the sign-in screen's probe", () => {
  it("offers linking inside the house and not outside it", async () => {
    expect((await probe(LAN)).json()).toMatchObject({ deviceLinkAvailable: true });
    expect((await probe(OUTSIDE)).json()).toMatchObject({ deviceLinkAvailable: false });
  });

  it("offers it outside only while a window is open", async () => {
    openLinkWindow("traveller", "boss");
    expect((await probe(OUTSIDE)).json()).toMatchObject({ deviceLinkAvailable: true });
  });

  it("stops offering it the moment the window is cancelled", async () => {
    openLinkWindow("traveller", "boss");
    await app.inject({
      method: "DELETE",
      url: "/api/users/traveller/device-link-window",
      headers: { cookie: await signIn("boss") }
    });
    expect((await probe(OUTSIDE)).json()).toMatchObject({ deviceLinkAvailable: false });
  });

  it("still answers everything else it always did", async () => {
    const body = (await probe(LAN)).json() as Record<string, unknown>;
    expect(body).toHaveProperty("requiresSetup");
    expect(body).toHaveProperty("defaultTheme");
    expect(body).toHaveProperty("passkeysAvailable");
  });
});
