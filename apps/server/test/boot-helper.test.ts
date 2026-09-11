// test/helpers/boot.ts, which two dozen route suites boot through — held to what
// they rely on: a sign-in that the real decorators accept, a session row that looks
// like a real sign-in's, CSRF handled the way the SPA handles it, and an app under
// test that carries nothing the helper added.
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { bootApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

function routes(instance: FastifyInstance): void {
  instance.get("/api/me", { preHandler: instance.authenticate }, async (request) => ({
    id: request.user?.id ?? null,
    kind: request.sessionKind ?? null
  }));
  instance.post("/api/admin-thing", { preHandler: instance.requireAdmin }, async () => ({ ok: true }));
}

beforeEach(() => {
  resetDb();
  makeUser("boss", "admin");
  makeUser("kid");
});

describe("bootApp", () => {
  it("signs someone in with a cookie the real decorators accept", async () => {
    const { app, signIn } = await bootApp({ afterRegister: routes });

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: await signIn("kid") } });
    const anonymous = await app.inject({ method: "GET", url: "/api/me" });
    const notAdmin = await app.inject({ method: "POST", url: "/api/admin-thing", headers: { cookie: await signIn("kid") } });

    expect(me.json()).toEqual({ id: "kid", kind: "browser" });
    expect(anonymous.statusCode).toBe(401);
    expect(notAdmin.statusCode).toBe(403);
  });

  it("records the session the way a real sign-in would", async () => {
    const { session } = await bootApp();

    const { id } = await session("kid", {
      kind: "device", label: "Kitchen display", headers: { "user-agent": "TestAgent/1.0" }, remoteAddress: "192.168.1.9"
    });

    expect(db.prepare("SELECT user_id, kind, label, device_name, ip_address FROM sessions WHERE id = ?").get(id)).toEqual({
      user_id: "kid", kind: "device", label: "Kitchen display", device_name: "TestAgent/1.0", ip_address: "192.168.1.9"
    });
  });

  it("adds no route, and no request, to the app under test", async () => {
    const { app, signIn } = await bootApp({ afterRegister: routes });
    await signIn("kid");

    const listed = app.printRoutes({ commonPrefix: false });
    expect(listed).toContain("/api/me");
    expect(listed).not.toMatch(/sign-in|:userId/);
  });

  it("with csrf on, hands back what the SPA would send, and the hook still refuses a bare POST", async () => {
    const { app, session, as } = await bootApp({ csrf: true, afterRegister: routes });
    const boss = await session("boss");

    const withToken = await as(boss.cookie).post("/api/admin-thing", {});
    const withHeaders = await app.inject({ method: "POST", url: "/api/admin-thing", headers: boss.headers, payload: {} });
    const bare = await app.inject({ method: "POST", url: "/api/admin-thing", headers: { cookie: boss.cookie }, payload: {} });

    expect(withToken.statusCode).toBe(200);
    expect(withHeaders.statusCode).toBe(200);
    expect(bare.statusCode).toBe(403);
  });
});
