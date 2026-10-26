// Pairing a container on Control panel → Apps → Setup (modules/apps/pairing.ts):
// a secret made here, kept sealed, shown once, and used by the gateway at once;
// the environment's secret always wins.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { appsPlugin } from "../src/modules/apps/index.js";
import { resolveAppSecret } from "../src/modules/apps/pairing.js";
import { gamesPlugin } from "../src/modules/games/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

let upstream: FastifyInstance;
let upstreamUrl: string;
let booted: BootedApp;
const savedUrl = config.gamesUrl;
const savedSecret = config.gamesGatewaySecret;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  upstream = Fastify();
  upstream.all("/games/*", async (request) => ({ url: request.url, headers: request.headers }));
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const address = upstream.server.address();
  upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  // The install's environment: an address, and no secret of its own.
  config.gamesUrl = upstreamUrl;
  config.gamesGatewaySecret = "";
  booted = await bootApp({ plugins: [appsPlugin, gamesPlugin] });
});

afterEach(async () => {
  await booted.app.close();
  await upstream.close();
  config.gamesUrl = savedUrl;
  config.gamesGatewaySecret = savedSecret;
});

const asAdmin = async (method: "GET" | "POST" | "DELETE", url: string) =>
  booted.app.inject({ method, url, headers: { cookie: await booted.signIn("admin") } });

describe("pairing", () => {
  it("makes a secret, shows it once and keeps it sealed", async () => {
    const res = await asAdmin("POST", "/api/apps/admin/pairing/games");
    expect(res.statusCode).toBe(201);
    const { secret, variable } = res.json() as { secret: string; variable: string };
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(variable).toBe("GATEWAY_SECRET");
    const stored = db.prepare("SELECT secret_sealed FROM app_pairings WHERE app_id = 'games'").get() as { secret_sealed: string };
    expect(stored.secret_sealed.startsWith("enc:v1:")).toBe(true);
    expect(stored.secret_sealed).not.toContain(secret);
    expect(resolveAppSecret("games")).toEqual({ upstream: upstreamUrl, secret, source: "paired" });
  });

  it("is used by the gateway at once, with no restart", async () => {
    const cookie = await booted.signIn("mum");
    // No secret yet: the games are not there.
    expect((await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie } })).statusCode).toBe(404);
    const { secret } = (await asAdmin("POST", "/api/apps/admin/pairing/games")).json() as { secret: string };
    const res = await booted.app.inject({ method: "GET", url: "/games/api/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().headers["x-isputnik-gateway"]).toBe(secret);
  });

  it("replaces the secret on a second go, and forgets it", async () => {
    const first = (await asAdmin("POST", "/api/apps/admin/pairing/games")).json().secret;
    const second = (await asAdmin("POST", "/api/apps/admin/pairing/games")).json().secret;
    expect(second).not.toBe(first);
    expect(resolveAppSecret("games").secret).toBe(second);
    const status = (await asAdmin("GET", "/api/apps/admin/status")).json().apps[0];
    expect(status).toMatchObject({ secretSource: "paired", secretSet: true, pairing: { pairedBy: "admin" } });
    await asAdmin("DELETE", "/api/apps/admin/pairing/games");
    expect(resolveAppSecret("games")).toMatchObject({ secret: "", source: "none" });
  });

  it("refuses while the environment sets a secret, which wins", async () => {
    config.gamesGatewaySecret = "environment-secret-0123456789abcdef";
    const res = await asAdmin("POST", "/api/apps/admin/pairing/games");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("GAMES_GATEWAY_SECRET");
    expect(resolveAppSecret("games")).toMatchObject({ source: "environment" });
  });

  it("is for administrators only", async () => {
    const res = await booted.app.inject({ method: "POST", url: "/api/apps/admin/pairing/games", headers: { cookie: await booted.signIn("mum") } });
    expect(res.statusCode).toBe(403);
  });
});
