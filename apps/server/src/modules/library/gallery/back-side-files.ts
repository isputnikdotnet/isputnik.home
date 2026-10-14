// What happens to a photo's BACK on disk and in the catalogue when someone acts
// on it by hand, and when its front is trashed or restored
// (docs/back-sides-proposal.md). The pairing RULE is back-sides.ts; the scanner
// keeps the columns in step with the files; this is everything in between:
//
//   add / replace   a file written beside the front under the library's own
//                   dialect (`X_b.jpg` in an Epson library), the old back set
//                   aside in `replaced/` like any file the app would otherwise
//                   be the only copy of
//   remove          the file set aside the same way, the columns cleared
//   rotate          the back's own turn, baked into its preview like the front's
//   split           the back becomes a photo again, under a name no pattern
//                   recognises, with everything its old row carried when it was
//                   one (the row the scanner tombstoned is revived under the
//                   new name)
//   trash / restore the back goes into the bin with its front and comes back
//                   paired — unless the Epson twin rule hands it to the `_a` /
//                   plain twin that stays behind, so cleaning up the twins
//                   never loses the back
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { stmt } from "../../../db/statement-cache.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath, pathIsInside } from "../shared/storage-roots.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { thumbnailAbsolutePath } from "../shared/thumbnail.js";
import { backFileNameFor, backRuleOf, epsonTwinStemOf, splitFileNameFor, type BackRule } from "./back-sides.js";
import { kindForExtension, generateBackPreview, backPreviewKey } from "./media.js";
import { setAsideReplaced } from "./replace.js";
import { scanSingleGalleryFile, setBackSide } from "./scanner.js";
import { uniqueGalleryFileName } from "./files.js";
import type { GalleryDetailRow, LibraryItemRow, LibraryRow } from "../../../db/rows.js";

export type BackSideResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409 | 422 | 500; error: string };

type FrontRow = Pick<GalleryDetailRow, "kind" | "relative_path" | "back_relative_path" | "back_rotation" | "back_preview_storage_key">
  & Pick<LibraryItemRow, "library_id">
  & Pick<LibraryRow, "source_path" | "settings_json">;

function loadFront(itemId: string): FrontRow | undefined {
  return stmt(`
    SELECT gd.kind, gd.relative_path, gd.back_relative_path, gd.back_rotation, gd.back_preview_storage_key,
           li.library_id, lib.source_path, lib.settings_json
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    JOIN libraries lib ON lib.id = li.library_id
    WHERE gd.item_id = ? AND li.deleted_at IS NULL
  `).get(itemId) as FrontRow | undefined;
}

function ruleFor(row: Pick<LibraryRow, "settings_json">): BackRule {
  return backRuleOf(normalizeLibrarySettings("gallery", row.settings_json).back_sides);
}

function absUnder(root: string, relativePath: string): string {
  return path.resolve(root, ...relativePath.split("/"));
}

/** The back file of a photo, for streaming: absolute path and mime, or null. */
export function backFileOf(itemId: string): { path: string; mime: string; fileName: string } | null {
  const row = loadFront(itemId);
  if (!row?.back_relative_path) return null;
  let root: string;
  try { root = validateLibrarySource(row.source_path); } catch { return null; }
  const abs = absUnder(root, row.back_relative_path);
  if (!pathIsInside(abs, root) || !fs.existsSync(abs)) return null;
  const ext = path.extname(abs).toLowerCase().slice(1);
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "tif" || ext === "tiff" ? "image/tiff" : ext === "bmp" ? "image/bmp" : ext === "avif" ? "image/avif" : ext === "heic" || ext === "heif" ? "image/heic" : "application/octet-stream";
  return { path: abs, mime, fileName: path.basename(abs) };
}

/** Write an uploaded file beside the front as its back (replacing one it had,
 *  which is set aside), and record it. */
