// Face-crop thumbnail FILES on disk (the per-face square webp avatars, keyed by face id
// in the shared thumbnail store). Rows in gallery_faces cascade away with their item, but
// files never do — every path that drops face rows must also remove the crop files, or
// they orphan forever. Kept free of any ML import (db + fs + thumbnail paths only) so the
// trash flow and clear.ts can delete crop files without loading the native onnxruntime
// binding.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../../db.js";
import { getConfiguredThumbnailPath, thumbnailAbsolutePath } from "../../shared/thumbnail.js";
import { normaliseRelativePath } from "../../shared/storage-roots.js";

// Every crop file cropFaceFromRaw writes ends in this suffix — it's what makes a face
// crop distinguishable from item covers sharing the same store, so the sweep can never
// touch anything else.
const FACE_CROP_SUFFIX = "-face.webp";

// Crop storage keys for one item's faces, collected BEFORE the rows are deleted (or
// cascade with the item) so the files can be removed afterwards.
export function faceCropKeysForItem(itemId: string): string[] {
  const rows = db.prepare(
    "SELECT thumb_storage_key AS k FROM gallery_faces WHERE item_id = ? AND thumb_storage_key IS NOT NULL"
  ).all(itemId) as { k: string }[];
  return rows.map((r) => r.k);
}

// Best-effort removal; a missing thumbnail store or file never throws.
export function removeFaceCropFiles(keys: string[]): void {
  for (const key of keys) {
    try { fs.rmSync(thumbnailAbsolutePath(key), { force: true }); } catch { /* best-effort */ }
  }
}

// Delete face-crop files no gallery_faces row references any more — the mop-up for
// orphans that already accumulated (rescans, purged items, deleted libraries) before
// the delete paths learned to remove files. Only ever touches "*-face.webp" files, so
// covers and previews in the same store are safe. Returns the number removed.
export function sweepOrphanFaceCrops(): number {
  let root: string;
  try { root = getConfiguredThumbnailPath(); } catch { return 0; } // store not configured
  const referenced = new Set(
    (db.prepare("SELECT thumb_storage_key AS k FROM gallery_faces WHERE thumb_storage_key IS NOT NULL")
      .all() as { k: string }[]).map((r) => r.k)
  );
  let removed = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.isFile() || !entry.name.endsWith(FACE_CROP_SUFFIX)) continue;
      const key = normaliseRelativePath(path.relative(root, abs));
      if (referenced.has(key)) continue;
      try { fs.rmSync(abs, { force: true }); removed += 1; } catch { /* best-effort */ }
    }
  };
  walk(root);
  return removed;
}
