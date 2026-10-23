// What the games gateway writes to this app's own log (modules/games/gateway-log.ts)
// and the admin status's signed check: a games container holding a different
// secret refuses every signed request, and that has to show up HERE — it used to
// leave members on "Not signed in" with nothing in this app's log.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { gamesPlugin } from "../src/modules/games/index.js";
import { resetGatewayLog } from "../src/modules/games/gateway-log.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const GAMES_SECRET = "the-secret-the-games-container-holds";
const HTML = "text/html,application/xhtml+xml,*/*;q=0.8";

// A stand-in games server that checks the gateway secret the way the real one does.
let upstream: FastifyInstance;
let upstreamUrl: string;
let booted: BootedApp | null = null;

beforeEach(async () => {
  resetDb();
  resetGatewayLog();
  makeUser("mum", "member");
  makeUser("admin", "admin");
  db.prepare("UPDATE users SET display_name = 'Mum' WHERE id = 'mum'").run();

  upstream = Fastify();
  upstream.get("/games/api/health", async () => ({ ok: true, version: "0.8.1" }));
  upstream.all("/games/*", async (request, reply) => {
    if (request.headers["x-isputnik-gateway"] !== GAMES_SECRET) return reply.code(401).send({ error: "Not signed in" });
    return reply.code(request.method === "POST" ? 201 : 200).send({ ok: true });
  });
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const address = upstream.server.address();
  upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await booted?.app.close();
  booted = null;
  await upstream.close();
});

async function boot(secret: string): Promise<BootedApp> {
  booted = await bootApp({ plugins: [[gamesPlugin, { upstream: upstreamUrl, secret }]] });
  return booted;
}

function logRows(prefix = "games.") {
  return db.prepare("SELECT event, actor_user_id AS actor, target_id AS target, detail FROM activity_logs WHERE event LIKE ? ORDER BY created_at, rowid")
    .all(`${prefix}%`) as { event: string; actor: string | null; target: string | null; detail: string }[];
}

describe("a games container with a different secret", () => {
  it("is logged here as refused, once while it lasts", async () => {
    const app = await boot("a-secret-that-does-not-match-theirs");
    const cookie = await app.signIn("mum");
    for (let i = 0; i < 3; i++) {
      const res = await app.app.inject({ method: "GET", url: "/games/api/summary", headers: { cookie } });
      expect(res.statusCode).toBe(401);
    }
    const rows = logRows();
    expect(rows.map((row) => row.event)).toEqual(["games.refused"]);
    expect(rows[0].actor).toBe("mum");
    expect(rows[0].detail).toContain("GAMES_GATEWAY_SECRET");
  });

  it("shows on the admin status as a refused secret", async () => {
    const app = await boot("a-secret-that-does-not-match-theirs");
    const res = await app.app.inject({ method: "GET", url: "/api/games/admin/status", headers: { cookie: await app.signIn("admin") } });
    expect(res.json()).toMatchObject({ configured: true, secretSet: true, secretAccepted: false, server: { ok: true, version: "0.8.1" } });
  });

  it("says nothing for a visitor this app itself turned away", async () => {
    const app = await boot("a-secret-that-does-not-match-theirs");
    expect((await app.app.inject({ method: "GET", url: "/games/api/summary" })).statusCode).toBe(401);
    expect(logRows()).toEqual([]);
  });
});

describe("a working link", () => {
  it("reports the secret accepted", async () => {
    const app = await boot(GAMES_SECRET);
    const res = await app.app.inject({ method: "GET", url: "/api/games/admin/status", headers: { cookie: await app.signIn("admin") } });
    expect(res.json()).toMatchObject({ secretAccepted: true });
  });

  it("logs opening the games once per half hour, naming the game", async () => {
    const app = await boot(GAMES_SECRET);
    const cookie = await app.signIn("mum");
    await app.app.inject({ method: "GET", url: "/games/dots/m/abc", headers: { cookie, accept: HTML } });
    await app.app.inject({ method: "GET", url: "/games/", headers: { cookie, accept: HTML } });
    // The front end's own API calls are not "opening" anything.
    await app.app.inject({ method: "GET", url: "/games/api/summary", headers: { cookie, accept: HTML } });
    expect(logRows()).toEqual([{ event: "games.opened", actor: "mum", target: "dots", detail: "Mum opened dots in the games." }]);
  });

  it("logs the match decisions, not the moves", async () => {
    const app = await boot(GAMES_SECRET);
    const headers = { cookie: await app.signIn("mum"), "content-type": "application/json" };
    for (const url of ["/games/api/matches", "/games/api/matches/m1/accept", "/games/api/matches/m1/moves", "/games/api/matches/m1/resign"]) {
      expect((await app.app.inject({ method: "POST", url, headers, payload: "{}" })).statusCode, url).toBe(201);
    }
    expect(logRows().map((row) => [row.event, row.target])).toEqual([
      ["games.match_started", null],
      ["games.match_accepted", "m1"],
      ["games.match_resigned", "m1"]
    ]);
  });
});

describe("a games container that is down", () => {
  it("is logged here as unreachable", async () => {
    const app = await boot(GAMES_SECRET);
    await upstream.close();
    const cookie = await app.signIn("mum");
    const res = await app.app.inject({ method: "GET", url: "/games/api/summary", headers: { cookie } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(logRows().map((row) => row.event)).toEqual(["games.unreachable"]);
    // Restarted for afterEach's close.
    upstream = Fastify();
    await upstream.listen({ host: "127.0.0.1", port: 0 });
  });
});