export async function addBackSide(itemId: string, upload: { tmpPath: string; filename: string }): Promise<BackSideResult> {
  const row = loadFront(itemId);
  if (!row) return { ok: false, status: 404, error: "Photo not found." };
  if (row.kind !== "photo") return { ok: false, status: 400, error: "Only a photo can have a back side." };
  const extension = path.extname(upload.filename).toLowerCase();
  if (kindForExtension(extension) !== "photo") {
    return { ok: false, status: 400, error: "The back of a photo has to be a photo file." };
  }
  let root: string;
  try { root = validateLibrarySource(row.source_path); } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "Library folder unavailable." };
  }
  const frontAbs = absUnder(root, row.relative_path);
  if (!pathIsInside(frontAbs, root) || !fs.existsSync(frontAbs)) {
    return { ok: false, status: 404, error: "The file for this photo is missing on disk." };
  }

  // The old back, if any, is set aside first so the new one can take its name.
  if (row.back_relative_path) {
    const oldAbs = absUnder(root, row.back_relative_path);
    if (pathIsInside(oldAbs, root) && fs.existsSync(oldAbs)) {
      const aside = setAsideReplaced(root, row.library_id, itemId, oldAbs);
      if (!aside.ok) return aside;
    }
  }

  const dir = path.dirname(frontAbs);
  const wanted = backFileNameFor(path.basename(row.relative_path), ruleFor(row), extension);
  const finalName = uniqueGalleryFileName(dir, wanted);
  if (!finalName) return { ok: false, status: 400, error: "That file name can't be used." };
  const finalAbs = path.join(dir, finalName);
  if (!pathIsInside(finalAbs, root)) return { ok: false, status: 400, error: "That file name can't be stored in this library." };
  try {
    fs.renameSync(upload.tmpPath, finalAbs);
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Could not store the file." };
  }
  const relative = normaliseRelativePath(path.relative(root, finalAbs));
  // A soft-deleted ghost at this address (a photo that once was this file's
  // name) must not come back as a photo on the next scan.
  const ok = await setBackSide(row.library_id, itemId, relative);
  if (!ok) return { ok: false, status: 422, error: "The file could not be read as a photo." };
  return { ok: true };
}

/** Set the back aside and forget it. The photo stays. */
export function removeBackSide(itemId: string): BackSideResult | Promise<BackSideResult> {
  const row = loadFront(itemId);
  if (!row) return { ok: false, status: 404, error: "Photo not found." };
  if (!row.back_relative_path) return { ok: false, status: 404, error: "This photo has no back side." };
  let root: string;
  try { root = validateLibrarySource(row.source_path); } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "Library folder unavailable." };
  }
  const abs = absUnder(root, row.back_relative_path);
  if (pathIsInside(abs, root) && fs.existsSync(abs)) {
    const aside = setAsideReplaced(root, row.library_id, itemId, abs);
    if (!aside.ok) return aside;
  }
  return setBackSide(row.library_id, itemId, null).then(() => ({ ok: true as const }));
}

/** Turn the back a quarter turn, baked into its preview; the file is untouched. */
export async function rotateBackSide(itemId: string, direction: "cw" | "ccw"): Promise<BackSideResult & { rotation?: number }> {
  const row = loadFront(itemId);
  if (!row) return { ok: false, status: 404, error: "Photo not found." };
  if (!row.back_relative_path) return { ok: false, status: 404, error: "This photo has no back side." };
  let root: string;
  try { root = validateLibrarySource(row.source_path); } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "Library folder unavailable." };
  }
  const abs = absUnder(root, row.back_relative_path);
  if (!pathIsInside(abs, root) || !fs.existsSync(abs)) return { ok: false, status: 404, error: "The back's file is missing on disk." };
  const rotation = ((row.back_rotation ?? 0) + (direction === "cw" ? 90 : 270)) % 360;
  const key = await generateBackPreview(row.library_id, itemId, abs, rotation);
  if (!key) return { ok: false, status: 422, error: "The back could not be rotated." };
  stmt("UPDATE gallery_details SET back_rotation = ?, back_preview_storage_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?")
    .run(rotation, key, itemId);
  return { ok: true, rotation };
}

/** The back becomes a photo of its own again: renamed to `<front> (back).<ext>`
 *  (no pattern recognises that), forgotten by the front, catalogued — reviving
 *  the row the scanner tombstoned when it was paired, so what that row carried
 *  (tags, people, albums, notes) comes back with it. Returns the new item's id. */
export async function splitBackSide(itemId: string): Promise<BackSideResult & { itemId?: string }> {
  const row = loadFront(itemId);
  if (!row) return { ok: false, status: 404, error: "Photo not found." };
  if (!row.back_relative_path) return { ok: false, status: 404, error: "This photo has no back side." };
  let root: string;
  try { root = validateLibrarySource(row.source_path); } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "Library folder unavailable." };
  }
  const backAbs = absUnder(root, row.back_relative_path);
  if (!pathIsInside(backAbs, root) || !fs.existsSync(backAbs)) return { ok: false, status: 404, error: "The back's file is missing on disk." };
  const dir = path.dirname(backAbs);
  const finalName = uniqueGalleryFileName(dir, splitFileNameFor(path.basename(row.relative_path), path.basename(backAbs)));
  if (!finalName) return { ok: false, status: 400, error: "That file name can't be used." };
  const finalAbs = path.join(dir, finalName);
  if (!pathIsInside(finalAbs, root)) return { ok: false, status: 400, error: "That file name can't be stored in this library." };
  try {
    fs.renameSync(backAbs, finalAbs);
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Could not rename the file." };
  }
  const oldRelative = row.back_relative_path;
  const newRelative = normaliseRelativePath(path.relative(root, finalAbs));
  db.transaction(() => {
    // The tombstone of the photo this file used to be, if the scanner paired an
    // existing item: it takes the new name, so the ingest below revives it.
    const ghost = stmt("SELECT id FROM library_items WHERE library_id = ? AND folder_path = ? AND deleted_at IS NOT NULL")
      .get(row.library_id, oldRelative) as Pick<LibraryItemRow, "id"> | undefined;
    if (ghost) {
      stmt("DELETE FROM library_items WHERE library_id = ? AND folder_path = ? AND id <> ?").run(row.library_id, newRelative, ghost.id);
      stmt("UPDATE library_items SET folder_path = ? WHERE id = ?").run(newRelative, ghost.id);
      stmt("UPDATE gallery_details SET relative_path = ? WHERE item_id = ?").run(newRelative, ghost.id);
    }
  })();
  await setBackSide(row.library_id, itemId, null);
  const newId = await scanSingleGalleryFile(row.library_id, newRelative);
  if (!newId) return { ok: false, status: 422, error: "The file could not be catalogued as a photo." };
  return { ok: true, itemId: newId };
}

