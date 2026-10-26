// Who may use a container, and from where (modules/apps/access.ts), as the
// gateway enforces it and Control panel → Apps → Access edits it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { appsPlugin } from "../src/modules/apps/index.js";
import { registerGamesGateway } from "../src/modules/games/gateway.js";
import { gamesPlugin } from "../src/modules/games/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "gateway-secret-for-tests";
const LAN = "192.168.2.10";
const OUTSIDE = "203.0.113.5";

let upstream: FastifyInstance;
let booted: BootedApp;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  makeUser("kid", "member");
  db.prepare("INSERT INTO user_groups (id, name, created_by) VALUES ('grp-kids', 'Kids', 'admin')").run();
  db.prepare("INSERT INTO group_members (group_id, user_id) VALUES ('grp-kids', 'kid')").run();

  // A stand-in games server that answers with the headers it received.
  upstream = Fastify();
  upstream.all("/games/*", async (request) => ({ url: request.url, headers: request.headers }));
  await upstream.listen({ host: "127.0.0.1", port: 0 });
  const address = upstream.server.address();
  const upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  booted = await bootApp({
    plugins: [appsPlugin, gamesPlugin],
    afterRegister: (app) => registerGamesGateway(app, { upstream: upstreamUrl, secret: SECRET })
  });
});

afterEach(async () => {
  await booted.app.close();
  await upstream.close();
});

async function games(userId: string, path = "/games/api/me", remoteAddress = LAN) {
  return booted.app.inject({ method: "GET", url: path, remoteAddress, headers: { cookie: await booted.signIn(userId) } });
}

async function admin(method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) {
  return booted.app.inject({ method, url, payload: payload as never, headers: { cookie: await booted.signIn("admin") } });
}

describe("who may use a container", () => {
  it("lets every signed-in member in until access is set, and says so in the headers", async () => {
    const res = await games("mum");
    expect(res.statusCode).toBe(200);
    expect(res.json().headers).toMatchObject({ "x-isputnik-app-role": "member", "x-isputnik-via": "session", "x-isputnik-network": "home" });
    // Nothing written until an admin changes something.
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'app'").get()).toEqual({ n: 0 });
  });

  it("makes administrators managers, whatever the grants say", async () => {
    await admin("PUT", "/api/apps/admin/access/games/everyone", { role: null });
    const res = await games("admin");
    expect(res.json().headers["x-isputnik-app-role"]).toBe("manager");
  });

  it("takes the container away from everyone but the people granted it", async () => {
    await admin("PUT", "/api/apps/admin/access/games/everyone", { role: null });
    await admin("POST", "/api/apps/admin/access/games/grants", { subjectType: "user", subjectId: "mum", role: "member" });
    expect((await games("mum")).statusCode).toBe(200);
    // Not there for the kid: 404, as when the section is off.
    expect((await games("kid")).statusCode).toBe(404);
    const status = await booted.app.inject({ method: "GET", url: "/api/games/status", headers: { cookie: await booted.signIn("kid") } });
    expect(status.json()).toEqual({ enabled: false });
  });

  it("writes the old baseline down before the first change, so Everyone keeps its role", async () => {
    await admin("POST", "/api/apps/admin/access/games/grants", { subjectType: "group", subjectId: "grp-kids", role: "deny" });
    const everyone = db.prepare("SELECT role FROM assignments WHERE object_type = 'app' AND subject_id = ?").get(EVERYONE_GROUP_ID);
    expect(everyone).toEqual({ role: "member" });
    expect((await games("mum")).statusCode).toBe(200);
    // A deny on a group blocks its members.
    expect((await games("kid")).statusCode).toBe(404);
  });

  it("forwards the manager role a grant gives", async () => {
    await admin("POST", "/api/apps/admin/access/games/grants", { subjectType: "user", subjectId: "mum", role: "manager" });
    expect((await games("mum")).json().headers["x-isputnik-app-role"]).toBe("manager");
  });
});

describe("from where", () => {
  it("holds a capability to trusted networks when the rule says so", async () => {
    await admin("PUT", "/api/apps/admin/access/games/rules", { play: "trusted" });
    const refused = await games("mum");
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ capability: "play", rule: "trusted" });
    db.prepare("INSERT INTO trusted_networks (id, cidr, label) VALUES ('t1', '192.168.2.0/24', 'Home')").run();
    const allowed = await games("mum");
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().headers["x-isputnik-network"]).toBe("trusted");
  });

  it("holds a capability to the home network, and applies it to each capability on its own", async () => {
    await admin("PUT", "/api/apps/admin/access/games/rules", { manage: "home" });
    expect((await games("admin", "/games/api/admin/log", OUTSIDE)).statusCode).toBe(403);
    expect((await games("admin", "/games/api/admin/log", LAN)).statusCode).toBe(200);
    // Play stays at its default, anywhere.
    const outside = await games("mum", "/games/api/me", OUTSIDE);
    expect(outside.statusCode).toBe(200);
    expect(outside.json().headers["x-isputnik-network"]).toBe("internet");
  });
});

describe("the admin API", () => {
  it("shows the baseline before anything is set, and only to an admin", async () => {
    const res = await admin("GET", "/api/apps/admin/access/games");
    expect(res.json()).toEqual({
      app: "games",
      everyone: "member",
      grants: [],
      capabilities: [
        { id: "manage", rule: "anywhere", defaultRule: "anywhere" },
        { id: "play", rule: "anywhere", defaultRule: "anywhere" }
      ]
    });
    const member = await booted.app.inject({ method: "GET", url: "/api/apps/admin/access/games", headers: { cookie: await booted.signIn("mum") } });
    expect(member.statusCode).toBe(403);
  });

  it("lists grants by name and removes them", async () => {
    await admin("POST", "/api/apps/admin/access/games/grants", { subjectType: "group", subjectId: "grp-kids", role: "deny" });
    const listed = await admin("GET", "/api/apps/admin/access/games");
    expect(listed.json().grants).toEqual([{ subjectType: "group", subjectId: "grp-kids", role: "deny", name: "Kids", email: null, missing: false }]);
    const removed = await admin("DELETE", "/api/apps/admin/access/games/grants/group/grp-kids");
    expect(removed.json().grants).toEqual([]);
    expect(removed.json().everyone).toBe("member");
  });

  it("refuses an unknown app, subject or capability", async () => {
    expect((await admin("GET", "/api/apps/admin/access/nope")).statusCode).toBe(404);
    expect((await admin("POST", "/api/apps/admin/access/games/grants", { subjectType: "user", subjectId: "ghost", role: "member" })).statusCode).toBe(404);
    expect((await admin("PUT", "/api/apps/admin/access/games/rules", { fly: "home" })).statusCode).toBe(400);
    expect((await admin("PUT", "/api/apps/admin/access/games/rules", { play: "moon" })).statusCode).toBe(400);
  });
});
