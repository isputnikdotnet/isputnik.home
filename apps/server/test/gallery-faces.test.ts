import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import {
  embeddingToBlob, blobToEmbedding, cosineSimilarity, centroidOf
} from "../src/modules/library/gallery/faces/embedding.js";
import { mutualKnnClusters, clusterGalleryFaces } from "../src/modules/library/gallery/faces/cluster.js";
import {
  faceRecognitionEnabledForLibrary, setFaceRecognitionEnabledForLibrary,
  enabledFaceLibraryIds, anyFaceLibraryEnabled
} from "../src/modules/library/gallery/faces/settings.js";
import { listGalleryPeople, untagAssetPerson, renameGalleryPerson } from "../src/modules/library/gallery/people.js";
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
      VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.99, ?, 'human/faceres', 'auto', 'scan')
    `).run(`f_${rel}`, itemId, embeddingToBlob(embedding));
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
});
