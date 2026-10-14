// Gallery scanner. Unlike the book scanners, EACH FILE IS ONE ITEM (one photo,
// video, or audio recording = one library_items row) — the Immich/Google-Photos
// "asset" model. The
// item's folder_path is the file's relative path: its directory powers the Folder
// view and its EXIF date (gallery_details.taken_at) powers the Timeline. There are
// no scan rules, series, authors, or categories for gallery — just assets.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { stmt } from "../../../db/statement-cache.js";
import { normaliseRelativePath, relativePathWithinRoot } from "../shared/storage-roots.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import { libraryJobRunning } from "../shared/scan-lock.js";
import { requeueInterruptedJobs, releaseAbandonedScanLibraries } from "../shared/job-recovery.js";
import { jobProgressWriter } from "../shared/job-progress.js";
import { registerJobHandler } from "../../../core/job-poller.js";
import { dateFromFileName } from "./filename-date.js";
import { isPhotoInboxLibrary } from "./system-libraries.js";
import {
  normalizeLibrarySettings,
  normalizeScanSources,
  sourceEnabled,
  type ScanSourceConfig
} from "../shared/library-settings.js";
import {
  kindForExtension,
  mimeForExtension,
  readAssetMetadata,
  browserPlayability,
  generateGalleryThumbnails,
  generateBackPreview,
  computeDhash,
  type AssetKind
} from "./media.js";
import { backRuleOf, frontStemsFor, pairBackSides, type BackRule } from "./back-sides.js";
import { thumbnailAbsolutePath } from "../shared/thumbnail.js";
import { readFaststart } from "./faststart.js";
import { applyItemAlphaIndex } from "../shared/alphabet-index.js";
import type { GalleryDetailRow, ItemMetadataRow, JobRow, LibraryItemRow, LibraryRow } from "../../../db/rows.js";
import { requestPhotoPlaceSweep } from "./places.js";

const scanJobType = "SCAN_GALLERY_LIBRARY";

export interface GalleryScanOptions {
  sources?: ScanSourceConfig[];
  // Restrict the rescan to one subtree (relative to the library root). Only files
  // under it are walked, and reconciliation (soft-deletes) is scoped to it too, so
  // the rest of the library is left completely untouched. Empty/omitted = full scan.
  folder?: string;
}

interface GalleryFileEntry {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  kind: AssetKind;
  size: number;
  modifiedAtMs: number;
}

// Symlink-safe recursive walk (mirrors the ebook scanner). Skips dot-entries so the
// hidden .trash / .upload staging folders are never indexed.
// `startDir` defaults to the library root; pass a subfolder to walk just that
// subtree while still recording each file's path relative to the library root
// (and keeping the same root as the symlink-escape boundary).
function walkGalleryFiles(rootPath: string, extensions: Set<string>, startDir: string = rootPath): GalleryFileEntry[] {
  const files: GalleryFileEntry[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (!fs.realpathSync(absolutePath).startsWith(`${rootPath}${path.sep}`)) continue;
        } catch { continue; }
      }
      if (entry.isDirectory()) { walk(absolutePath); continue; }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!extensions.has(extension)) continue;
      const kind = kindForExtension(extension);
      if (!kind) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(absolutePath); } catch { continue; }
      // An empty file has nothing to render (failed copy, placeholder, or a copy
      // still in flight) — leave it unindexed; a later scan picks it up if it
      // gains content, and an already-indexed one is reconciled away.
      if (stat.size === 0) continue;
      files.push({
        absolutePath,
        relativePath: normaliseRelativePath(path.relative(rootPath, absolutePath)),
        fileName: entry.name,
        extension,
        kind,
        size: stat.size,
        modifiedAtMs: stat.mtimeMs
      });
    }
  };
  walk(startDir);
  return files;
}

function sortName(value: string): string {
  return value.trim().toLowerCase();
}

// One file on disk, described the way the walk describes it, or null when it is
// not there (or empty — the walk's own rule).
function fileEntryAt(rootPath: string, relativePath: string): GalleryFileEntry | null {
  const extension = path.extname(relativePath).toLowerCase();
  const kind = kindForExtension(extension);
  if (!kind) return null;
  const absolutePath = path.join(rootPath, ...relativePath.split("/"));
  let stat: fs.Stats;
  try { stat = fs.statSync(absolutePath); } catch { return null; }
  if (!stat.isFile() || stat.size === 0) return null;
  return {
    absolutePath,
    relativePath,
    fileName: path.basename(relativePath),
    extension,
    kind,
    size: stat.size,
    modifiedAtMs: stat.mtimeMs
  };
}

