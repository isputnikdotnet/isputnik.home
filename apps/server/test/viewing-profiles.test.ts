// Viewing profiles (modules/profiles, docs/tv-profiles-plan.md): the household's ways of
// watching video, set up by an admin and worn by any TV or browser. What matters most is
// that a profile only ever NARROWS: the engine is told fewer libraries, never more, and
// never more than the signed-in account may see.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { videoPlugin } from "../src/modules/library/video/index.js";
import { profilesPlugin } from "../src/modules/profiles/index.js";
import { bootApp, type BootedApp, type TestSession } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

const SECRET = "video-gateway-secret-0123456789abcdef";
let engine: FastifyInstance;
let booted: BootedApp;
let admin: TestSession;
let tv: TestSession;
let mum: TestSession;
/** Profiles home asked the engine to forget the history of. */
let forgotten: string[];

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("dad", "member");
  makeUser("mum", "member");
  for (const id of ["films", "cartoons", "secret"]) makeLibrary(id, { createdBy: "admin", type: "video" });
  for (const id of ["films", "cartoons"]) grant("user", "dad", id, "viewer");
  grant("user", "mum", "cartoons", "viewer");

  engine = Fastify();
  forgotten = [];
  engine.get("/video/api/shows", async (request) => ({ libraries: request.headers["x-isputnik-libraries"] }));
  // Whose history the engine is asked for (P3).
  engine.get("/video/api/continue", async (request) => ({ profile: request.headers["x-isputnik-profile-id"] ?? null }));
  engine.delete("/video/api/admin/history/profiles/:id", async (request) => {
    forgotten.push((request.params as { id: string }).id);
    return { removed: 0 };
  });
  await engine.listen({ host: "127.0.0.1", port: 0 });
  const address = engine.server.address();
  const upstream = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  booted = await bootApp({ plugins: [[videoPlugin, { upstream, secret: SECRET }], profilesPlugin] });
  admin = await booted.session("admin");
  tv = await booted.session("dad", { kind: "device", label: "Living Room TV" });
  mum = await booted.session("mum");
});

afterEach(async () => {
  await booted.app.close();
  await engine.close();
});

const kids = { name: "Kids", avatar: "green", restricted: true, libraries: ["cartoons"] };
const create = async (body: unknown = kids) => booted.as(admin.cookie).post("/api/profiles", body as never);
const wear = async (profileId: string | null, session = tv) => booted.as(session.cookie).post("/api/profiles/switch", { profileId });
const engineSees = async (session = tv) =>
  String((await booted.as(session.cookie).get("/video/api/shows")).json().libraries).split(",").filter(Boolean).sort();

describe("setting profiles up", () => {
  it("is an admin's, for the whole household", async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(res.json().profile).toMatchObject({ name: "Kids", avatar: "green", restricted: true, libraries: ["cartoons"], ownRows: false });
    // Everyone sees the same list; only an admin at a keyboard may change it.
    const seen = (await booted.as(mum.cookie).get("/api/profiles")).json();
    expect(seen.profiles.map((profile: { name: string }) => profile.name)).toEqual(["Kids"]);
    expect(seen.editable).toBe(false);
    expect((await booted.as(admin.cookie).get("/api/profiles")).json().editable).toBe(true);
    expect(db.prepare("SELECT created_by FROM viewing_profiles").get()).toEqual({ created_by: "admin" });
  });

  it("is refused to members and to TVs, even an admin's", async () => {
    const id = (await create()).json().profile.id as string;
    expect((await booted.as(mum.cookie).post("/api/profiles", kids)).statusCode).toBe(403);
    expect((await booted.as(mum.cookie).patch(`/api/profiles/${id}`, { ...kids, libraries: null })).statusCode).toBe(403);
    const adminTv = await booted.session("admin", { kind: "device" });
    expect((await booted.as(adminTv.cookie).delete(`/api/profiles/${id}`)).statusCode).toBe(403);
  });

  it("keeps only video libraries", async () => {
    makeLibrary("books", { createdBy: "admin", type: "audiobook" });
    const res = await create({ ...kids, libraries: ["cartoons", "books", "nowhere"] });
    expect(res.json().profile.libraries).toEqual(["cartoons"]);
  });

  it("refuses a bad avatar or a blank name", async () => {
    expect((await create({ ...kids, avatar: "skull" })).statusCode).toBe(400);
    expect((await create({ ...kids, name: "  " })).statusCode).toBe(400);
  });
});

