import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { rescanSingleBook } from "./scanner.js";
import { METADATA_SOURCE_IDS } from "../shared/metadata-sources.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { getAccessibleLibrary, canUserWriteLibrary, getLibraryForBook, canUserAccessBook, canUserDownloadBook, libraryCapabilities, getReadableDocument } from "../shared/library-access.js";
import { mediaKind } from "../shared/library-types.js";
import { getAudiobookBookDetail, progressUpdateSchema, bulkMetadataSchema, BULK_METADATA_FIELDS, applyBulkMetadata, BOOK_LIST_COLUMNS, BOOK_LIST_JOINS, mapBookListRow, type BookListRow } from "./book-helpers.js";
import { resolveScopeLibraryIds, queryCatalog, catalogFacets } from "./catalog.js";

const readingProgressSchema = z.object({
  documentId: z.string().trim().min(1),
  cfi: z.string().trim().min(1).max(2000),
  percentComplete: z.number().min(0).max(1).nullable().optional(),
  label: z.string().trim().max(300).nullable().optional()
});

const trackPlayedSchema = z.object({
  played: z.boolean()
});

export function registerBookRoutes(app: FastifyInstance) {

  app.get("/api/library/audiobook-libraries/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getAccessibleLibrary(id, user.id, user.role, "audiobook");
    if (!library) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    const books = db.prepare(`
      SELECT ${BOOK_LIST_COLUMNS}
      ${BOOK_LIST_JOINS}
      WHERE library_items.library_id = ?
        AND library_items.deleted_at IS NULL
      GROUP BY library_items.id
      ORDER BY COALESCE(item_metadata.sort_title, item_metadata.title, library_items.folder_path) COLLATE NOCASE
    `).all(user.id, user.id, id) as BookListRow[];

    return { books: books.map(mapBookListRow) };
  });

  // Paged, server-side searched/sorted/filtered catalog. Replaces loading every
  // book client-side. scope = all (every accessible library) | library.
  const catalogSchema = z.object({
    scope: z.enum(["all", "library"]).default("all"),
    libraryId: z.string().trim().min(1).optional(),
    q: z.string().trim().max(200).default(""),
    sort: z.enum(["title", "title_desc", "recent", "duration", "author", "series"]).default("title"),
    limit: z.number().int().min(1).max(200).default(48),
    offset: z.number().int().min(0).default(0),
    filters: z.object({
      authors: z.array(z.string()).default([]),
      narrators: z.array(z.string()).default([]),
      categories: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      series: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([]),
      status: z.array(z.string()).default([]),
      durations: z.array(z.string()).default([])
    }).default({ authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], status: [], durations: [] })
  });

  app.post("/api/library/audiobooks/catalog", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(catalogSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid catalog query", details: parsed.error });
      return;
    }
    const p = parsed.data;
    const f = p.filters ?? {};
    const libIds = resolveScopeLibraryIds(request.user!, p.scope ?? "all", p.libraryId);
    reply.send(queryCatalog(request.user!.id, libIds, {
      q: p.q ?? "",
      sort: p.sort ?? "title",
      limit: p.limit ?? 48,
      offset: p.offset ?? 0,
      filters: {
        authors: f.authors ?? [],
        narrators: f.narrators ?? [],
        categories: f.categories ?? [],
        tags: f.tags ?? [],
        series: f.series ?? [],
        languages: f.languages ?? [],
        status: f.status ?? [],
        durations: f.durations ?? []
      }
    }));
  });

  app.get("/api/library/audiobooks/facets", { preHandler: app.authenticate }, async (request) => {
    const qp = request.query as { scope?: string; libraryId?: string };
    const scope = qp.scope === "library" ? qp.scope : "all";
    const libIds = resolveScopeLibraryIds(request.user!, scope, qp.libraryId);
    return catalogFacets(libIds);
  });


  // Bulk overwrite metadata across selected books. Write access is checked per
  // book's library; books the user can't write are skipped and reported back.
  app.post("/api/library/books/bulk-metadata", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(bulkMetadataSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid bulk metadata", details: parsed.error });
      return;
    }

    const hasField = BULK_METADATA_FIELDS.some((field) => parsed.data[field] !== undefined);
    if (!hasField) {
      reply.code(400).send({ error: "Provide at least one field to overwrite." });
      return;
    }

    const user = request.user!;
    let updated = 0;
    let forbidden = 0;
    let missing = 0;
    for (const bookId of parsed.data.bookIds) {
      const lib = getLibraryForBook(bookId);
      if (!lib) { missing += 1; continue; }
      if (!canUserWriteLibrary(lib, user.id, user.role)) { forbidden += 1; continue; }
      if (applyBulkMetadata(bookId, parsed.data)) { updated += 1; } else { missing += 1; }
    }

    if (updated === 0 && forbidden > 0) {
      reply.code(403).send({ error: "Write access required to edit the selected books." });
      return;
    }

    reply.send({ updated, forbidden, missing });
  });

  app.get("/api/library/books/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    // Gate by book-level access (library role or an explicit share) — direct id
    // fetches were previously open to any signed-in user.
    const lib = getLibraryForBook(id);
    if (!lib || !canUserAccessBook(id, lib, user.id, user.role, mediaKind(lib.type))) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const book = getAudiobookBookDetail(id);
    if (!book) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    // Capability flags so the client can gate edit/download/share affordances.
    // Sharing requires the curate capability (see shares.ts); server still enforces.
    const caps = libraryCapabilities(lib, user.id, user.role);
    reply.send({
      book,
      capabilities: {
        canEdit: caps.canEdit,
        // Download also covers a user-share of this single book (no library role needed).
        canDownload: canUserDownloadBook(id, lib, user.id, user.role, mediaKind(lib.type)),
        canCurate: caps.canCurate,
        canShare: caps.canCurate,
        // Delete (move to Recycle Bin) needs manager+ on a managed library — same gate the
        // delete endpoint enforces. Drives the detail-page Delete affordance for every type.
        canDelete: caps.canDelete
      }
    });
  });


  app.get("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;

    const row = db.prepare(`
      SELECT current_file_id, position_seconds, percent_complete, completed_at
      FROM playback_progress
      WHERE item_id = ? AND user_id = ?
    `).get(bookId, userId) as {
      current_file_id: string | null;
      position_seconds: number;
      percent_complete: number | null;
      completed_at: string | null;
    } | undefined;

    reply.send({
      progress: row
        ? {
            fileId: row.current_file_id,
            positionSeconds: row.position_seconds,
            percentComplete: row.percent_complete,
            completedAt: row.completed_at
          }
        : null
    });
  });

  app.get("/api/library/books/:id/reading-progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const documentId = ((request.query as { documentId?: string }).documentId ?? "").trim();
    if (!documentId) {
      reply.code(400).send({ error: "Document id is required" });
      return;
    }
    const user = request.user!;
    if (!getReadableDocument(bookId, documentId, user)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }

    const row = db.prepare(`
      SELECT document_id, location AS cfi, percent_complete, label, updated_at, completed_at
      FROM reading_progress
      WHERE item_id = ? AND document_id = ? AND user_id = ?
    `).get(bookId, documentId, user.id) as {
      document_id: string;
      cfi: string;
      percent_complete: number | null;
      label: string | null;
      updated_at: string;
      completed_at: string | null;
    } | undefined;

    reply.send({
      progress: row
        ? {
            documentId: row.document_id,
            cfi: row.cfi,
            percentComplete: row.percent_complete,
            label: row.label,
            updatedAt: row.updated_at,
            completedAt: row.completed_at
          }
        : null
    });
  });

  app.patch("/api/library/books/:id/reading-progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const parsed = parseBody(readingProgressSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid reading progress update", details: parsed.error });
      return;
    }

    const user = request.user!;
    if (!getReadableDocument(bookId, parsed.data.documentId, user)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }

    const percentComplete = parsed.data.percentComplete ?? null;
    const completedAt = percentComplete != null && percentComplete >= 0.98 ? new Date().toISOString() : null;
    db.prepare(`
      INSERT INTO reading_progress (id, user_id, item_id, document_id, location, percent_complete, label, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
      ON CONFLICT(user_id, item_id, document_id) DO UPDATE SET
        location = excluded.location,
        percent_complete = excluded.percent_complete,
        label = excluded.label,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at = CASE WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at ELSE reading_progress.completed_at END
    `).run(nanoid(16), user.id, bookId, parsed.data.documentId, parsed.data.cfi, percentComplete, parsed.data.label ?? null, completedAt);

    reply.send({ updated: true });
  });

  app.delete("/api/library/books/:id/reading-progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const documentId = ((request.query as { documentId?: string }).documentId ?? "").trim();
    if (!documentId) {
      reply.code(400).send({ error: "Document id is required" });
      return;
    }
    const user = request.user!;
    if (!getReadableDocument(bookId, documentId, user)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }
    db.prepare("DELETE FROM reading_progress WHERE item_id = ? AND document_id = ? AND user_id = ?")
      .run(bookId, documentId, user.id);
    reply.send({ reset: true });
  });

  // Mark an ebook finished without opening it. Mirrors /progress/complete for
  // audiobooks. On an existing row this only flips percent/completed_at — the
  // saved reading position (cfi/label) is left intact so "finished" never erases
  // where the reader left off.
  app.post("/api/library/books/:id/reading-progress/complete", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const documentId = ((request.body as { documentId?: string } | undefined)?.documentId ?? "").trim();
    if (!documentId) {
      reply.code(400).send({ error: "Document id is required" });
      return;
    }
    const user = request.user!;
    if (!getReadableDocument(bookId, documentId, user)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }
    db.prepare(`
      INSERT INTO reading_progress (id, user_id, item_id, document_id, location, percent_complete, updated_at, completed_at)
      VALUES (?, ?, ?, ?, '', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(user_id, item_id, document_id) DO UPDATE SET
        percent_complete = 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(nanoid(16), user.id, bookId, documentId);
    reply.send({ completed: true });
  });


  app.patch("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const parsed = parseBody(progressUpdateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid progress update", details: parsed.error });
      return;
    }

    const { fileId, positionSeconds } = parsed.data;

    const cumulative = db.prepare(`
      SELECT COALESCE(SUM(bf.duration_seconds), 0) AS before_seconds
      FROM audio_files bf
      JOIN audio_files current_file ON current_file.id = ? AND current_file.item_id = ? AND current_file.item_id = bf.item_id
      WHERE bf.track_number < current_file.track_number
        AND bf.status = 'available'
    `).get(fileId, bookId) as { before_seconds: number } | undefined;

    const currentFile = db.prepare(`
      SELECT id, duration_seconds
      FROM audio_files
      WHERE id = ?
        AND item_id = ?
        AND status = 'available'
    `).get(fileId, bookId) as { id: string; duration_seconds: number | null } | undefined;
    if (!currentFile) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const totalDuration = (db.prepare("SELECT duration_seconds FROM audiobook_details WHERE item_id = ?").get(bookId) as { duration_seconds: number | null } | undefined)?.duration_seconds ?? null;

    const absoluteSeconds = (cumulative?.before_seconds ?? 0) + positionSeconds;
    const percentComplete = totalDuration ? Math.min(absoluteSeconds / totalDuration, 1) : null;

    // Auto-finish only when the FINAL track is (nearly) played through — not when a
    // forward jump parks the cursor deep in the book. A skip to the last track sits at
    // position 0 of that track, so it won't trip this; the 2% slack forgives credits/silence.
    const lastTrack = db.prepare(`
      SELECT id, duration_seconds
      FROM audio_files
      WHERE item_id = ? AND status = 'available'
      ORDER BY track_number DESC, relative_path COLLATE NOCASE DESC
      LIMIT 1
    `).get(bookId) as { id: string; duration_seconds: number | null } | undefined;
    const isComplete =
      lastTrack?.id === fileId &&
      lastTrack.duration_seconds != null &&
      lastTrack.duration_seconds > 0 &&
      positionSeconds >= lastTrack.duration_seconds * 0.98;

    db.prepare(`
      INSERT INTO playback_progress (id, user_id, item_id, current_file_id, position_seconds, duration_seconds, percent_complete, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        current_file_id = excluded.current_file_id,
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        percent_complete = excluded.percent_complete,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at = CASE WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at ELSE completed_at END
    `).run(
      nanoid(16),
      userId,
      bookId,
      fileId,
      positionSeconds,
      totalDuration,
      percentComplete,
      isComplete ? new Date().toISOString() : null
    );

    // Episodic libraries also track each track on its own, so skipping one never
    // touches the others. A track counts as played once ~98% of its OWN duration is
    // reached. (Linear libraries rely solely on the book-level cursor written above.)
    const settingsRow = db.prepare(`
      SELECT libraries.settings_json AS settings_json
      FROM library_items
      JOIN libraries ON libraries.id = library_items.library_id
      WHERE library_items.id = ?
    `).get(bookId) as { settings_json: string } | undefined;
    const isEpisodic = normalizeLibrarySettings("audiobook", settingsRow?.settings_json).progress_mode === "episodic";
    if (isEpisodic) {
      const trackDuration = currentFile.duration_seconds;
      const trackComplete = trackDuration != null && trackDuration > 0 && positionSeconds >= trackDuration * 0.98;
      db.prepare(`
        INSERT INTO track_progress (id, user_id, item_id, file_id, position_seconds, duration_seconds, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
        ON CONFLICT(user_id, file_id) DO UPDATE SET
          position_seconds = excluded.position_seconds,
          duration_seconds = excluded.duration_seconds,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          completed_at = CASE WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at ELSE track_progress.completed_at END
      `).run(
        nanoid(16),
        userId,
        bookId,
        fileId,
        positionSeconds,
        trackDuration,
        trackComplete ? new Date().toISOString() : null
      );
    }

    reply.send({ updated: true });
  });


  app.post("/api/library/books/:id/progress/complete", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const file = db.prepare(`
      SELECT id, duration_seconds
      FROM audio_files
      WHERE item_id = ?
        AND status = 'available'
      ORDER BY track_number DESC, relative_path COLLATE NOCASE DESC
      LIMIT 1
    `).get(bookId) as { id: string; duration_seconds: number | null } | undefined;

    if (!file) {
      reply.code(404).send({ error: "No audio files available" });
      return;
    }

    const totalDuration = (db.prepare("SELECT duration_seconds FROM audiobook_details WHERE item_id = ?").get(bookId) as { duration_seconds: number | null } | undefined)?.duration_seconds ?? null;
    db.prepare(`
      INSERT INTO playback_progress (id, user_id, item_id, current_file_id, position_seconds, duration_seconds, percent_complete, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        current_file_id = excluded.current_file_id,
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        percent_complete = 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(nanoid(16), userId, bookId, file.id, file.duration_seconds ?? totalDuration ?? 0, totalDuration);

    // In episodic libraries "finished" means every episode is played — mark them all,
    // not just the book-level cursor. (Linear libraries have no per-track state.)
    const settingsRow = db.prepare(`
      SELECT libraries.settings_json AS settings_json
      FROM library_items
      JOIN libraries ON libraries.id = library_items.library_id
      WHERE library_items.id = ?
    `).get(bookId) as { settings_json: string } | undefined;
    if (normalizeLibrarySettings("audiobook", settingsRow?.settings_json).progress_mode === "episodic") {
      db.prepare(`
        INSERT INTO track_progress (id, user_id, item_id, file_id, position_seconds, duration_seconds, updated_at, completed_at)
        SELECT lower(hex(randomblob(8))), ?, ?, bf.id, COALESCE(bf.duration_seconds, 0), bf.duration_seconds, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM audio_files bf
        WHERE bf.item_id = ? AND bf.status = 'available'
        ON CONFLICT(user_id, file_id) DO UPDATE SET
          position_seconds = excluded.position_seconds,
          duration_seconds = excluded.duration_seconds,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(userId, bookId, bookId);
    }

    reply.send({ updated: true });
  });


  app.delete("/api/library/books/:id/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    db.prepare("DELETE FROM playback_progress WHERE item_id = ? AND user_id = ?").run(bookId, userId);
    db.prepare("DELETE FROM track_progress WHERE item_id = ? AND user_id = ?").run(bookId, userId);
    reply.send({ reset: true });
  });


  // Per-track progress for episodic libraries — the user's played/position state for
  // every track of a show. Linear libraries return an empty list (they use /progress).
  app.get("/api/library/books/:id/tracks/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const bookId = (request.params as { id: string }).id;
    const userId = request.user!.id;
    const rows = db.prepare(`
      SELECT file_id, position_seconds, completed_at
      FROM track_progress
      WHERE user_id = ? AND item_id = ?
    `).all(userId, bookId) as { file_id: string; position_seconds: number; completed_at: string | null }[];
    reply.send({
      tracks: rows.map((row) => ({
        fileId: row.file_id,
        positionSeconds: row.position_seconds,
        completedAt: row.completed_at
      }))
    });
  });


  // Explicitly mark one track played / unplayed (the episode-list toggle). "Unplayed"
  // clears the row entirely, resetting position too.
  app.put("/api/library/books/:id/tracks/:fileId/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const { id: bookId, fileId } = request.params as { id: string; fileId: string };
    const userId = request.user!.id;
    const parsed = parseBody(trackPlayedSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid track update", details: parsed.error });
      return;
    }

    const file = db.prepare(`
      SELECT duration_seconds
      FROM audio_files
      WHERE id = ? AND item_id = ? AND status = 'available'
    `).get(fileId, bookId) as { duration_seconds: number | null } | undefined;
    if (!file) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    if (parsed.data.played) {
      db.prepare(`
        INSERT INTO track_progress (id, user_id, item_id, file_id, position_seconds, duration_seconds, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(user_id, file_id) DO UPDATE SET
          position_seconds = excluded.position_seconds,
          duration_seconds = excluded.duration_seconds,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(nanoid(16), userId, bookId, fileId, file.duration_seconds ?? 0, file.duration_seconds);
    } else {
      db.prepare("DELETE FROM track_progress WHERE user_id = ? AND file_id = ?").run(userId, fileId);
    }

    reply.send({ updated: true });
  });


  const rescanBookSchema = z.object({
    // One-shot override of the library's persisted scan_sources for this book only.
    sources: z.array(z.object({
      id: z.enum(METADATA_SOURCE_IDS),
      enabled: z.boolean()
    })).max(20).optional(),
    tagEncoding: z.enum(["windows-1251", "windows-1250", "windows-1252", "koi8-r"]).optional()
  });

  app.post("/api/library/books/:id/rescan", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to rescan." });
      return;
    }

    const parsed = parseBody(rescanBookSchema, request.body ?? {});
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid rescan options", details: parsed.error });
      return;
    }

    let result: string | null;
    try {
      result = await rescanSingleBook(id, parsed.data);
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Rescan failed" });
      return;
    }
    if (!result) {
      reply.code(404).send({ error: "Audiobook folder not found or has no audio files." });
      return;
    }

    const book = getAudiobookBookDetail(id);
    reply.send({ rescanned: true, book });
  });
}
