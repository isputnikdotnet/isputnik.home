// One face on a photo: where it sits (the lightbox draws it), and saying who that
// one face is — without touching anyone else in the picture, and without the next
// clustering pass or rescan quietly undoing it.
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { getGalleryAsset, listAssetFaces } from "../src/modules/library/gallery/catalog-asset.js";
import { embeddingToBlob } from "../src/modules/library/gallery/faces/embedding.js";
import { clusterGalleryFaces } from "../src/modules/library/gallery/faces/cluster.js";
import { carryConfirmedFaces } from "../src/modules/library/gallery/faces/scanner.js";
import { FACE_EMBEDDING_MODEL } from "../src/modules/library/gallery/faces/model-id.js";
import { galleryPeopleRoutesPlugin } from "../src/modules/library/gallery/people-routes.js";
import {
  assignGalleryFace, createGalleryPerson, listGalleryPeople, rejectGalleryFace, renameGalleryPerson
} from "../src/modules/library/gallery/people.js";
import { bootApp } from "./helpers/boot.js";
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
  db.prepare("SELECT person_id, assignment FROM gallery_faces WHERE id = ?").get(id) as { person_id: string | null; assignment: string };

const excluded = (itemId: string, personId: string) =>
  Boolean(db.prepare("SELECT 1 FROM gallery_face_exclusions WHERE item_id = ? AND person_id = ?").get(itemId, personId));

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("face boxes on the asset detail", () => {
  it("lists each detected face with its box and who it is, and a rejected face as nobody", async () => {
    const item = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    addFace("f1", item, vec(0));
    addFace("f2", item, vec(4), [0.6, 0.1, 0.2, 0.2]);
    const mum = createGalleryPerson("Mum");
    assignGalleryFace("f1", mum.id);
    rejectGalleryFace("f2");

    const detail = getGalleryAsset("u1", ["GAL"], item)!;
    expect(detail.faces).toEqual([
      { id: "f1", box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, personId: mum.id, personName: "Mum", confirmed: true, thumbUrl: null },
      { id: "f2", box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 }, personId: null, personName: null, confirmed: false, thumbUrl: null }
    ]);
  });

  it("turns boxes with a manual rotation, the way the preview is turned", async () => {
    const item = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    addFace("f1", item, vec(0), [0.1, 0.2, 0.3, 0.4]);
    const box = (rotation: number) => listAssetFaces(item, rotation)[0].box;

    expect(box(0)).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    // Clockwise quarter turn: the left edge becomes the top, sides swap.
    expect(box(90)).toEqual({ x: 0.4, y: 0.1, w: 0.4, h: 0.3 });
    expect(box(180)).toEqual({ x: 0.6, y: 0.4, w: 0.3, h: 0.4 });
    expect(box(270)).toEqual({ x: 0.2, y: 0.6, w: 0.4, h: 0.3 });
  });
});

describe("naming one face", () => {
  it("moves only that face, and excludes the old person only when nothing else of them is left", async () => {
    const item = await ingestGalleryAsset("GAL", asset("group.jpg", T), false);
    const bob = createGalleryPerson("Bob");
    const mum = createGalleryPerson("Mum");
    addFace("f1", item, vec(0));
    addFace("f2", item, vec(0, 0.1), [0.6, 0.1, 0.2, 0.2]);
    db.prepare("UPDATE gallery_faces SET person_id = ?").run(bob.id);

    // Clustering put both faces on Bob; one of them is really Mum.
    expect(assignGalleryFace("f2", mum.id)).toBe(true);
    expect(faceRow("f1")).toEqual({ person_id: bob.id, assignment: "auto" });
    expect(faceRow("f2")).toEqual({ person_id: mum.id, assignment: "confirmed" });
    // Bob is still in the photo through f1, so he isn't excluded from it.
    expect(excluded(item, bob.id)).toBe(false);

    // Now f1 turns out not to be Bob either: that was his last face here.
    expect(rejectGalleryFace("f1")).toBe(true);
    expect(faceRow("f1").assignment).toBe("rejected");
    expect(excluded(item, bob.id)).toBe(true);
    expect(getGalleryAsset("u1", ["GAL"], item)!.people).toEqual([{ id: mum.id, name: "Mum" }]);
  });

  it("a named face stays with its person when clustering groups it with someone else", async () => {
    const t = T;
    const items = await Promise.all(["a1", "a2", "a3"].map((rel, i) => ingestGalleryAsset("GAL", asset(`${rel}.jpg`, t + i * 1000), false)));
    items.forEach((item, i) => addFace(`f${i}`, item, vec(0, 0.02 * (i + 1))));
    await clusterGalleryFaces();
    const group = faceRow("f0").person_id!;
    renameGalleryPerson(group, "Bob");

    // The embedding says Bob; the family says the third photo is his brother.
    const brother = createGalleryPerson("Brother");
    assignGalleryFace("f2", brother.id);
    await clusterGalleryFaces();

    expect(faceRow("f2")).toEqual({ person_id: brother.id, assignment: "confirmed" });
    expect(faceRow("f0").person_id).toBe(group);
    expect(listGalleryPeople(["GAL"]).find((p) => p.id === brother.id)?.faceCount).toBe(1);
  });
});

