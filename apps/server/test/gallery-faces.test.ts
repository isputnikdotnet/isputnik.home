import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import {
  embeddingToBlob, blobToEmbedding, cosineSimilarity, centroidOf
} from "../src/modules/library/gallery/faces/embedding.js";
import { mutualKnnClusters, mergeClustersByCentroid, clusterGalleryFaces } from "../src/modules/library/gallery/faces/cluster.js";
import { FACE_EMBEDDING_MODEL } from "../src/modules/library/gallery/faces/model-id.js";
import { enqueueFaceScan, enqueueFaceScanBatches, faceJobType } from "../src/modules/library/gallery/faces/queue.js";
import { clearLibraryFaceData } from "../src/modules/library/gallery/faces/clear.js";
import {
  faceRecognitionEnabledForLibrary, setFaceRecognitionEnabledForLibrary,
  enabledFaceLibraryIds, anyFaceLibraryEnabled
} from "../src/modules/library/gallery/faces/settings.js";
import { listGalleryPeople, untagAssetPerson, renameGalleryPerson, mergeGalleryPeople } from "../src/modules/library/gallery/people.js";
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
  it("links mutual neighbours into one group and isolates a dissimilar face", () => {
    const faces = [
      { id: "a1", emb: vec(0, 0.05) },
      { id: "a2", emb: vec(0, 0.1) },
      { id: "a3", emb: vec(0, 0.02) },
      { id: "b1", emb: vec(4) }
    ];
    const groups = mutualKnnClusters(faces, 3, 0.5);
    expect(groups.length).toBe(2);
    expect(groups.find((g) => g.includes("a1"))?.sort()).toEqual(["a1", "a2", "a3"]);
    expect(groups.find((g) => g.includes("b1"))).toEqual(["b1"]);
  });

  it("keeps two tight groups apart (hub-chaining resistance)", () => {
    const faces = [
      { id: "a1", emb: vec(0, 0.03) }, { id: "a2", emb: vec(0, 0.06) }, { id: "a3", emb: vec(0, 0.09) },
      { id: "c1", emb: vec(2, 0.03) }, { id: "c2", emb: vec(2, 0.06) }, { id: "c3", emb: vec(2, 0.09) }
    ];
    expect(mutualKnnClusters(faces, 3, 0.5).length).toBe(2);
  });
});

