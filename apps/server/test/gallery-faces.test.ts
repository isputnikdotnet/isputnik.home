import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import {
  embeddingToBlob, blobToEmbedding, cosineSimilarity, centroidOf
} from "../src/modules/library/gallery/faces/embedding.js";
import { assignFaces, clusterGalleryFaces } from "../src/modules/library/gallery/faces/cluster.js";
import { listGalleryPeople } from "../src/modules/library/gallery/people.js";
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

describe("assignFaces (pure greedy clustering)", () => {
  it("groups similar faces and separates dissimilar ones", () => {
    let n = 0;
    const faces = [
      { id: "a1", embedding: vec(0, 0.05) },
      { id: "a2", embedding: vec(0, 0.1) },
      { id: "b1", embedding: vec(4) }
    ];
    const out = assignFaces(faces, [], 0.5, () => `c${n++}`);
    expect(out[0]).toMatchObject({ faceId: "a1", created: true });
    expect(out[1]).toMatchObject({ faceId: "a2", clusterId: out[0].clusterId, created: false });
    expect(out[2].created).toBe(true);
    expect(out[2].clusterId).not.toBe(out[0].clusterId);
    expect(new Set(out.map((a) => a.clusterId)).size).toBe(2);
  });

  it("attaches a face to a matching pre-existing cluster", () => {
    const out = assignFaces([{ id: "x", embedding: vec(0, 0.05) }], [{ id: "known", vec: vec(0) }], 0.5, () => "new");
    expect(out[0]).toMatchObject({ faceId: "x", clusterId: "known", created: false });
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
    expect(result.newClusters).toBe(2);

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

  it("a second pass attaches new faces to the existing cluster (no new cluster)", async () => {
    const t = Date.parse("2024-02-01T00:00:00Z");
    await addFace("a1.jpg", vec(0, 0.05), t);
    clusterGalleryFaces();
    const firstClusters = (db.prepare("SELECT COUNT(*) n FROM gallery_people").get() as { n: number }).n;

    await addFace("a3.jpg", vec(0, 0.08), t + 1000);
    const second = clusterGalleryFaces();
    expect(second.newClusters).toBe(0);
    expect(second.assigned).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM gallery_people").get() as { n: number }).n).toBe(firstClusters);
    expect(listGalleryPeople(["GAL"])[0].faceCount).toBe(2);
  });
});
