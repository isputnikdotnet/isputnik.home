// Move ONE gallery asset to another library and folder, keeping the item itself —
// its id, tags, faces, likes, collection and album membership, edits and thumbnails
// all hang off the item id, so they survive untouched. The file moves on disk, the
// row is re-homed, and the generated thumbnails follow it into the destination's
// bucket (thumbnail keys begin with the library id, and deleting a library removes
// its whole bucket — a kept photo must not lose its previews when the Inbox it came
// from is deleted).
//
// Built for the Photo Inbox's Keep (docs/photo-inbox-proposal.md), and general on
// purpose: nothing here knows what an Inbox is. It refuses what the rest of the app
// refuses — an external destination, a locked source folder — and nothing else.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { parsePolicy } from "../../../core/permissions.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath, pathIsInside } from "../shared/storage-roots.js";
import { lockCovering } from "../shared/folder-locks.js";
import { thumbnailAbsolutePath } from "../shared/thumbnail.js";
import type { GalleryDetailRow, GalleryFaceRow, ItemMetadataRow, LibraryItemRow, LibraryRow, Nullable } from "../../../db/rows.js";

export interface MoveDestination {
  libraryId: string;
  /** Folder relative to the destination library's root; "" is the root itself. */
  folder: string;
}

export type MoveResult =
  | { ok: true; itemId: string; libraryId: string; folderPath: string; title: string; moved: boolean }
  | { ok: false; status: 400 | 403 | 404 | 423; error: string };

