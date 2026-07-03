// Gallery scanner. Unlike the book scanners, EACH FILE IS ONE ITEM (one photo or
// one video = one library_items row) — the Immich/Google-Photos "asset" model. The
// item's folder_path is the file's relative path: its directory powers the Folder
// view and its EXIF date (gallery_details.taken_at) powers the Timeline. There are
// no scan rules, series, authors, or categories for gallery — just assets.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import { libraryJobRunning } from "../shared/scan-lock.js";
import { jobProgressWriter } from "../shared/job-progress.js";
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
  generateGalleryThumbnails,
  type AssetKind
} from "./media.js";

const scanJobType = "SCAN_GALLERY_LIBRARY";

export interface GalleryScanOptions {
  sources?: ScanSourceConfig[];
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
function walkGalleryFiles(rootPath: string, extensions: Set<string>): GalleryFileEntry[] {
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
  walk(rootPath);
  return files;
}

function sortName(value: string): string {
  return value.trim().toLowerCase();
}

// Catalog one asset (insert/update its item + gallery_details + minimal metadata).
// Skips all work when the file is unchanged (same size + mtime) and already ready,
// so a rescan only touches new/modified assets. Returns the item id.
export async function ingestGalleryAsset(
  libraryId: string,
  file: GalleryFileEntry,
  metaEnabled: boolean
): Promise<string> {
  const existing = db.prepare("SELECT id FROM library_items WHERE library_id = ? AND folder_path = ?")
    .get(libraryId, file.relativePath) as { id: string } | undefined;
  const itemId = existing?.id ?? nanoid(16);
  const modifiedIso = new Date(file.modifiedAtMs).toISOString();

  // Hand-edited title/description (item_metadata.source) and a user-set date
  // (gallery_details.taken_at_source) are owned by the user — the scanner must not
  // overwrite them on a rescan.
  const metaManual = existing
    ? (db.prepare("SELECT source FROM item_metadata WHERE item_id = ?").get(itemId) as { source: string } | undefined)?.source === "manual"
    : false;

  // A user-applied rotation is owned by the user; carry it onto regenerated
  // thumbnails when a changed file is re-ingested (the column itself is preserved
  // by the gallery_details UPSERT, which never writes it).
  let existingRotation = 0;
  if (existing) {
    const prior = db.prepare("SELECT size, modified_at, preview_storage_key, rotation FROM gallery_details WHERE item_id = ?")
      .get(itemId) as { size: number | null; modified_at: string | null; preview_storage_key: string | null; rotation: number | null } | undefined;
    existingRotation = prior?.rotation ?? 0;
    const unchanged = prior && prior.size === file.size && prior.modified_at === modifiedIso && prior.preview_storage_key;
    if (unchanged) {
      // Revive a previously-missing row without re-reading the file.
      db.prepare("UPDATE library_items SET status = 'ready', deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(itemId);
      return itemId;
    }
  }

  const metadata = metaEnabled
    ? await readAssetMetadata(file.kind, file.absolutePath)
    : { width: null, height: null, orientation: null, durationSeconds: null, takenAt: null, gpsLat: null, gpsLng: null, cameraMake: null, cameraModel: null };
  // Fall back to the file's mtime so every asset has a Timeline date.
  const takenAt = metadata.takenAt ?? modifiedIso;
  const thumbs = await generateGalleryThumbnails(libraryId, itemId, file.kind, file.absolutePath, existingRotation);
  const title = file.fileName;

  db.transaction(() => {
    if (existing) {
      db.prepare("UPDATE library_items SET status = 'ready', deleted_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(itemId);
    } else {
      db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')")
        .run(itemId, libraryId, file.relativePath);
    }

    if (metaManual) {
      // Keep the hand-edited title/description; only refresh the derived thumbnail.
      if (thumbs?.coverKey) {
        db.prepare("UPDATE item_metadata SET cover_storage_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE item_id = ?")
          .run(thumbs.coverKey, itemId);
      }
    } else {
      db.prepare(`
        INSERT INTO item_metadata (item_id, source, title, sort_title, cover_storage_key)
        VALUES (?, 'scan', ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          title = excluded.title,
          sort_title = excluded.sort_title,
          cover_storage_key = COALESCE(excluded.cover_storage_key, item_metadata.cover_storage_key),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(itemId, title, sortName(title), thumbs?.coverKey ?? null);
    }

    db.prepare(`
      INSERT INTO gallery_details
        (item_id, kind, relative_path, mime_type, size, width, height, orientation, duration_seconds, taken_at, modified_at, gps_lat, gps_lng, camera_make, camera_model, preview_storage_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        kind = excluded.kind, relative_path = excluded.relative_path, mime_type = excluded.mime_type,
        size = excluded.size, width = excluded.width, height = excluded.height, orientation = excluded.orientation,
        duration_seconds = excluded.duration_seconds, modified_at = excluded.modified_at,
        -- A user-set date is preserved; a scan-owned date tracks the file.
        taken_at = CASE WHEN gallery_details.taken_at_source = 'manual' THEN gallery_details.taken_at ELSE excluded.taken_at END,
        gps_lat = excluded.gps_lat, gps_lng = excluded.gps_lng, camera_make = excluded.camera_make,
        camera_model = excluded.camera_model,
        preview_storage_key = COALESCE(excluded.preview_storage_key, gallery_details.preview_storage_key),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      itemId, file.kind, file.relativePath, mimeForExtension(file.extension), file.size,
      metadata.width, metadata.height, metadata.orientation, metadata.durationSeconds,
      takenAt, modifiedIso, metadata.gpsLat, metadata.gpsLng, metadata.cameraMake, metadata.cameraModel,
      thumbs?.previewKey ?? null
    );
  })();

  return itemId;
}

// Soft-delete gallery items no longer present on disk.
function reconcileGalleryItems(libraryId: string, presentPaths: Set<string>): void {
  const known = db.prepare("SELECT id, folder_path FROM library_items WHERE library_id = ? AND deleted_at IS NULL")
    .all(libraryId) as { id: string; folder_path: string }[];
  for (const item of known) {
    if (!presentPaths.has(item.folder_path)) {
      db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(item.id);
    }
  }
}

async function scanGalleryLibrary(
  libraryId: string,
  options: GalleryScanOptions = {},
  onProgress?: (processed: number, total: number) => void
) {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) throw new Error("Gallery library not found.");

  const settings = normalizeLibrarySettings("gallery", library.settings_json);
  const sources = options.sources ? normalizeScanSources("gallery", options.sources) : settings.scan_sources;
  const metaEnabled = sourceEnabled(sources, "file_metadata");
  const rootPath = validateLibrarySource(library.source_path);
  const files = walkGalleryFiles(rootPath, new Set(settings.scan_extensions.map((extension) => `.${extension}`)));

  for (let i = 0; i < files.length; i += 1) {
    onProgress?.(i, files.length);
    await ingestGalleryAsset(libraryId, files[i], metaEnabled);
  }
  onProgress?.(files.length, files.length);
  reconcileGalleryItems(libraryId, new Set(files.map((file) => file.relativePath)));

  db.prepare("UPDATE libraries SET scan_status = 'idle', last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(libraryId);
  return { assets: files.length };
}

// Ingest one newly-added asset (upload / restore) without re-walking the library.
export async function scanSingleGalleryFile(libraryId: string, relativePath: string): Promise<string | null> {
  const library = db.prepare("SELECT id, source_path, settings_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as { id: string; source_path: string; settings_json: string } | undefined;
  if (!library) return null;

  const settings = normalizeLibrarySettings("gallery", library.settings_json);
  const metaEnabled = sourceEnabled(settings.scan_sources, "file_metadata");
  const rootPath = validateLibrarySource(library.source_path);
  const normalized = normaliseRelativePath(relativePath);
  const extension = path.extname(normalized).toLowerCase();
  const kind = kindForExtension(extension);
  if (!kind) return null;
  const absolutePath = path.join(rootPath, ...normalized.split("/"));
  let stat: fs.Stats;
  try { stat = fs.statSync(absolutePath); } catch { return null; }
  if (stat.size === 0) return null; // same empty-file rule as the walk

  return ingestGalleryAsset(libraryId, {
    absolutePath,
    relativePath: normalized,
    fileName: path.basename(normalized),
    extension,
    kind,
    size: stat.size,
    modifiedAtMs: stat.mtimeMs
  }, metaEnabled);
}

// ── Job queue (mirrors the ebook scan worker) ──

export function enqueueGalleryScan(libraryId: string, options: GalleryScanOptions = {}): string {
  const jobId = nanoid(16);
  db.prepare("UPDATE libraries SET scan_status = 'scanning', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(libraryId);
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, scanJobType, JSON.stringify({ libraryId, options }));
  return jobId;
}

let queueRunning = false;

export async function processGalleryScanQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    db.prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, error = NULL WHERE type = ? AND status = 'running'")
      .run(scanJobType);

    for (;;) {
      // One library job at a time server-wide: while another scan or face job is
      // running (whatever its type), leave the queue alone until the next poll.
      if (libraryJobRunning()) break;

      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(run_at) ASC LIMIT 1
      `).get(scanJobType) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as { libraryId: string; options?: GalleryScanOptions };
      try {
        // Persist live progress into the job payload (throttled) so the Tasks page
        // shows items scanned + ETA while the scan runs.
        const result = await scanGalleryLibrary(payload.libraryId, payload.options ?? {}, jobProgressWriter(job.id, payload));
        db.prepare(`
          UPDATE jobs SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL
          WHERE id = ?
        `).run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        const permanent = err instanceof LibrarySourceError;
        const message = err instanceof Error ? err.message : "Gallery scan failed";
        const attempts = (db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number });
        if (!permanent && attempts.attempts < attempts.max_attempts) {
          const runAt = new Date(Date.now() + 5000).toISOString();
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(runAt, message, job.id);
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
          db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND scan_status = 'scanning'")
            .run(payload.libraryId);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startGalleryScanWorker() {
  const timer = setInterval(() => { void processGalleryScanQueue(); }, 2000);
  return () => clearInterval(timer);
}
