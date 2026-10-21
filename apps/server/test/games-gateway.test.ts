// The gateway to isputnik.games (modules/games/gateway.ts): every request under
// /games goes through authenticate and reaches the games server with the member's
// identity in signed headers — and with any such header the client sent dropped.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { registerGamesGateway, identityHeaders, stripIdentityHeaders } from "../src/modules/games/gateway.js";
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
    afterRegister: (app) => registerGamesGateway(app, { upstream: upstreamUrl, secret: SECRET })
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
