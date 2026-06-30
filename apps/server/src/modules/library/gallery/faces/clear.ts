// "Forget everything about faces in this library" — removes all face-recognition data
// for one gallery library: detected faces, their per-photo scan markers, and exclusions
// (manual whole-photo tags included). Orphaned face-crop thumbnails are deleted
// best-effort. Re-clusters afterwards so people built only from this library's faces are
// pruned (unnamed) or have their centroids recomputed. The library's photos and any
// named global people that also appear elsewhere are left intact.
//
// Kept separate from scanner.ts so callers (and tests) don't pull in the native
// onnxruntime detector just to clear data.
import fs from "node:fs";
import { db } from "../../../../db.js";
import { thumbnailAbsolutePath } from "../../shared/thumbnail.js";
import { clusterGalleryFaces } from "./cluster.js";

export function clearLibraryFaceData(libraryId: string): { faces: number; photos: number } {
  const itemFilter = "item_id IN (SELECT id FROM library_items WHERE library_id = ?)";

  const faces = (db.prepare(
    `SELECT COUNT(*) AS n FROM gallery_faces WHERE ${itemFilter}`
  ).get(libraryId) as { n: number }).n;
  const photos = (db.prepare(
    `SELECT COUNT(*) AS n FROM gallery_face_scans WHERE ${itemFilter}`
  ).get(libraryId) as { n: number }).n;
  const thumbKeys = db.prepare(
    `SELECT thumb_storage_key AS k FROM gallery_faces WHERE thumb_storage_key IS NOT NULL AND ${itemFilter}`
  ).all(libraryId) as { k: string }[];

  db.transaction(() => {
    db.prepare(`DELETE FROM gallery_faces WHERE ${itemFilter}`).run(libraryId);
    db.prepare(`DELETE FROM gallery_face_scans WHERE ${itemFilter}`).run(libraryId);
    db.prepare(`DELETE FROM gallery_face_exclusions WHERE ${itemFilter}`).run(libraryId);
  })();

  // Re-cluster the surviving faces (other libraries) and prune now-empty unnamed people.
  clusterGalleryFaces();

  for (const { k } of thumbKeys) {
    try { fs.rmSync(thumbnailAbsolutePath(k), { force: true }); } catch { /* best-effort */ }
  }

  return { faces, photos };
}
