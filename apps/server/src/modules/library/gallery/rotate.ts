// Manual photo rotation. Stores a user-applied clockwise angle (0/90/180/270) in
// gallery_details.rotation and bakes it into the regenerated thumbnails (cover +
// preview) on top of the EXIF orientation. The original file on disk is never
// touched — every gallery view shows a thumbnail, so the rotation is visible
// everywhere; only a raw download of the original is unaffected. Photos only:
// videos thumbnail from an ffmpeg poster frame and play the original, so there is
// nothing to bake a rotation into.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { generateGalleryThumbnails } from "./media.js";

export type RotateDirection = "cw" | "ccw";

export type RotateResult =
  | { ok: true; rotation: number }
  | { ok: false; status: number; error: string };

interface RotateRow {
  relative_path: string;
  kind: string;
  rotation: number | null;
  library_id: string;
  source_path: string;
}

export async function rotateGalleryAsset(itemId: string, direction: RotateDirection): Promise<RotateResult> {
  const row = db.prepare(`
    SELECT gallery_details.relative_path, gallery_details.kind, gallery_details.rotation,
           library_items.library_id, libraries.source_path
    FROM gallery_details
    JOIN library_items ON library_items.id = gallery_details.item_id
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE gallery_details.item_id = ? AND library_items.deleted_at IS NULL
  `).get(itemId) as RotateRow | undefined;

  if (!row) return { ok: false, status: 404, error: "Asset not found" };
  if (row.kind !== "photo") return { ok: false, status: 400, error: "Only photos can be rotated." };

  const filePath = path.join(row.source_path, ...row.relative_path.split("/"));
  if (!pathIsInside(filePath, row.source_path) || !fs.existsSync(filePath)) {
    return { ok: false, status: 404, error: "Asset file not found" };
  }

  const delta = direction === "cw" ? 90 : 270; // ccw === -90 (mod 360)
  const rotation = ((row.rotation ?? 0) + delta) % 360;

  const thumbs = await generateGalleryThumbnails(row.library_id, itemId, "photo", filePath, rotation);
  if (!thumbs) return { ok: false, status: 422, error: "This photo could not be rotated." };

  // Thumbnails are regenerated in place under their deterministic keys; bumping
  // updated_at lets the client bust the image cache (see mapAsset's ?v= token).
  db.transaction(() => {
    db.prepare("UPDATE gallery_details SET rotation = ?, preview_storage_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?")
      .run(rotation, thumbs.previewKey, itemId);
    db.prepare("UPDATE item_metadata SET cover_storage_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?")
      .run(thumbs.coverKey, itemId);
  })();

  return { ok: true, rotation };
}