describe("wearing a profile", () => {
  it("works on a TV and in a browser, each session on its own", async () => {
    const id = (await create()).json().profile.id as string;
    expect(await engineSees()).toEqual(["cartoons", "films"]);
    const worn = await wear(id);
    expect(worn.statusCode).toBe(200);
    expect(worn.json()).toMatchObject({ current: id });
    expect(await engineSees()).toEqual(["cartoons"]);
    expect(db.prepare("SELECT profile_id FROM sessions WHERE id = ?").get(tv.id)).toEqual({ profile_id: id });
    // Dad's browser is a session of its own and isn't wearing anything.
    const dadBrowser = await booted.session("dad");
    expect(await engineSees(dadBrowser)).toEqual(["cartoons", "films"]);
    expect((await wear(id, dadBrowser)).statusCode).toBe(200);
    expect(await engineSees(dadBrowser)).toEqual(["cartoons"]);
    await wear(null);
    expect(await engineSees()).toEqual(["cartoons", "films"]);
  });

  it("never shows more than the account may see", async () => {
    const all = (await create({ name: "Everything", avatar: "blue", libraries: null })).json().profile.id as string;
    const secret = (await create({ name: "Secret", avatar: "red", libraries: ["secret", "cartoons"] })).json().profile.id as string;
    await wear(all, mum);
    expect(await engineSees(mum)).toEqual(["cartoons"]);
    await wear(secret, mum);
    expect(await engineSees(mum)).toEqual(["cartoons"]);
    db.prepare("DELETE FROM assignments WHERE subject_id = 'mum'").run();
    expect(await engineSees(mum)).toEqual([]);
  });

  it("narrows the library list the screens draw", async () => {
    const id = (await create()).json().profile.id as string;
    await wear(id);
    const listed = (await booted.as(tv.cookie).get("/api/library/video-libraries")).json().libraries.map((row: { id: string }) => row.id);
    expect(listed).toEqual(["cartoons"]);
  });

  it("is a video thing only: the rest of the account is untouched", async () => {
    const id = (await create()).json().profile.id as string;
    await wear(id, mum);
    // No PIN set: nothing is locked, and a browser is never fenced.
    expect((await booted.as(mum.cookie).get("/api/profiles")).json()).toMatchObject({ current: id, locked: false });
  });

  it("goes back to the account when the profile is deleted", async () => {
    const id = (await create()).json().profile.id as string;
    await wear(id);
    expect((await booted.as(admin.cookie).delete(`/api/profiles/${id}`)).statusCode).toBe(200);
    expect(db.prepare("SELECT profile_id FROM sessions WHERE id = ?").get(tv.id)).toEqual({ profile_id: null });
    expect(await engineSees()).toEqual(["cartoons", "films"]);
  });

  it("refuses a profile that doesn't exist", async () => {
    expect((await wear("nope")).statusCode).toBe(404);
  });
});

