// A photo kept out of a Photo Inbox arrives at its first face scan already carrying
// the reviewer's answer to "who is in it?" — as a whole-photo tag, because an Inbox
// is never scanned and there was no face to point at. When the scan finds exactly one
// face, that tag can only have meant it (adopt.ts), so the detection takes the name
// and reaches the recogniser. Anything less certain is left as it was.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { getGalleryAsset } from "../src/modules/library/gallery/catalog-asset.js";
import { embeddingToBlob } from "../src/modules/library/gallery/faces/embedding.js";
import { clusterGalleryFaces } from "../src/modules/library/gallery/faces/cluster.js";
import { adoptWholePhotoTag, adoptWholePhotoTags } from "../src/modules/library/gallery/faces/adopt.js";
import { FACE_EMBEDDING_MODEL } from "../src/modules/library/gallery/faces/model-id.js";
import { createGalleryPerson, tagAssetPerson, listGalleryPeople } from "../src/modules/library/gallery/people.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function vec(axis: number, noise = 0): Float32Array {
  const v = new Float32Array(8);
  v[axis] = 1;
  v[(axis + 1) % 8] = noise;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function asset(relativePath: string, modifiedMs: number) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`, relativePath, fileName: relativePath.split("/").pop()!,
    extension, kind: kindForExtension(extension)!, size: 1000, modifiedAtMs: modifiedMs
  };
}

const T = Date.parse("2024-01-01T00:00:00Z");

function addFace(id: string, itemId: string, embedding: Float32Array, box = [0.1, 0.2, 0.3, 0.4]) {
  db.prepare(`
    INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, assignment, source)
    VALUES (?, ?, ?, ?, ?, ?, 0.99, ?, ?, 'auto', 'scan')
  `).run(id, itemId, box[0], box[1], box[2], box[3], embeddingToBlob(embedding), FACE_EMBEDDING_MODEL);
}

const faceRow = (id: string) =>
  db.prepare("SELECT person_id, assignment FROM gallery_faces WHERE id = ?").get(id) as
    { person_id: string | null; assignment: string } | undefined;

const tagCount = (itemId: string) => (db.prepare(
  "SELECT COUNT(*) AS n FROM gallery_faces WHERE item_id = ? AND source = 'manual' AND box_x IS NULL"
).get(itemId) as { n: number }).n;

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("adopting a whole-photo tag onto the one face", () => {
  it("gives the single face the single name, and drops the tag that stood in for it", async () => {
    const item = await ingestGalleryAsset("GAL", asset("kept.jpg", T), false);
    const mum = createGalleryPerson("Mum");
    tagAssetPerson(item, mum.id);              // said in Review, before the photo had faces
    addFace("f1", item, vec(0));               // the scan, after it was kept

    expect(adoptWholePhotoTag(item)).toBe(mum.id);
    expect(faceRow("f1")).toEqual({ person_id: mum.id, assignment: "confirmed" });
    expect(tagCount(item)).toBe(0);

    // The photo still says Mum exactly once — now on her face, not beside it.
    const detail = getGalleryAsset("u1", ["GAL"], item)!;
    expect(detail.people).toEqual([{ id: mum.id, name: "Mum" }]);
    expect(detail.faces).toEqual([
      { id: "f1", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, personId: mum.id, personName: "Mum", confirmed: true, thumbUrl: null }
    ]);
    expect(listGalleryPeople(["GAL"]).find((p) => p.id === mum.id)?.faceCount).toBe(1);
  });

  it("leaves two faces and one name alone — nothing says which of them she is", async () => {
    const item = await ingestGalleryAsset("GAL", asset("pair.jpg", T), false);
    const mum = createGalleryPerson("Mum");
    tagAssetPerson(item, mum.id);
    addFace("f1", item, vec(0));
    addFace("f2", item, vec(4), [0.6, 0.1, 0.2, 0.2]);

    expect(adoptWholePhotoTag(item)).toBeNull();
    expect(faceRow("f1")!.person_id).toBeNull();
    expect(tagCount(item)).toBe(1);
  });

  it("leaves one face and two names alone", async () => {
    const item = await ingestGalleryAsset("GAL", asset("crowd.jpg", T), false);
    tagAssetPerson(item, createGalleryPerson("Mum").id);
    tagAssetPerson(item, createGalleryPerson("Dad").id);
    addFace("f1", item, vec(0));

    expect(adoptWholePhotoTag(item)).toBeNull();
    expect(faceRow("f1")!.person_id).toBeNull();
    expect(tagCount(item)).toBe(2);
  });

  it("does not overwrite a face someone named: the specific answer wins", async () => {
    const item = await ingestGalleryAsset("GAL", asset("named.jpg", T), false);
    const mum = createGalleryPerson("Mum");
    const gran = createGalleryPerson("Gran");
    tagAssetPerson(item, mum.id);
    addFace("f1", item, vec(0));
    db.prepare("UPDATE gallery_faces SET person_id = ?, assignment = 'confirmed' WHERE id = 'f1'").run(gran.id);

    expect(adoptWholePhotoTag(item)).toBeNull();
    expect(faceRow("f1")).toEqual({ person_id: gran.id, assignment: "confirmed" });
    expect(tagCount(item)).toBe(1);
  });

  it("clears the tag that has become a duplicate of the face's own name", async () => {
    const item = await ingestGalleryAsset("GAL", asset("same.jpg", T), false);
    const mum = createGalleryPerson("Mum");
    tagAssetPerson(item, mum.id);
    addFace("f1", item, vec(0));
    db.prepare("UPDATE gallery_faces SET person_id = ? WHERE id = 'f1'").run(mum.id);

    expect(adoptWholePhotoTag(item)).toBe(mum.id);
    expect(tagCount(item)).toBe(0);
    expect(faceRow("f1")).toEqual({ person_id: mum.id, assignment: "confirmed" });
  });

  it("holds the name through the next clustering pass, and hands it to the group", async () => {
    const [kept, other] = await Promise.all([
      ingestGalleryAsset("GAL", asset("kept.jpg", T), false),
      ingestGalleryAsset("GAL", asset("older.jpg", T + 1000), false)
    ]);
    const mum = createGalleryPerson("Mum");
    tagAssetPerson(kept, mum.id);
    addFace("f1", kept, vec(0));
    addFace("f2", other, vec(0, 0.02));        // the same face, from before the Inbox

    expect(adoptWholePhotoTag(kept)).toBe(mum.id);
    await clusterGalleryFaces();

    // Confirmed faces are pinned, so the adopted one stays Mum — and its vote names
    // the group, which is the whole point: the reviewer's answer reached the recogniser.
    expect(faceRow("f1")).toEqual({ person_id: mum.id, assignment: "confirmed" });
    expect(faceRow("f2")!.person_id).toBe(mum.id);
    expect(listGalleryPeople(["GAL"]).find((p) => p.id === mum.id)?.faceCount).toBe(2);
  });
});

describe("the sweep over photos scanned before this existed", () => {
  it("adopts every unambiguous photo and counts them, leaving the rest", async () => {
    const mum = createGalleryPerson("Mum");
    const dad = createGalleryPerson("Dad");
    const [one, two, pair] = await Promise.all([
      ingestGalleryAsset("GAL", asset("one.jpg", T), false),
      ingestGalleryAsset("GAL", asset("two.jpg", T + 1000), false),
      ingestGalleryAsset("GAL", asset("pair.jpg", T + 2000), false)
    ]);
    tagAssetPerson(one, mum.id);
    tagAssetPerson(two, dad.id);
    tagAssetPerson(pair, mum.id);
    addFace("f1", one, vec(0));
    addFace("f2", two, vec(4));
    addFace("f3", pair, vec(0, 0.02));
    addFace("f4", pair, vec(4, 0.02), [0.6, 0.1, 0.2, 0.2]);

    expect(adoptWholePhotoTags()).toBe(2);
    expect(faceRow("f1")!.person_id).toBe(mum.id);
    expect(faceRow("f2")!.person_id).toBe(dad.id);
    expect(faceRow("f3")!.person_id).toBeNull();
    expect(tagCount(pair)).toBe(1);
    // Nothing left to do on a second pass.
    expect(adoptWholePhotoTags()).toBe(0);
  });

  it("skips a photo with no faces at all — the tag is all anyone knows", async () => {
    const item = await ingestGalleryAsset("GAL", asset("scenery.jpg", T), false);
    const mum = createGalleryPerson("Mum");
    tagAssetPerson(item, mum.id);

    expect(adoptWholePhotoTags()).toBe(0);
    expect(tagCount(item)).toBe(1);
    expect(getGalleryAsset("u1", ["GAL"], item)!.people).toEqual([{ id: mum.id, name: "Mum" }]);
  });
});
