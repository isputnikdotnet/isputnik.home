// Control panel → Apps → Installed (modules/apps): every container this release
// knows, how it is set up, whether it answers and whether it takes our signature.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { appsPlugin } from "../src/modules/apps/index.js";
import { appConfigured, appDefinition } from "../src/modules/apps/registry.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "apps-secret-for-tests-0123456789abcdef";

// A stand-in games server: healthy, and it takes only SECRET.
let upstream: FastifyInstance;
let upstreamUrl: string;
let booted: BootedApp | null = null;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  upstream = Fastify();
  upstream.get("/games/api/health", async () => ({ ok: true, version: "0.17.0" }));
  upstream.get("/games/api/me", async (request, reply) =>
    request.headers["x-isputnik-gateway"] === SECRET ? { id: request.headers["x-isputnik-user-id"] } : reply.code(401).send({ error: "Not signed in" })
  );
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const address = upstream.server.address();
  upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await booted?.app.close();
  booted = null;
  await upstream.close();
});

async function boot(settings: { upstream: string; secret: string }) {
  booted = await bootApp({ plugins: [[appsPlugin, { settings: { games: settings } }]] });
  return booted;
}

describe("GET /api/apps/admin/status", () => {
  it("lists the games as not installed when no URL is set, and only to an admin", async () => {
    const app = await boot({ upstream: "", secret: "" });
    const res = await app.app.inject({ method: "GET", url: "/api/apps/admin/status", headers: { cookie: await app.signIn("admin") } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      apps: [{
        id: "games", kind: "app", prefix: "/games", configured: false, reason: null, url: null, secretSet: false,
        secretSource: "none", pairing: null, variables: { url: "GAMES_URL", secret: "GAMES_GATEWAY_SECRET", container: "GATEWAY_SECRET" },
        secretAccepted: null, server: null
      }]
    });
    expect((await app.app.inject({ method: "GET", url: "/api/apps/admin/status", headers: { cookie: await app.signIn("mum") } })).statusCode).toBe(403);
  });

  it("reports a running container that takes the signature", async () => {
    const app = await boot({ upstream: upstreamUrl, secret: SECRET });
    const res = await app.app.inject({ method: "GET", url: "/api/apps/admin/status", headers: { cookie: await app.signIn("admin") } });
    expect(res.json().apps[0]).toMatchObject({
      id: "games", configured: true, url: upstreamUrl, secretSet: true, secretAccepted: true, server: { ok: true, version: "0.17.0", error: null }
    });
  });

  it("tells a wrong secret apart from a working one", async () => {
    const app = await boot({ upstream: upstreamUrl, secret: "a-different-secret-0123456789abcdef" });
    const res = await app.app.inject({ method: "GET", url: "/api/apps/admin/status", headers: { cookie: await app.signIn("admin") } });
    expect(res.json().apps[0]).toMatchObject({ configured: true, secretAccepted: false, server: { ok: true } });
  });
});

describe("appConfigured", () => {
  const games = appDefinition("games");
  it("stays off, with a reason, while half set up", () => {
    expect(appConfigured(games, "", "")).toEqual({ enabled: false });
    expect(appConfigured(games, "http://games:4200", "").reason).toContain("GAMES_GATEWAY_SECRET");
    expect(appConfigured(games, "games:4200", SECRET).reason).toContain("http://");
    expect(appConfigured(games, "http://games:4200", SECRET)).toEqual({ enabled: true });
  });
});
