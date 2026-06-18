import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { receiveUploadBatch, UploadError } from "../../uploads/index.js";
import { can, parsePolicy } from "../../../core/permissions.js";
import { canUserAccessLibrary, libraryCapabilities, deleteLibraryAccess } from "../shared/library-access.js";
import { publicLibrary, type LibraryListRow } from "../shared/library-serializer.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import { coreLibraryCreateSchema, coreLibraryUpdateSchema, createLibraryRecord, updateLibraryRecord } from "../shared/library-crud.js";
import { METADATA_SOURCE_IDS } from "../shared/metadata-sources.js";
import { validateLibrarySource, LibrarySourceError } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "../shared/library-settings.js";
import { enqueueEbookScan, processEbookScanQueue, scanSingleEbookFile } from "./scanner.js";
import { resolveEbookScopeLibraryIds, queryEbookCatalog, ebookCatalogFacets } from "./catalog.js";

// Each uploaded file becomes its own ebook, so this also bounds books-per-upload.
const MAX_EBOOK_UPLOAD_FILES = 100;

// Turn a client filename into a safe, collision-free name within the library root:
// strip path separators / control chars, refuse a leading dot (the scanner skips
// dot-entries, and ".upload-*" is reserved for staging), then disambiguate against
// existing files with " (2)", " (3)", … Returns null if nothing usable remains.
function uniqueEbookFileName(root: string, filename: string): string | null {
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
  while (fs.existsSync(path.join(root, candidate))) {
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
  }
  return candidate;
}

const EBOOK_LIBRARY_LIST_SQL = `
  SELECT
    libraries.*,
    COUNT(DISTINCT library_items.id) AS book_count,
    COUNT(document_files.id) AS file_count,
    COALESCE(SUM(COALESCE(document_files.size, 0)), 0) AS total_size_bytes
  FROM libraries
  LEFT JOIN library_items ON library_items.library_id = libraries.id AND library_items.deleted_at IS NULL
  LEFT JOIN document_files ON document_files.item_id = library_items.id AND document_files.status = 'available' AND document_files.deleted_at IS NULL
  WHERE libraries.type = 'ebook' %WHERE%
  GROUP BY libraries.id
  ORDER BY datetime(libraries.created_at) DESC
`;