type PriorBack = Pick<GalleryDetailRow, "back_relative_path" | "back_size" | "back_modified_at" | "back_preview_storage_key" | "back_rotation">;

// Bring the front's back-side columns in line with the back file beside it (or
// with there being none). A back that has not changed (same path, size, mtime,
// preview present) costs nothing; a new or changed one gets its preview rendered
// — AFTER the front's own thumbnails, never alongside them (two sharp pipelines at
// once is what kills the process; see CLAUDE.md). A different file under the same
// front starts upright: the old turn was for the old picture.
async function syncBackSide(libraryId: string, itemId: string, back: GalleryFileEntry | null, prior: PriorBack | undefined): Promise<void> {
  if (!back) {
    if (prior?.back_relative_path) {
      stmt("UPDATE gallery_details SET back_relative_path = NULL, back_size = NULL, back_modified_at = NULL, back_preview_storage_key = NULL, back_rotation = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?")
        .run(itemId);
      if (prior.back_preview_storage_key) {
        try { fs.rmSync(thumbnailAbsolutePath(prior.back_preview_storage_key), { force: true }); } catch { /* ignore */ }
      }
    }
    return;
  }
  const modifiedIso = new Date(back.modifiedAtMs).toISOString();
  const samePath = prior?.back_relative_path === back.relativePath;
  if (samePath && prior!.back_size === back.size && prior!.back_modified_at === modifiedIso && prior!.back_preview_storage_key) return;
  const rotation = samePath ? prior!.back_rotation ?? 0 : 0;
  const key = await generateBackPreview(libraryId, itemId, back.absolutePath, rotation);
  stmt(`
    UPDATE gallery_details
    SET back_relative_path = ?, back_size = ?, back_modified_at = ?, back_rotation = ?,
        back_preview_storage_key = COALESCE(?, back_preview_storage_key),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE item_id = ?
  `).run(back.relativePath, back.size, modifiedIso, rotation, key, itemId);
}

