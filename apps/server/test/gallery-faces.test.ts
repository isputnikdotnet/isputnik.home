import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import {
  embeddingToBlob, blobToEmbedding, cosineSimilarity, centroidOf
} from "../src/modules/library/gallery/faces/embedding.js";
import { mutualKnnClusters, mergeClustersByCentroid, clusterGalleryFaces, recomputeClusterCentroid } from "../src/modules/library/gallery/faces/cluster.js";
import { computeClusterHealth } from "../src/modules/library/gallery/faces/health.js";
import { sweepOrphanFaceCrops, faceCropKeysForItem } from "../src/modules/library/gallery/faces/crop-files.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { FACE_EMBEDDING_MODEL } from "../src/modules/library/gallery/faces/model-id.js";
import {
  enqueueFaceScan, enqueueFaceScanBatches, faceJobType,
  recordFaceScanFailure, MAX_FACE_SCAN_ATTEMPTS, resetLibraryFaceScanMarkers
} from "../src/modules/library/gallery/faces/queue.js";
import { clearLibraryFaceData } from "../src/modules/library/gallery/faces/clear.js";
import {
  faceRecognitionEnabledForLibrary, setFaceRecognitionEnabledForLibrary,
  enabledFaceLibraryIds, anyFaceLibraryEnabled
} from "../src/modules/library/gallery/faces/settings.js";
import {
  listGalleryPeople, getGalleryPersonPhotos, untagAssetPerson, renameGalleryPerson,
  mergeGalleryPeople, setGalleryPersonHidden
} from "../src/modules/library/gallery/people.js";
import { getGalleryAsset } from "../src/modules/library/gallery/catalog.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// A unit vector pointing mostly along axis `axis` (8-d), with a little noise so two
// "same person" faces aren't identical.
function vec(axis: number, noise = 0): Float32Array {
  const v = new Float32Array(8);
  v[axis] = 1;
  v[(axis + 1) % 8] = noise;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 8; i += 1) v[i] /= n;
  return v;
}

// A unit vector w0·axis(a0) + w1·axis(a1), normalised — for controlled cosines.
function mix(a0: number, w0: number, a1: number, w1: number): Float32Array {
  const v = new Float32Array(8);
  const n = Math.hypot(w0, w1) || 1;
  v[a0] = w0 / n;
  v[a1] = w1 / n;
  return v;
}