export async function ebookRoutesPlugin(app: FastifyInstance) {
  app.post("/api/library/ebook-libraries", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseBody(coreLibraryCreateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid ebook library details", details: parsed.error });
      return;
    }

    const result = createLibraryRecord({
      type: "ebook",
      data: parsed.data,
      userId: request.user!.id,
      ip: request.ip
    });
    if ("error" in result) {
      reply.code(result.status).send({ error: result.error });
      return;
    }

    const jobId = enqueueEbookScan(result.libraryId);
    void processEbookScanQueue();

    reply.code(201).send({ library: { id: result.libraryId }, job: { id: jobId, type: "SCAN_EBOOK_LIBRARY" } });
  });

  app.get("/api/library/ebook-libraries", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(EBOOK_LIBRARY_LIST_SQL.replace("%WHERE%", "")).all() as LibraryListRow[];

    const manageAll = (request.query as { manage?: string }).manage != null && user.role === "admin";
    const visible = manageAll ? rows : rows.filter((row) => canUserAccessLibrary(row, user.id, user.role));
    return { libraries: visible.map((row) => publicLibrary(row, user.role === "admin", libraryCapabilities(row, user.id, user.role))) };
  });

  app.patch("/api/library/ebook-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;

    const parsed = parseBody(coreLibraryUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid library details", details: parsed.error });
      return;
    }

    const result = updateLibraryRecord({
      type: "ebook",
      id,
      data: parsed.data,
      userId: request.user!.id,
      ip: request.ip
    });
    if ("error" in result) {
      reply.code(result.status).send({ error: result.error });
      return;
    }

    const updated = db.prepare(EBOOK_LIBRARY_LIST_SQL.replace("%WHERE%", "AND libraries.id = ?")).get(id) as LibraryListRow;
    reply.send({ library: publicLibrary(updated, true, libraryCapabilities(updated, request.user!.id, request.user!.role)) });
  });

  app.get("/api/library/ebook-libraries/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = db.prepare("SELECT id FROM libraries WHERE id = ? AND type = 'ebook'")
      .get(id) as { id: string } | undefined;
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Ebook library not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT
        library_items.id,
        library_items.library_id,
        library_items.folder_path,
        library_items.status,
        library_items.discovered_at,
        library_items.updated_at,
        item_metadata.title,
        item_metadata.year_published,
        item_metadata.language,
        item_metadata.cover_storage_key,
        categories.key AS category_key,
        categories.name AS category_name,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        (SELECT format FROM document_files WHERE item_id = library_items.id AND status = 'available' LIMIT 1) AS format,
        (SELECT id FROM document_files WHERE item_id = library_items.id AND status = 'available' LIMIT 1) AS document_id,
        (SELECT COUNT(*) FROM document_files WHERE item_id = library_items.id AND status = 'available') AS file_count,
        (SELECT COALESCE(SUM(size), 0) FROM document_files WHERE item_id = library_items.id AND status = 'available') AS total_size,
        (SELECT reading_progress.percent_complete FROM reading_progress WHERE reading_progress.item_id = library_items.id AND reading_progress.user_id = ? ORDER BY datetime(reading_progress.updated_at) DESC LIMIT 1) AS progress_percent,
        (SELECT reading_progress.completed_at FROM reading_progress WHERE reading_progress.item_id = library_items.id AND reading_progress.user_id = ? ORDER BY datetime(reading_progress.updated_at) DESC LIMIT 1) AS progress_completed_at,
        (SELECT item_saves.id IS NOT NULL FROM item_saves WHERE item_saves.item_id = library_items.id AND item_saves.user_id = ? LIMIT 1) AS saved
      FROM library_items
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN item_categories ic ON ic.item_id = library_items.id AND ic.is_primary = 1
      LEFT JOIN categories ON categories.id = ic.category_id
      LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
      LEFT JOIN people AS authors ON authors.id = item_people.person_id
      WHERE library_items.library_id = ? AND library_items.deleted_at IS NULL
      GROUP BY library_items.id
      ORDER BY COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) COLLATE NOCASE
    `).all(user.id, user.id, user.id, id) as {
      id: string; library_id: string; folder_path: string; status: string; discovered_at: string; updated_at: string;
      title: string | null; year_published: number | null; language: string | null;
      cover_storage_key: string | null; category_key: string | null; category_name: string | null;
      author_names: string | null; format: string | null; document_id: string | null; file_count: number; total_size: number;
      progress_percent: number | null; progress_completed_at: string | null; saved: number | null;
    }[];

    const tagsFor = db.prepare(`
      SELECT tags.display_name AS name FROM taggables
      JOIN tags ON tags.id = taggables.tag_id
      WHERE taggables.entity_type = 'library_item' AND taggables.entity_id = ?
      ORDER BY tags.display_name COLLATE NOCASE
    `);

    return {
      books: rows.map((row) => {
        const coverUrl = row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null;
        return {
          id: row.id,
          libraryId: row.library_id,
          folderPath: row.folder_path,
          status: row.status,
          title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
          series: null,
          seriesPosition: null,
          authors: row.author_names ? row.author_names.split(",").map((n) => n.trim()).filter(Boolean) : [],
          narrators: [],
          category: row.category_key && row.category_name ? { key: row.category_key, name: row.category_name } : null,
          tags: (tagsFor.all(row.id) as { name: string }[]).map((t) => t.name),
          language: row.language,
          format: row.format,
          documentId: row.document_id,
          fileCount: row.file_count,
          totalSize: row.total_size,
          durationSeconds: null,
          yearPublished: row.year_published,
          coverUrl,
          coverLargeUrl: coverUrl ? coverUrl.replace("-cover.webp", "-cover-large.webp") : null,
          publisher: null,
          asin: null,
          progress: {
            percentComplete: row.progress_percent,
            completedAt: row.progress_completed_at
          },
          saved: Boolean(row.saved),
          discoveredAt: row.discovered_at,
          updatedAt: row.updated_at
        };
      })
    };
  });

  // Upload ebooks: every file in the multipart request becomes its OWN book (one
  // file = one ebook, unlike audiobooks where a folder of tracks is one book). Files
  // stream into a hidden ".upload-*" staging folder first, then each is moved into the
  // library root under a safe, unique name and cataloged immediately.
  app.post("/api/library/ebook-libraries/:id/books/upload", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const user = request.user!;

    const library = db.prepare(
      "SELECT id, name, source_path, settings_json, policy_json FROM libraries WHERE id = ? AND type = 'ebook'"
    ).get(libraryId) as { id: string; name: string; source_path: string; settings_json: string; policy_json: string } | undefined;
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Ebook library not found" });
      return;
    }

    const policy = parsePolicy(library.policy_json);
    if (!can(user, { objectType: "library", objectId: library.id, policy }, "upload")) {
      reply.code(403).send({ error: "Uploading is not allowed in this library." });
      return;
    }

    let root: string;
    try {
      root = validateLibrarySource(library.source_path);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Library source folder is unavailable." });
      return;
    }

    const settings = normalizeLibrarySettings("ebook", library.settings_json);
    const maxBytes = policy.maxUploadMB != null ? policy.maxUploadMB * 1024 * 1024 : null;
    const stagingDir = path.join(root, `.upload-${nanoid(10)}`);

    let received;
    try {
      received = await receiveUploadBatch(
        request,
        { accept: uploadAcceptExtensions(settings), maxBytes },
        stagingDir,
        MAX_EBOOK_UPLOAD_FILES
      );
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const status = err instanceof UploadError ? err.statusCode : 400;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Upload failed" });
      return;
    }

    // Each file moves into the library root under a unique name, then is cataloged
    // on its own. Files already in place stay even if a later one fails.
    const createdIds: string[] = [];
    let totalBytes = 0;
    try {
      for (const file of received) {
        const finalName = uniqueEbookFileName(root, file.filename);
        if (!finalName) { fs.rmSync(file.tmpPath, { force: true }); continue; }
        const finalPath = path.join(root, finalName);
        fs.renameSync(file.tmpPath, finalPath);
        const relativePath = normaliseRelativePath(path.relative(root, finalPath));
        const bookId = await scanSingleEbookFile(library.id, relativePath);
        if (bookId) { createdIds.push(bookId); totalBytes += file.sizeBytes; }
      }
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : "Could not store the uploaded files." });
      return;
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    if (createdIds.length === 0) {
      reply.code(400).send({ error: "No ebooks were added from the upload." });
      return;
    }

    logActivity({
      event: "library.ebook.book_uploaded",
      actorUserId: user.id,
      targetType: "library",
      targetId: library.id,
      detail: `Uploaded ${createdIds.length} ebook${createdIds.length === 1 ? "" : "s"} (${totalBytes} bytes) to library "${library.name}".`,
      ipAddress: request.ip
    });

    reply.code(201).send({ uploaded: createdIds.length });
  });

  // Paged, server-side searched/sorted/filtered ebook catalog (mirrors the
  // audiobook catalog). scope = all (every accessible ebook library) | library.
  const ebookCatalogSchema = z.object({
    scope: z.enum(["all", "library"]).default("all"),
    libraryId: z.string().trim().min(1).optional(),
    q: z.string().trim().max(200).default(""),
    sort: z.enum(["title", "title_desc", "recent", "author"]).default("title"),
    limit: z.number().int().min(1).max(200).default(48),
    offset: z.number().int().min(0).default(0),
    filters: z.object({
      authors: z.array(z.string()).default([]),
      categories: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([]),
      status: z.array(z.string()).default([])
    }).default({ authors: [], categories: [], tags: [], languages: [], status: [] })
  });

  app.post("/api/library/ebooks/catalog", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(ebookCatalogSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid catalog query", details: parsed.error });
      return;
    }
    const p = parsed.data;
    const f = p.filters ?? {};
    const libIds = resolveEbookScopeLibraryIds(request.user!, p.scope ?? "all", p.libraryId);
    reply.send(queryEbookCatalog(request.user!.id, libIds, {
      q: p.q ?? "",
      sort: p.sort ?? "title",
      limit: p.limit ?? 48,
      offset: p.offset ?? 0,
      // Ebooks ignore narrators/series/durations; the engine treats them as empty.
      filters: {
        authors: f.authors ?? [],
        narrators: [],
        categories: f.categories ?? [],
        tags: f.tags ?? [],
        series: [],
        languages: f.languages ?? [],
        status: f.status ?? [],
        durations: []
      }
    }));
  });

  app.get("/api/library/ebooks/facets", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { scope?: string; libraryId?: string };
    const scope = qp.scope === "library" ? qp.scope : "all";
    const libIds = resolveEbookScopeLibraryIds(request.user!, scope, qp.libraryId);
    return ebookCatalogFacets(libIds);
  });

  const rescanOptionsSchema = z.object({
    // One-shot override of the library's persisted scan_sources for this run only.
    sources: z.array(z.object({
      id: z.enum(METADATA_SOURCE_IDS),
      enabled: z.boolean()
    })).max(20).optional()
  });

  app.post("/api/library/ebook-libraries/:id/rescan", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'ebook'")
      .get(id) as { id: string; source_path: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Ebook library not found" });
      return;
    }

    const parsed = parseBody(rescanOptionsSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
      return;
    }

    // Catch a missing/inaccessible source folder now, so the user gets an immediate
    // error instead of a library stuck on "scanning" while the job retries.
    try {
      validateLibrarySource(exists.source_path);
    } catch (err) {
      if (err instanceof LibrarySourceError) {
        reply.code(422).send({ error: err.message });
        return;
      }
      throw err;
    }

    const jobId = enqueueEbookScan(id, parsed.data);
    void processEbookScanQueue();
    logActivity({
      event: "library.ebook.rescan",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: "Queued an ebook library rescan.",
      ipAddress: request.ip
    });
    reply.send({ job: { id: jobId, type: "SCAN_EBOOK_LIBRARY" } });
  });

  app.delete("/api/library/ebook-libraries/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const exists = db.prepare("SELECT id, name FROM libraries WHERE id = ? AND type = 'ebook'")
      .get(id) as { id: string; name: string } | undefined;
    if (!exists) {
      reply.code(404).send({ error: "Ebook library not found" });
      return;
    }

    db.transaction(() => {
      db.prepare("DELETE FROM taggables WHERE entity_type = 'library_item' AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)").run(id);
      deleteSharesForLibrary("ebook", id);
      deleteCollectionItemsForLibrary("ebook", id);
      deleteLibraryAccess(id);
      db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
    })();

    logActivity({
      event: "library.ebook.deleted",
      actorUserId: request.user!.id,
      targetType: "library",
      targetId: id,
      detail: `Deleted ebook library "${exists.name}". Files on disk were not removed.`,
      ipAddress: request.ip
    });
    reply.send({ deleted: true });
  });
}