// Catalog one asset (insert/update its item + gallery_details + minimal metadata).
// Skips all work when the file is unchanged (same size + mtime) and already ready,
// so a rescan only touches new/modified assets. Returns the item id.
// `back` is the back side paired with this file (docs/back-sides-proposal.md), or
// null when it has none — the caller decides, from the library's rule or the
// record; this only keeps the row in step with it.
export async function ingestGalleryAsset(
  libraryId: string,
  file: GalleryFileEntry,
  metaEnabled: boolean,
  back: GalleryFileEntry | null = null
): Promise<string> {
  const existing = stmt("SELECT id FROM library_items WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, file.relativePath) as Pick<LibraryItemRow, "id"> | undefined;
  const itemId = existing?.id ?? nanoid(16);
  const modifiedIso = new Date(file.modifiedAtMs).toISOString();

  // Hand-edited title/description (item_metadata.source) and a user-set date
  // (gallery_details.taken_at_source) are owned by the user — the scanner must not
  // overwrite them on a rescan.
  const metaManual = existing
    ? (stmt("SELECT source FROM item_metadata WHERE item_id = ?").get(itemId) as Pick<ItemMetadataRow, "source"> | undefined)?.source === "manual"
    : false;

  // A user-applied rotation is owned by the user; carry it onto regenerated
  // thumbnails when a changed file is re-ingested (the column itself is preserved
  // by the gallery_details UPSERT, which never writes it).
  let existingRotation = 0;
  let priorBack: PriorBack | undefined;
  if (existing) {
    const prior = stmt("SELECT size, modified_at, preview_storage_key, rotation, playable, faststart, phash, taken_at, taken_at_source, back_relative_path, back_size, back_modified_at, back_preview_storage_key, back_rotation FROM gallery_details WHERE item_id = ?")
      .get(itemId) as (Pick<GalleryDetailRow, "size" | "modified_at" | "preview_storage_key" | "rotation" | "playable" | "faststart" | "phash" | "taken_at" | "taken_at_source"> & PriorBack) | undefined;
    priorBack = prior;
    existingRotation = prior?.rotation ?? 0;
    // Re-probe an unchanged video whose playable flag was never computed (rows from
    // before this feature) so a single rescan backfills the grid hint.
    const needsPlayableBackfill = file.kind === "video" && prior?.playable == null;
    const unchanged = prior && prior.size === file.size && prior.modified_at === modifiedIso && prior.preview_storage_key && !needsPlayableBackfill;
    if (unchanged) {
      // Backfill the streaming flag onto videos cataloged before it existed. A few
      // reads of the file's first boxes — no ffprobe, no thumbnail work — so an
      // ordinary incremental scan fills it in without re-ingesting anything.
      if (file.kind === "video" && prior!.faststart == null) {
        const front = await readFaststart(file.absolutePath, file.extension);
        if (front != null) {
          stmt("UPDATE gallery_details SET faststart = ? WHERE item_id = ?").run(front ? 1 : 0, itemId);
        }
      }
      // Backfill the perceptual hash for photos cataloged before the phash column
      // existed — hashed from the cached preview, so no thumbnail regeneration and
      // no original-file read. A failure just leaves NULL for the next scan.
      if (file.kind === "photo" && prior!.phash == null && prior!.preview_storage_key) {
        try {
          const hash = await computeDhash(thumbnailAbsolutePath(prior!.preview_storage_key));
          if (hash) stmt("UPDATE gallery_details SET phash = ? WHERE item_id = ?").run(hash, itemId);
        } catch { /* thumb store unavailable — retried next scan */ }
      }
      // Backfill a filename date onto rows cataloged before that step existed.
      // taken_at === modified_at is the fingerprint of the mtime fallback: EXIF
      // matching the mtime to the millisecond doesn't happen in practice, and a
      // hand-set date is excluded outright. Costs one filename parse — no file
      // read — so an ordinary incremental scan repairs an existing library.
      if (
        prior!.taken_at_source !== "manual"
        && prior!.taken_at != null
        && prior!.taken_at === prior!.modified_at
      ) {
        const fromName = dateFromFileName(file.fileName);
        if (fromName && fromName !== prior!.taken_at) {
          stmt("UPDATE gallery_details SET taken_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?")
            .run(fromName, itemId);
        }
      }
      // Revive a previously-missing row without re-reading the file.
      stmt("UPDATE library_items SET status = 'ready', deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(itemId);
      await syncBackSide(libraryId, itemId, back, priorBack);
      return itemId;
    }
  }

  const metadata = metaEnabled
    ? await readAssetMetadata(file.kind, file.absolutePath)
    : { width: null, height: null, orientation: null, durationSeconds: null, takenAt: null, gpsLat: null, gpsLng: null, cameraMake: null, cameraModel: null, videoCodec: null, audioCodec: null };
  // When EXIF is silent, a date in the filename beats the file's mtime: mtime is
  // rewritten by any copy, sync or restore, while a name like "2012-12-02T16-38-20"
  // still carries the real date. mtime remains the last resort so every asset has
  // a Timeline date.
  const takenAt = metadata.takenAt ?? dateFromFileName(file.fileName) ?? modifiedIso;
  // Videos carry a browser-playability flag (1/0); photos and un-probed videos stay
  // NULL. SQLite has no boolean, so store 1/0.
  const playable = file.kind === "video"
    ? (() => { const p = browserPlayability(file.extension, metadata); return p == null ? null : p ? 1 : 0; })()
    : null;
  // Where the MP4 index sits, for the "not ready for streaming" list (faststart.ts).
  // Photos, WebM and unreadable files stay NULL.
  const indexInFront = file.kind === "video" ? await readFaststart(file.absolutePath, file.extension) : null;
  const faststart = indexInFront == null ? null : indexInFront ? 1 : 0;
  const thumbs = await generateGalleryThumbnails(libraryId, itemId, file.kind, file.absolutePath, existingRotation);
  // Perceptual fingerprint for near-duplicate detection, hashed from the preview just
  // written (a small webp — cheap). Videos stay NULL.
  let phash: string | null = null;
  if (file.kind === "photo" && thumbs?.previewKey) {
    try { phash = await computeDhash(thumbnailAbsolutePath(thumbs.previewKey)); } catch { /* stays NULL */ }
  }
  const title = file.fileName;

  db.transaction(() => {
    if (existing) {
      stmt("UPDATE library_items SET status = 'ready', deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(itemId);
    } else {
      stmt("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')")
        .run(itemId, libraryId, file.relativePath);
    }

    if (metaManual) {
      // Keep the hand-edited title/description; only refresh the derived thumbnail.
      if (thumbs?.coverKey) {
        stmt("UPDATE item_metadata SET cover_storage_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?")
          .run(thumbs.coverKey, itemId);
      }
    } else {
      stmt(`
        INSERT INTO item_metadata (item_id, source, title, sort_title, cover_storage_key)
        VALUES (?, 'scan', ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          title = excluded.title,
          sort_title = excluded.sort_title,
          cover_storage_key = COALESCE(excluded.cover_storage_key, item_metadata.cover_storage_key),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(itemId, title, sortName(title), thumbs?.coverKey ?? null);
    }
    applyItemAlphaIndex(itemId);

    stmt(`
      INSERT INTO gallery_details
        (item_id, kind, relative_path, mime_type, size, width, height, orientation, duration_seconds, taken_at, modified_at, gps_lat, gps_lng, camera_make, camera_model, preview_storage_key, playable, faststart, phash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        kind = excluded.kind, relative_path = excluded.relative_path, mime_type = excluded.mime_type,
        size = excluded.size, width = excluded.width, height = excluded.height, orientation = excluded.orientation,
        duration_seconds = excluded.duration_seconds, modified_at = excluded.modified_at, playable = excluded.playable,
        faststart = excluded.faststart,
        -- A user-set date/location is preserved; scan-owned values track the file.
        taken_at = CASE WHEN gallery_details.taken_at_source = 'manual' THEN gallery_details.taken_at ELSE excluded.taken_at END,
        gps_lat = CASE WHEN gallery_details.gps_source = 'manual' THEN gallery_details.gps_lat ELSE excluded.gps_lat END,
        gps_lng = CASE WHEN gallery_details.gps_source = 'manual' THEN gallery_details.gps_lng ELSE excluded.gps_lng END,
        camera_make = excluded.camera_make,
        camera_model = excluded.camera_model,
        preview_storage_key = COALESCE(excluded.preview_storage_key, gallery_details.preview_storage_key),
        -- A failed hash never wipes a previous one (e.g. a re-ingest without thumbs).
        phash = COALESCE(excluded.phash, gallery_details.phash),
        -- This UPSERT only runs for a new/changed file (the unchanged fast-path returns
        -- earlier), so any existing web-playable copy is now stale: clear it so the
        -- convert job re-makes one from the new content if it's still unplayable.
        web_video_key = NULL,
        web_video_attempts = 0,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      itemId, file.kind, file.relativePath, mimeForExtension(file.extension), file.size,
      metadata.width, metadata.height, metadata.orientation, metadata.durationSeconds,
      takenAt, modifiedIso, metadata.gpsLat, metadata.gpsLng, metadata.cameraMake, metadata.cameraModel,
      thumbs?.previewKey ?? null, playable, faststart, phash
    );
  })();

  await syncBackSide(libraryId, itemId, back, priorBack);
  return itemId;
}

/** Record `backRelativePath` as this photo's back (rendering its preview), or
 *  none: what the explicit actions and a bin restore do, rule or no rule. The
 *  back file must already be beside the front. Returns false when the item or
 *  the file is not there. */
export async function setBackSide(libraryId: string, itemId: string, backRelativePath: string | null): Promise<boolean> {
  const row = stmt(`
    SELECT gd.back_relative_path, gd.back_size, gd.back_modified_at, gd.back_preview_storage_key, gd.back_rotation,
           lib.source_path
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    JOIN libraries lib ON lib.id = li.library_id
    WHERE gd.item_id = ? AND li.library_id = ?
  `).get(itemId, libraryId) as (PriorBack & Pick<LibraryRow, "source_path">) | undefined;
  if (!row) return false;
  let back: GalleryFileEntry | null = null;
  if (backRelativePath) {
    const rootPath = validateLibrarySource(row.source_path);
    back = fileEntryAt(rootPath, normaliseRelativePath(backRelativePath));
    if (!back || back.kind !== "photo") return false;
  }
  await syncBackSide(libraryId, itemId, back, row);
  return true;
}

// The backs this library has on record for its live photos: front path → back
// path. A recorded pair holds while both files exist, whatever the rule says now
// (a rule turned off never turns a back into a second photo), and a file on
// record as a back is never catalogued as an item.
function recordedBackPairs(libraryId: string): Map<string, string> {
  const rows = stmt(`
    SELECT li.folder_path AS front, gd.back_relative_path AS back
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND gd.back_relative_path IS NOT NULL
  `).all(libraryId) as { front: string; back: string }[];
  return new Map(rows.map((row) => [row.front, row.back]));
}

// Which files are backs of which, for one walk: the record first, then the
// library's rule over whatever is left.
function resolveBackSides(libraryId: string, files: GalleryFileEntry[], rule: BackRule): { backOf: Map<string, GalleryFileEntry>; backs: Set<string> } {
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  const backOf = new Map<string, GalleryFileEntry>();
  const backs = new Set<string>();
  for (const [front, back] of recordedBackPairs(libraryId)) {
    const entry = byPath.get(back);
    if (!entry || !byPath.has(front)) continue;
    backOf.set(front, entry);
    backs.add(back);
  }
  const pairing = pairBackSides(files, rule);
  for (const [front, back] of pairing.backOf) {
    if (backOf.has(front) || backs.has(back) || backs.has(front) || backOf.has(back)) continue;
    const entry = byPath.get(back);
    if (!entry) continue;
    backOf.set(front, entry);
    backs.add(back);
  }
  return { backOf, backs };
}

export interface BackSidesCheck {
  /** Photos the walk found. */
  files: number;
  /** Backs a rescan would pair under the rule given. */
  pairs: number;
  /** Of those, how many are catalogued as photos today and would leave the grid. */
  itemsToRetire: number;
  /** Files that fit a pattern but have no front: they stay ordinary photos. */
  unmatched: number;
}

/** Dry run of a back-sides rule over a library's files, from names alone: what the
 *  Scanning tab's "Check this library" shows before anything is saved. */
export function checkBackSides(libraryId: string, rule: BackRule): BackSidesCheck {
  const library = stmt("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as Pick<LibraryRow, "id" | "source_path" | "settings_json"> | undefined;
  if (!library) throw new Error("Gallery library not found.");
  const settings = normalizeLibrarySettings("gallery", library.settings_json);
  const rootPath = validateLibrarySource(library.source_path);
  const files = walkGalleryFiles(rootPath, new Set(settings.scan_extensions.map((extension) => `.${extension}`)))
    .filter((file) => file.kind === "photo");
  const recorded = new Set(recordedBackPairs(libraryId).values());
  const pairing = pairBackSides(files, rule);
  let itemsToRetire = 0;
  const isItem = stmt("SELECT 1 FROM library_items WHERE library_id = ? AND folder_path = ? AND deleted_at IS NULL");
  for (const back of pairing.backs) {
    if (recorded.has(back)) continue;
    if (isItem.get(libraryId, back)) itemsToRetire += 1;
  }
  const newPairs = Array.from(pairing.backs).filter((back) => !recorded.has(back)).length;
  return { files: files.length, pairs: newPairs, itemsToRetire, unmatched: pairing.unmatched.length };
}

// Soft-delete gallery items no longer present on disk. Returns the folder_path of each
// item newly tombstoned this pass (already-missing ones aren't reported again), so the
// caller can log which photos went missing.
export function reconcileGalleryItems(libraryId: string, presentPaths: Set<string>, folderScope: string | null = null): string[] {
  // A folder rescan reconciles ONLY items under that folder — every asset's
  // folder_path is its file path, so items in the subtree match "<folder>/%".
  // Escape LIKE wildcards (a real folder name can contain _ or %) so the delete
  // scope can't over-match a sibling folder and wrongly soft-delete it.
  const known = folderScope
    ? stmt("SELECT id, folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL AND folder_path LIKE ? ESCAPE '\\'")
        .all(libraryId, `${folderScope.replace(/[\\%_]/g, "\\$&")}/%`) as Pick<LibraryItemRow, "id" | "folder_path">[]
    : stmt("SELECT id, folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL")
        .all(libraryId) as Pick<LibraryItemRow, "id" | "folder_path">[];
  const nowMissing: string[] = [];
  for (const item of known) {
    if (!presentPaths.has(item.folder_path)) {
      stmt("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(item.id);
      nowMissing.push(item.folder_path);
    }
  }
  return nowMissing;
}

// Exported for tests, which scan a library in place rather than through the job
// queue (whose worker outlives a test and races the next one's database reset).
export async function scanGalleryLibrary(
  libraryId: string,
  options: GalleryScanOptions = {},
  onProgress?: (processed: number, total: number) => void
) {
  const library = stmt("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as Pick<LibraryRow, "id" | "source_path" | "settings_json"> | undefined;
  if (!library) throw new Error("Gallery library not found.");

  const settings = normalizeLibrarySettings("gallery", library.settings_json);
  const sources = options.sources ? normalizeScanSources("gallery", options.sources) : settings.scan_sources;
  const metaEnabled = sourceEnabled(sources, "file_metadata");
  const rootPath = validateLibrarySource(library.source_path);

  // Optional folder scope: walk just that subtree and reconcile only within it.
  // relativePathWithinRoot resolves + containment-checks the path (throws on escape
  // or a missing/non-directory target); a target that resolves to the root itself
  // degrades to a normal full scan.
  let startDir = rootPath;
  let folderScope: string | null = null;
  if (options.folder != null && options.folder.trim() !== "") {
    const resolved = relativePathWithinRoot(rootPath, options.folder);
    const rel = normaliseRelativePath(path.relative(rootPath, resolved));
    if (rel !== "") { startDir = resolved; folderScope = rel; }
  }

  const files = walkGalleryFiles(rootPath, new Set(settings.scan_extensions.map((extension) => `.${extension}`)), startDir);

  // Backs of scanned prints are not items: they are taken out of the list and
  // handed to their fronts (docs/back-sides-proposal.md).
  const { backOf, backs } = resolveBackSides(libraryId, files, backRuleOf(settings.back_sides));
  const items = files.filter((file) => !backs.has(file.relativePath));

  for (let i = 0; i < items.length; i += 1) {
    onProgress?.(i, items.length);
    await ingestGalleryAsset(libraryId, items[i], metaEnabled, backOf.get(items[i].relativePath) ?? null);
  }
  onProgress?.(items.length, items.length);
  // A photo that has just become a back leaves the catalogue the way a missing
  // file does (its row stays, soft-deleted, with everything it carried — Split
  // brings it back), but it is not missing: nothing to log about it.
  const nowMissing = reconcileGalleryItems(libraryId, new Set(items.map((file) => file.relativePath)), folderScope)
    .filter((relativePath) => !backs.has(relativePath));

  // Record which photos went missing this scan so admins have a trail (the details also
  // stay visible in the "Missing photos" list until they're purged).
  if (nowMissing.length > 0) {
    const sample = nowMissing.slice(0, 8).join(", ");
    const extra = nowMissing.length - 8;
    logActivity({
      event: "library.gallery.photos_missing",
      actorUserId: null,
      targetType: "library",
      targetId: libraryId,
      detail: `${nowMissing.length} photo${nowMissing.length === 1 ? "" : "s"} missing from disk${folderScope ? ` in "${folderScope}"` : ""}: ${extra > 0 ? `${sample} … +${extra} more` : sample}.`,
      ipAddress: null
    });
  }

  // A folder rescan is partial, so it clears the "scanning" flag but must NOT claim
  // a full-library last_scanned_at timestamp.
  if (folderScope) {
    stmt("UPDATE libraries SET scan_status = 'idle', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(libraryId);
  } else {
    stmt("UPDATE libraries SET scan_status = 'idle', last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(libraryId);
  }
  return { assets: items.length, folder: folderScope };
}

// Ingest one newly-added asset (upload / restore) without re-walking the library.
export async function scanSingleGalleryFile(libraryId: string, relativePath: string): Promise<string | null> {
  const library = stmt("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as Pick<LibraryRow, "id" | "source_path" | "settings_json"> | undefined;
  if (!library) return null;

  const settings = normalizeLibrarySettings("gallery", library.settings_json);
  const metaEnabled = sourceEnabled(settings.scan_sources, "file_metadata");
  const rootPath = validateLibrarySource(library.source_path);
  const normalized = normaliseRelativePath(relativePath);
  const entry = fileEntryAt(rootPath, normalized);
  if (!entry) return null; // not a gallery file, not there, or empty — the walk's rules

  const rule = backRuleOf(settings.back_sides);
  const extensions = new Set(settings.scan_extensions.map((ext) => `.${ext}`));

  // A back, not a photo of its own (docs/back-sides-proposal.md): on record as
  // some live front's back, or fitting the rule beside a front. Either way the
  // FRONT is (re-)catalogued with it and its id is the answer.
  if (entry.kind === "photo") {
    const recordedFront = stmt(`
      SELECT li.folder_path FROM gallery_details gd
      JOIN library_items li ON li.id = gd.item_id
      WHERE li.library_id = ? AND li.deleted_at IS NULL AND gd.back_relative_path = ?
    `).get(libraryId, normalized) as Pick<LibraryItemRow, "folder_path"> | undefined;
    const frontPath = recordedFront?.folder_path ?? frontFileBeside(rootPath, normalized, rule, extensions);
    if (frontPath) {
      const front = fileEntryAt(rootPath, frontPath);
      if (front) {
        requestPhotoPlaceSweep();
        return ingestGalleryAsset(libraryId, front, metaEnabled, entry);
      }
    }
  }

  requestPhotoPlaceSweep();
  return ingestGalleryAsset(libraryId, entry, metaEnabled, backFileBeside(libraryId, rootPath, entry, rule, extensions));
}

// The photo files in one folder, by name only — no stat, so a folder of
// thousands costs one readdir when a single file lands in it.
function photoNamesIn(rootPath: string, dir: string, extensions: Set<string>): string[] {
  const abs = dir === "." ? rootPath : path.join(rootPath, ...dir.split("/"));
  let names: fs.Dirent[];
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; }
  return names
    .filter((d) => d.isFile() && !d.name.startsWith(".") && extensions.has(path.extname(d.name).toLowerCase()) && kindForExtension(path.extname(d.name).toLowerCase()) === "photo")
    .map((d) => d.name);
}

// The front a lone back file belongs to under the rule, beside it on disk, or null.
// A front already on record as someone's back is no front.
function frontFileBeside(rootPath: string, backPath: string, rule: BackRule, extensions: Set<string>): string | null {
  const stems = frontStemsFor(backPath, rule);
  if (stems.length === 0) return null;
  const dir = path.posix.dirname(backPath);
  const names = photoNamesIn(rootPath, dir, extensions);
  for (const stem of stems) {
    const match = names.find((name) => name.slice(0, name.length - path.extname(name).length).toLowerCase() === stem.toLowerCase());
    if (!match) continue;
    const candidate = dir === "." ? match : `${dir}/${match}`;
    if (candidate === backPath) continue;
    return candidate;
  }
  return null;
}

// The back a front has: the one on record if its file is still there, else the
// one the rule finds beside it on disk, else none.
function backFileBeside(libraryId: string, rootPath: string, front: GalleryFileEntry, rule: BackRule, extensions: Set<string>): GalleryFileEntry | null {
  if (front.kind !== "photo") return null;
  const recorded = stmt(`
    SELECT gd.back_relative_path FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    WHERE li.library_id = ? AND li.folder_path = ? AND gd.back_relative_path IS NOT NULL
  `).get(libraryId, front.relativePath) as Pick<GalleryDetailRow, "back_relative_path"> | undefined;
  if (recorded?.back_relative_path) {
    const kept = fileEntryAt(rootPath, recorded.back_relative_path);
    if (kept) return kept;
  }
  if (rule.patterns.length === 0) return null;
  const dir = path.posix.dirname(front.relativePath);
  const candidates = photoNamesIn(rootPath, dir, extensions)
    .map((name) => ({ relativePath: dir === "." ? name : `${dir}/${name}`, kind: "photo" as const }));
  const backPath = pairBackSides(candidates, rule).backOf.get(front.relativePath);
  if (!backPath) return null;
  // Someone else's back on record stays theirs.
  const taken = stmt(`
    SELECT 1 FROM gallery_details gd JOIN library_items li ON li.id = gd.item_id
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND gd.back_relative_path = ? AND li.folder_path <> ?
  `).get(libraryId, backPath, front.relativePath);
  if (taken) return null;
  return fileEntryAt(rootPath, backPath);
}

// ── Job queue (mirrors the ebook scan worker) ──

// Queue a scan, or join the one already waiting.
//
// Identical pending jobs used to stack, and a caller in a loop could queue hundreds
// of full library scans without meaning to — restoring N photos from the Recycle Bin
// queued N of them, each a complete walk of the library, run one after another. A
// scan that has not started yet cannot have missed anything a second one would find,
// so the waiting job IS the answer to the new request.
//
// Matched on the exact payload: a subtree rescan and a full scan are different work,
// and a running job is never joined — it may already be past the file in question.
export function enqueueGalleryScan(libraryId: string, options: GalleryScanOptions = {}): string {
  const payload = JSON.stringify({ libraryId, options });
  stmt("UPDATE libraries SET scan_status = 'scanning', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(libraryId);

  const waiting = stmt(
    "SELECT id FROM jobs WHERE type = ? AND status = 'pending' AND payload = ? LIMIT 1"
  ).get(scanJobType, payload) as Pick<JobRow, "id"> | undefined;
  if (waiting) return waiting.id;

  const jobId = nanoid(16);
  stmt("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, scanJobType, payload);
  return jobId;
}

let queueRunning = false;

export async function processGalleryScanQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // A scan the recovery pass gives up on (interrupted on its last attempt) has to
    // release its library too, or the library keeps claiming to scan with no task
    // behind it — and the nightly scheduler skips libraries marked 'scanning'.
    releaseAbandonedScanLibraries(requeueInterruptedJobs(scanJobType).abandoned);

    for (;;) {
      // One library job at a time server-wide: while another scan or face job is
      // running (whatever its type), leave the queue alone until the next poll.
      if (libraryJobRunning()) break;

      const job = stmt(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY run_at ASC LIMIT 1
      `).get(scanJobType) as Pick<JobRow, "id" | "payload"> | undefined;
      if (!job) break;

      const claim = stmt(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as { libraryId: string; options?: GalleryScanOptions };
      try {
        // Persist live progress into the job payload (throttled) so the Tasks page
        // shows items scanned + ETA while the scan runs.
        const result = await scanGalleryLibrary(payload.libraryId, payload.options ?? {}, jobProgressWriter(job.id, payload));
        stmt(`
          UPDATE jobs SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL
          WHERE id = ?
        `).run(JSON.stringify({ ...payload, result }), job.id);
        // Photos the scan found or moved get their place names (places.ts).
        requestPhotoPlaceSweep();
        // A finished Photo Inbox scan queues its duplicate check, so the review page
        // can open with "12 new, 3 look like copies" (docs/photo-inbox-proposal.md,
        // decision 9). Imported lazily: the duplicates module reaches back into this
        // one. A check that cannot start — another cleanup holds the slot — is not
        // an error; the Inbox page offers it by hand.
        if (isPhotoInboxLibrary(payload.libraryId)) {
          void import("./duplicates/inbox-check.js")
            .then((mod) => mod.queueInboxCheck(payload.libraryId))
            .catch(() => { /* started by hand from the Inbox page */ });
        }
      } catch (err) {
        const permanent = err instanceof LibrarySourceError;
        const message = err instanceof Error ? err.message : "Gallery scan failed";
        const attempts = (stmt("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as Pick<JobRow, "attempts" | "max_attempts">);
        if (!permanent && attempts.attempts < attempts.max_attempts) {
          const runAt = new Date(Date.now() + 5000).toISOString();
          stmt("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(runAt, message, job.id);
        } else {
          stmt("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
          stmt("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND scan_status = 'scanning'")
            .run(payload.libraryId);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

// On the shared job poller (core/job-poller.ts).
export function startGalleryScanWorker() {
  return registerJobHandler({ name: "gallery scan", types: [scanJobType], run: processGalleryScanQueue });
}