describe("a profile's video page", () => {
  const rows = [
    { id: "c", type: "continue" },
    { id: "toons", type: "titles", kind: "movies", libraries: ["cartoons"] },
    { id: "films", type: "titles", kind: "movies", libraries: ["films"] },
    { id: "both", type: "titles", kind: "all", libraries: ["films", "cartoons"] }
  ];

  it("follows the household's page until it has its own, never a person's own", async () => {
    const id = (await create()).json().profile.id as string;
    await booted.as(admin.cookie).put("/api/video/home", { rows: [{ id: "s", type: "sets" }] });
    // Dad's own "Just me" rows don't reach the profile.
    const dadBrowser = await booted.session("dad");
    await booted.as(dadBrowser.cookie).put("/api/video/home", { rows: [{ id: "m", type: "mylist" }], scope: "mine" });
    await wear(id);
    const page = (await booted.as(tv.cookie).get("/api/video/home")).json();
    expect(page).toMatchObject({ profileId: id, own: false, rows: [{ id: "s", type: "sets" }] });
  });

  it("is set by an admin, drawn wherever the profile is worn, without rows it can't fill", async () => {
    const id = (await create()).json().profile.id as string;
    const saved = await booted.as(admin.cookie).put("/api/video/home", { rows, scope: "profile", profileId: id });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().own).toBe(true);
    // The household's page is untouched.
    expect((await booted.as(admin.cookie).get("/api/video/home?scope=everyone")).json().rows).toHaveLength(4 /* the default rows */);
    await wear(id);
    const page = (await booted.as(tv.cookie).get("/api/video/home")).json();
    expect(page.rows.map((row: { id: string }) => row.id)).toEqual(["c", "toons", "both"]);
    expect(page.rows[2].libraries).toEqual(["cartoons"]);
    // Not a member's, and not a TV's.
    expect((await booted.as(mum.cookie).put("/api/video/home", { rows, scope: "profile", profileId: id })).statusCode).toBe(403);
    expect((await booted.as(tv.cookie).put("/api/video/home", { rows, scope: "profile", profileId: id })).statusCode).toBe(403);
    // Anyone may read it.
    expect((await booted.as(mum.cookie).get(`/api/video/home?scope=profile&profile=${id}`)).statusCode).toBe(200);
    // Reset: back to following the household's.
    const reset = await booted.as(admin.cookie).delete(`/api/video/home?scope=profile&profile=${id}`);
    expect(reset.json().own).toBe(false);
  });

  it("needs a profile that exists", async () => {
    expect((await booted.as(admin.cookie).put("/api/video/home", { rows, scope: "profile", profileId: "nope" })).statusCode).toBe(404);
    expect((await booted.as(admin.cookie).put("/api/video/home", { rows, scope: "profile" })).statusCode).toBe(400);
  });
});

describe("a profile's own history (P3)", () => {
  it("is what the engine is asked for while the profile is worn", async () => {
    const id = (await create()).json().profile.id as string;
    const whose = async (session = tv) => (await booted.as(session.cookie).get("/video/api/continue")).json().profile;
    expect(await whose()).toBeNull();
    await wear(id);
    expect(await whose()).toBe(id);
    // Not something a client can claim for itself.
    const claimed = await booted.as(mum.cookie).get("/video/api/continue", undefined, { "x-isputnik-profile-id": id });
    expect(claimed.json().profile).toBeNull();
    await wear(null);
    expect(await whose()).toBeNull();
  });

  it("keeps My list apart: the profile's, whoever watches as it", async () => {
    db.prepare("INSERT INTO video_refs (kind, entity_id, library_id, title) VALUES ('movies', 'toon', 'cartoons', 'Toon'), ('movies', 'film', 'films', 'Film')").run();
    const id = (await create()).json().profile.id as string;
    const list = async (session: TestSession) => (await booted.as(session.cookie).get("/api/video/my-list")).json().items.map((item: { id: string }) => item.id);
    // Dad's own list, from his browser.
    const dad = await booted.session("dad");
    expect((await booted.as(dad.cookie).put("/api/video/my-list/movies/film")).statusCode).toBe(200);
    // The TV, as Kids.
    await wear(id);
    expect(await list(tv)).toEqual([]);
    expect((await booted.as(tv.cookie).put("/api/video/my-list/movies/toon")).json()).toEqual({ inList: true });
    // A film outside the profile's libraries can't go on its list.
    expect((await booted.as(tv.cookie).put("/api/video/my-list/movies/film")).statusCode).toBe(404);
    expect(await list(tv)).toEqual(["toon"]);
    expect(await list(dad)).toEqual(["film"]);
    // Mum watching as Kids sees Kids' list.
    await wear(id, mum);
    expect(await list(mum)).toEqual(["toon"]);
    expect((await booted.as(mum.cookie).get("/api/video/my-list/movies/toon")).json()).toEqual({ inList: true });
    await booted.as(mum.cookie).delete("/api/video/my-list/movies/toon");
    expect(await list(tv)).toEqual([]);
  });

  it("goes with the profile: its list here, and its history on the engine", async () => {
    db.prepare("INSERT INTO video_refs (kind, entity_id, library_id, title) VALUES ('movies', 'toon', 'cartoons', 'Toon')").run();
    const id = (await create()).json().profile.id as string;
    await wear(id);
    await booted.as(tv.cookie).put("/api/video/my-list/movies/toon");
    expect((await booted.as(admin.cookie).delete(`/api/profiles/${id}`)).statusCode).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM video_profile_my_list").get()).toEqual({ n: 0 });
    // The engine call is fire-and-forget: give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(forgotten).toEqual([id]);
  });
});