// ── Trash and restore ────────────────────────────────────────────────────────

/** Before an item's files move into the bin: under the Epson rule a front's back
 *  goes to the twin that stays (`X` ↔ `X_a`) rather than into the bin with it —
 *  cleaning up the twins must never lose the back. Returns the companion files
 *  that DO go into the bin with the item. */
export function backSidesForTrash(itemId: string): string[] {
  const row = loadFront(itemId);
  if (!row?.back_relative_path) return [];
  const rule = ruleFor(row);
  if (rule.epsonTwin) {
    const twinStem = epsonTwinStemOf(row.relative_path);
    if (twinStem) {
      const dir = path.posix.dirname(row.relative_path);
      const prefix = dir === "." ? "" : `${dir}/`;
      const like = `${prefix}${twinStem}.`.toLowerCase().replace(/[\\%_]/g, "\\$&");
      const twins = stmt(`
        SELECT li.id, li.folder_path FROM library_items li
        JOIN gallery_details gd ON gd.item_id = li.id
        WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.id <> ? AND gd.kind = 'photo'
          AND gd.back_relative_path IS NULL
          AND lower(li.folder_path) LIKE ? ESCAPE '\\'
      `).all(row.library_id, itemId, `${like}%`) as Pick<LibraryItemRow, "id" | "folder_path">[];
      const match = twins.find((candidate) => {
        const base = path.posix.basename(candidate.folder_path);
        const stem = base.slice(0, base.length - path.posix.extname(base).length);
        return path.posix.dirname(candidate.folder_path) === dir && stem.toLowerCase() === twinStem.toLowerCase();
      });
      if (match) {
        db.transaction(() => {
          stmt(`
            UPDATE gallery_details
            SET back_relative_path = ?, back_rotation = ?, back_size = NULL, back_modified_at = NULL, back_preview_storage_key = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE item_id = ?
          `).run(row.back_relative_path, row.back_rotation ?? 0, match.id);
          stmt("UPDATE gallery_details SET back_relative_path = NULL, back_size = NULL, back_modified_at = NULL, back_preview_storage_key = NULL, back_rotation = 0 WHERE item_id = ?")
            .run(itemId);
        })();
        if (row.back_preview_storage_key) {
          try { fs.rmSync(thumbnailAbsolutePath(row.back_preview_storage_key), { force: true }); } catch { /* ignore */ }
        }
        // The twin's preview renders on its next ingest (the nightly scan, or
        // any touch of the file); until then the lightbox shows the file itself
        // (mapAsset falls back to it). Nothing is rendered here: trashBook is
        // synchronous and a cleanup trashes many items in a row.
        return [];
      }
    }
  }
  return [row.back_relative_path];
}

/** After a restore put the files back: pair the back with its front again
 *  before the library scan sees either, whatever the rule says now. The scan
 *  completes the rows; this only makes sure it finds the pair on record. */
export function seedRestoredBackSide(libraryId: string, itemPath: string, backPath: string): void {
  const existing = stmt("SELECT id FROM library_items WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, itemPath) as Pick<LibraryItemRow, "id"> | undefined;
  db.transaction(() => {
    let itemId = existing?.id;
    if (!itemId) {
      itemId = nanoid(16);
      stmt("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'pending')")
        .run(itemId, libraryId, itemPath);
    } else {
      stmt("UPDATE library_items SET deleted_at = NULL, status = 'pending' WHERE id = ?").run(itemId);
    }
    const kind = kindForExtension(path.extname(itemPath).toLowerCase()) ?? "photo";
    stmt(`
      INSERT INTO gallery_details (item_id, kind, relative_path, back_relative_path)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET back_relative_path = excluded.back_relative_path
    `).run(itemId, kind, itemPath, backPath);
    // The back's own tombstone, if it ever was a photo, must not be revived as one.
    stmt("UPDATE library_items SET deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE library_id = ? AND folder_path = ? AND id <> ?")
      .run(libraryId, backPath, itemId);
  })();
}

/** The thumbnail-store key of a photo's back preview, for the bin's cover sweep. */
export { backPreviewKey };
