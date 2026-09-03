// Replace the FILE behind a gallery photo or video, keeping the item itself —
// a high-resolution scan over the low-resolution one, a straightened version, a
// re-encode. The item's id never changes, so everything pointing at it comes
// along untouched: the stories that show it, the albums and slideshows holding
// it, its tags, its faces (boxes are normalised [0,1], so a higher-resolution
// copy of the same framing keeps every person exactly where they are), who has
// favourited it, and its place in the timeline.
//
// Deleting and re-uploading cannot do this: that makes a NEW item and leaves
// every one of those references pointing at a photo that no longer exists.
//
// The file that was there is kept rather than overwritten. It moves into a
// `replaced/` folder beside the Recycle Bin — outside the library, so the
// scanner never re-catalogues it — because this is the one operation in the app
// that would otherwise destroy the only copy of something.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { getTrashRootSetting } from "../shared/trash.js";
import { kindForExtension, type AssetKind } from "./media.js";
import { scanSingleGalleryFile } from "./scanner.js";

export type ReplaceResult =
  | { ok: true; itemId: string; relativePath: string; keptAt: string }
  | { ok: false; status: number; error: string };

interface AssetRow {
  relative_path: string;
  kind: string;
  taken_at: string | null;
  taken_at_source: string | null;
  library_id: string;
  source_path: string;
}

export async function replaceGalleryAssetFile(
  itemId: string,
  upload: { tmpPath: string; filename: string }
): Promise<ReplaceResult> {
  const row = db.prepare(`
    SELECT gallery_details.relative_path, gallery_details.kind,
           gallery_details.taken_at, gallery_details.taken_at_source,
           library_items.library_id, libraries.source_path
    FROM gallery_details
    JOIN library_items ON library_items.id = gallery_details.item_id
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE gallery_details.item_id = ? AND library_items.deleted_at IS NULL
  `).get(itemId) as AssetRow | undefined;

  if (!row) return { ok: false, status: 404, error: "Asset not found" };

  const extension = path.extname(upload.filename).toLowerCase();
  const newKind = kindForExtension(extension);
  if (!newKind) {
    return { ok: false, status: 400, error: "That file type isn't a photo or a video this library reads." };
  }
  // A photo is replaced by a photo. Swapping kinds would leave every card, strip
  // and player that reads `kind` describing the wrong thing.
  if (newKind !== row.kind) {
    return {
      ok: false,
      status: 400,
      error: `This is a ${row.kind}, so it can only be replaced by a ${row.kind}.`
    };
  }

  let root: string;
  try {
    root = validateLibrarySource(row.source_path);
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "Library folder unavailable." };
  }

  const currentAbs = path.join(root, ...row.relative_path.split("/"));
  if (!fs.existsSync(currentAbs)) {
    return { ok: false, status: 404, error: "The file for this item is missing, so there is nothing to replace." };
  }

  // Same folder, same name — only the extension follows the new file, so a jpeg
  // replaced by a tif lands beside where it was rather than in the root.
  const dir = path.dirname(row.relative_path);
  const stem = path.basename(row.relative_path, path.extname(row.relative_path));
  const nextRelative = normaliseRelativePath(dir === "." ? `${stem}${extension}` : `${dir}/${stem}${extension}`);
  const nextAbs = path.join(root, ...nextRelative.split("/"));

  // Where the old file goes. Under the bin's own root when one is configured,
  // else the library's hidden .trash — the walk skips dot-entries either way.
  const trashRoot = getTrashRootSetting();
  const keptDir = path.join(trashRoot ?? path.join(root, ".trash"), "replaced", row.library_id, itemId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const keptAbs = path.join(keptDir, `${stamp}-${path.basename(row.relative_path)}`);

  try {
    fs.mkdirSync(keptDir, { recursive: true });
    fs.renameSync(currentAbs, keptAbs);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Could not set the current file aside."
    };
  }

  try {
    fs.mkdirSync(path.dirname(nextAbs), { recursive: true });
    fs.renameSync(upload.tmpPath, nextAbs);
  } catch (err) {
    // Put the old file back: the item must never be left pointing at nothing.
    try { fs.renameSync(keptAbs, currentAbs); } catch { /* the error below says enough */ }
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : "Could not store the new file."
    };
  }

  // A different extension means a different path, and the catalogue keys on it:
  // point the row at the new name FIRST, or the re-ingest below would catalogue
  // a second item and leave this one orphaned.
  if (nextRelative !== row.relative_path) {
    db.transaction(() => {
      db.prepare("UPDATE library_items SET folder_path = ? WHERE id = ?").run(nextRelative, itemId);
      db.prepare("UPDATE gallery_details SET relative_path = ? WHERE item_id = ?").run(nextRelative, itemId);
    })();
  }

  const scanned = await scanSingleGalleryFile(row.library_id, nextRelative);
  if (!scanned) {
    return { ok: false, status: 422, error: "The new file could not be read as a photo or video." };
  }

  // The date stays put. A replacement is the same picture with better pixels, so
  // it keeps the place in the timeline the family already knows it by — a fresh
  // scan of a print often carries no capture date at all, and letting the file's
  // own mtime win would file a 1974 photograph under today.
  db.prepare("UPDATE gallery_details SET taken_at = ?, taken_at_source = ? WHERE item_id = ?")
    .run(row.taken_at, row.taken_at_source, itemId);

  return { ok: true, itemId, relativePath: nextRelative, keptAt: keptAbs };
}

/** Whether this kind can have its file replaced at all. */
export function replaceableKind(kind: string): kind is AssetKind {
  return kind === "photo" || kind === "video";
}