describe("carrying named faces across a rescan", () => {
  const named = [{ person_id: "mum", box_x: 0.1, box_y: 0.1, box_w: 0.2, box_h: 0.2 }];

  it("gives the name to the fresh box over the same spot", () => {
    expect(carryConfirmedFaces(named, [[0.6, 0.1, 0.2, 0.2], [0.11, 0.1, 0.2, 0.21]])).toEqual([null, "mum"]);
  });

  it("drops the name when no fresh box clearly overlaps", () => {
    expect(carryConfirmedFaces(named, [[0.2, 0.2, 0.2, 0.2]])).toEqual([null]);
  });

  it("gives each name to one box only, the best overlap first", () => {
    const two = [...named, { person_id: "dad", box_x: 0.12, box_y: 0.1, box_w: 0.2, box_h: 0.2 }];
    expect(carryConfirmedFaces(two, [[0.1, 0.1, 0.2, 0.2]])).toEqual(["mum"]);
  });
});

describe("face routes", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;

  beforeEach(async () => {
    ({ app, signIn } = await bootApp({ plugins: [galleryPeopleRoutesPlugin] }));
  });

  it("names an unnamed group from one of its faces, and refuses a reader", async () => {
    const items = await Promise.all(["a1", "a2"].map((rel, i) => ingestGalleryAsset("GAL", asset(`${rel}.jpg`, T + i), false)));
    items.forEach((item, i) => addFace(`f${i}`, item, vec(0, 0.02 * (i + 1))));
    await clusterGalleryFaces();
    const group = faceRow("f0").person_id!;

    makeUser("reader");
    makeLibrary("OTHER", { createdBy: "u1", type: "gallery" });
    const denied = await app.inject({
      method: "PUT", url: "/api/library/gallery/faces/f0/person",
      headers: { cookie: await signIn("reader") }, payload: { name: "Mum" }
    });
    expect(denied.statusCode).toBe(403);

    makeUser("admin", "admin");
    const res = await app.inject({
      method: "PUT", url: "/api/library/gallery/faces/f0/person",
      headers: { cookie: await signIn("admin") }, payload: { name: "Mum", wholeGroup: true }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { asset: { faces: { id: string; personName: string }[] } };
    expect(body.asset.faces[0]).toMatchObject({ id: "f0", personName: "Mum" });
    // The group became Mum: both photos, one person, no empty duplicate.
    expect(listGalleryPeople(["GAL"])).toMatchObject([{ id: group, name: "Mum", faceCount: 2 }]);

    const rejected = await app.inject({
      method: "DELETE", url: "/api/library/gallery/faces/f1/person",
      headers: { cookie: await signIn("admin") }
    });
    expect(rejected.statusCode).toBe(200);
    expect(faceRow("f1").assignment).toBe("rejected");

    const missing = await app.inject({
      method: "PUT", url: "/api/library/gallery/faces/nope/person",
      headers: { cookie: await signIn("admin") }, payload: { name: "Mum" }
    });
    expect(missing.statusCode).toBe(404);
  });
});
