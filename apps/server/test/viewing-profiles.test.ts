// Viewing profiles (modules/profiles, docs/tv-profiles-plan.md phase P1): views of
// one account for a shared TV. What matters most here is that a profile only ever
// NARROWS: the engine is told fewer libraries, never more, and a section a profile
// leaves out is refused on the server, not just hidden on the screen.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { ALL_SECTIONS_ON } from "../src/core/sections.js";
import { videoPlugin } from "../src/modules/library/video/index.js";
import { profilesPlugin } from "../src/modules/profiles/index.js";
import { fencedSection } from "../src/modules/profiles/fence.js";
import { bootApp, type BootedApp, type TestSession } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "video-gateway-secret-0123456789abcdef";
let engine: FastifyInstance;
let booted: BootedApp;
let browser: TestSession;
let tv: TestSession;

beforeEach(async () => {
  resetDb();
  makeUser("dad", "member");
  makeUser("mum", "member");
  for (const id of ["films", "cartoons", "secret"]) makeLibrary(id, { createdBy: "dad", type: "video" });
  grant("user", "dad", "films", "viewer");
  grant("user", "dad", "cartoons", "viewer");
  grant("user", "mum", "secret", "viewer");

  engine = Fastify();
  engine.get("/video/api/shows", async (request) => ({ libraries: request.headers["x-isputnik-libraries"] }));
  await engine.listen({ host: "127.0.0.1", port: 0 });
  const address = engine.server.address();
  const upstream = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  booted = await bootApp({
    plugins: [[videoPlugin, { upstream, secret: SECRET }], profilesPlugin],
    afterRegister: (app) => {
      // Something in a section a Kids profile leaves out.
      app.get("/api/family-tree/test", { preHandler: app.authenticate }, async () => ({ ok: true }));
      app.get("/api/stories", { preHandler: app.authenticate }, async () => ({ ok: true }));
    }
  });
  browser = await booted.session("dad");
  tv = await booted.session("dad", { kind: "device", label: "Living Room TV" });
});

afterEach(async () => {
  await booted.app.close();
  await engine.close();
});

const kids = { name: "Kids", avatar: "green", restricted: true, libraries: ["cartoons"] };
const create = async (body: unknown = kids) => booted.as(browser.cookie).post("/api/profiles", body as never);
const wear = async (profileId: string | null, session = tv) => booted.as(session.cookie).post("/api/profiles/switch", { profileId });
const engineSees = async (session = tv) =>
  String((await booted.as(session.cookie).get("/video/api/shows")).json().libraries).split(",").filter(Boolean).sort();

describe("making profiles", () => {
  it("is done from a browser, and a restricted one starts with Video alone", async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(res.json().profile).toMatchObject({ name: "Kids", avatar: "green", restricted: true, libraries: ["cartoons"], sections: ["video"], ownRows: false });
    const list = (await booted.as(browser.cookie).get("/api/profiles")).json();
    expect(list.profiles).toHaveLength(1);
    expect(list).toMatchObject({ current: null, editable: true });
  });

  it("is refused on a TV, so the remote can't loosen Kids", async () => {
    expect((await booted.as(tv.cookie).post("/api/profiles", kids)).statusCode).toBe(403);
    const id = (await create()).json().profile.id as string;
    expect((await booted.as(tv.cookie).patch(`/api/profiles/${id}`, { ...kids, libraries: null })).statusCode).toBe(403);
    expect((await booted.as(tv.cookie).delete(`/api/profiles/${id}`)).statusCode).toBe(403);
    expect((await booted.as(tv.cookie).get("/api/profiles")).json().editable).toBe(false);
  });

  it("keeps only libraries the owner can see", async () => {
    const res = await create({ ...kids, libraries: ["cartoons", "secret", "nowhere"] });
    expect(res.json().profile.libraries).toEqual(["cartoons"]);
  });

  it("refuses a bad avatar or a blank name", async () => {
    expect((await create({ ...kids, avatar: "skull" })).statusCode).toBe(400);
    expect((await create({ ...kids, name: "  " })).statusCode).toBe(400);
  });

  it("are never another account's", async () => {
    const id = (await create()).json().profile.id as string;
    const mum = await booted.session("mum");
    const mumTv = await booted.session("mum", { kind: "device" });
    expect((await booted.as(mum.cookie).patch(`/api/profiles/${id}`, kids)).statusCode).toBe(404);
    expect((await booted.as(mum.cookie).delete(`/api/profiles/${id}`)).statusCode).toBe(404);
    expect((await wear(id, mumTv)).statusCode).toBe(404);
  });
});

