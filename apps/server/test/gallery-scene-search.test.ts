// Scene search, S3 (docs/scene-search-plan.md): ranking, the cutoff, and above all
// that a search returns nothing its asker could not already open. The engine is a
// stand-in that maps a word to an axis, so "what looks like hockey" is exact here
// and every assertion is about what home does with the ranking.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { SCENE_DIMENSIONS, SCENE_MODEL } from "../src/modules/library/gallery/scene/model-id.js";
import { encodeSceneVector } from "../src/modules/library/gallery/scene/vectors.js";
import { NoSceneEngineError, SceneEngineError, setSceneEngine, type SceneEngine } from "../src/modules/library/gallery/scene/engine-client.js";
import { setSceneSearchEnabled } from "../src/modules/library/gallery/scene/settings.js";
import { SCENE_MAX_RESULTS, clearSceneSearchCache, rankScenes } from "../src/modules/library/gallery/scene/search.js";
import { gallerySceneRoutesPlugin } from "../src/modules/library/gallery/scene/routes.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";
import { bootApp } from "./helpers/boot.js";

const AXES: Record<string, number> = { hockey: 1, beach: 2, cake: 3 };

/** A unit vector made of the given amounts of each word's axis. */
function mix(parts: Record<string, number>): Float32Array {
  const v = new Float32Array(SCENE_DIMENSIONS);
  for (const [word, amount] of Object.entries(parts)) v[AXES[word]] = amount;
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return v.map((x) => x / norm);
}

let clock = Date.parse("2024-01-01T00:00:00Z");

/** A photo (or a video) already described as `shows`. */
async function described(libraryId: string, name: string, shows: Record<string, number>, extension = "jpg"): Promise<string> {
  clock += 60_000;
  const relativePath = `${name}.${extension}`;
  const itemId = await ingestGalleryAsset(libraryId, {
    absolutePath: `/src/${libraryId}/${relativePath}`, relativePath, fileName: relativePath,
    extension: `.${extension}`, kind: kindForExtension(`.${extension}`)!, size: 1000, modifiedAtMs: clock
  }, false);
  db.prepare("INSERT INTO gallery_scene_vectors (item_id, model, vector) VALUES (?, ?, ?)").run(itemId, SCENE_MODEL, encodeSceneVector(mix(shows)));
  return itemId;
}

let asked: string[] = [];
let textFails: Error | null = null;
const engine: SceneEngine = {
  async status() { return { available: true, version: "0.2.0", reason: null }; },
  async ensure() { /* there */ },
  async embedImage() { throw new Error("the search never sends a picture"); },
  async embedText(text) {
    asked.push(text);
    if (textFails) throw textFails;
    const word = Object.keys(AXES).find((candidate) => text.toLowerCase().includes(candidate));
    return word ? mix({ [word]: 1 }) : new Float32Array(SCENE_DIMENSIONS);
  }
};

