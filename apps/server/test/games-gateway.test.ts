// The gateway to isputnik.games (modules/games/gateway.ts): every request under
// /games goes through authenticate and reaches the games server with the member's
// identity in signed headers — and with any such header the client sent dropped.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { registerGamesGateway, identityHeaders, stripIdentityHeaders } from "../src/modules/games/gateway.js";
import { gamesPlugin } from "../src/modules/games/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "gateway-secret-for-tests";

// A stand-in for the games server: it answers with whatever headers it received,
// so a test can see exactly what crossed the boundary.
let upstream: FastifyInstance;
let upstreamUrl: string;
let booted: BootedApp;

beforeEach(async () => {
  resetDb();
  makeUser("mum", "member");
  db.prepare("UPDATE users SET display_name = ?, language = 'ru', theme = 'plain-dark' WHERE id = 'mum'").run("Мама");

  upstream = Fastify();
  upstream.all("/games/*", async (request, reply) => reply.send({ url: request.url, headers: request.headers }));
  upstream.all("/games", async (request, reply) => reply.send({ url: request.url, headers: request.headers }));
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const address = upstream.server.address();
  upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  booted = await bootApp({
    // The module itself (status + members; no gateway, since GAMES_URL is unset
    // in tests) and the gateway registered by hand against the stand-in.
    plugins: [gamesPlugin],
    afterRegister: (app) => registerGamesGateway(app, { upstream: upstreamUrl, secret: SECRET })
  });
});

describe("the games module", () => {
  it("reports the games off when GAMES_URL is unset", async () => {
    const cookie = await booted.signIn("mum");
    const res = await booted.app.inject({ method: "GET", url: "/api/games/status", headers: { cookie } });
    expect(res.json()).toEqual({ enabled: false });
    expect((await booted.app.inject({ method: "GET", url: "/api/games/status" })).statusCode).toBe(401);
  });

  it("lists the active members by name for invitations", async () => {
    makeUser("dad", "member");
    makeUser("gone", "member");
    db.prepare("UPDATE users SET display_name = 'Dad' WHERE id = 'dad'").run();
    db.prepare("UPDATE users SET is_active = 0 WHERE id = 'gone'").run();
    const cookie = await booted.signIn("mum");
    const res = await booted.app.inject({ method: "GET", url: "/api/games/members", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ members: [{ id: "dad", name: "Dad" }, { id: "mum", name: "Мама" }] });
    expect((await booted.app.inject({ method: "GET", url: "/api/games/members" })).statusCode).toBe(401);
  });

  it("tells an admin how the integration stands, and nobody else", async () => {
    makeUser("admin", "admin");
    const res = await booted.app.inject({ method: "GET", url: "/api/games/admin/status", headers: { cookie: await booted.signIn("admin") } });
    expect(res.statusCode).toBe(200);
    // GAMES_URL is unset under test, so the server is not probed and nothing names it.
    expect(res.json()).toEqual({ configured: false, reason: null, url: null, secretSet: false, server: null });
    expect((await booted.app.inject({ method: "GET", url: "/api/games/admin/status", headers: { cookie: await booted.signIn("mum") } })).statusCode).toBe(403);
  });
});

afterEach(async () => {
  await booted.app.close();
  await upstream.close();
});

describe("identity headers", () => {
  it("percent-encodes the display name and carries role, language and theme", () => {
    const headers = identityHeaders({
      id: "mum", display_name: "Мама", role: "member", language: "ru", theme: "plain-dark"
    } as never, SECRET);
    expect(headers).toEqual({
      "x-isputnik-gateway": SECRET,
      "x-isputnik-user-id": "mum",
      "x-isputnik-user-name": encodeURIComponent("Мама"),
      "x-isputnik-user-role": "member",
      "x-isputnik-user-lang": "ru",
      "x-isputnik-user-theme": "plain-dark"
    });
  });

  it("strips every x-isputnik-* header, whatever its case, and keeps the rest", () => {
    expect(stripIdentityHeaders({
      "x-isputnik-user-id": "forged", "X-Isputnik-Gateway": "forged", accept: "text/html", cookie: "a=b"
    })).toEqual({ accept: "text/html", cookie: "a=b" });
  });
});

describe("GET /games/*", () => {
  it("refuses anonymous visitors with this app's own 401", async () => {
    const res = await booted.app.inject({ method: "GET", url: "/games/" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Not authenticated" });
  });

  it("sends a signed-out page navigation to the sign-in screen, with the way back", async () => {
    const accept = "text/html,application/xhtml+xml,*/*;q=0.8";
    const page = await booted.app.inject({ method: "GET", url: "/games/dots?x=1", headers: { accept } });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/login?next=" + encodeURIComponent("/games/dots?x=1"));
    expect(page.body).toBe("");
    // The games front end's own API calls keep the 401 so it can say "signed out".
    const api = await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { accept } });
    expect(api.statusCode).toBe(401);
    // A signed-in navigation is proxied as before.
    const cookie = await booted.signIn("mum");
    expect((await booted.app.inject({ method: "GET", url: "/games/dots", headers: { accept, cookie } })).statusCode).toBe(200);
  });

  it("forwards a signed-in member's request with the identity headers", async () => {
    const cookie = await booted.signIn("mum");
    const res = await booted.app.inject({ method: "GET", url: "/games/api/me?x=1", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { url: string; headers: Record<string, string> };
    expect(body.url).toBe("/games/api/me?x=1");
    expect(body.headers["x-isputnik-gateway"]).toBe(SECRET);
    expect(body.headers["x-isputnik-user-id"]).toBe("mum");
    expect(decodeURIComponent(body.headers["x-isputnik-user-name"])).toBe("Мама");
    expect(body.headers["x-isputnik-user-role"]).toBe("member");
    expect(body.headers["x-isputnik-user-lang"]).toBe("ru");
    expect(body.headers["x-isputnik-user-theme"]).toBe("plain-dark");
  });

  it("drops identity headers the client tried to send", async () => {
    const cookie = await booted.signIn("mum");
    const res = await booted.app.inject({
      method: "GET",
      url: "/games/api/me",
      headers: { cookie, "x-isputnik-user-id": "admin-please", "x-isputnik-user-role": "admin", "x-isputnik-gateway": "guess" }
    });
    const body = res.json() as { headers: Record<string, string> };
    expect(body.headers["x-isputnik-user-id"]).toBe("mum");
    expect(body.headers["x-isputnik-user-role"]).toBe("member");
    expect(body.headers["x-isputnik-gateway"]).toBe(SECRET);
  });

  it("reaches the bare prefix and the pages, not just the API", async () => {
    const cookie = await booted.signIn("mum");
    for (const url of ["/games", "/games/", "/games/dots", "/games/static/app.js"]) {
      const res = await booted.app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      expect((res.json() as { url: string }).url).toBe(url);
    }
  });
});
