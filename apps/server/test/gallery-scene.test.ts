// Scene search, S2 (docs/scene-search-plan.md): how a vector is stored, this
// server's calls to the engine, the scan that describes a library's photos, and
// the admin's switch. The engine is a stand-in throughout: what matters here is
// what home does with a vector, never what the model thinks of a picture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { thumbnailPathSettingKey, thumbnailStorageKey } from "../src/modules/library/shared/thumbnail.js";
import { SCENE_DIMENSIONS, SCENE_MODEL } from "../src/modules/library/gallery/scene/model-id.js";
import { decodeSceneVector, encodeSceneVector, sceneScore } from "../src/modules/library/gallery/scene/vectors.js";
import {
  NoSceneEngineError, SceneEngineError, createSceneEngine, setSceneEngine, type SceneEngine
} from "../src/modules/library/gallery/scene/engine-client.js";
import { setSceneSearchEnabled, sceneLibraryIds } from "../src/modules/library/gallery/scene/settings.js";
import { MAX_SCENE_SCAN_ATTEMPTS, enqueueSceneScans, undescribedPhotoCount } from "../src/modules/library/gallery/scene/queue.js";
import { activeSceneScan, processSceneScanQueue, resetLibrarySceneMarkers } from "../src/modules/library/gallery/scene/scanner.js";
import { gallerySceneRoutesPlugin } from "../src/modules/library/gallery/scene/routes.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";
import { bootApp } from "./helpers/boot.js";

const SECRET = "faces-secret-for-tests-0123456789abcdef";
const UPSTREAM = "http://faces.test:4400";

/** A unit vector with a little of everything and a lot of one thing, like the model's. */
function unitVector(seed: number): Float32Array {
  const v = new Float32Array(SCENE_DIMENSIONS);
  let state = seed * 2654435761 % 4294967296;
  for (let i = 0; i < v.length; i += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296;
    v[i] = state / 4294967296 - 0.5;
  }
  v[seed % v.length] = 8;
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return v.map((x) => x / norm);
}
const wire = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("how a scene vector is stored", () => {
  it("keeps one byte per number and scores within a hair of the original", () => {
    const query = unitVector(3);
    for (const seed of [1, 2, 3, 40, 500]) {
      const photo = unitVector(seed);
      const blob = encodeSceneVector(photo);
      expect(blob.byteLength).toBe(SCENE_DIMENSIONS);
      expect(Math.abs(sceneScore(query, decodeSceneVector(blob)) - dot(query, photo))).toBeLessThan(0.005);
    }
  });

  it("ranks the same photo first", () => {
    const query = unitVector(7);
    const photos = [1, 2, 7, 9, 11].map(unitVector);
    const scores = photos.map((photo) => sceneScore(query, decodeSceneVector(encodeSceneVector(photo))));
    expect(scores.indexOf(Math.max(...scores))).toBe(2);
  });

  it("survives a vector of nothing", () => {
    const stored = decodeSceneVector(encodeSceneVector(new Float32Array(SCENE_DIMENSIONS)));
    expect(sceneScore(unitVector(1), stored)).toBe(0);
  });
});

