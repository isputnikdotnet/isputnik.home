import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity, logActivityOnce } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { can, parsePolicy } from "../../../core/permissions.js";
import { canUserAccessLibrary, canUserAccessBook, libraryCapabilities, deleteLibraryAccess, canUserWriteLibrary, getLibraryForBook } from "../shared/library-access.js";
import { publicLibrary, type LibraryListRow } from "../shared/library-serializer.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import { deleteStoryBlocksForLibrary } from "../../stories/cleanup.js";
import { coreLibraryCreateSchema, coreLibraryUpdateSchema, createLibraryRecord, updateLibraryRecord, resolveUploadMaxBytes } from "../shared/library-crud.js";
import { METADATA_SOURCE_IDS } from "../shared/metadata-sources.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import { normaliseRelativePath, relativePathWithinRoot } from "../shared/storage-roots.js";
import { removeThumbnailsForLibrary } from "../shared/thumbnail.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "../shared/library-settings.js";
import { receiveUploadBatch, UploadError } from "../../uploads/index.js";
import { enqueueGalleryScan, processGalleryScanQueue, scanSingleGalleryFile } from "./scanner.js";
import { kindForExtension, readAssetMetadata } from "./media.js";
import { listMissingGalleryPhotos, setMissingRetentionDays, purgeMissingGalleryPhoto, purgeMissingGalleryPhotos } from "./cleanup.js";
import {
  resolveGalleryScopeLibraryIds,
  parseLibraryIds,
  queryGalleryTimeline,
  queryGalleryFolders,
  searchGalleryFolders,
  getGalleryAsset,
  getGalleryAssets,
  getGalleryAssetUnscoped,
  galleryFacets,
  queryGalleryMapPoints,
  queryGalleryMemories,
  EMPTY_GALLERY_FILTERS
} from "./catalog.js";
import { changeGalleryTags, setGalleryPlaceAndTime, updateGalleryAsset } from "./edit.js";
import { searchPlaces } from "./geocode.js";
import { suggestGalleryMemories } from "./memories.js";
import { suggestYearReviews, buildYearReview } from "./year-review.js";
import { rotateGalleryAsset } from "./rotate.js";

// Each uploaded file becomes its own asset (one photo/video = one item), so this
// also bounds assets-per-upload — galleries are dropped in large batches.
const MAX_GALLERY_UPLOAD_FILES = 200;

// Turn a client filename into a safe, collision-free name within a directory:
// strip path separators / control chars, refuse a leading dot (the scanner skips
// dot-entries, and ".upload-*" is reserved for staging), then disambiguate against
// existing files with " (2)", " (3)", … Returns null if nothing usable remains.
// Mirrors the ebook uploader.
// Exported for the story narration flow, which lands recordings in a gallery
// library through the same naming rules as a regular upload.
export function uniqueGalleryFileName(dir: string, filename: string): string | null {
  const ext = path.extname(filename);
  const stem = Array.from(path.basename(filename, ext))
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150)
    .replace(/[\s.]+$/g, "");
  if (!stem) return null;
  let candidate = `${stem}${ext}`;
  let counter = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

