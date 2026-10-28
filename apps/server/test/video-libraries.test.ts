// Video libraries (modules/library/video): rows here, contents on the engine.
// A stand-in engine records what home asks of it, so these test the contract
// (docs/video-architecture.md → How they talk): what home sends, and what home
// does when the engine refuses or is not there.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { setSections, ALL_SECTIONS_ON } from "../src/core/sections.js";
import { videoPlugin } from "../src/modules/library/video/index.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "video-gateway-secret-0123456789abcdef";

interface Call { method: string; url: string; body: unknown; headers: Record<string, unknown> }
let calls: Call[];
let engine: FastifyInstance;
let engineUrl: string;
let booted: BootedApp;
/** What the stand-in engine knows, by library id. */
let known: Map<string, { name: string; kind: string; folder: string }>;

async function startEngine() {
  calls = [];
  known = new Map();
  engine = Fastify();
  engine.addHook("onRequest", async (request) => {
    calls.push({ method: request.method, url: request.url, body: undefined, headers: request.headers });
  });
  engine.addHook("preHandler", async (request) => {
    calls[calls.length - 1].body = request.body;
  });
  const signed = (request: { headers: Record<string, unknown> }) => request.headers["x-isputnik-gateway"] === SECRET;
  engine.put("/video/api/admin/libraries/:id", async (request, reply) => {
    if (!signed(request)) return reply.code(401).send({ error: "Not signed in" });
    const body = request.body as { name: string; kind: string; folder: string };
    if (body.folder === "Nope") return reply.code(422).send({ error: 'The folder "Nope" is not there on the video app' });
    const id = (request.params as { id: string }).id;
    const created = !known.has(id);
    known.set(id, body);
    return reply.code(created ? 201 : 200).send({ library: { id } });
  });
  engine.delete("/video/api/admin/libraries/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!known.delete(id)) return reply.code(404).send({ error: "No such library" });
    return { deleted: true };
  });
  engine.get("/video/api/admin/libraries", async () => ({
    libraries: [...known.keys()].map((id) => ({ id, state: "active", scanState: "idle", scanError: null, lastScanAt: "2026-10-26T08:00:00.000Z", titles: 17, episodes: 412, sizeBytes: 1234 }))
  }));
  engine.post("/video/api/admin/libraries/sync", async () => ({ detached: [], reattached: [] }));
  engine.post("/video/api/admin/libraries/:id/scan", async (_request, reply) => reply.code(202).send({}));
  engine.get("/video/api/admin/folders", async (request) => ({ path: (request.query as { path: string }).path, folders: [{ name: "Shows", path: "Shows", folders: 42 }] }));
  engine.get("/video/api/shows", async (request) => ({ headers: request.headers }));
  engine.get("/video/api/play/:id", async (request, reply) =>
    (request.params as { id: string }).id === "gone" ? reply.code(404).send({ error: "No such title" }) : { url: "/video/api/stream/x" });
  await engine.listen({ host: "127.0.0.1", port: 0 });
  const address = engine.server.address();
  engineUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mum", "member");
  await startEngine();
  booted = await bootApp({ plugins: [[videoPlugin, { upstream: engineUrl, secret: SECRET }]] });
});

afterEach(async () => {
  await booted.app.close();
  await engine.close();
});

const asAdmin = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  booted.app.inject({ method, url, payload: payload as never, headers: { cookie: await booted.signIn("admin") } });

const create = (payload: Record<string, unknown>) =>
  asAdmin("POST", "/api/library/video-libraries", { name: "TV Shows", kind: "shows", folder: "Shows", defaultLanguage: "ru", ...payload });

