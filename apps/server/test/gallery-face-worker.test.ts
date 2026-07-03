// The face-scan WORKER's drain-time clustering: reclustering is O(n²) over all faces,
// so it must run once when the queue drains — and only when something changed — never
// after every batch. These tests drive processFaceScanQueue over empty backlogs (no
// photo files are ever decoded, so the native ONNX engine is imported but never runs).
// Kept in its own file so gallery-faces.test.ts stays off the onnxruntime import chain.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { processFaceScanQueue, recoverOrphanFaceClusters } from "../src/modules/library/gallery/faces/scanner.js";
import { faceScanThreadBudget } from "../src/modules/library/gallery/faces/arcface.js";
import { enqueueFaceScanBatches } from "../src/modules/library/gallery/faces/queue.js";
import { setFaceRecognitionEnabledForLibrary } from "../src/modules/library/gallery/faces/settings.js";
import { embeddingToBlob } from "../src/modules/library/gallery/faces/embedding.js";
import { FACE_EMBEDDING_MODEL } from "../src/modules/library/gallery/faces/model-id.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

function asset(relativePath: string, modifiedMs: number) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`, relativePath, fileName: relativePath.split("/").pop()!,
    extension, kind: kindForExtension(extension)!, size: 1000, modifiedAtMs: modifiedMs
  };
}

// An 8-d unit vector along `axis`.
function vec(axis: number): Float32Array {
  const v = new Float32Array(8);
  v[axis] = 1;
  return v;
}

describe("face scan thread budget (keeps the server responsive during a scan)", () => {
  const original = process.env.FACE_ORT_THREADS;
  afterEach(() => {
    if (original === undefined) delete process.env.FACE_ORT_THREADS;
    else process.env.FACE_ORT_THREADS = original;
  });

  it("defaults to at least one thread, leaving a core for the event loop", () => {
    delete process.env.FACE_ORT_THREADS;
    expect(faceScanThreadBudget()).toBeGreaterThanOrEqual(1);
  });

  it("honours a positive FACE_ORT_THREADS override", () => {
    process.env.FACE_ORT_THREADS = "2";
    expect(faceScanThreadBudget()).toBe(2);
  });

  it("ignores a zero or non-numeric override", () => {
    process.env.FACE_ORT_THREADS = "0";
    expect(faceScanThreadBudget()).toBeGreaterThanOrEqual(1);
    process.env.FACE_ORT_THREADS = "nonsense";
    expect(faceScanThreadBudget()).toBeGreaterThanOrEqual(1);
  });
});

describe("face scan worker (cluster once at queue drain)", () => {
  beforeEach(() => {
    resetDb();
    db.prepare("DELETE FROM jobs").run();
    makeUser("u1");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
    // The scan validates the library source for real: it must exist on disk, sit inside
    // a configured storage container, and not overlap the (configured) thumbnail store.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "face-worker-"));
    const sourceRoot = path.join(base, "library");
    const thumbRoot = path.join(base, "thumbs");
    fs.mkdirSync(sourceRoot);
    fs.mkdirSync(thumbRoot);
    db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(thumbnailPathSettingKey, thumbRoot);
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL'").run(sourceRoot);
    setFaceRecognitionEnabledForLibrary("GAL", true, "u1");
    // Sentinel: clusterGalleryFaces prunes empty unnamed people unconditionally, so this
    // row surviving a worker cycle proves clustering did NOT run.
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('sentinel', '')").run();
  });

  // A photo that is already scanned under the current model — an empty backlog.
  async function scannedPhoto(rel: string, when: number): Promise<string> {
    const itemId = await ingestGalleryAsset("GAL", asset(rel, when), false) as string;
    db.prepare("INSERT INTO gallery_face_scans (item_id, model, face_count, status, attempts) VALUES (?, ?, 0, 'ok', 0)")
      .run(itemId, FACE_EMBEDDING_MODEL);
    return itemId;
  }

  it("a no-op batch completes without reclustering", async () => {
    await scannedPhoto("done.jpg", Date.parse("2024-12-01T00:00:00Z"));
    const [jobId] = enqueueFaceScanBatches("GAL");

    await processFaceScanQueue();

    const job = db.prepare("SELECT status, payload FROM jobs WHERE id = ?").get(jobId) as { status: string; payload: string };
    expect(job.status).toBe("completed");
    expect(JSON.parse(job.payload).result.items).toBe(0);
    // Clustering never ran: the prunable sentinel person is still there.
    expect(db.prepare("SELECT 1 FROM gallery_people WHERE id = 'sentinel'").get()).toBeTruthy();
  });

  it("stamps started_at when the worker claims a job and keeps it after completion", async () => {
    await scannedPhoto("done.jpg", Date.parse("2024-12-03T00:00:00Z"));
    const [jobId] = enqueueFaceScanBatches("GAL");

    await processFaceScanQueue();

    // started_at drives the Tasks page duration; it must be set on claim and survive
    // completion (locked_at is cleared, so it can't serve this purpose).
    const job = db.prepare("SELECT status, started_at, created_at FROM jobs WHERE id = ?")
      .get(jobId) as { status: string; started_at: string | null; created_at: string };
    expect(job.status).toBe("completed");
    expect(job.started_at).not.toBeNull();
    expect(new Date(job.started_at!).getTime()).toBeGreaterThanOrEqual(new Date(job.created_at).getTime());
  });

  it("unassigned scan faces left behind get clustered at drain (crash recovery)", async () => {
    // A completed-but-never-clustered state: the photo is marked scanned, its face has
    // no person (as if the process died between the batch and its recluster).
    const itemId = await scannedPhoto("orphan.jpg", Date.parse("2024-12-02T00:00:00Z"));
    db.prepare(`
      INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, assignment, source)
      VALUES ('f1', ?, 0.1, 0.1, 0.2, 0.2, 0.99, ?, ?, 'auto', 'scan')
    `).run(itemId, embeddingToBlob(vec(0)), FACE_EMBEDDING_MODEL);
    const [jobId] = enqueueFaceScanBatches("GAL");

    await processFaceScanQueue();

    expect((db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string }).status).toBe("completed");
    // The drain-time pass clustered the stray face and pruned the sentinel.
    expect((db.prepare("SELECT person_id FROM gallery_faces WHERE id = 'f1'").get() as { person_id: string | null }).person_id).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM gallery_people WHERE id = 'sentinel'").get()).toBeFalsy();
  });

  // The production bug: a scan interrupted with EVERY batch already 'completed' leaves
  // faces with no person AND no pending jobs, so processFaceScanQueue's loop never runs
  // and its drain clustering is skipped — People stays empty. Startup recovery fixes it.
  it("recoverOrphanFaceClusters adopts unclustered faces when NO jobs are pending (restart mid-scan)", async () => {
    const itemId = await scannedPhoto("orphan.jpg", Date.parse("2024-12-04T00:00:00Z"));
    db.prepare(`
      INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, assignment, source)
      VALUES ('f1', ?, 0.1, 0.1, 0.2, 0.2, 0.99, ?, ?, 'auto', 'scan')
    `).run(itemId, embeddingToBlob(vec(0)), FACE_EMBEDDING_MODEL);
    // No jobs queued at all — the exact state after a restart where all batches finished.
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toMatchObject({ n: 0 });

    // A plain worker cycle can't help — nothing is pending, so it clusters nothing.
    await processFaceScanQueue();
    expect((db.prepare("SELECT person_id FROM gallery_faces WHERE id = 'f1'").get() as { person_id: string | null }).person_id).toBeNull();

    // Startup recovery adopts the orphaned face and prunes the sentinel.
    await recoverOrphanFaceClusters();
    expect((db.prepare("SELECT person_id FROM gallery_faces WHERE id = 'f1'").get() as { person_id: string | null }).person_id).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM gallery_people WHERE id = 'sentinel'").get()).toBeFalsy();
  });

  it("recoverOrphanFaceClusters defers while a scan is still queued/running", async () => {
    const itemId = await scannedPhoto("orphan.jpg", Date.parse("2024-12-05T00:00:00Z"));
    db.prepare(`
      INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, assignment, source)
      VALUES ('f1', ?, 0.1, 0.1, 0.2, 0.2, 0.99, ?, ?, 'auto', 'scan')
    `).run(itemId, embeddingToBlob(vec(0)), FACE_EMBEDDING_MODEL);
    // A pending batch means a scan is active — recovery must leave clustering to it.
    enqueueFaceScanBatches("GAL");

    await recoverOrphanFaceClusters();

    // Untouched: still unassigned, sentinel still present (no premature clustering).
    expect((db.prepare("SELECT person_id FROM gallery_faces WHERE id = 'f1'").get() as { person_id: string | null }).person_id).toBeNull();
    expect(db.prepare("SELECT 1 FROM gallery_people WHERE id = 'sentinel'").get()).toBeTruthy();
  });
});