function seed(): void {
  resetDb();
  clearSceneSearchCache();
  asked = [];
  textFails = null;
  makeUser("admin", "admin");
  makeUser("mum");
  makeUser("dad");
  makeLibrary("FAMILY", { createdBy: "admin", type: "gallery" });
  makeLibrary("PRIVATE", { createdBy: "admin", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "FAMILY", "member");
  grant("user", "dad", "PRIVATE", "member");
  setSceneEngine(engine);
  setSceneSearchEnabled(true, "admin");
}

describe("ranking", () => {
  beforeEach(seed);
  afterEach(() => setSceneEngine(null));

  it("returns what looks like the words, best first, and nothing that does not", async () => {
    const strong = await described("FAMILY", "game", { hockey: 1 });
    const good = await described("FAMILY", "rink", { hockey: 0.9, beach: 0.4 });
    await described("FAMILY", "sea", { beach: 1 });
    const hits = await rankScenes(["FAMILY"], "hockey");
    expect(hits.map((hit) => hit.itemId)).toEqual([strong, good]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("drops what falls far below the best hit, even when it clears the floor", async () => {
    const strong = await described("FAMILY", "game", { hockey: 1 });
    // 0.3 of the way to hockey: well over the floor, well under 60% of the best.
    await described("FAMILY", "hint", { hockey: 0.3, beach: 0.95 });
    expect((await rankScenes(["FAMILY"], "hockey")).map((hit) => hit.itemId)).toEqual([strong]);
  });

  it("finds nothing for words no photo looks like", async () => {
    await described("FAMILY", "sea", { beach: 1 });
    expect(await rankScenes(["FAMILY"], "hockey")).toEqual([]);
    expect(await rankScenes([], "beach")).toEqual([]);
  });

  it("looks only in the libraries it is handed", async () => {
    await described("PRIVATE", "secret-game", { hockey: 1 });
    expect(await rankScenes(["FAMILY"], "hockey")).toEqual([]);
  });

  it("ignores vectors another model made, and photos in the bin", async () => {
    const old = await described("FAMILY", "old", { hockey: 1 });
    db.prepare("UPDATE gallery_scene_vectors SET model = 'older/1' WHERE item_id = ?").run(old);
    const binned = await described("FAMILY", "binned", { hockey: 1 });
    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(binned);
    expect(await rankScenes(["FAMILY"], "hockey")).toEqual([]);
  });

  it("asks the engine once for the same words, however they are cased", async () => {
    await described("FAMILY", "game", { hockey: 1 });
    await rankScenes(["FAMILY"], "Hockey");
    await rankScenes(["FAMILY"], "hockey");
    expect(asked).toEqual(["Hockey"]);
  });
});

describe("POST /api/library/gallery/scene/search", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;
  let as: Awaited<ReturnType<typeof bootApp>>["as"];
  const URL = "/api/library/gallery/scene/search";
  const ids = (res: { json(): { assets: { id: string }[] } }) => res.json().assets.map((asset) => asset.id);

  beforeEach(async () => {
    seed();
    ({ app, signIn, as } = await bootApp({ plugins: [gallerySceneRoutesPlugin] }));
  });

  afterEach(async () => {
    await app.close();
    setSceneEngine(null);
  });

  it("needs someone signed in, and something to look for", async () => {
    expect((await as().post(URL, { q: "hockey" })).statusCode).toBe(401);
    const mum = as(await signIn("mum"));
    expect((await mum.post(URL, {})).statusCode).toBe(400);
    expect((await mum.post(URL, { q: "h" })).statusCode).toBe(400);
  });

  it("answers a member with the photos that look like it, as gallery assets, best first", async () => {
    const strong = await described("FAMILY", "game", { hockey: 1 });
    const good = await described("FAMILY", "rink", { hockey: 0.9, beach: 0.4 });
    await described("FAMILY", "sea", { beach: 1 });
    const res = await as(await signIn("mum")).post(URL, { q: "hockey" });
    expect(res.statusCode).toBe(200);
    expect(res.json().available).toBe(true);
    expect(ids(res)).toEqual([strong, good]);
    expect(res.json().assets[0]).toMatchObject({ id: strong, kind: "photo", libraryId: "FAMILY" });
  });

  it("never returns a photo from a library the asker cannot open, whatever its score", async () => {
    const family = await described("FAMILY", "rink", { hockey: 0.9, beach: 0.4 });
    const secret = await described("PRIVATE", "secret-game", { hockey: 1 });

    // Mum has FAMILY only: the perfect match in PRIVATE is not hers to find.
    expect(ids(await as(await signIn("mum")).post(URL, { q: "hockey" }))).toEqual([family]);
    // Naming the library in the filter does not open it either.
    expect(ids(await as(await signIn("mum")).post(URL, { q: "hockey", filters: { libraries: ["PRIVATE"] } }))).toEqual([]);
    // Dad was granted PRIVATE: for him it is the best hit.
    expect(ids(await as(await signIn("dad")).post(URL, { q: "hockey" }))).toEqual([secret, family]);
  });

  it("keeps a personal library's photos to its owner", async () => {
    makeLibrary("MUMS", { createdBy: "admin", type: "gallery" });
    db.prepare("UPDATE libraries SET personal_user_id = 'mum' WHERE id = 'MUMS'").run();
    grant("user", "mum", "MUMS", "manager");
    const hers = await described("MUMS", "her-beach", { beach: 1 });
    expect(ids(await as(await signIn("mum")).post(URL, { q: "beach" }))).toEqual([hers]);
    expect(ids(await as(await signIn("dad")).post(URL, { q: "beach" }))).toEqual([]);
  });

  it("leaves the Photo Inbox and App files out, even for an admin", async () => {
    makeLibrary("INBOX", { createdBy: "admin", type: "gallery", role: "inbox" });
    makeLibrary("APPFILES", { createdBy: "admin", type: "gallery", role: "app-files" });
    await described("INBOX", "unkept", { cake: 1 });
    await described("APPFILES", "recording", { cake: 1 });
    const kept = await described("FAMILY", "birthday", { cake: 1 });
    expect(ids(await as(await signIn("admin")).post(URL, { q: "cake" }))).toEqual([kept]);
    expect(ids(await as(await signIn("admin")).post(URL, { q: "cake", filters: { libraries: ["INBOX"] } }))).toEqual([]);
  });

  it("respects the filters that are on", async () => {
    const photo = await described("FAMILY", "game", { hockey: 1 });
    const clip = await described("FAMILY", "game-clip", { hockey: 0.95, beach: 0.3 }, "mp4");
    const mum = as(await signIn("mum"));
    expect(ids(await mum.post(URL, { q: "hockey" }))).toEqual([photo, clip]);
    expect(ids(await mum.post(URL, { q: "hockey", kinds: ["video"] }))).toEqual([clip]);
    expect(ids(await mum.post(URL, { q: "hockey", filters: { libraries: ["FAMILY"] } }))).toEqual([photo, clip]);
  });

  it("shows no more than a screenful or two", async () => {
    for (let i = 0; i < SCENE_MAX_RESULTS + 15; i += 1) await described("FAMILY", `game-${i}`, { hockey: 1 });
    expect(ids(await as(await signIn("mum")).post(URL, { q: "hockey" }))).toHaveLength(SCENE_MAX_RESULTS);
  });

  it("steps aside, without an error, when switched off or when the engine cannot help", async () => {
    await described("FAMILY", "game", { hockey: 1 });
    const mum = as(await signIn("mum"));

    textFails = new SceneEngineError("The isputnik.faces container did not answer (ECONNREFUSED).", "unavailable");
    expect((await mum.post(URL, { q: "hockey" })).json()).toEqual({ available: false, assets: [] });
    textFails = new NoSceneEngineError("not paired");
    expect((await mum.post(URL, { q: "hockey" })).json()).toEqual({ available: false, assets: [] });

    textFails = null;
    setSceneSearchEnabled(false, "admin");
    asked = [];
    const off = await mum.post(URL, { q: "hockey" });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ available: false, assets: [] });
    // Off means off: the words never reach the engine.
    expect(asked).toEqual([]);
  });
});