describe("creating a video library", () => {
  it("writes the row here and tells the engine, with home's id", async () => {
    const res = await create({});
    expect(res.statusCode).toBe(201);
    const id = res.json().library.id as string;
    const row = db.prepare("SELECT type, source_path, settings_json FROM libraries WHERE id = ?").get(id) as { type: string; source_path: string; settings_json: string };
    expect(row.type).toBe("video");
    // Never a folder of this server's: it cannot overlap one.
    expect(row.source_path).toBe("video:/Shows");
    expect(JSON.parse(row.settings_json)).toEqual({ kind: "shows", folder: "Shows", default_language: "ru" });
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toBe(`/video/api/admin/libraries/${id}`);
    expect(put?.body).toEqual({ name: "TV Shows", kind: "shows", folder: "Shows", language: "ru" });
    expect(put?.headers["x-isputnik-user-role"]).toBe("admin");
  });

  it("is not a library when the engine refuses its folder", async () => {
    const res = await create({ folder: "Nope" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain("not there on the video app");
    expect(db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE type = 'video'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'library'").get()).toEqual({ n: 0 });
  });

  it("is not a library when the engine is down", async () => {
    await engine.close();
    const res = await create({});
    expect(res.statusCode).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE type = 'video'").get()).toEqual({ n: 0 });
  });

  it("refuses a folder that climbs out, before asking anyone", async () => {
    expect((await create({ folder: "../etc" })).statusCode).toBe(400);
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("refuses a second library on the same folder", async () => {
    await create({});
    expect((await create({ name: "Again" })).statusCode).toBe(409);
  });
});

describe("listing", () => {
  it("shows an admin the engine's counts, and a member only what they may open", async () => {
    await create({});
    await create({ name: "Private films", kind: "movies", folder: "Movies", visibility: "private" });
    const managed = (await asAdmin("GET", "/api/library/video-libraries?manage=1")).json();
    expect(managed.engineOnline).toBe(true);
    const tv = managed.libraries.find((library: { name: string }) => library.name === "TV Shows");
    expect(tv).toMatchObject({ type: "video", kind: "shows", folder: "Shows", bookCount: 17, fileCount: 412, totalSizeBytes: 1234, engine: { online: true } });

    const member = (await booted.app.inject({ method: "GET", url: "/api/library/video-libraries", headers: { cookie: await booted.signIn("mum") } })).json();
    expect(member.libraries.map((library: { name: string }) => library.name)).toEqual(["TV Shows"]);
    // A member is never shown where the files are.
    expect(member.libraries[0].folder).toBeUndefined();
  });

  it("still lists the libraries when the engine is down, and says so", async () => {
    await create({});
    await engine.close();
    const managed = (await asAdmin("GET", "/api/library/video-libraries?manage=1")).json();
    expect(managed.engineOnline).toBe(false);
    expect(managed.libraries[0]).toMatchObject({ name: "TV Shows", bookCount: null, engine: { online: false } });
  });
});

describe("the gateway to the engine", () => {
  it("tells the engine which libraries the person may see, and only those", async () => {
    const open = (await create({})).json().library.id as string;
    const closed = (await create({ name: "Private", kind: "movies", folder: "Movies", visibility: "private" })).json().library.id as string;
    const mum = await booted.app.inject({ method: "GET", url: "/video/api/shows", headers: { cookie: await booted.signIn("mum") } });
    expect(mum.statusCode).toBe(200);
    expect(mum.json().headers["x-isputnik-libraries"]).toBe(open);
    // Granting Mum the private library is all it takes for the engine to show it.
    // (Straight into assignments: an admin holds no grant on a private library
    // nobody owns, so the members route is refused them, as for any library.)
    db.prepare("INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role) VALUES ('user', 'mum', 'library', ?, 'viewer')").run(closed);
    const again = await booted.app.inject({ method: "GET", url: "/video/api/shows", headers: { cookie: await booted.signIn("mum") } });
    expect(String(again.json().headers["x-isputnik-libraries"]).split(",").sort()).toEqual([open, closed].sort());
  });

  it("is not there while the Video section is off", async () => {
    setSections({ ...ALL_SECTIONS_ON, video: false }, "admin");
    const cookie = await booted.signIn("mum");
    expect((await booted.app.inject({ method: "GET", url: "/video/api/shows", headers: { cookie } })).statusCode).toBe(404);
    expect((await booted.app.inject({ method: "GET", url: "/api/video/status", headers: { cookie } })).json()).toEqual({ enabled: false });
  });
});

// Overview › Activity counts a title started as "Watched": the gateway notes the
// engine's play call, once per person and title for a few hours.
describe("watching through the gateway", () => {
  const played = () => db.prepare("SELECT actor_user_id AS who, target_id AS item FROM activity_logs WHERE event = 'library.video.played'").all();

  it("notes a title started, once however often the player asks", async () => {
    const cookie = await booted.signIn("mum");
    expect((await booted.app.inject({ method: "GET", url: "/video/api/play/m1", headers: { cookie } })).statusCode).toBe(200);
    await booted.app.inject({ method: "GET", url: "/video/api/play/m1?audio=1", headers: { cookie } });
    await booted.app.inject({ method: "GET", url: "/video/api/play/m2", headers: { cookie } });
    expect(played()).toEqual([{ who: "mum", item: "m1" }, { who: "mum", item: "m2" }]);
  });

  it("notes nothing for browsing, or for a title the engine does not have", async () => {
    const cookie = await booted.signIn("mum");
    await booted.app.inject({ method: "GET", url: "/video/api/shows", headers: { cookie } });
    expect((await booted.app.inject({ method: "GET", url: "/video/api/play/gone", headers: { cookie } })).statusCode).toBe(404);
    expect(played()).toEqual([]);
  });
});

describe("changing and deleting", () => {
  it("passes a new folder on, and puts the row back when the engine refuses it", async () => {
    const id = (await create({})).json().library.id as string;
    const moved = await asAdmin("PATCH", `/api/library/video-libraries/${id}`, { name: "Series", folder: "TV", defaultLanguage: "ru" });
    expect(moved.statusCode).toBe(200);
    expect(known.get(id)).toMatchObject({ name: "Series", folder: "TV", kind: "shows" });
    const refused = await asAdmin("PATCH", `/api/library/video-libraries/${id}`, { name: "Elsewhere", folder: "Nope", defaultLanguage: "ru" });
    expect(refused.statusCode).toBe(422);
    const row = db.prepare("SELECT name, source_path FROM libraries WHERE id = ?").get(id);
    expect(row).toEqual({ name: "Series", source_path: "video:/TV" });
  });

  it("deletes the row, its access and the engine's catalog", async () => {
    const id = (await create({})).json().library.id as string;
    expect((await asAdmin("DELETE", `/api/library/video-libraries/${id}`)).json()).toEqual({ deleted: true });
    expect(known.has(id)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE id = ?").get(id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_id = ?").get(id)).toEqual({ n: 0 });
  });

  it("deletes here even while the engine is down; the next sync lets it go there", async () => {
    const id = (await create({})).json().library.id as string;
    await engine.close();
    expect((await asAdmin("DELETE", `/api/library/video-libraries/${id}`)).json()).toEqual({ deleted: true });
    const log = db.prepare("SELECT detail FROM activity_logs WHERE event = 'library.video.deleted'").get() as { detail: string };
    expect(log.detail).toContain("next sync");
  });

  it("asks the engine to rescan", async () => {
    const id = (await create({})).json().library.id as string;
    expect((await asAdmin("POST", `/api/library/video-libraries/${id}/rescan`)).statusCode).toBe(202);
    expect(calls.some((call) => call.method === "POST" && call.url === `/video/api/admin/libraries/${id}/scan`)).toBe(true);
  });
});

describe("the folder picker", () => {
  it("shows the engine's folders to an admin only", async () => {
    const res = await asAdmin("GET", "/api/library/video-folders?path=");
    expect(res.json()).toEqual({ path: "", folders: [{ name: "Shows", path: "Shows", folders: 42 }] });
    const member = await booted.app.inject({ method: "GET", url: "/api/library/video-folders", headers: { cookie: await booted.signIn("mum") } });
    expect(member.statusCode).toBe(403);
  });
});

describe("syncing", () => {
  it("sends home's list to the engine when the server starts", async () => {
    // Started on ready without waiting for it, so it lands a moment later.
    await vi.waitFor(() => {
      const sync = calls.find((call) => call.url === "/video/api/admin/libraries/sync");
      expect(sync?.body).toEqual({ ids: [] });
    });
  });
});