describe("this server's calls to the engine", () => {
  const healthy = { ok: true, version: "0.2.0", scene: { model: SCENE_MODEL, dimensions: SCENE_DIMENSIONS, modelsPresent: true, loaded: false } };
  type Call = { url: string; init: RequestInit | undefined };
  function engineWith(answer: (call: Call) => { status?: number; body: unknown }) {
    const calls: Call[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const call = { url: String(url), init };
      calls.push(call);
      const { status = 200, body } = answer(call);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { calls, engine: createSceneEngine({ target: () => ({ upstream: UPSTREAM, secret: SECRET }), fetch: fake }) };
  }

  it("is available when the container names this server's model", async () => {
    const { engine } = engineWith(() => ({ body: healthy }));
    expect(await engine.status()).toEqual({ available: true, version: "0.2.0", reason: null });
    await expect(engine.ensure()).resolves.toBeUndefined();
  });

  it("says why not: not paired, too old, no model, another model, not answering", async () => {
    const unpaired = createSceneEngine({ target: () => ({ upstream: "", secret: "" }) });
    expect((await unpaired.status()).reason).toMatch(/pair it/);
    await expect(unpaired.ensure()).rejects.toBeInstanceOf(NoSceneEngineError);

    const old = engineWith(() => ({ body: { ok: true, version: "0.1.1" } })).engine;
    expect((await old.status()).reason).toMatch(/older than 0\.2\.0/);
    await expect(old.ensure()).rejects.toBeInstanceOf(NoSceneEngineError);

    const empty = engineWith(() => ({ body: { ...healthy, scene: { ...healthy.scene, modelsPresent: false } } })).engine;
    expect((await empty.status()).reason).toMatch(/no scene model/);

    const other = engineWith(() => ({ body: { ...healthy, scene: { ...healthy.scene, model: "clip/1" } } })).engine;
    expect((await other.status()).reason).toMatch(/different scene model \(clip\/1\)/);

    const down = createSceneEngine({ target: () => ({ upstream: UPSTREAM, secret: SECRET }), fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    expect(await down.status()).toMatchObject({ available: false, reason: expect.stringMatching(/did not answer/) });
  });

  it("sends a picture as its bytes, signed, and reads the vector back", async () => {
    const vector = unitVector(5);
    const { engine, calls } = engineWith(() => ({ body: { model: SCENE_MODEL, dimensions: SCENE_DIMENSIONS, embedding: wire(vector) } }));
    const answer = await engine.embedImage(Buffer.from("webp-bytes"), "image/webp");
    expect(Array.from(answer)).toEqual(Array.from(vector));
    expect(calls[0].url).toBe(`${UPSTREAM}/faces/api/embed/image`);
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("image/webp");
    expect(headers["x-isputnik-gateway"]).toBe(SECRET);
    expect(headers["x-isputnik-user-role"]).toBe("admin");
  });

  it("sends what was typed as JSON", async () => {
    const { engine, calls } = engineWith(() => ({ body: { model: SCENE_MODEL, dimensions: SCENE_DIMENSIONS, embedding: wire(unitVector(6)) } }));
    await engine.embedText("hockey");
    expect(calls[0].url).toBe(`${UPSTREAM}/faces/api/embed/text`);
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ text: "hockey" });
  });

  it("tells a picture it cannot read from an engine that cannot help", async () => {
    const unreadable = engineWith(() => ({ status: 422, body: { error: "The picture could not be decoded" } })).engine;
    await expect(unreadable.embedImage(Buffer.from("x"), "image/webp")).rejects.toMatchObject({ kind: "undecodable" });
    // An engine from before 0.2.0 has no such route; one with no model answers 503.
    for (const status of [404, 503]) {
      const engine = engineWith(() => ({ status, body: {} })).engine;
      await expect(engine.embedImage(Buffer.from("x"), "image/webp")).rejects.toMatchObject({ kind: "unavailable" });
    }
    const refused = engineWith(() => ({ status: 401, body: {} })).engine;
    await expect(refused.embedText("x")).rejects.toMatchObject({ kind: "refused" });
  });

  it("refuses a vector made by another model, or of the wrong size", async () => {
    const other = engineWith(() => ({ body: { model: "clip/1", embedding: wire(unitVector(1)) } })).engine;
    await expect(other.embedText("x")).rejects.toBeInstanceOf(SceneEngineError);
    const short = engineWith(() => ({ body: { model: SCENE_MODEL, embedding: Buffer.alloc(512 * 4).toString("base64") } })).engine;
    await expect(short.embedText("x")).rejects.toThrow(/512 numbers, not 768/);
  });
});

// ── The scan ──────────────────────────────────────────────────────────────

let thumbRoot: string;

function asset(relativePath: string, modifiedMs: number) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`, relativePath, fileName: relativePath.split("/").pop()!,
    extension, kind: kindForExtension(extension)!, size: 1000, modifiedAtMs: modifiedMs
  };
}

/** A photo in `libraryId` with a thumbnail in the store (or a key to one that is not there). */
async function photo(libraryId: string, name: string, options: { thumbnail?: "file" | "missing" | "none" } = {}): Promise<string> {
  const itemId = await ingestGalleryAsset(libraryId, asset(`${name}.jpg`, Date.parse("2024-06-01T00:00:00Z")), false);
  const how = options.thumbnail ?? "file";
  if (how === "none") {
    db.prepare("UPDATE item_metadata SET cover_storage_key = NULL WHERE item_id = ?").run(itemId);
    return itemId;
  }
  const key = thumbnailStorageKey(libraryId, itemId, `${itemId}.webp`);
  db.prepare("UPDATE item_metadata SET cover_storage_key = ? WHERE item_id = ?").run(key, itemId);
  if (how === "file") {
    const file = path.join(thumbRoot, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `thumbnail of ${name}`);
  }
  return itemId;
}

interface StandIn extends SceneEngine {
  seen: string[];
  /** What to do with a picture, by its bytes. */
  onImage: (bytes: string) => Float32Array;
  available: string | null;
}

function standIn(): StandIn {
  const engine: StandIn = {
    seen: [],
    available: null,
    onImage: () => unitVector(1),
    async status() {
      return { available: engine.available === null, version: "0.2.0", reason: engine.available };
    },
    async ensure() {
      if (engine.available !== null) throw new NoSceneEngineError(engine.available);
    },
    async embedImage(bytes) {
      const text = bytes.toString("utf8");
      engine.seen.push(text);
      return engine.onImage(text);
    },
    async embedText() {
      return unitVector(2);
    }
  };
  return engine;
}

const marker = (itemId: string) => db.prepare("SELECT model, status, attempts FROM item_model_scans WHERE item_id = ? AND pass = 'scene'").get(itemId) as
  { model: string; status: string; attempts: number } | undefined;
const vectorOf = (itemId: string) => db.prepare("SELECT model, vector FROM gallery_scene_vectors WHERE item_id = ?").get(itemId) as { model: string; vector: Buffer } | undefined;
const jobResult = (jobId: string) => {
  const row = db.prepare("SELECT status, payload FROM jobs WHERE id = ?").get(jobId) as { status: string; payload: string };
  return { status: row.status, result: JSON.parse(row.payload).result as Record<string, unknown> };
};

/** Runs the queue to the end, whoever started it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    await processSceneScanQueue();
    if (!activeSceneScan()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the scene queue did not drain");
}

function seedGallery(): void {
  resetDb();
  db.prepare("DELETE FROM jobs").run();
  makeUser("admin", "admin");
  makeUser("mum");
  makeLibrary("GAL", { createdBy: "admin", type: "gallery" });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "scene-scan-"));
  thumbRoot = path.join(base, "thumbs");
  fs.mkdirSync(thumbRoot);
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'admin')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
}

describe("the scene scan", () => {
  let engine: StandIn;

  beforeEach(() => {
    seedGallery();
    engine = standIn();
    setSceneEngine(engine);
    setSceneSearchEnabled(true, "admin");
  });

  afterEach(() => {
    setSceneEngine(null);
  });

  it("describes each photo from its thumbnail and keeps the vector", async () => {
    const a = await photo("GAL", "a");
    const b = await photo("GAL", "b");
    engine.onImage = (bytes) => unitVector(bytes.endsWith("a") ? 10 : 20);
    const [jobId] = enqueueSceneScans();

    await settle();

    expect(engine.seen.sort()).toEqual(["thumbnail of a", "thumbnail of b"]);
    expect(jobResult(jobId)).toMatchObject({ status: "completed", result: { items: 2, described: 2 } });
    expect(marker(a)).toEqual({ model: SCENE_MODEL, status: "ok", attempts: 0 });
    expect(vectorOf(a)!.model).toBe(SCENE_MODEL);
    expect(vectorOf(a)!.vector.byteLength).toBe(SCENE_DIMENSIONS);
    // Each photo kept its own vector, not its neighbour's.
    expect(sceneScore(unitVector(10), decodeSceneVector(vectorOf(a)!.vector))).toBeGreaterThan(0.99);
    expect(sceneScore(unitVector(20), decodeSceneVector(vectorOf(b)!.vector))).toBeGreaterThan(0.99);
  });

  it("has nothing to queue once everything is described, and takes only what is new", async () => {
    await photo("GAL", "a");
    enqueueSceneScans();
    await settle();
    expect(enqueueSceneScans()).toEqual([]);

    await photo("GAL", "new");
    engine.seen = [];
    expect(enqueueSceneScans()).toHaveLength(1);
    await settle();
    expect(engine.seen).toEqual(["thumbnail of new"]);
  });

  it("does not queue a library twice", async () => {
    await photo("GAL", "a");
    expect(enqueueSceneScans()).toHaveLength(1);
    expect(enqueueSceneScans()).toEqual([]);
  });

  it("leaves the Photo Inbox and App files alone, and describes a personal library", async () => {
    makeLibrary("INBOX", { createdBy: "admin", type: "gallery", role: "inbox" });
    makeLibrary("APPFILES", { createdBy: "admin", type: "gallery", role: "app-files" });
    makeLibrary("MINE", { createdBy: "admin", type: "gallery" });
    db.prepare("UPDATE libraries SET personal_user_id = 'mum' WHERE id = 'MINE'").run();
    await photo("INBOX", "unkept");
    await photo("APPFILES", "recording");
    const mine = await photo("MINE", "mine");
    expect(sceneLibraryIds().sort()).toEqual(["GAL", "MINE"]);

    enqueueSceneScans();
    await settle();

    expect(engine.seen).toEqual(["thumbnail of mine"]);
    expect(marker(mine)?.status).toBe("ok");
  });

  it("gives a photo with no thumbnail a few tries, then leaves it until a full rescan", async () => {
    const none = await photo("GAL", "none", { thumbnail: "none" });
    const gone = await photo("GAL", "gone", { thumbnail: "missing" });
    for (let attempt = 1; attempt <= MAX_SCENE_SCAN_ATTEMPTS; attempt += 1) {
      expect(undescribedPhotoCount("GAL")).toBe(2);
      enqueueSceneScans();
      await settle();
      expect(marker(none)).toEqual({ model: SCENE_MODEL, status: "failed", attempts: attempt });
      expect(marker(gone)?.attempts).toBe(attempt);
    }
    expect(undescribedPhotoCount("GAL")).toBe(0);
    expect(enqueueSceneScans()).toEqual([]);
    expect(engine.seen).toEqual([]);

    resetLibrarySceneMarkers("GAL");
    expect(undescribedPhotoCount("GAL")).toBe(2);
  });

  it("counts a picture the engine cannot read against that photo, and carries on", async () => {
    const bad = await photo("GAL", "bad");
    const good = await photo("GAL", "good");
    engine.onImage = (bytes) => {
      if (bytes.endsWith("bad")) throw new SceneEngineError("The picture could not be decoded", "undecodable");
      return unitVector(1);
    };
    const [jobId] = enqueueSceneScans();
    await settle();

    expect(marker(bad)).toMatchObject({ status: "failed", attempts: 1 });
    expect(marker(good)?.status).toBe("ok");
    expect(jobResult(jobId).result).toMatchObject({ items: 2, described: 1, failed: 1 });
  });

  it("stops when the engine goes away mid-scan, failing nothing", async () => {
    for (const name of ["a", "b", "c", "d"]) await photo("GAL", name);
    engine.onImage = () => {
      if (engine.seen.length > 2) throw new SceneEngineError("The isputnik.faces container did not answer (ECONNREFUSED).", "unavailable");
      return unitVector(1);
    };
    const [jobId] = enqueueSceneScans();
    await settle();

    const { status, result } = jobResult(jobId);
    expect(status).toBe("completed");
    expect(result).toMatchObject({ items: 2, described: 2, remaining: 2 });
    expect(result.reason).toMatch(/did not answer/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM item_model_scans WHERE status = 'failed'").get()).toEqual({ n: 0 });
    // The two that were not reached are simply still to do.
    expect(undescribedPhotoCount("GAL")).toBe(2);
  });

  it("skips, with the reason, when there is no engine at all", async () => {
    const a = await photo("GAL", "a");
    engine.available = "The isputnik.faces container is older than 0.2.0 and cannot describe photos yet: update it.";
    const [jobId] = enqueueSceneScans();
    await settle();

    expect(jobResult(jobId)).toMatchObject({ status: "completed", result: { skipped: true, reason: expect.stringMatching(/older than 0\.2\.0/) } });
    expect(marker(a)).toBeUndefined();
    expect(engine.seen).toEqual([]);
  });

  it("drops the rest of the night's libraries when one of them finds no engine", async () => {
    makeLibrary("GAL2", { createdBy: "admin", type: "gallery" });
    await photo("GAL", "a");
    await photo("GAL2", "b");
    engine.available = "not there";
    expect(enqueueSceneScans()).toHaveLength(2);
    await settle();
    expect(db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all()).toEqual([{ status: "completed", n: 1 }]);
  });

  it("describes everything again when the model changes", async () => {
    const a = await photo("GAL", "a");
    enqueueSceneScans();
    await settle();
    // As if an older server had made these under another model.
    db.prepare("UPDATE item_model_scans SET model = 'older/1' WHERE item_id = ?").run(a);
    db.prepare("UPDATE gallery_scene_vectors SET model = 'older/1' WHERE item_id = ?").run(a);

    engine.seen = [];
    expect(enqueueSceneScans()).toHaveLength(1);
    await settle();

    expect(engine.seen).toEqual(["thumbnail of a"]);
    expect(marker(a)?.model).toBe(SCENE_MODEL);
    expect(vectorOf(a)?.model).toBe(SCENE_MODEL);
  });

  it("does nothing while the feature is switched off", async () => {
    const a = await photo("GAL", "a");
    const [jobId] = enqueueSceneScans();
    setSceneSearchEnabled(false, "admin");
    await settle();
    expect(jobResult(jobId).result).toMatchObject({ skipped: true });
    expect(marker(a)).toBeUndefined();
  });

  it("stops at the next photo when the feature is switched off mid-scan", async () => {
    for (const name of ["a", "b", "c"]) await photo("GAL", name);
    engine.onImage = () => {
      setSceneSearchEnabled(false, "admin");
      return unitVector(1);
    };
    const [jobId] = enqueueSceneScans();
    await settle();
    expect(jobResult(jobId).result).toMatchObject({ items: 1, described: 1, remaining: 2, switchedOff: true });
    expect(engine.seen).toHaveLength(1);
  });

  it("takes a photo's vector and marker away with the photo", async () => {
    const a = await photo("GAL", "a");
    enqueueSceneScans();
    await settle();
    db.prepare("DELETE FROM library_items WHERE id = ?").run(a);
    expect(vectorOf(a)).toBeUndefined();
    expect(marker(a)).toBeUndefined();
  });
});

describe("the admin's switch", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;
  let as: Awaited<ReturnType<typeof bootApp>>["as"];
  let engine: StandIn;

  beforeEach(async () => {
    seedGallery();
    engine = standIn();
    setSceneEngine(engine);
    ({ app, signIn, as } = await bootApp({ plugins: [gallerySceneRoutesPlugin] }));
  });

  afterEach(async () => {
    await settle();
    await app.close();
    setSceneEngine(null);
  });

  const URL = "/api/library/gallery/scene";

  it("is the admin's alone", async () => {
    const mum = as(await signIn("mum"));
    expect((await mum.get(`${URL}/settings`)).statusCode).toBe(403);
    expect((await mum.patch(`${URL}/settings`, { enabled: true })).statusCode).toBe(403);
    expect((await mum.post(`${URL}/scan`, {})).statusCode).toBe(403);
    expect((await mum.delete(`${URL}/data`)).statusCode).toBe(403);
    expect((await as().get(`${URL}/settings`)).statusCode).toBe(401);
  });

  it("starts off, and says what there is to describe", async () => {
    await photo("GAL", "a");
    await photo("GAL", "b");
    const res = await as(await signIn("admin")).get(`${URL}/settings`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      enabled: false,
      model: SCENE_MODEL,
      engine: { available: true, version: "0.2.0", reason: null },
      libraries: [{ id: "GAL", name: "GAL", personal: false, photos: 2, described: 0, unreadable: 0 }],
      scan: null
    });
  });

  it("will not switch on with no engine, and says why", async () => {
    engine.available = "Search by what a photo shows needs the isputnik.faces container: pair it on Control panel → Settings › Apps.";
    const admin = as(await signIn("admin"));
    const res = await admin.patch(`${URL}/settings`, { enabled: true });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/pair it/);
    expect((await admin.get(`${URL}/settings`)).json().enabled).toBe(false);
  });

  it("switching on describes the photos; the page then counts them", async () => {
    await photo("GAL", "a");
    await photo("GAL", "b");
    const admin = as(await signIn("admin"));
    const on = await admin.patch(`${URL}/settings`, { enabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().enabled).toBe(true);
    await settle();

    const after = (await admin.get(`${URL}/settings`)).json();
    expect(after.libraries).toEqual([{ id: "GAL", name: "GAL", personal: false, photos: 2, described: 2, unreadable: 0 }]);
    expect(after.scan).toBeNull();
    const events = db.prepare("SELECT event FROM activity_logs WHERE event LIKE 'library.gallery.scene.%'").all() as { event: string }[];
    expect(events.map((row) => row.event)).toEqual(["library.gallery.scene.settings"]);
  });

  it("scans again on request, in full when asked, and only while switched on", async () => {
    await photo("GAL", "a");
    const admin = as(await signIn("admin"));
    expect((await admin.post(`${URL}/scan`, {})).statusCode).toBe(409);

    await admin.patch(`${URL}/settings`, { enabled: true });
    await settle();
    engine.seen = [];

    // Nothing new: nothing is sent to the engine.
    expect((await admin.post(`${URL}/scan`, {})).json().jobs).toBe(0);
    await settle();
    expect(engine.seen).toEqual([]);

    expect((await admin.post(`${URL}/scan`, { force: true })).json().jobs).toBe(1);
    await settle();
    expect(engine.seen).toEqual(["thumbnail of a"]);
  });

  it("deletes what it stored only once switched off", async () => {
    const a = await photo("GAL", "a");
    const admin = as(await signIn("admin"));
    await admin.patch(`${URL}/settings`, { enabled: true });
    await settle();
    expect(vectorOf(a)).toBeDefined();

    expect((await admin.delete(`${URL}/data`)).statusCode).toBe(409);
    await admin.patch(`${URL}/settings`, { enabled: false });
    const res = await admin.delete(`${URL}/data`);
    expect(res.statusCode).toBe(200);
    expect(res.json().removed).toBe(1);
    expect(vectorOf(a)).toBeUndefined();
    expect(marker(a)).toBeUndefined();
    // The photo itself is untouched.
    expect(db.prepare("SELECT 1 FROM library_items WHERE id = ?").get(a)).toBeTruthy();
  });
});