function asset(relativePath: string, modifiedMs: number) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`, relativePath, fileName: relativePath.split("/").pop()!,
    extension, kind: kindForExtension(extension)!, size: 1000, modifiedAtMs: modifiedMs
  };
}

describe("face embedding helpers", () => {
  it("round-trips an embedding through a BLOB", () => {
    const v = vec(2, 0.1);
    const back = blobToEmbedding(embeddingToBlob(v));
    expect(Array.from(back)).toEqual(Array.from(v));
  });

  it("cosine similarity is ~1 for aligned and ~0 for orthogonal vectors", () => {
    expect(cosineSimilarity(vec(0), vec(0))).toBeCloseTo(1, 5);
    expect(cosineSimilarity(vec(0), vec(3))).toBeCloseTo(0, 5);
  });

  it("centroid of aligned vectors stays aligned and unit-length", () => {
    const c = centroidOf([vec(1, 0.05), vec(1, 0.1), vec(1)]);
    let norm = 0; for (const x of c) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(c, vec(1))).toBeGreaterThan(0.95);
  });
});

describe("mutualKnnClusters (pure)", () => {
  it("links mutual neighbours into one group and isolates a dissimilar face", async () => {
    const faces = [
      { id: "a1", emb: vec(0, 0.05) },
      { id: "a2", emb: vec(0, 0.1) },
      { id: "a3", emb: vec(0, 0.02) },
      { id: "b1", emb: vec(4) }
    ];
    const groups = await mutualKnnClusters(faces, 3, 0.5);
    expect(groups.length).toBe(2);
    expect(groups.find((g) => g.includes("a1"))?.sort()).toEqual(["a1", "a2", "a3"]);
    expect(groups.find((g) => g.includes("b1"))).toEqual(["b1"]);
  });

  it("keeps two tight groups apart (hub-chaining resistance)", async () => {
    const faces = [
      { id: "a1", emb: vec(0, 0.03) }, { id: "a2", emb: vec(0, 0.06) }, { id: "a3", emb: vec(0, 0.09) },
      { id: "c1", emb: vec(2, 0.03) }, { id: "c2", emb: vec(2, 0.06) }, { id: "c3", emb: vec(2, 0.09) }
    ];
    expect((await mutualKnnClusters(faces, 3, 0.5)).length).toBe(2);
  });
});

describe("mergeClustersByCentroid (pure)", () => {
  it("re-unites one person's k-NN fragments while keeping different people apart", async () => {
    // One person in two "eras": the b-faces sit at cosine ~0.8 to the a-faces, but each
    // sub-group's top-2 lists are saturated by its own near-duplicates, so mutual k-NN
    // (k=2) leaves the person split. A third, unrelated person (z) stays orthogonal.
    const faces = [
      { id: "a1", emb: vec(0, 0.02) }, { id: "a2", emb: vec(0, 0.04) }, { id: "a3", emb: vec(0, 0.06) },
      { id: "b1", emb: mix(0, 0.8, 1, 0.6) }, { id: "b2", emb: mix(0, 0.79, 1, 0.61) }, { id: "b3", emb: mix(0, 0.81, 1, 0.59) },
      { id: "z1", emb: vec(4, 0.02) }, { id: "z2", emb: vec(4, 0.04) }, { id: "z3", emb: vec(4, 0.06) }
    ];
    const knn = await mutualKnnClusters(faces, 2, 0.3);
    expect(knn.length).toBe(3); // fragmented: a-, b-, and z-groups

    const embById = new Map(faces.map((f) => [f.id, f.emb]));
    const merged = (await mergeClustersByCentroid(knn, embById, 0.58)).map((g) => [...g].sort());
    expect(merged.length).toBe(2);
    expect(merged.find((g) => g.includes("a1"))).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
    expect(merged.find((g) => g.includes("z1"))).toEqual(["z1", "z2", "z3"]);
  });

  it("leaves everything untouched when no centroids clear the threshold", async () => {
    const faces = [
      { id: "a1", emb: vec(0, 0.05) }, { id: "a2", emb: vec(0, 0.1) },
      { id: "c1", emb: vec(2, 0.05) }, { id: "c2", emb: vec(2, 0.1) }
    ];
    const embById = new Map(faces.map((f) => [f.id, f.emb]));
    const groups = await mutualKnnClusters(faces, 3, 0.5);
    expect((await mergeClustersByCentroid(groups, embById, 0.58)).length).toBe(groups.length);
  });
});

describe("face scan queue (batch chaining)", () => {
  beforeEach(() => { db.prepare("DELETE FROM jobs").run(); });

  it("a plain enqueue runs immediately with no chain marker", () => {
    const id = enqueueFaceScan("LIB");
    const row = db.prepare("SELECT type, status, run_at, payload FROM jobs WHERE id = ?").get(id) as { type: string; status: string; run_at: string; payload: string };
    expect(row.type).toBe(faceJobType);
    expect(row.status).toBe("pending");
    expect(new Date(row.run_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(JSON.parse(row.payload)).toEqual({ libraryId: "LIB", force: false });
  });

  it("a follow-up batch is delayed and carries the chain's start time", () => {
    const chainStartedAt = new Date(Date.now() - 60_000).toISOString();
    const id = enqueueFaceScan("LIB", false, { delaySeconds: 5, chainStartedAt });
    const row = db.prepare("SELECT run_at, payload FROM jobs WHERE id = ?").get(id) as { run_at: string; payload: string };
    // run_at sits in the future so other queued library jobs can take the lock first.
    expect(new Date(row.run_at).getTime()).toBeGreaterThan(Date.now() + 3000);
    expect(JSON.parse(row.payload)).toEqual({ libraryId: "LIB", force: false, chainStartedAt });
  });

  it("pre-queues the unscanned backlog as numbered batches sharing one group", async () => {
    resetDb();
    makeUser("u1");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
    const t = Date.parse("2024-09-01T00:00:00Z");
    const itemIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      itemIds.push(await ingestGalleryAsset("GAL", asset(`b${i}.jpg`, t + i * 1000), false) as string);
    }

    const ids = enqueueFaceScanBatches("GAL", { batchSize: 2 });
    expect(ids).toHaveLength(3); // ceil(5 / 2)

    const rows = ids.map((id) => JSON.parse((db.prepare("SELECT payload FROM jobs WHERE id = ?").get(id) as { payload: string }).payload));
    expect(rows.map((r) => r.batch)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.batches === 3 && r.libraryId === "GAL" && r.force === false)).toBe(true);
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
    expect(rows[0].groupId).toBeTruthy();
  });

  it("an empty backlog still queues one batch so the no-op run is recorded", async () => {
    resetDb();
    makeUser("u1");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
    const t = Date.parse("2024-09-02T00:00:00Z");
    const itemId = await ingestGalleryAsset("GAL", asset("done.jpg", t), false);
    db.prepare("INSERT INTO gallery_face_scans (item_id, model, face_count) VALUES (?, ?, 0)").run(itemId, FACE_EMBEDDING_MODEL);

    const ids = enqueueFaceScanBatches("GAL", { batchSize: 2 });
    expect(ids).toHaveLength(1);
    const payload = JSON.parse((db.prepare("SELECT payload FROM jobs WHERE id = ?").get(ids[0]) as { payload: string }).payload);
    expect(payload).toMatchObject({ libraryId: "GAL", batch: 1, batches: 1 });
  });

  // A rescan resets the scan markers so every photo re-enters the incremental
  // pipeline and gets split into numbered batches (issue: rescan used to run as a
  // single monolithic job).
  it("resetLibraryFaceScanMarkers re-opens the whole backlog for batching, scoped to one library", async () => {
    resetDb();
    makeUser("u1");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
    makeLibrary("OTHER", { createdBy: "u1", type: "gallery" });
    const t = Date.parse("2024-10-01T00:00:00Z");
    const galItems: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await ingestGalleryAsset("GAL", asset(`g${i}.jpg`, t + i * 1000), false) as string;
      galItems.push(id);
      db.prepare("INSERT INTO gallery_face_scans (item_id, model, face_count, status) VALUES (?, ?, 0, 'ok')").run(id, FACE_EMBEDDING_MODEL);
    }
    const otherItem = await ingestGalleryAsset("OTHER", asset("o0.jpg", t), false) as string;
    db.prepare("INSERT INTO gallery_face_scans (item_id, model, face_count, status) VALUES (?, ?, 0, 'ok')").run(otherItem, FACE_EMBEDDING_MODEL);

    // Fully scanned → no batches to run.
    db.prepare("DELETE FROM jobs").run();
    expect(enqueueFaceScanBatches("GAL", { batchSize: 2 })).toHaveLength(1); // 1 no-op batch

    resetLibraryFaceScanMarkers("GAL");

    // GAL's markers are gone; OTHER's remain.
    expect((db.prepare("SELECT COUNT(*) AS n FROM gallery_face_scans WHERE item_id IN (SELECT id FROM library_items WHERE library_id='GAL')").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM gallery_face_scans WHERE item_id = ?").get(otherItem) as { n: number }).n).toBe(1);

    // All 3 GAL photos are unscanned again → they split into ceil(3/2) = 2 batches.
    db.prepare("DELETE FROM jobs").run();
    expect(enqueueFaceScanBatches("GAL", { batchSize: 2 })).toHaveLength(2);
  });
});

describe("face scan failure markers (retry budget)", () => {
  beforeEach(() => {
    resetDb();
    db.prepare("DELETE FROM jobs").run();
    makeUser("u1");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  });

  const scanRow = (itemId: string) =>
    db.prepare("SELECT status, attempts, model FROM gallery_face_scans WHERE item_id = ?").get(itemId) as
      | { status: string; attempts: number; model: string }
      | undefined;

  it("a failing photo is retried until the cap, then drops out of the backlog", async () => {
    const t = Date.parse("2024-11-01T00:00:00Z");
    const bad = await ingestGalleryAsset("GAL", asset("bad.jpg", t), false);
    await ingestGalleryAsset("GAL", asset("fresh.jpg", t + 1000), false);

    for (let attempt = 1; attempt <= MAX_FACE_SCAN_ATTEMPTS; attempt += 1) {
      // Retry budget left: the failing photo still counts toward the backlog.
      db.prepare("DELETE FROM jobs").run();
      expect(enqueueFaceScanBatches("GAL", { batchSize: 1 })).toHaveLength(2);
      recordFaceScanFailure(bad);
      expect(scanRow(bad)).toMatchObject({ status: "failed", attempts: attempt, model: FACE_EMBEDDING_MODEL });
    }

    // Cap reached: only the fresh photo remains in the backlog.
    db.prepare("DELETE FROM jobs").run();
    expect(enqueueFaceScanBatches("GAL", { batchSize: 1 })).toHaveLength(1);
  });

  it("a failure never downgrades a successful current-model marker (force-rescan case)", async () => {
    const t = Date.parse("2024-11-02T00:00:00Z");
    const done = await ingestGalleryAsset("GAL", asset("done.jpg", t), false);
    db.prepare("INSERT INTO gallery_face_scans (item_id, model, face_count, status, attempts) VALUES (?, ?, 2, 'ok', 0)")
      .run(done, FACE_EMBEDDING_MODEL);

    recordFaceScanFailure(done);
    expect(scanRow(done)).toMatchObject({ status: "ok", attempts: 0, model: FACE_EMBEDDING_MODEL });
  });

  it("a failure under a stale model restarts the count for the current model", async () => {
    const t = Date.parse("2024-11-03T00:00:00Z");
    const item = await ingestGalleryAsset("GAL", asset("stale.jpg", t), false);
    db.prepare("INSERT INTO gallery_face_scans (item_id, model, face_count, status, attempts) VALUES (?, 'old-model', 0, 'failed', 9)")
      .run(item);

    recordFaceScanFailure(item);
    expect(scanRow(item)).toMatchObject({ status: "failed", attempts: 1, model: FACE_EMBEDDING_MODEL });
  });
});

describe("per-library face recognition settings", () => {
  beforeEach(() => { resetDb(); makeUser("u1"); });

  it("tracks enablement independently per library", () => {
    expect(anyFaceLibraryEnabled()).toBe(false);
    setFaceRecognitionEnabledForLibrary("LIB_A", true, "u1");
    expect(faceRecognitionEnabledForLibrary("LIB_A")).toBe(true);
    expect(faceRecognitionEnabledForLibrary("LIB_B")).toBe(false);
    expect(enabledFaceLibraryIds()).toEqual(["LIB_A"]);
    expect(anyFaceLibraryEnabled()).toBe(true);

    setFaceRecognitionEnabledForLibrary("LIB_A", false, "u1");
    expect(enabledFaceLibraryIds()).toEqual([]);
    expect(anyFaceLibraryEnabled()).toBe(false);
  });
});

describe("clusterGalleryFaces (DB)", () => {
  beforeEach(async () => {
    resetDb();
    makeUser("u1");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
    grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  });

  // Insert an auto (scan) face on a real gallery item so access-scoped queries work.
  async function addFace(rel: string, embedding: Float32Array, when: number) {
    const itemId = await ingestGalleryAsset("GAL", asset(rel, when), false);
    db.prepare(`
      INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, assignment, source)
      VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.99, ?, ?, 'auto', 'scan')
    `).run(`f_${rel}`, itemId, embeddingToBlob(embedding), FACE_EMBEDDING_MODEL);
    return itemId;
  }

  it("forms one cluster per person and assigns every face", async () => {
    const t = Date.parse("2024-01-01T00:00:00Z");
    await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    await addFace("b1.jpg", vec(4), t + 2000);

    const result = await clusterGalleryFaces();
    expect(result.assigned).toBe(3);
    expect(result.clusters).toBe(2);

    // Two distinct clusters; the two "a" faces share one.
    const links = db.prepare("SELECT item_id, person_id FROM gallery_faces ORDER BY id").all() as { item_id: string; person_id: string | null }[];
    expect(links.every((l) => l.person_id)).toBe(true);
    const clusters = new Set(links.map((l) => l.person_id));
    expect(clusters.size).toBe(2);

    // The People list surfaces both clusters (unnamed), with the 2-photo one first.
    const people = listGalleryPeople(["GAL"]);
    expect(people).toHaveLength(2);
    expect(people[0].faceCount).toBe(2);
    expect(people.every((p) => p.name === "")).toBe(true);
  });

  it("avatar is a representative face, not a sharp mis-clustered outlier", async () => {
    const t = Date.parse("2024-05-01T00:00:00Z");
    const pid = "person-P";
    db.prepare("INSERT INTO gallery_people (id, name) VALUES (?, '')").run(pid);
    // Assign one person P: three genuine faces (with crops) plus one very sharp face of a
    // DIFFERENT person (orthogonal embedding) that got mis-merged in.
    const addAssigned = async (rel: string, emb: Float32Array, det: number) => {
      const itemId = await ingestGalleryAsset("GAL", asset(rel, t), false);
      db.prepare(`
        INSERT INTO gallery_faces (id, item_id, person_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, thumb_storage_key, assignment, source)
        VALUES (?, ?, ?, 0.1, 0.1, 0.2, 0.2, ?, ?, ?, ?, 'auto', 'scan')
      `).run(`f_${rel}`, itemId, pid, det, embeddingToBlob(emb), FACE_EMBEDDING_MODEL, `thumb_${rel}`);
      return `f_${rel}`;
    };
    await addAssigned("a1.jpg", vec(0, 0.02), 0.80);
    await addAssigned("a2.jpg", vec(0, 0.04), 0.78);
    const a3 = await addAssigned("a3.jpg", vec(0, 0.03), 0.82); // clearest genuine face
    const outlier = await addAssigned("x.jpg", vec(4), 0.99);   // sharpest, but wrong person

    recomputeClusterCentroid(pid);

    // The high-det_score outlier must NOT win; the clearest representative face does.
    const cover = (db.prepare("SELECT cover_face_id FROM gallery_people WHERE id = ?").get(pid) as { cover_face_id: string }).cover_face_id;
    expect(cover).not.toBe(outlier);
    expect(cover).toBe(a3);

    // The People list shows that same representative crop, not the outlier's.
    const person = listGalleryPeople(["GAL"]).find((p) => p.id === pid)!;
    expect(person.coverUrl).toContain("thumb_a3.jpg");
    expect(person.coverUrl).not.toContain("thumb_x.jpg");
  });

  it("re-clustering is global and consolidates matching faces into one person", async () => {
    const t = Date.parse("2024-02-01T00:00:00Z");
    await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.08), t + 1000);
    await clusterGalleryFaces();
    expect(listGalleryPeople(["GAL"]).length).toBe(1);
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(2);

    await addFace("a3.jpg", vec(0, 0.02), t + 2000);
    const second = await clusterGalleryFaces();
    expect(second.assigned).toBe(3);
    expect(listGalleryPeople(["GAL"]).length).toBe(1);
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(3);
  });

  it("removing an auto person from a photo rejects the face and never reclusters it back", async () => {
    const t = Date.parse("2024-03-01T00:00:00Z");
    const i1 = await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    await clusterGalleryFaces();
    const personId = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = ?").get(i1) as { person_id: string }).person_id;
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(2);

    // The reported bug: removing an auto-detected person must actually detach it.
    untagAssetPerson(i1, personId);
    expect((db.prepare("SELECT assignment FROM gallery_faces WHERE item_id = ?").get(i1) as { assignment: string }).assignment).toBe("rejected");
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(1);
    expect((getGalleryAsset("u1", ["GAL"], i1) as { people?: unknown[] }).people).toEqual([]);

    // A later clustering pass must not pull the rejected face back into the person.
    await clusterGalleryFaces();
    expect((db.prepare("SELECT assignment FROM gallery_faces WHERE item_id = ?").get(i1) as { assignment: string }).assignment).toBe("rejected");
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(1);
  });

  it("a removal survives a FULL rescan for a named person (exclusion re-applied)", async () => {
    const t = Date.parse("2024-04-01T00:00:00Z");
    const i1 = await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    await clusterGalleryFaces();
    const personId = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = ?").get(i1) as { person_id: string }).person_id;
    renameGalleryPerson(personId, "Mum"); // naming makes the cluster persist across a rescan
    untagAssetPerson(i1, personId);        // user removes i1 from Mum → records an exclusion
    expect(listGalleryPeople(["GAL"]).find((p) => p.id === personId)?.faceCount).toBe(1);

    // Simulate a full rescan: every auto face is deleted and re-detected from scratch.
    db.prepare("DELETE FROM gallery_faces WHERE source = 'scan'").run();
    await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    await clusterGalleryFaces();

    // Mum is rebuilt, but i1 stays out (count 1) — the removal was re-applied.
    const mum = listGalleryPeople(["GAL"]).find((p) => p.id === personId);
    expect(mum?.name).toBe("Mum");
    expect(mum?.faceCount).toBe(1);
    expect((db.prepare("SELECT assignment FROM gallery_faces WHERE item_id = ?").get(i1) as { assignment: string }).assignment).toBe("rejected");
    const people = (getGalleryAsset("u1", ["GAL"], i1) as { people?: { id: string }[] }).people ?? [];
    expect(people.some((p) => p.id === personId)).toBe(false);
  });

  it("a user merge into a named person survives reclustering", async () => {
    const t = Date.parse("2024-07-01T00:00:00Z");
    await addFace("p1.jpg", vec(0, 0.05), t);
    await addFace("p2.jpg", vec(0, 0.1), t + 1000);
    await addFace("q1.jpg", vec(3, 0.05), t + 2000);
    await addFace("q2.jpg", vec(3, 0.1), t + 3000);
    await clusterGalleryFaces();
    const people = listGalleryPeople(["GAL"]);
    expect(people).toHaveLength(2);

    // Name one cluster and fold the other into it (they're really the same person).
    const [target, source] = people;
    renameGalleryPerson(target.id, "Dad");
    expect(mergeGalleryPeople(source.id, target.id)).toBe(true);
    expect(listGalleryPeople(["GAL"])).toHaveLength(1);

    // The nightly recluster used to re-split this (only one new group could reclaim the
    // name); now every group whose faces belonged to Dad re-unions into him.
    await clusterGalleryFaces();
    const after = listGalleryPeople(["GAL"]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(target.id);
    expect(after[0].name).toBe("Dad");
    expect(after[0].faceCount).toBe(4);
  });

  it("a merge of two UNNAMED groups is durable too (curated anchor)", async () => {
    const t = Date.parse("2024-07-02T00:00:00Z");
    await addFace("p1.jpg", vec(0, 0.05), t);
    await addFace("p2.jpg", vec(0, 0.1), t + 1000);
    await addFace("q1.jpg", vec(3, 0.05), t + 2000);
    await addFace("q2.jpg", vec(3, 0.1), t + 3000);
    await clusterGalleryFaces();
    const [target, source] = listGalleryPeople(["GAL"]);

    expect(mergeGalleryPeople(source.id, target.id)).toBe(true);
    expect((db.prepare("SELECT curated FROM gallery_people WHERE id = ?").get(target.id) as { curated: number }).curated).toBe(1);

    await clusterGalleryFaces();
    const after = listGalleryPeople(["GAL"]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(target.id);
    expect(after[0].faceCount).toBe(4);
  });

  it("after a rescan, a lone slightly-drifted face rejoins the anchored person", async () => {
    const t = Date.parse("2024-08-01T00:00:00Z");
    await addFace("m1.jpg", vec(0, 0.05), t);
    await addFace("m2.jpg", vec(0, 0.1), t + 1000);
    await clusterGalleryFaces();
    const person = listGalleryPeople(["GAL"])[0];
    renameGalleryPerson(person.id, "Mum");

    // Full rescan re-detects a single face with a drifted embedding — cosine ~0.52 to
    // Mum's centroid: below the whole-group rematch bar (0.55) but above the 1–2-face
    // attach bar (0.5), so only the singleton-absorption path can claim it.
    db.prepare("DELETE FROM gallery_faces WHERE source = 'scan'").run();
    await addFace("m3.jpg", mix(0, 0.52, 2, 0.854), t + 2000);
    await clusterGalleryFaces();

    const after = listGalleryPeople(["GAL"]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(person.id);
    expect(after[0].name).toBe("Mum");
    expect(after[0].faceCount).toBe(1);
  });

  it("the cover face skips rejected faces and trashed photos, and clears when none qualify", async () => {
    const t = Date.parse("2024-09-01T00:00:00Z");
    const i1 = await addFace("c1.jpg", vec(0, 0.05), t);
    const i2 = await addFace("c2.jpg", vec(0, 0.1), t + 1000);
    // Both faces have crops; c1's face has the higher det_score, so it starts as cover.
    db.prepare("UPDATE gallery_faces SET thumb_storage_key = id || '.webp'").run();
    db.prepare("UPDATE gallery_faces SET det_score = 0.5 WHERE item_id = ?").run(i2);
    await clusterGalleryFaces();
    const personId = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = ?").get(i1) as { person_id: string }).person_id;
    const cover = () => (db.prepare("SELECT cover_face_id AS c FROM gallery_people WHERE id = ?").get(personId) as { c: string | null }).c;
    expect(cover()).toBe("f_c1.jpg");

    // "Not this person" on the cover photo must move the avatar off the rejected face.
    untagAssetPerson(i1, personId);
    expect(cover()).toBe("f_c2.jpg");

    // Trashing the photo behind the remaining crop clears the cover entirely.
    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(i2);
    recomputeClusterCentroid(personId);
    expect(cover()).toBeNull();
  });

  it("the People-list avatar never leaks a face crop from an inaccessible library", async () => {
    makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
    grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
    const t = Date.parse("2024-10-01T00:00:00Z");
    await addFace("a1.jpg", vec(0, 0.05), t);
    // The same person's face in GAL2, with the globally best (highest-score) crop.
    const other = await ingestGalleryAsset("GAL2", {
      ...asset("a2.jpg", t + 1000), absolutePath: "/src/GAL2/a2.jpg"
    }, false);
    db.prepare(`
      INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, assignment, source)
      VALUES ('f_other', ?, 0.1, 0.1, 0.2, 0.2, 0.995, ?, ?, 'auto', 'scan')
    `).run(other, embeddingToBlob(vec(0, 0.1)), FACE_EMBEDDING_MODEL);
    db.prepare("UPDATE gallery_faces SET thumb_storage_key = id || '.webp'").run();
    await clusterGalleryFaces();
    expect(listGalleryPeople(["GAL", "GAL2"])).toHaveLength(1); // one person across both

    // Full access: the globally best crop (GAL2's) is the avatar. Face crops are
    // content-addressed, so their URL carries ?v=1 for immutable browser caching.
    expect(listGalleryPeople(["GAL", "GAL2"])[0].coverUrl).toBe("/api/library/covers/f_other.webp?v=1");
    // GAL-only access: the avatar comes from GAL's face, never the GAL2 crop.
    expect(listGalleryPeople(["GAL"])[0].coverUrl).toBe("/api/library/covers/f_a1.jpg.webp?v=1");
  });

  it("a hidden person's photos are not reachable by direct id (unless allowed)", async () => {
    const t = Date.parse("2024-10-02T00:00:00Z");
    const i1 = await addFace("h1.jpg", vec(0, 0.05), t);
    await clusterGalleryFaces();
    const personId = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = ?").get(i1) as { person_id: string }).person_id;
    expect(getGalleryPersonPhotos("u1", ["GAL"], personId, 10, 0)?.assets).toHaveLength(1);

    setGalleryPersonHidden(personId, true);
    // Hidden: gone from the list AND a null (404) by direct id for regular viewers.
    expect(listGalleryPeople(["GAL"])).toHaveLength(0);
    expect(getGalleryPersonPhotos("u1", ["GAL"], personId, 10, 0)).toBeNull();
    // The admin path (includeHidden) still reaches it.
    expect(getGalleryPersonPhotos("u1", ["GAL"], personId, 10, 0, true)?.assets).toHaveLength(1);
  });

  it("clearLibraryFaceData wipes faces, scan markers, and exclusions and prunes people", async () => {
    const t = Date.parse("2024-05-01T00:00:00Z");
    const i1 = await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    await clusterGalleryFaces();
    // A scan marker and an exclusion exist for the library's items.
    db.prepare("INSERT INTO gallery_face_scans (item_id, model, face_count) VALUES (?, ?, 1)").run(i1, FACE_EMBEDDING_MODEL);
    const personId = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = ?").get(i1) as { person_id: string }).person_id;
    db.prepare("INSERT INTO gallery_face_exclusions (item_id, person_id) VALUES (?, ?)").run(i1, personId);
    expect(listGalleryPeople(["GAL"]).length).toBe(1);

    const result = await clearLibraryFaceData("GAL");
    expect(result.faces).toBe(2);
    expect(result.photos).toBe(1);

    expect((db.prepare("SELECT COUNT(*) AS n FROM gallery_faces").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM gallery_face_scans").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM gallery_face_exclusions").get() as { n: number }).n).toBe(0);
    // The unnamed person, now faceless, is pruned.
    expect(listGalleryPeople(["GAL"]).length).toBe(0);
  });

  it("clearLibraryFaceData keeps another library's faces", async () => {
    makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
    grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
    const t = Date.parse("2024-06-01T00:00:00Z");
    await addFace("a1.jpg", vec(0, 0.05), t);
    // A face in the other library (insert directly against a GAL2 item).
    const other = await ingestGalleryAsset("GAL2", {
      ...asset("b1.jpg", t + 1000), absolutePath: "/src/GAL2/b1.jpg"
    }, false);
    db.prepare(`
      INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, assignment, source)
      VALUES ('f_other', ?, 0.1, 0.1, 0.2, 0.2, 0.99, ?, ?, 'auto', 'scan')
    `).run(other, embeddingToBlob(vec(4)), FACE_EMBEDDING_MODEL);
    await clusterGalleryFaces();

    await clearLibraryFaceData("GAL");

    const remaining = db.prepare("SELECT item_id FROM gallery_faces").all() as { item_id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].item_id).toBe(other);
  });
});

describe("face-crop files (orphan sweep)", () => {
  let root: string;

  beforeEach(() => {
    resetDb();
    makeUser("u1");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
    grant("group", EVERYONE_GROUP_ID, "GAL", "member");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "face-sweep-"));
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(thumbnailPathSettingKey, root);
  });

  afterEach(() => {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const file = (...segments: string[]) => {
    const abs = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x");
    return abs;
  };

  it("removes unreferenced *-face.webp files and keeps referenced crops and covers", async () => {
    const itemId = await ingestGalleryAsset("GAL", asset("a1.jpg", Date.parse("2024-10-01T00:00:00Z")), false);
    db.prepare(`
      INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, thumb_storage_key, assignment, source)
      VALUES ('f_keep', ?, 0.1, 0.1, 0.2, 0.2, 0.99, ?, ?, 'GAL/aa/bb/f_keep-face.webp', 'auto', 'scan')
    `).run(itemId, embeddingToBlob(vec(0)), FACE_EMBEDDING_MODEL);

    const kept = file("GAL", "aa", "bb", "f_keep-face.webp");   // referenced crop
    const orphan = file("GAL", "aa", "bb", "f_gone-face.webp"); // no row references it
    const cover = file("GAL", "aa", "bb", "item-cover.webp");   // not a face crop

    expect(faceCropKeysForItem(itemId)).toEqual(["GAL/aa/bb/f_keep-face.webp"]);
    expect(sweepOrphanFaceCrops()).toBe(1);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(cover)).toBe(true);
  });

  // Skipped if a THUMBNAIL_PATH env fallback exists — the sweep would then walk a real
  // store, and this test's empty in-memory DB references nothing.
  it.skipIf(!!process.env.THUMBNAIL_PATH)("is a safe no-op when the thumbnail store is not configured", () => {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
    expect(sweepOrphanFaceCrops()).toBe(0);
  });
});

describe("computeClusterHealth (DB)", () => {
  beforeEach(() => {
    resetDb();
    makeUser("u1");
    makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
    grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  });

  // Assign a scan face (with a crop) to a specific person on a real gallery item.
  async function addAssigned(rel: string, personId: string, emb: Float32Array) {
    const itemId = await ingestGalleryAsset("GAL", asset(rel, Date.parse("2024-06-01T00:00:00Z")), false);
    db.prepare(`
      INSERT INTO gallery_faces (id, item_id, person_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, thumb_storage_key, assignment, source)
      VALUES (?, ?, ?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, ?, ?, 'auto', 'scan')
    `).run(`f_${rel}`, itemId, personId, embeddingToBlob(emb), FACE_EMBEDDING_MODEL, `thumb_${rel}`);
  }

  it("flags two near-duplicate people as a likely merge and leaves distinct ones alone", async () => {
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('pA', ''), ('pB', ''), ('pC', '')").run();
    // pB's centroid sits at cosine 0.55 to pA's (axis 0) — just under the 0.58 merge line,
    // i.e. the "likely same person, split" band. pC is orthogonal (a genuinely different
    // person) and must not be suggested.
    const near = mix(0, 0.55, 1, Math.sqrt(1 - 0.55 * 0.55));
    await addAssigned("a1.jpg", "pA", vec(0));
    await addAssigned("a2.jpg", "pA", vec(0));
    await addAssigned("b1.jpg", "pB", near);
    await addAssigned("b2.jpg", "pB", near);
    await addAssigned("c1.jpg", "pC", vec(4));
    for (const id of ["pA", "pB", "pC"]) recomputeClusterCentroid(id);

    const health = await computeClusterHealth(["GAL"]);
    expect(health.totalPeople).toBe(3);
    expect(health.peopleWithTwin).toBe(2);
    expect(health.bands.nearCertain).toBe(0);
    expect(health.bands.likely).toBe(1);
    expect(health.bands.possible).toBe(0);
    expect(health.pairs).toHaveLength(1);
    expect([health.pairs[0].a.id, health.pairs[0].b.id].sort()).toEqual(["pA", "pB"]);
    expect(health.pairs[0].similarity).toBeGreaterThan(0.52);
    expect(health.pairs[0].similarity).toBeLessThan(0.58);
  });

  it("reports a clean bill of health when clusters are well separated", async () => {
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('pX', ''), ('pY', '')").run();
    await addAssigned("x1.jpg", "pX", vec(0));
    await addAssigned("y1.jpg", "pY", vec(4));
    for (const id of ["pX", "pY"]) recomputeClusterCentroid(id);

    const health = await computeClusterHealth(["GAL"]);
    expect(health.totalPeople).toBe(2);
    expect(health.peopleWithTwin).toBe(0);
    expect(health.pairs).toHaveLength(0);
  });
});