// The library-relative subfolder an upload is filed under: `YYYY/YYYY-MM-DD` from the
// file's capture date, so uploads land in dated folders alongside the rest of the
// library instead of piling up at the root. Y/M/D come straight from the ISO prefix
// (no timezone shift); `fallback` (the upload time) is used when the file carries no
// embedded date. Pure + injectable for tests.
export function dateFolderForCapture(takenAt: string | null, fallback: Date): string {
  const parts = takenAt ? /^(\d{4})-(\d{2})-(\d{2})/.exec(takenAt) : null;
  const y = parts ? Number(parts[1]) : fallback.getFullYear();
  const m = parts ? Number(parts[2]) : fallback.getMonth() + 1;
  const d = parts ? Number(parts[3]) : fallback.getDate();
  return `${y}/${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Probe a staged upload for its capture date (EXIF for photos, container metadata for
// videos) and turn it into its dated subfolder. Falls back to the upload time when the
// file has no embedded date — the multipart stream doesn't carry the original's mtime.
async function uploadDateFolder(tmpPath: string, extension: string): Promise<string> {
  const kind = kindForExtension(`.${extension}`);
  let takenAt: string | null = null;
  if (kind) {
    try { takenAt = (await readAssetMetadata(kind, tmpPath)).takenAt; } catch { /* no date → fallback */ }
  }
  return dateFolderForCapture(takenAt, new Date());
}

// Turn a raw filesystem write failure into a message that names the real problem.
// The usual culprit is a read-only media mount (Unraid's template historically mapped
// media read-only) or missing write permission — uploading has to create files in the
// library folder, unlike scanning which only reads.
export function friendlyStorageError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(EROFS|EACCES|EPERM|ENOENT)\b/.test(message) && /mkdir|open|rename|EROFS/.test(message)) {
    return "Can't write to this library's folder. Uploads need write access — on Unraid, set the Media Storage path to Read/Write (not Read Only) and make sure the container can write to it.";
  }
  return message || fallback;
}

const GALLERY_LIBRARY_LIST_SQL = `
  SELECT
    libraries.*,
    COUNT(DISTINCT library_items.id) AS book_count,
    COUNT(gallery_details.item_id) AS file_count,
    COALESCE(SUM(COALESCE(gallery_details.size, 0)), 0) AS total_size_bytes
  FROM libraries
  LEFT JOIN library_items ON library_items.library_id = libraries.id AND library_items.deleted_at IS NULL
  LEFT JOIN gallery_details ON gallery_details.item_id = library_items.id
  WHERE libraries.type = 'gallery' %WHERE%
  GROUP BY libraries.id
  ORDER BY datetime(libraries.created_at) DESC
`;

export async function galleryRoutesPlugin(app: FastifyInstance) {
  app.post("/api/library/gallery-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(coreLibraryCreateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid gallery library details", details: parsed.error });
    }

    const result = createLibraryRecord({ type: "gallery", data: parsed.data, userId: request.user!.id, ip: request.ip });
    if ("error" in result) {
      return reply.code(result.status).send({ error: result.error });
    }

    const jobId = enqueueGalleryScan(result.libraryId);
    void processGalleryScanQueue();
    return reply.code(201).send({ library: { id: result.libraryId }, job: { id: jobId, type: "SCAN_GALLERY_LIBRARY" } });
  });

  app.get("/api/library/gallery-libraries", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(GALLERY_LIBRARY_LIST_SQL.replace("%WHERE%", "")).all() as LibraryListRow[];
    const manageAll = (request.query as { manage?: string }).manage != null && user.role === "admin";
    const visible = manageAll ? rows : rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));
    return { libraries: visible.map((row) => publicLibrary(row, user.role === "admin", libraryCapabilities(row, user.id, user.role))) };
  });

  app.patch("/api/library/gallery-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = parseBody(coreLibraryUpdateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid library details", details: parsed.error });
    }

    const result = updateLibraryRecord({ type: "gallery", id, data: parsed.data, userId: request.user!.id, ip: request.ip });
    if ("error" in result) {
      return reply.code(result.status).send({ error: result.error });
    }

    const updated = db.prepare(GALLERY_LIBRARY_LIST_SQL.replace("%WHERE%", "AND libraries.id = ?")).get(id) as LibraryListRow;
    return reply.send({ library: publicLibrary(updated, true, libraryCapabilities(updated, request.user!.id, request.user!.role)) });
  });

  app.delete("/api/library/gallery-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      return reply.code(404).send({ error: "Gallery library not found" });
    }

    db.transaction(() => {
      db.prepare("DELETE FROM taggables WHERE entity_type = 'library_item' AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)").run(id);
      deleteSharesForLibrary("gallery", id);
      deleteCollectionItemsForLibrary("gallery", id);
      deleteStoryBlocksForLibrary("gallery", id);
      deleteLibraryAccess(id);
      db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    })();
    removeThumbnailsForLibrary(id);

    logActivity({
      event: "library.gallery.deleted",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Deleted gallery library "${exists.name}". Source files on disk were not removed; generated thumbnails were deleted.`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  const rescanOptionsSchema = z.object({
    sources: z.array(z.object({ id: z.enum(METADATA_SOURCE_IDS), enabled: z.boolean() })).max(20).optional(),
    // Optional: rescan just one subtree instead of the whole library.
    folder: z.string().trim().max(1024).optional()
  });

  app.post("/api/library/gallery-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'gallery'")
      .get(id) as { id: string; source_path: string } | undefined;
    if (!exists) {
      return reply.code(404).send({ error: "Gallery library not found" });
    }

    const parsed = parseBody(rescanOptionsSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
    }

    let root: string;
    try {
      root = validateLibrarySource(exists.source_path);
    } catch (err) {
      if (err instanceof LibrarySourceError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }

    // Validate a folder scope up front so a bad path returns a clean 400 instead of
    // failing (and retrying) inside the scan worker.
    const folder = parsed.data.folder?.trim();
    if (folder) {
      try {
        relativePathWithinRoot(root, folder);
      } catch {
        return reply.code(400).send({ error: "That folder is not inside this library." });
      }
    }

    const jobId = enqueueGalleryScan(id, parsed.data);
    void processGalleryScanQueue();
    logActivity({
      event: "library.gallery.rescan",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: folder ? `Queued a gallery rescan of "${folder}".` : "Queued a gallery library rescan.",
      ipAddress: request.ip
    });
    return reply.send({ job: { id: jobId, type: "SCAN_GALLERY_LIBRARY" } });
  });

  // Upload photos/videos: every file in the multipart request becomes its OWN asset
  // (one file = one item). Files stream into a hidden ".upload-*" staging folder under
  // the library root, then each is moved into the root under a safe, unique name and
  // cataloged immediately via scanSingleGalleryFile (reads EXIF + builds thumbnails).
  app.post("/api/library/gallery-libraries/:id/assets/upload", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const user = request.user!;

    const library = db.prepare(
      "SELECT id, name, source_path, settings_json, policy_json FROM libraries WHERE id = ? AND type = 'gallery'"
    ).get(libraryId) as { id: string; name: string; source_path: string; settings_json: string; policy_json: string } | undefined;
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      return reply.code(404).send({ error: "Gallery library not found" });
    }

    const policy = parsePolicy(library.policy_json);
    if (!can(user, { objectType: "library", objectId: library.id, policy }, "upload")) {
      return reply.code(403).send({ error: "Uploading is not allowed in this library." });
    }

    let root: string;
    try {
      root = validateLibrarySource(library.source_path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Library source folder is unavailable." });
    }

    const settings = normalizeLibrarySettings("gallery", library.settings_json);
    const maxBytes = resolveUploadMaxBytes(policy.maxUploadMB);
    const stagingDir = path.join(root, `.upload-${nanoid(10)}`);

    let received;
    try {
      received = await receiveUploadBatch(
        request,
        { accept: uploadAcceptExtensions(settings), maxBytes },
        stagingDir,
        MAX_GALLERY_UPLOAD_FILES
      );
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const status = err instanceof UploadError ? err.statusCode : 400;
      return reply.code(status).send({ error: friendlyStorageError(err, "Upload failed") });
    }

    // Each file moves into a dated subfolder (YYYY/YYYY-MM-DD by capture date) under the
    // library root, then is cataloged on its own. Files already in place stay even if a
    // later one fails.
    const createdIds: string[] = [];
    let totalBytes = 0;
    try {
      for (const file of received) {
        const targetDir = path.join(root, ...(await uploadDateFolder(file.tmpPath, file.extension)).split("/"));
        fs.mkdirSync(targetDir, { recursive: true });
        const finalName = uniqueGalleryFileName(targetDir, file.filename);
        if (!finalName) { fs.rmSync(file.tmpPath, { force: true }); continue; }
        const finalPath = path.join(targetDir, finalName);
        fs.renameSync(file.tmpPath, finalPath);
        const relativePath = normaliseRelativePath(path.relative(root, finalPath));
        const assetId = await scanSingleGalleryFile(library.id, relativePath);
        if (assetId) { createdIds.push(assetId); totalBytes += file.sizeBytes; }
      }
    } catch (err) {
      return reply.code(500).send({ error: friendlyStorageError(err, "Could not store the uploaded files.") });
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    if (createdIds.length === 0) {
      return reply.code(400).send({ error: "No photos or videos were added from the upload." });
    }

    logActivity({
      event: "library.gallery.uploaded",
      actorUserId: user.id,
      targetType: "library",
      targetId: library.id,
      detail: `Uploaded ${createdIds.length} item${createdIds.length === 1 ? "" : "s"} (${totalBytes} bytes) to gallery "${library.name}".`,
      ipAddress: request.ip
    });

    // `itemIds` lets a caller act on what it just uploaded — the family tree
    // attaches them to a person or event straight after the upload.
    return reply.code(201).send({ uploaded: createdIds.length, itemIds: createdIds });
  });

  // ── Browse: Timeline (by date) and Folders (by on-disk structure) ──

  // Advanced-filter arrays (audiobook-catalog style): each list is optional and
  // bounded so a hostile payload can't inflate the SQL placeholder count.
  const filterList = z.array(z.string().trim().min(1).max(200)).max(100).default([]);
  const timelineSchema = z.object({
    q: z.string().trim().max(200).default(""),
    kinds: z.array(z.enum(["photo", "video", "audio"])).default([]),
    filters: z.object({
      // Which gallery libraries this scopes to — the first cut, so it stays
      // outside the AND-of-facets loop below and reads that way in catalog.ts.
      libraries: filterList,
      people: filterList,
      tags: filterList,
      years: filterList,
      months: z.array(z.string().regex(/^(0[1-9]|1[0-2])$/)).max(12).default([]),
      taken: z.array(z.string().regex(/^(from|to):\d{4}-\d{2}-\d{2}$/)).max(2).default([]),
      cameras: filterList,
      sizes: z.array(z.enum(["small", "medium", "large", "huge"])).max(4).default([]),
      location: z.array(z.enum(["with_gps", "no_gps"])).max(2).default([]),
      likes: z.array(z.enum(["mine", "anyone", "none"])).max(3).default([])
      // prefault, not default: zod 4 requires a `.default()` to be the finished
      // OUTPUT object, so `{}` no longer type-checks. `.prefault({})` keeps zod 3's
      // behaviour of feeding the value back through the schema, which lets each
      // field's own `.default([])` above stay the single source of truth — spelling
      // the whole object out here would just be a second copy to forget to update.
    }).prefault({}),
    sort: z.enum(["taken", "added"]).default("taken"),
    limit: z.number().int().min(1).max(200).default(80),
    offset: z.number().int().min(0).default(0)
  });

  app.post("/api/library/gallery/timeline", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(timelineSchema, request.body ?? {});
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid timeline query", details: parsed.error });
    }
    const p = parsed.data;
    const libIds = resolveGalleryScopeLibraryIds(request.user!, p.filters?.libraries ?? []);
    return reply.send(queryGalleryTimeline(request.user!.id, libIds, {
      q: p.q ?? "", kinds: p.kinds ?? [],
      filters: { ...EMPTY_GALLERY_FILTERS, ...p.filters },
      sort: p.sort ?? "taken",
      limit: p.limit ?? 80, offset: p.offset ?? 0
    }));
  });

  // ── Missing photos (reconcile tombstones: files gone from disk, hidden but retained) ──
  // Admin-only housekeeping: list them, tune the auto-purge window, or purge now.
  app.get("/api/library/gallery/missing", { preHandler: app.requireAdmin }, async () => {
    return listMissingGalleryPhotos();
  });

  const retentionSchema = z.object({ retentionDays: z.number().int().min(0).max(3650) });
  app.patch("/api/library/gallery/missing/retention", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(retentionSchema, request.body);
    if (parsed.error) { return reply.code(400).send({ error: "Invalid retention", details: parsed.error }); }
    const retentionDays = setMissingRetentionDays(parsed.data.retentionDays, request.user!.id);
    logActivity({
      event: "library.gallery.missing_retention",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: null,
      detail: retentionDays === 0 ? "Missing-photo auto-purge disabled." : `Missing-photo auto-purge set to ${retentionDays} days.`,
      ipAddress: request.ip
    });
    return reply.send({ retentionDays });
  });

  // Purge every tombstone past the grace window right now (the scheduled job on demand).
  // destructive: purging missing entries deletes their records and thumbnails —
  // refused from untrusted networks under the deletions-only policy.
  app.post("/api/library/gallery/missing/purge", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request) => {
    return purgeMissingGalleryPhotos(undefined, request.user!.id);
  });

  // Purge one specific missing photo immediately, ignoring the grace window.
  app.delete("/api/library/gallery/missing/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!purgeMissingGalleryPhoto(id, request.user!.id)) {
      return reply.code(404).send({ error: "No such missing photo." });
    }
    return reply.send({ purged: true });
  });

  app.get("/api/library/gallery/folders", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { libraryIds?: string; parent?: string; limit?: string; offset?: string };
    const libIds = resolveGalleryScopeLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    // Cap the folder path: real relative paths are short, so a bounded value keeps
    // the LIKE pattern and all downstream string work sane (defense in depth).
    const parent = (qp.parent ?? "").slice(0, 1024);
    return queryGalleryFolders(request.user!.id, libIds, parent, limit, offset);
  });

  // Folder-NAME search, everywhere in scope — "where is the folder called wedding".
  // Separate from /folders above, which browses one level of the tree.
  app.get("/api/library/gallery/folders/search", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { libraryIds?: string; q?: string; limit?: string };
    const libIds = resolveGalleryScopeLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "100", 10) || 100, 1), 200);
    return searchGalleryFolders(libIds, (qp.q ?? "").slice(0, 200), limit);
  });

  // Memories ("On this day"): past-year assets matching today's month/day, grouped
  // by year. `date` is the client's local calendar date — the server may sit in a
  // different timezone, and "today" belongs to the person looking at the screen.
  // `perYear` caps items per year group (the Home tile only needs one for a cover).
  app.get("/api/library/gallery/memories", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { libraryIds?: string; date?: string; perYear?: string };
    const libIds = resolveGalleryScopeLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    // A malformed or impossible date (e.g. 2026-99-99 passes the shape check but
    // not Date parsing) falls back to the server's local calendar date.
    let date = qp.date ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      const now = new Date();
      date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    }
    const perYear = Math.min(Math.max(Number.parseInt(qp.perYear ?? "60", 10) || 60, 1), 200);
    return queryGalleryMemories(request.user!.id, libIds, date, perYear);
  });

  // Suggested memories: event/trip moments clustered from the viewer's accessible
  // items, returned as PROPOSED slideshows (nothing persisted until saved). Distinct
  // from /memories above, which is the date-only "On this day" anniversary feed.
  app.get("/api/library/gallery/memories/suggestions", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { libraryIds?: string; limit?: string };
    const libIds = resolveGalleryScopeLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "12", 10) || 12, 1), 40);
    return { suggestions: suggestGalleryMemories(libIds, { limit }) };
  });

  // "2026 in review": a year's best, proposed as a slideshow. Same contract as the
  // memory suggestions above — nothing is persisted until the user saves one — but
  // built from the household's likes rather than from time clustering, and
  // spread across the calendar so the film covers the year (see year-review.ts).
  //
  // `year` picks one; without it the most recent few years with material are
  // returned, newest first. Each one is a real selection pass, so the count stays
  // small by default.
  app.get("/api/library/gallery/year-review", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { libraryIds?: string; year?: string; limit?: string; maxItems?: string };
    const libIds = resolveGalleryScopeLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const maxItems = qp.maxItems ? Math.min(Math.max(Number.parseInt(qp.maxItems, 10) || 60, 12), 200) : undefined;

    const year = Number.parseInt(qp.year ?? "", 10);
    if (Number.isFinite(year) && year > 1800 && year < 3000) {
      const review = buildYearReview(libIds, request.user!.id, year, { maxItems });
      return { suggestions: review ? [review] : [] };
    }
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "3", 10) || 3, 1), 12);
    return { suggestions: suggestYearReviews(libIds, request.user!.id, { limit, maxItems }) };
  });

  // Bulk asset lookup by ids (the suggestion-preview grid fetches a montage's
  // thumbnails in one round trip). Access-filtered per the caller's libraries;
  // inaccessible/unknown ids are silently omitted (bulk contract). Results keep the
  // requested order.
  const lookupSchema = z.object({ itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(100) });
  app.post("/api/library/gallery/assets/lookup", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(lookupSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid item ids", details: parsed.error });
    }
    const libIds = resolveGalleryScopeLibraryIds(request.user!);
    return reply.send({ assets: getGalleryAssets(request.user!.id, libIds, parsed.data.itemIds) });
  });

  app.get("/api/library/gallery/facets", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { libraryIds?: string };
    const libIds = resolveGalleryScopeLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    return galleryFacets(libIds);
  });

  // Geotagged assets for the map view. Same scope/kind filtering as the timeline;
  // capped so a huge library can't return an unbounded marker payload.
  app.get("/api/library/gallery/map", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { libraryIds?: string; kinds?: string };
    const libIds = resolveGalleryScopeLibraryIds(request.user!, parseLibraryIds(qp.libraryIds));
    const kinds = (qp.kinds ?? "").split(",").map((k) => k.trim()).filter((k) => k === "photo" || k === "video" || k === "audio");
    return queryGalleryMapPoints(libIds, { kinds, limit: 5000 });
  });

  app.get("/api/library/gallery/assets/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const libIds = resolveGalleryScopeLibraryIds(user);
    let asset = getGalleryAsset(user.id, libIds, id);
    if (!asset) {
      // Not in a library the viewer can browse — allow it only if the photo was
      // shared directly with them (the "Shared with me" path opens this route).
      const library = getLibraryForBook(id);
      if (library && library.type === "gallery" && canUserAccessBook(id, library, user.id, user.role, "gallery")) {
        asset = getGalleryAssetUnscoped(user.id, id);
      }
    }
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }
    return reply.send({ asset });
  });

  // Lightweight view ping fired by the lightbox as the visitor browses — logged at
  // most once per user+asset per dedup window (see logActivityOnce), so paging back
  // and forth through a set doesn't flood activity_logs.
  app.post("/api/library/gallery/assets/:id/viewed", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const libIds = resolveGalleryScopeLibraryIds(user);
    let asset = getGalleryAsset(user.id, libIds, id);
    if (!asset) {
      const library = getLibraryForBook(id);
      if (library && library.type === "gallery" && canUserAccessBook(id, library, user.id, user.role, "gallery")) {
        asset = getGalleryAssetUnscoped(user.id, id);
      }
    }
    if (!asset) {
      return reply.code(404).send({ error: "Asset not found" });
    }
    logActivityOnce({
      event: "library.gallery.viewed",
      actorUserId: user.id,
      targetType: "gallery",
      targetId: id,
      detail: `Viewed ${asset.kind} "${asset.title}".`,
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
  });

  // Manual metadata edit: title/caption, description, date taken, tags, location.
  // Requires write access to the asset's library; protects the fields from future
  // rescans. `gps` omitted = leave the location untouched, null = remove it.
  const editSchema = z.object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(5000).nullable().optional(),
    takenAt: z.iso.datetime().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional()
  });

  app.patch("/api/library/gallery/assets/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Write access required to edit this item." });
    }

    const parsed = parseBody(editSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid details", details: parsed.error });
    }

    const ok = updateGalleryAsset(id, {
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      takenAt: parsed.data.takenAt ?? null,
      tags: parsed.data.tags ?? [],
      gps: parsed.data.gps
    });
    if (!ok) {
      return reply.code(404).send({ error: "Asset not found" });
    }

    logActivity({
      event: "library.gallery.edited",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: `Edited gallery item "${parsed.data.title}".`,
      ipAddress: request.ip
    });

    return reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id) });
  });

  // Place lookup behind the location picker's search box. Rate-limited well below
  // the global ceiling: every hit is an outbound request to a free community
  // service, and their policy is one request a second.
  app.get(
    "/api/library/gallery/geocode",
    { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const q = ((request.query as { q?: string }).q ?? "").trim();
      if (q.length < 2 || q.length > 200) {
        return reply.code(400).send({ error: "Type at least two characters to search for a place." });
      }
      try {
        return reply.send({ results: await searchPlaces(q) });
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : "The place lookup failed." });
      }
    }
  );

  // Bulk "set date taken / location" from the multi-select bar — one request for
  // the whole selection, mirroring bulk-save/bulk-delete. Permission is checked
  // per item's library; items the user can't write are counted, not fatal. Each
  // field is optional but at least one must be sent (an empty edit is a mistake,
  // not a no-op worth 200 writes).
  // `takenAt` sets one instant on everything; `shiftMinutes` moves each item's own
  // date instead (bounded to ±10 years, enough for any timezone/clock slip).
  const bulkPlaceTimeSchema = z
    .object({
      ids: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
      takenAt: z.iso.datetime().optional(),
      shiftMinutes: z.number().int().min(-5_256_000).max(5_256_000).refine((v) => v !== 0).optional(),
      gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional()
    })
    .refine((body) => body.takenAt === undefined || body.shiftMinutes === undefined, {
      message: "Set a date or shift by an offset, not both."
    })
    .refine((body) => body.takenAt !== undefined || body.shiftMinutes !== undefined || body.gps !== undefined, {
      message: "Send a date, an offset, a location, or a combination."
    });

  app.post("/api/library/gallery/assets/bulk-place-time", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(bulkPlaceTimeSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid details", details: parsed.error });
    }

    const user = request.user!;
    const allowed: string[] = [];
    let forbidden = 0;
    for (const id of parsed.data.ids) {
      const lib = getLibraryForBook(id);
      if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
        forbidden += 1;
        continue;
      }
      allowed.push(id);
    }

    const { updated, noDate } = setGalleryPlaceAndTime(allowed, {
      takenAt: parsed.data.takenAt,
      shiftMinutes: parsed.data.shiftMinutes,
      gps: parsed.data.gps
    });

    if (updated > 0) {
      const fields = [
        parsed.data.takenAt ? "date taken" : null,
        parsed.data.shiftMinutes ? `date taken (shifted ${parsed.data.shiftMinutes} min)` : null,
        parsed.data.gps ? "location" : null
      ].filter(Boolean).join(" and ");
      logActivity({
        event: "library.gallery.edited",
        actorUserId: user.id,
        targetType: "library_item",
        targetId: allowed[0],
        detail: `Set the ${fields} on ${updated} gallery item${updated === 1 ? "" : "s"}.`,
        ipAddress: request.ip
      });
    }

    return reply.send({ updated, forbidden, noDate });
  });

  // Bulk tagging from the multi-select bar — label a whole holiday in one go.
  // Add and remove rather than replace, so a photo keeps the tags it already
  // carries; both may travel in one request. Permission is checked per item's
  // library and items the user can't write are counted, not fatal.
  const bulkTagsSchema = z
    .object({
      ids: z.array(z.string().trim().min(1).max(64)).min(1).max(200),
      add: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
      remove: z.array(z.string().trim().min(1).max(80)).max(20).optional()
    })
    .refine((body) => (body.add?.length ?? 0) > 0 || (body.remove?.length ?? 0) > 0, {
      message: "Send at least one tag to add or remove."
    });

  app.post("/api/library/gallery/assets/bulk-tags", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(bulkTagsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid tags", details: parsed.error });
    }

    const user = request.user!;
    const allowed: string[] = [];
    let forbidden = 0;
    for (const id of parsed.data.ids) {
      const lib = getLibraryForBook(id);
      if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
        forbidden += 1;
        continue;
      }
      allowed.push(id);
    }

    const { updated } = changeGalleryTags(allowed, { add: parsed.data.add, remove: parsed.data.remove });

    if (updated > 0) {
      const what = [
        parsed.data.add?.length ? `added ${parsed.data.add.join(", ")}` : null,
        parsed.data.remove?.length ? `removed ${parsed.data.remove.join(", ")}` : null
      ].filter(Boolean).join(" and ");
      logActivity({
        event: "library.gallery.edited",
        actorUserId: user.id,
        targetType: "library_item",
        targetId: allowed[0],
        detail: `Tagged ${updated} gallery item${updated === 1 ? "" : "s"} (${what}).`,
        ipAddress: request.ip
      });
    }

    return reply.send({ updated, forbidden });
  });

  // Rotate a photo or video 90° clockwise/counter-clockwise. Stores the angle and
  // bakes it into the regenerated thumbnails (a video's poster frame included);
  // the original file is untouched — the client rotates video playback via CSS.
  const rotateSchema = z.object({ direction: z.enum(["cw", "ccw"]) });

  app.post("/api/library/gallery/assets/:id/rotate", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || lib.type !== "gallery" || !canUserWriteLibrary(lib, user.id, user.role)) {
      return reply.code(403).send({ error: "Write access required to edit this item." });
    }

    const parsed = parseBody(rotateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid rotation", details: parsed.error });
    }

    const result = await rotateGalleryAsset(id, parsed.data.direction);
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }

    logActivity({
      event: "library.gallery.rotated",
      actorUserId: user.id,
      targetType: "library_item",
      targetId: id,
      detail: `Rotated gallery ${result.kind} ${parsed.data.direction === "cw" ? "right" : "left"} (now ${result.rotation}°).`,
      ipAddress: request.ip
    });

    return reply.send({ updated: true, asset: getGalleryAsset(user.id, [lib.id], id) });
  });
}