describe("mergeClustersByCentroid (pure)", () => {
  it("re-unites one person's k-NN fragments while keeping different people apart", () => {
    // One person in two "eras": the b-faces sit at cosine ~0.8 to the a-faces, but each
    // sub-group's top-2 lists are saturated by its own near-duplicates, so mutual k-NN
    // (k=2) leaves the person split. A third, unrelated person (z) stays orthogonal.
    const faces = [
      { id: "a1", emb: vec(0, 0.02) }, { id: "a2", emb: vec(0, 0.04) }, { id: "a3", emb: vec(0, 0.06) },
      { id: "b1", emb: mix(0, 0.8, 1, 0.6) }, { id: "b2", emb: mix(0, 0.79, 1, 0.61) }, { id: "b3", emb: mix(0, 0.81, 1, 0.59) },
      { id: "z1", emb: vec(4, 0.02) }, { id: "z2", emb: vec(4, 0.04) }, { id: "z3", emb: vec(4, 0.06) }
    ];
    const knn = mutualKnnClusters(faces, 2, 0.3);
    expect(knn.length).toBe(3); // fragmented: a-, b-, and z-groups

    const embById = new Map(faces.map((f) => [f.id, f.emb]));
    const merged = mergeClustersByCentroid(knn, embById, 0.58).map((g) => [...g].sort());
    expect(merged.length).toBe(2);
    expect(merged.find((g) => g.includes("a1"))).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"]);
    expect(merged.find((g) => g.includes("z1"))).toEqual(["z1", "z2", "z3"]);
  });

  it("leaves everything untouched when no centroids clear the threshold", () => {
    const faces = [
      { id: "a1", emb: vec(0, 0.05) }, { id: "a2", emb: vec(0, 0.1) },
      { id: "c1", emb: vec(2, 0.05) }, { id: "c2", emb: vec(2, 0.1) }
    ];
    const embById = new Map(faces.map((f) => [f.id, f.emb]));
    const groups = mutualKnnClusters(faces, 3, 0.5);
    expect(mergeClustersByCentroid(groups, embById, 0.58).length).toBe(groups.length);
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

    const result = clusterGalleryFaces();
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

  it("re-clustering is global and consolidates matching faces into one person", async () => {
    const t = Date.parse("2024-02-01T00:00:00Z");
    await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.08), t + 1000);
    clusterGalleryFaces();
    expect(listGalleryPeople(["GAL"]).length).toBe(1);
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(2);

    await addFace("a3.jpg", vec(0, 0.02), t + 2000);
    const second = clusterGalleryFaces();
    expect(second.assigned).toBe(3);
    expect(listGalleryPeople(["GAL"]).length).toBe(1);
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(3);
  });

  it("removing an auto person from a photo rejects the face and never reclusters it back", async () => {
    const t = Date.parse("2024-03-01T00:00:00Z");
    const i1 = await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    clusterGalleryFaces();
    const personId = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = ?").get(i1) as { person_id: string }).person_id;
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(2);

    // The reported bug: removing an auto-detected person must actually detach it.
    untagAssetPerson(i1, personId);
    expect((db.prepare("SELECT assignment FROM gallery_faces WHERE item_id = ?").get(i1) as { assignment: string }).assignment).toBe("rejected");
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(1);
    expect((getGalleryAsset("u1", ["GAL"], i1) as { people?: unknown[] }).people).toEqual([]);

    // A later clustering pass must not pull the rejected face back into the person.
    clusterGalleryFaces();
    expect((db.prepare("SELECT assignment FROM gallery_faces WHERE item_id = ?").get(i1) as { assignment: string }).assignment).toBe("rejected");
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(1);
  });

  it("a removal survives a FULL rescan for a named person (exclusion re-applied)", async () => {
    const t = Date.parse("2024-04-01T00:00:00Z");
    const i1 = await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    clusterGalleryFaces();
    const personId = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = ?").get(i1) as { person_id: string }).person_id;
    renameGalleryPerson(personId, "Mum"); // naming makes the cluster persist across a rescan
    untagAssetPerson(i1, personId);        // user removes i1 from Mum → records an exclusion
    expect(listGalleryPeople(["GAL"]).find((p) => p.id === personId)?.faceCount).toBe(1);

    // Simulate a full rescan: every auto face is deleted and re-detected from scratch.
    db.prepare("DELETE FROM gallery_faces WHERE source = 'scan'").run();
    await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    clusterGalleryFaces();

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
    clusterGalleryFaces();
    const people = listGalleryPeople(["GAL"]);
    expect(people).toHaveLength(2);

    // Name one cluster and fold the other into it (they're really the same person).
    const [target, source] = people;
    renameGalleryPerson(target.id, "Dad");
    expect(mergeGalleryPeople(source.id, target.id)).toBe(true);
    expect(listGalleryPeople(["GAL"])).toHaveLength(1);

    // The nightly recluster used to re-split this (only one new group could reclaim the
    // name); now every group whose faces belonged to Dad re-unions into him.
    clusterGalleryFaces();
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
    clusterGalleryFaces();
    const [target, source] = listGalleryPeople(["GAL"]);

    expect(mergeGalleryPeople(source.id, target.id)).toBe(true);
    expect((db.prepare("SELECT curated FROM gallery_people WHERE id = ?").get(target.id) as { curated: number }).curated).toBe(1);

    clusterGalleryFaces();
    const after = listGalleryPeople(["GAL"]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(target.id);
    expect(after[0].faceCount).toBe(4);
  });

  it("after a rescan, a lone slightly-drifted face rejoins the anchored person", async () => {
    const t = Date.parse("2024-08-01T00:00:00Z");
    await addFace("m1.jpg", vec(0, 0.05), t);
    await addFace("m2.jpg", vec(0, 0.1), t + 1000);
    clusterGalleryFaces();
    const person = listGalleryPeople(["GAL"])[0];
    renameGalleryPerson(person.id, "Mum");

    // Full rescan re-detects a single face with a drifted embedding — cosine ~0.52 to
    // Mum's centroid: below the whole-group rematch bar (0.55) but above the 1–2-face
    // attach bar (0.5), so only the singleton-absorption path can claim it.
    db.prepare("DELETE FROM gallery_faces WHERE source = 'scan'").run();
    await addFace("m3.jpg", mix(0, 0.52, 2, 0.854), t + 2000);
    clusterGalleryFaces();

    const after = listGalleryPeople(["GAL"]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(person.id);
    expect(after[0].name).toBe("Mum");
    expect(after[0].faceCount).toBe(1);
  });

  it("clearLibraryFaceData wipes faces, scan markers, and exclusions and prunes people", async () => {
    const t = Date.parse("2024-05-01T00:00:00Z");
    const i1 = await addFace("a1.jpg", vec(0, 0.05), t);
    await addFace("a2.jpg", vec(0, 0.1), t + 1000);
    clusterGalleryFaces();
    // A scan marker and an exclusion exist for the library's items.
    db.prepare("INSERT INTO gallery_face_scans (item_id, model, face_count) VALUES (?, ?, 1)").run(i1, FACE_EMBEDDING_MODEL);
    const personId = (db.prepare("SELECT person_id FROM gallery_faces WHERE item_id = ?").get(i1) as { person_id: string }).person_id;
    db.prepare("INSERT INTO gallery_face_exclusions (item_id, person_id) VALUES (?, ?)").run(i1, personId);
    expect(listGalleryPeople(["GAL"]).length).toBe(1);

    const result = clearLibraryFaceData("GAL");
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
    clusterGalleryFaces();

    clearLibraryFaceData("GAL");

    const remaining = db.prepare("SELECT item_id FROM gallery_faces").all() as { item_id: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].item_id).toBe(other);
  });
});