describe("wearing a profile", () => {
  it("is a TV's: a browser session doesn't switch", async () => {
    const id = (await create()).json().profile.id as string;
    expect((await wear(id, browser)).statusCode).toBe(403);
  });

  it("narrows what the engine is told, and stays on the session", async () => {
    const id = (await create()).json().profile.id as string;
    expect(await engineSees()).toEqual(["cartoons", "films"]);
    const worn = await wear(id);
    expect(worn.statusCode).toBe(200);
    expect(worn.json()).toMatchObject({ current: id, sections: { ...Object.fromEntries(Object.keys(ALL_SECTIONS_ON).map((key) => [key, false])), video: true } });
    expect(await engineSees()).toEqual(["cartoons"]);
    expect(db.prepare("SELECT profile_id FROM sessions WHERE id = ?").get(tv.id)).toEqual({ profile_id: id });
    // The owner's own browser is untouched.
    expect(await engineSees(browser)).toEqual(["cartoons", "films"]);
    await wear(null);
    expect(await engineSees()).toEqual(["cartoons", "films"]);
  });

  it("never outlives the owner's own access", async () => {
    const id = (await create()).json().profile.id as string;
    await wear(id);
    db.prepare("DELETE FROM assignments WHERE subject_id = 'dad' AND object_id = 'cartoons'").run();
    expect(await engineSees()).toEqual([]);
    // Nor does a profile with every library widen anything.
    const all = (await create({ name: "Everything", avatar: "blue", libraries: null })).json().profile.id as string;
    await wear(all);
    expect(await engineSees()).toEqual(["films"]);
  });

  it("narrows the library list the screens draw", async () => {
    const id = (await create()).json().profile.id as string;
    await wear(id);
    const listed = (await booted.as(tv.cookie).get("/api/library/video-libraries")).json().libraries.map((row: { id: string }) => row.id);
    expect(listed).toEqual(["cartoons"]);
  });

  it("refuses the sections it leaves out, on the server", async () => {
    const id = (await create()).json().profile.id as string;
    expect((await booted.as(tv.cookie).get("/api/family-tree/test")).statusCode).toBe(200);
    await wear(id);
    expect((await booted.as(tv.cookie).get("/api/family-tree/test")).statusCode).toBe(403);
    expect((await booted.as(tv.cookie).get("/api/stories")).statusCode).toBe(403);
    // Its own list, and switching back, stay open.
    expect((await booted.as(tv.cookie).get("/api/profiles")).statusCode).toBe(200);
    expect((await wear(null)).statusCode).toBe(200);
    expect((await booted.as(tv.cookie).get("/api/stories")).statusCode).toBe(200);
  });

  it("goes back to the account when the profile is deleted", async () => {
    const id = (await create()).json().profile.id as string;
    await wear(id);
    expect((await booted.as(browser.cookie).delete(`/api/profiles/${id}`)).statusCode).toBe(200);
    expect(db.prepare("SELECT profile_id FROM sessions WHERE id = ?").get(tv.id)).toEqual({ profile_id: null });
    expect(await engineSees()).toEqual(["cartoons", "films"]);
  });
});

describe("a profile's video page", () => {
  const rows = [
    { id: "c", type: "continue" },
    { id: "toons", type: "titles", kind: "movies", libraries: ["cartoons"] },
    { id: "films", type: "titles", kind: "movies", libraries: ["films"] },
    { id: "both", type: "titles", kind: "all", libraries: ["films", "cartoons"] }
  ];

  it("follows the owner's page until it has its own", async () => {
    const id = (await create()).json().profile.id as string;
    await booted.as(browser.cookie).put("/api/video/home", { rows: [{ id: "s", type: "sets" }], scope: "mine" });
    await wear(id);
    const page = (await booted.as(tv.cookie).get("/api/video/home")).json();
    expect(page).toMatchObject({ profileId: id, own: false, rows: [{ id: "s", type: "sets" }] });
  });

  it("is the owner's to set from a browser, drawn on the TV that wears it, without rows it can't fill", async () => {
    const id = (await create()).json().profile.id as string;
    const saved = await booted.as(browser.cookie).put("/api/video/home", { rows, scope: "profile", profileId: id });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().own).toBe(true);
    // The owner's own page is untouched.
    expect((await booted.as(browser.cookie).get("/api/video/home")).json().rows).toHaveLength(4 /* the default rows */);
    await wear(id);
    const page = (await booted.as(tv.cookie).get("/api/video/home")).json();
    expect(page.rows.map((row: { id: string }) => row.id)).toEqual(["c", "toons", "both"]);
    expect(page.rows[2].libraries).toEqual(["cartoons"]);
    // The TV can't change it.
    expect((await booted.as(tv.cookie).put("/api/video/home", { rows, scope: "profile", profileId: id })).statusCode).toBe(403);
    // Reset: back to following the owner's.
    const reset = await booted.as(browser.cookie).delete(`/api/video/home?scope=profile&profile=${id}`);
    expect(reset.json().own).toBe(false);
  });

  it("needs a profile of the person's own", async () => {
    const id = (await create()).json().profile.id as string;
    const mum = await booted.session("mum");
    expect((await booted.as(mum.cookie).put("/api/video/home", { rows, scope: "profile", profileId: id })).statusCode).toBe(404);
    expect((await booted.as(mum.cookie).get(`/api/video/home?scope=profile&profile=${id}`)).statusCode).toBe(404);
    expect((await booted.as(browser.cookie).put("/api/video/home", { rows, scope: "profile" })).statusCode).toBe(400);
  });
});

describe("the section fence", () => {
  const only = (...keys: (keyof typeof ALL_SECTIONS_ON)[]) =>
    ({ ...Object.fromEntries(Object.keys(ALL_SECTIONS_ON).map((key) => [key, false])), ...Object.fromEntries(keys.map((key) => [key, true])) }) as typeof ALL_SECTIONS_ON;

  it("matches whole path segments", () => {
    expect(fencedSection("/video/api/shows", only("games"))).toBe("video");
    expect(fencedSection("/videos", only("games"))).toBeNull();
    expect(fencedSection("/api/library/video-libraries", only("games"))).toBe("video");
    expect(fencedSection("/api/library/gallery-libraries", only("video"))).toBe("gallery");
  });

  it("closes books only when both book sections are off", () => {
    expect(fencedSection("/api/library/books/x", only("audiobooks"))).toBeNull();
    expect(fencedSection("/api/library/books/x", only("video"))).toBe("audiobooks");
    expect(fencedSection("/api/library/audiobook-libraries", only("ebooks"))).toBe("audiobooks");
  });
});
