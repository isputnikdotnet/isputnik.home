// Faces found by the isputnik.faces container (docs/face-engine-plan.md): the
// scanner sends each photo to a stand-in engine and stores what comes back —
// faces, vectors, crops — exactly as the in-process path would; a photo the
// engine cannot read is a failed attempt; a wrong model refuses the scan; and
// with no engine and no runtime, a scan says so before it starts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { processFaceScanQueue } from "../src/modules/library/gallery/faces/scanner.js";
import { enqueueFaceScanBatches } from "../src/modules/library/gallery/faces/queue.js";
import { setFaceRecognitionEnabledForLibrary } from "../src/modules/library/gallery/faces/settings.js";
import { createFaceDetector, setFaceDetector, NoDetectorError } from "../src/modules/library/gallery/faces/detector.js";
import { FACE_EMBEDDING_MODEL } from "../src/modules/library/gallery/faces/model-id.js";
import { thumbnailPathSettingKey, thumbnailAbsolutePath } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

const SECRET = "faces-secret-for-tests-0123456789abcdef";

/** A tiny JPEG: enough for the scanner to read bytes off disk. */
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
/** The crop the engine hands back: a RIFF/WEBP header is all the store looks at. */
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);

let engine: FastifyInstance;
let upstream: string;
/** How the stand-in answers: the faces it returns, or a refusal. */
let behaviour: { model?: string; faces?: number; status?: number; failAfter?: number; health?: Partial<Record<string, unknown>> };
let received: { type: string | undefined; bytes: number; role: string | undefined }[];

function embedding(axis: number): string {
  const v = new Float32Array(512);
  v[axis] = 1;
  return Buffer.from(v.buffer).toString("base64");
}

let sourceRoot: string;
let thumbRoot: string;

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM jobs").run();
  makeUser("u1");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "face-engine-"));
  sourceRoot = path.join(base, "library");
  thumbRoot = path.join(base, "thumbs");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(thumbRoot);
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL'").run(sourceRoot);
  setFaceRecognitionEnabledForLibrary("GAL", true, "u1");

  behaviour = { faces: 2 };
  received = [];
  engine = Fastify();
  engine.addContentTypeParser("image/jpeg", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  engine.get("/faces/api/health", async () => ({ ok: true, version: "0.1.0", model: FACE_EMBEDDING_MODEL, modelsPresent: true, loaded: true, providers: ["cpu"], gpu: false, ...behaviour.health }));
  engine.post("/faces/api/detect", async (request, reply) => {
    if (request.headers["x-isputnik-gateway"] !== SECRET) return reply.code(401).send({ error: "Not signed in" });
    received.push({ type: request.headers["content-type"], bytes: (request.body as Buffer).length, role: request.headers["x-isputnik-user-role"] as string });
    if (behaviour.status) return reply.code(behaviour.status).send({ error: "nope" });
    if (behaviour.failAfter && received.length > behaviour.failAfter) return reply.code(500).send({ error: "boom" });
    const faces = Array.from({ length: behaviour.faces ?? 0 }, (_, i) => ({
      box: [0.1 * (i + 1), 0.1, 0.2, 0.2], score: 0.9, embedding: embedding(i), crop: WEBP.toString("base64")
    }));
    return { model: behaviour.model ?? FACE_EMBEDDING_MODEL, width: 100, height: 100, faces };
  });
  await engine.listen({ host: "127.0.0.1", port: 0 });
  const address = engine.server.address();
  upstream = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  setFaceDetector(createFaceDetector({ target: () => ({ upstream, secret: SECRET }), inProcess: null }));
});

afterEach(async () => {
  setFaceDetector(null);
  await engine.close();
});

async function photo(name: string): Promise<string> {
  fs.writeFileSync(path.join(sourceRoot, name), JPEG);
  const extension = path.extname(name);
  return await ingestGalleryAsset("GAL", {
    absolutePath: path.join(sourceRoot, name), relativePath: name, fileName: name,
    extension, kind: kindForExtension(extension)!, size: JPEG.length, modifiedAtMs: Date.parse("2024-12-01T00:00:00Z")
  }, false) as string;
}

