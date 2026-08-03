// Face-aimed thumbnail cropping. Gallery thumbnails are generated uncropped
// (fit: "inside"), so the square tile crop happens in CSS — mapAsset's faceFocus
// is what aims it. The risk is the coordinate space: faces are detected on the
// EXIF-oriented photo, but thumbnails apply a manual rotation on top of that.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "../src/modules/library/gallery/catalog.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

function makePhoto(id: string, opts: { rotation?: number } = {}): string {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'lib', 'gallery', ?, 'ready')"
  ).run(id, `/${id}.jpg`);
  db.prepare(
    "INSERT INTO gallery_details (item_id, kind, relative_path, rotation) VALUES (?, 'photo', ?, ?)"
  ).run(id, `${id}.jpg`, opts.rotation ?? 0);
  return id;
}

// box_* are normalised [0,1] top-left + size, as the detector stores them.
function makeFace(id: string, itemId: string, box: { x: number; y: number; w: number; h: number }, assignment = "auto"): void {
  db.prepare(
    `INSERT INTO gallery_faces (id, item_id, box_x, box_y, box_w, box_h, assignment, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'scan')`
  ).run(id, itemId, box.x, box.y, box.w, box.h, assignment);
}

function focusOf(itemId: string) {
  const row = db.prepare(`SELECT ${ASSET_COLUMNS} ${ASSET_JOINS} WHERE library_items.id = ?`)
    .get("user", itemId) as GalleryAssetRow;
  return mapAsset(row).faceFocus;
}

beforeEach(() => {
  resetDb();
  makeUser("user");
  makeLibrary("lib", { createdBy: "user", type: "gallery" });
});

describe("faceFocus (aiming a cropped tile at the faces)", () => {
  it("is null for a photo with no detected faces, leaving the centre crop alone", () => {
    makePhoto("p1");
    expect(focusOf("p1")).toBeNull();
  });

  it("centres on a single face", () => {
    makePhoto("p1");
    // A head in the upper third: box spans y 0.1–0.3, so the centre is y=0.2.
    makeFace("f1", "p1", { x: 0.4, y: 0.1, w: 0.2, h: 0.2 });
    expect(focusOf("p1")).toEqual({ x: 50, y: 20 });
  });

  it("covers every face in a group shot, not just one", () => {
    makePhoto("p1");
    makeFace("f1", "p1", { x: 0.1, y: 0.2, w: 0.1, h: 0.1 });
    makeFace("f2", "p1", { x: 0.7, y: 0.2, w: 0.1, h: 0.1 });
    // Enclosing box spans x 0.1–0.8 → centre 0.45; both faces sit at y 0.2–0.3.
    expect(focusOf("p1")).toEqual({ x: 45, y: 25 });
  });

  it("ignores a face rejected as not this photo's subject", () => {
    makePhoto("p1");
    makeFace("f1", "p1", { x: 0.4, y: 0.1, w: 0.2, h: 0.2 });
    makeFace("f2", "p1", { x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, "rejected");
    expect(focusOf("p1")).toEqual({ x: 50, y: 20 });
  });

  it("ignores a whole-photo tag, which carries no box", () => {
    makePhoto("p1");
    makeFace("f1", "p1", { x: 0.4, y: 0.1, w: 0.2, h: 0.2 });
    db.prepare(
      "INSERT INTO gallery_faces (id, item_id, assignment, source) VALUES ('f2', 'p1', 'confirmed', 'manual')"
    ).run();
    expect(focusOf("p1")).toEqual({ x: 50, y: 20 });
  });

  it("turns the point with a manual 90° rotation, which the thumbnail bakes in", () => {
    makePhoto("p1", { rotation: 90 });
    // Face near the top-centre; rotating the photo clockwise sends it right.
    makeFace("f1", "p1", { x: 0.4, y: 0.1, w: 0.2, h: 0.2 });
    expect(focusOf("p1")).toEqual({ x: 80, y: 50 });
  });

  it("turns the point with a manual 180° rotation", () => {
    makePhoto("p1", { rotation: 180 });
    makeFace("f1", "p1", { x: 0.4, y: 0.1, w: 0.2, h: 0.2 });
    expect(focusOf("p1")).toEqual({ x: 50, y: 80 });
  });

  it("turns the point with a manual 270° rotation", () => {
    makePhoto("p1", { rotation: 270 });
    makeFace("f1", "p1", { x: 0.4, y: 0.1, w: 0.2, h: 0.2 });
    expect(focusOf("p1")).toEqual({ x: 20, y: 50 });
  });

  it("stays within the photo for a face box running past its edge", () => {
    makePhoto("p1");
    makeFace("f1", "p1", { x: 0.9, y: 0.9, w: 0.4, h: 0.4 });
    const focus = focusOf("p1")!;
    expect(focus.x).toBeLessThanOrEqual(100);
    expect(focus.y).toBeLessThanOrEqual(100);
    expect(focus.x).toBeGreaterThanOrEqual(0);
    expect(focus.y).toBeGreaterThanOrEqual(0);
  });
});