// A folder someone typed, made safe: forward slashes only, no empty or dot
// segments (the scanner skips dot-entries, and ".." would climb out), nothing a
// filesystem refuses. Returns null when nothing usable is left.
export function normaliseTargetFolder(raw: string): string | null {
  const segments = raw.replace(/\\/g, "/").split("/").map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    if (segment.startsWith(".")) return null;
    if (/[<>:"|?*]/.test(segment)) return null;
    if (Array.from(segment).some((ch) => ch.charCodeAt(0) < 32)) return null;
    if (/[\s.]$/.test(segment)) return null;
  }
  return segments.join("/");
}

// A name free in BOTH the directory and the catalogue — a soft-deleted row can
// still hold the address (UNIQUE(library_id, folder_path)), and a live row could
// name a file the disk has lost. Numbered " (2)", " (3)", … like the uploader.
function freeName(dir: string, libraryId: string, folder: string, fileName: string): string {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  const taken = (candidate: string): boolean => {
    if (fs.existsSync(path.join(dir, candidate))) return true;
    const rel = folder ? `${folder}/${candidate}` : candidate;
    return db.prepare("SELECT 1 FROM library_items WHERE library_id = ? AND folder_path = ? AND deleted_at IS NULL")
      .get(libraryId, rel) != null;
  };
  let candidate = `${stem}${ext}`;
  let counter = 2;
  while (taken(candidate)) {
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

// rename() across mount points fails with EXDEV; fall back to copy + unlink so a
// destination on another disk still works.
function moveFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

// Remove the folders a move emptied, up to (never including) the library root.
// Best-effort: a folder someone else is writing into simply stays.
function pruneEmptyDirs(dir: string, root: string): void {
  let current = dir;
  while (current !== root && pathIsInside(current, root)) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

// Thumbnail keys are `<libraryId>/<shard>/<shard>/<file>`. Re-home one into the
// destination bucket by moving the file; returns the new key, or the old one when
// the file couldn't be moved (the preview then keeps working until the source
// bucket goes, which is the state it would have been in anyway).
function rehomeThumbnail(key: string | null, fromLibraryId: string, toLibraryId: string): string | null {
  if (!key || !key.startsWith(`${fromLibraryId}/`)) return key;
  const next = `${toLibraryId}/${key.slice(fromLibraryId.length + 1)}`;
  try {
    const fromAbs = thumbnailAbsolutePath(key);
    if (!fs.existsSync(fromAbs)) return key;
    const toAbs = thumbnailAbsolutePath(next);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    moveFile(fromAbs, toAbs);
    return next;
  } catch {
    return key;
  }
}

type MoveRow = Pick<LibraryItemRow, "id" | "library_id" | "folder_path" | "deleted_at">
  & Pick<LibraryRow, "source_path">
  & Pick<GalleryDetailRow, "preview_storage_key" | "web_video_key">
  & Nullable<Pick<ItemMetadataRow, "title" | "cover_storage_key">>
  & { library_name: LibraryRow["name"] };

export function moveGalleryAsset(itemId: string, dest: MoveDestination): MoveResult {
  const row = db.prepare(`
    SELECT li.id, li.library_id, li.folder_path, li.deleted_at,
           lib.source_path, lib.name AS library_name,
           im.title, im.cover_storage_key,
           gd.preview_storage_key, gd.web_video_key
    FROM library_items li
    JOIN libraries lib ON lib.id = li.library_id
    JOIN gallery_details gd ON gd.item_id = li.id
    LEFT JOIN item_metadata im ON im.item_id = li.id
    WHERE li.id = ? AND li.type = 'gallery'
  `).get(itemId) as MoveRow | undefined;
  if (!row || row.deleted_at) return { ok: false, status: 404, error: "Photo not found." };
  const title = row.title ?? path.basename(row.folder_path);

  const target = db.prepare("SELECT id, name, type, source_path, policy_json, role FROM libraries WHERE id = ?")
    .get(dest.libraryId) as Pick<LibraryRow, "id" | "name" | "type" | "source_path" | "policy_json" | "role"> | undefined;
  if (!target || target.type !== "gallery") return { ok: false, status: 404, error: "Destination library not found." };
  const policy = parsePolicy(target.policy_json);
  if ((policy.mode ?? "managed") === "external") {
    return { ok: false, status: 403, error: `"${target.name}" is external, so the app can't write files into it.` };
  }
  if (target.role === "inbox") {
    return { ok: false, status: 403, error: `"${target.name}" is a Photo Inbox; keep photos into a regular library.` };
  }

  const folder = normaliseTargetFolder(dest.folder);
  if (folder === null) return { ok: false, status: 400, error: "That folder name can't be used." };

  const lockedUnder = lockCovering(row.library_id, row.folder_path);
  if (lockedUnder !== null) {
    return { ok: false, status: 423, error: `"${lockedUnder}" in "${row.library_name}" is locked, so nothing inside it can be moved from the app.` };
  }

  let sourceRoot: string;
  let targetRoot: string;
  try {
    sourceRoot = validateLibrarySource(row.source_path);
    targetRoot = validateLibrarySource(target.source_path);
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : "Library source folder is unavailable." };
  }

  const sourceAbs = path.resolve(sourceRoot, ...row.folder_path.split("/"));
  if (!pathIsInside(sourceAbs, sourceRoot)) return { ok: false, status: 400, error: "The photo's path is outside its library." };
  if (!fs.existsSync(sourceAbs)) return { ok: false, status: 404, error: "The file for this photo is missing on disk." };

  const targetDir = folder ? path.resolve(targetRoot, ...folder.split("/")) : targetRoot;
  if (!pathIsInside(targetDir, targetRoot)) return { ok: false, status: 400, error: "That folder is outside the library." };

  // Already there: nothing to do, and not an error.
  if (row.library_id === target.id && path.dirname(sourceAbs) === targetDir) {
    return { ok: true, itemId, libraryId: target.id, folderPath: row.folder_path, title, moved: false };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const finalName = freeName(targetDir, target.id, folder, path.basename(sourceAbs));
  const finalAbs = path.join(targetDir, finalName);
  moveFile(sourceAbs, finalAbs);
  const newRel = normaliseRelativePath(path.relative(targetRoot, finalAbs));

  const crossLibrary = row.library_id !== target.id;
  const previewKey = crossLibrary ? rehomeThumbnail(row.preview_storage_key, row.library_id, target.id) : row.preview_storage_key;
  const coverKey = crossLibrary ? rehomeThumbnail(row.cover_storage_key, row.library_id, target.id) : row.cover_storage_key;
  const webVideoKey = crossLibrary ? rehomeThumbnail(row.web_video_key, row.library_id, target.id) : row.web_video_key;
  const faceKeys = crossLibrary
    ? (db.prepare("SELECT id, thumb_storage_key AS k FROM gallery_faces WHERE item_id = ? AND thumb_storage_key IS NOT NULL")
        .all(itemId) as (Pick<GalleryFaceRow, "id"> & { k: NonNullable<GalleryFaceRow["thumb_storage_key"]> })[])
        .map((face) => ({ id: face.id, key: rehomeThumbnail(face.k, row.library_id, target.id) }))
    : [];

  db.transaction(() => {
    // A soft-deleted ghost at the new address would trip UNIQUE(library_id, folder_path).
    db.prepare("DELETE FROM library_items WHERE library_id = ? AND folder_path = ? AND deleted_at IS NOT NULL AND id <> ?")
      .run(target.id, newRel, itemId);
    // Crossing into another library counts as arriving there: discovered_at moves to
    // now so "new photos" surfaces see it. A move within one library keeps its date.
    // The scan rule that produced the row belonged to the old library.
    db.prepare(`
      UPDATE library_items
      SET library_id = ?, folder_path = ?, scan_rule_id = NULL,
          discovered_at = CASE WHEN library_id = ? THEN discovered_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(target.id, newRel, target.id, itemId);
    db.prepare(`
      UPDATE gallery_details
      SET relative_path = ?, preview_storage_key = ?, web_video_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE item_id = ?
    `).run(newRel, previewKey, webVideoKey, itemId);
    if (row.cover_storage_key !== coverKey) {
      db.prepare("UPDATE item_metadata SET cover_storage_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?")
        .run(coverKey, itemId);
    }
    for (const face of faceKeys) {
      db.prepare("UPDATE gallery_faces SET thumb_storage_key = ? WHERE id = ?").run(face.key, face.id);
    }
  })();

  pruneEmptyDirs(path.dirname(sourceAbs), sourceRoot);
  return { ok: true, itemId, libraryId: target.id, folderPath: newRel, title, moved: true };
}