describe("face scan through the faces container", () => {
  it("sends the photo's bytes and stores the faces, vectors and crops it gets back", async () => {
    const itemId = await photo("two.jpg");
    enqueueFaceScanBatches("GAL");

    await processFaceScanQueue();

    expect(received).toEqual([{ type: "image/jpeg", bytes: JPEG.length, role: "admin" }]);
    const faces = db.prepare("SELECT box_x, embedding, embedding_model, thumb_storage_key FROM gallery_faces WHERE item_id = ? ORDER BY box_x").all(itemId) as
      { box_x: number; embedding: Buffer; embedding_model: string; thumb_storage_key: string }[];
    expect(faces).toHaveLength(2);
    expect(faces[0].box_x).toBeCloseTo(0.1);
    expect(faces[0].embedding_model).toBe(FACE_EMBEDDING_MODEL);
    expect(new Float32Array(faces[0].embedding.buffer.slice(faces[0].embedding.byteOffset, faces[0].embedding.byteOffset + 2048))[0]).toBe(1);
    expect(faces[1].embedding.length).toBe(2048);
    // The crop the engine made is in the thumbnail store under the face's key.
    expect(fs.readFileSync(thumbnailAbsolutePath(faces[0].thumb_storage_key)).subarray(0, 4).toString("latin1")).toBe("RIFF");
    const scan = db.prepare("SELECT status, face_count FROM gallery_face_scans WHERE item_id = ?").get(itemId) as { status: string; face_count: number };
    expect(scan).toEqual({ status: "ok", face_count: 2 });
  });

  it("records a photo the engine cannot read as a failed attempt and goes on", async () => {
    behaviour = { status: 422 };
    const itemId = await photo("broken.jpg");
    enqueueFaceScanBatches("GAL");

    await processFaceScanQueue();

    const scan = db.prepare("SELECT status, attempts FROM gallery_face_scans WHERE item_id = ?").get(itemId) as { status: string; attempts: number };
    expect(scan).toEqual({ status: "failed", attempts: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM gallery_faces").get()).toEqual({ n: 0 });
  });

  it("refuses to scan against an engine running another model", async () => {
    behaviour = { health: { model: "something-else" } };
    await expect(createFaceDetector({ target: () => ({ upstream, secret: SECRET }), inProcess: null }).ensure()).rejects.toThrow(NoDetectorError);
    const status = await createFaceDetector({ target: () => ({ upstream, secret: SECRET }), inProcess: null }).status();
    expect(status.where).toBe("none");
    expect(status.reason).toContain("different model");
  });

  it("stops the batch, keeping what it has, when the engine goes away mid-scan", async () => {
    const first = await photo("a.jpg");
    const second = await photo("b.jpg");
    enqueueFaceScanBatches("GAL");
    behaviour = { faces: 1, failAfter: 1 };

    await processFaceScanQueue();

    const scanned = db.prepare("SELECT item_id FROM gallery_face_scans WHERE status = 'ok'").all() as { item_id: string }[];
    expect(scanned.map((row) => row.item_id)).toHaveLength(1);
    expect([first, second]).toContain(scanned[0].item_id);
    // The other photo keeps no marker — not a failure, just not done yet.
    expect(db.prepare("SELECT count(*) AS n FROM gallery_face_scans").get()).toEqual({ n: 1 });
  });

  it("skips a batch, completed with the reason, when no engine can be reached", async () => {
    await photo("waiting.jpg");
    const [jobId] = enqueueFaceScanBatches("GAL");
    await engine.close();

    await processFaceScanQueue();

    const job = db.prepare("SELECT status, payload FROM jobs WHERE id = ?").get(jobId) as { status: string; payload: string };
    expect(job.status).toBe("completed");
    const result = JSON.parse(job.payload).result as { skipped?: boolean; reason?: string };
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("did not answer");
    // The photo keeps no marker: the next run, engine back, takes it.
    expect(db.prepare("SELECT count(*) AS n FROM gallery_face_scans").get()).toEqual({ n: 0 });
  });

  it("says where faces are found, and that nothing can when no engine is set and no runtime is here", async () => {
    const container = await createFaceDetector({ target: () => ({ upstream, secret: SECRET }), inProcess: null }).status();
    expect(container).toEqual({ where: "container", version: "0.1.0", model: FACE_EMBEDDING_MODEL, gpu: false, reason: null });

    const none = createFaceDetector({ target: () => ({ upstream: "", secret: "" }), inProcess: null });
    const status = await none.status();
    expect(status.where).toBe("none");
    expect(status.reason).toContain("isputnik.faces");
    await expect(none.ensure()).rejects.toThrow(NoDetectorError);
  });
});
