import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { z } from "zod";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { sortTitle } from "./scanner.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { getAccessibleLibrary, canUserCurateLibrary } from "../shared/library-access.js";

async function writeSeriesCover(libraryId: string, seriesId: string, source: Buffer) {
  const storageKey = thumbnailStorageKey(libraryId, seriesId, `${seriesId}-series-cover.webp`);
  const filePath = thumbnailAbsolutePath(storageKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await sharp(source).resize(300, 300, { fit: "cover" }).webp({ quality: 84 }).toFile(filePath);
  return storageKey;
}

// Series rows for one library, with a cover that falls back to the first book's
// cover. Shared by the audiobook and ebook library-scoped list endpoints.
function listSeriesForLibrary(libraryId: string) {
  const rows = db.prepare(`
    SELECT
      series.id,
      series.name,
      COUNT(books.id) AS book_count,
      COALESCE(
        series.cover_storage_key,
        (
          SELECT book_metadata.cover_storage_key
          FROM books b
          LEFT JOIN book_metadata ON book_metadata.book_id = b.id
          WHERE b.series_id = series.id AND b.deleted_at IS NULL
          ORDER BY b.series_position ASC
          LIMIT 1
        )
      ) AS cover_storage_key
    FROM series
    LEFT JOIN books ON books.series_id = series.id AND books.deleted_at IS NULL
    WHERE series.library_id = ?
    GROUP BY series.id
    ORDER BY series.name COLLATE NOCASE
  `).all(libraryId) as { id: string; name: string; book_count: number; cover_storage_key: string | null }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    bookCount: r.book_count,
    coverUrl: r.cover_storage_key ? `/api/library/covers/${r.cover_storage_key}` : null
  }));
}

// List + create series for a library of the given type. Series live in a single
// library (so they're single-type), but both audiobook and ebook libraries get the
// same shape — only the access type-guard and not-found message differ.
function registerLibrarySeriesRoutes(app: FastifyInstance, type: "audiobook" | "ebook") {
  const notFound = type === "ebook" ? "Ebook library not found" : "Audiobook library not found";

  app.get(`/api/library/${type}-libraries/:id/series`, { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getAccessibleLibrary(id, user.id, user.role, type);
    if (!library) {
      reply.code(404).send({ error: notFound });
      return;
    }
    reply.send({ series: listSeriesForLibrary(id) });
  });

  app.post(`/api/library/${type}-libraries/:id/series`, { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getAccessibleLibrary(id, user.id, user.role, type);
    if (!library || !canUserCurateLibrary(library, user.id, user.role)) {
      reply.code(403).send({ error: "Curator access required to manage series." });
      return;
    }

    const parsed = parseBody(z.object({
      name: z.string().trim().min(1).max(240),
      description: z.string().trim().max(10000).nullable().optional()
    }), request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Series name is required." });
      return;
    }

    const existing = db.prepare("SELECT id FROM series WHERE library_id = ? AND name = ?").get(id, parsed.data.name);
    if (existing) {
      reply.code(409).send({ error: "A series with this name already exists in this library." });
      return;
    }

    const seriesId = nanoid(16);
    db.prepare("INSERT INTO series (id, library_id, name, sort_name, description) VALUES (?, ?, ?, ?, ?)").run(
      seriesId, id, parsed.data.name, sortTitle(parsed.data.name), parsed.data.description ?? null
    );

    reply.code(201).send({ series: { id: seriesId, name: parsed.data.name, bookCount: 0, coverUrl: null } });
  });
}

export function registerSeriesRoutes(app: FastifyInstance) {

  app.get("/api/library/audiobook-libraries/:id/people", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const library = getAccessibleLibrary(id, user.id, user.role, "audiobook");
    if (!library) {
      reply.code(404).send({ error: "Audiobook library not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT name FROM authors WHERE library_id = ? ORDER BY name COLLATE NOCASE
    `).all(id) as { name: string }[];

    reply.send({ people: rows.map((r) => r.name) });
  });


  // Library-scoped list/create, registered for both library types. Ebook series
  // reuse the generic /api/library/series/:id* routes below.
  registerLibrarySeriesRoutes(app, "audiobook");
  registerLibrarySeriesRoutes(app, "ebook");


  app.get("/api/library/series/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const row = db.prepare(`
      SELECT series.id, series.name, series.description, series.cover_storage_key, series.library_id, libraries.name AS library_name
      FROM series
      JOIN libraries ON libraries.id = series.library_id
      WHERE series.id = ?
    `).get(id) as { id: string; name: string; description: string | null; cover_storage_key: string | null; library_id: string; library_name: string } | undefined;

    if (!row) {
      reply.code(404).send({ error: "Series not found" });
      return;
    }

    // A series id maps 1:1 to its library, so the `/series/:id*` routes resolve
    // access by the series' own library regardless of type (no "audiobook" filter).
    // That's what lets ebook-library series reuse these routes.
    const lib = getAccessibleLibrary(row.library_id, user.id, user.role);
    if (!lib) {
      reply.code(404).send({ error: "Series not found" });
      return;
    }

    const books = db.prepare(`
      SELECT
        books.id,
        books.series_position,
        COALESCE(book_metadata.title, books.folder_path) AS title,
        book_metadata.cover_storage_key,
        GROUP_CONCAT(authors.name ORDER BY book_authors.sort_order) AS author_names
      FROM books
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
      LEFT JOIN authors ON authors.id = book_authors.author_id
      WHERE books.series_id = ?
        AND books.deleted_at IS NULL
      GROUP BY books.id
      ORDER BY books.series_position ASC, title COLLATE NOCASE
    `).all(id) as { id: string; series_position: number | null; title: string; cover_storage_key: string | null; author_names: string | null }[];

    reply.send({
      series: {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
        libraryId: row.library_id,
        libraryName: row.library_name,
        books: books.map((b) => ({
          id: b.id,
          title: b.title,
          authors: b.author_names ? b.author_names.split(",").map((n) => n.trim()).filter(Boolean) : [],
          coverUrl: b.cover_storage_key ? `/api/library/covers/${b.cover_storage_key}` : null,
          seriesPosition: b.series_position
        }))
      }
    });
  });


  app.patch("/api/library/series/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const row = db.prepare("SELECT id, library_id FROM series WHERE id = ?").get(id) as { id: string; library_id: string } | undefined;
    if (!row) {
      reply.code(404).send({ error: "Series not found" });
      return;
    }

    const lib = getAccessibleLibrary(row.library_id, user.id, user.role);
    if (!lib || !canUserCurateLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Curator access required to manage series." });
      return;
    }

    const parsed = parseBody(z.object({
      name: z.string().trim().min(1).max(240),
      description: z.string().trim().max(10000).nullable().optional()
    }), request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Series name is required." });
      return;
    }

    db.prepare("UPDATE series SET name = ?, sort_name = ?, description = ? WHERE id = ?").run(
      parsed.data.name, sortTitle(parsed.data.name), parsed.data.description ?? null, id
    );

    reply.send({ updated: true });
  });


  app.post("/api/library/series/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const row = db.prepare("SELECT id, library_id FROM series WHERE id = ?").get(id) as { id: string; library_id: string } | undefined;
    if (!row) {
      reply.code(404).send({ error: "Series not found" });
      return;
    }

    const lib = getAccessibleLibrary(row.library_id, user.id, user.role);
    if (!lib || !canUserCurateLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Curator access required to manage series." });
      return;
    }

    const parsed = parseBody(
      z.object({ bookIds: z.array(z.string().min(1)).min(1) }),
      request.body
    );
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid books list." });
      return;
    }

    // Auto-append: new books get positions after the series' current highest,
    // in the order they were selected. Books already in this series are left
    // untouched; books from other series are moved in.
    const maxRow = db.prepare("SELECT COALESCE(MAX(series_position), 0) AS max_pos FROM books WHERE series_id = ?")
      .get(id) as { max_pos: number };
    let nextPos = maxRow.max_pos;
    let added = 0;
    let skipped = 0;

    db.transaction(() => {
      const update = db.prepare(`
        UPDATE books SET series_id = ?, series_position = ?, series_source = 'manual'
        WHERE id = ? AND library_id = ? AND deleted_at IS NULL
          AND (series_id IS NULL OR series_id != ?)
      `);
      for (const bookId of parsed.data.bookIds) {
        const candidatePos = nextPos + 1;
        const result = update.run(id, candidatePos, bookId, row.library_id, id);
        if (result.changes > 0) {
          nextPos = candidatePos;
          added += 1;
        } else {
          skipped += 1;
        }
      }
    })();

    reply.send({ added, skipped });
  });


  app.put("/api/library/series/:id/cover", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const row = db.prepare("SELECT id, library_id FROM series WHERE id = ?").get(id) as { id: string; library_id: string } | undefined;
    if (!row) {
      reply.code(404).send({ error: "Series not found" });
      return;
    }

    const lib = getAccessibleLibrary(row.library_id, user.id, user.role);
    if (!lib || !canUserCurateLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Curator access required to change covers." });
      return;
    }

    const contentType = request.headers["content-type"]?.split(";")[0]?.toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      reply.code(415).send({ error: "Upload a JPEG, PNG, or WebP image." });
      return;
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      reply.code(400).send({ error: "Image is required." });
      return;
    }
    if (body.byteLength > 10 * 1024 * 1024) {
      reply.code(400).send({ error: "Image is too large." });
      return;
    }

    try {
      const storageKey = await writeSeriesCover(row.library_id, id, body);
      db.prepare("UPDATE series SET cover_storage_key = ? WHERE id = ?").run(storageKey, id);
      reply.send({ updated: true, coverUrl: `/api/library/covers/${storageKey}?v=${Date.now()}` });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to save cover" });
    }
  });


  app.delete("/api/library/series/:id/cover", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const row = db.prepare("SELECT id, library_id, cover_storage_key FROM series WHERE id = ?")
      .get(id) as { id: string; library_id: string; cover_storage_key: string | null } | undefined;
    if (!row) {
      reply.code(404).send({ error: "Series not found" });
      return;
    }

    const lib = getAccessibleLibrary(row.library_id, user.id, user.role);
    if (!lib || !canUserCurateLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Curator access required to change covers." });
      return;
    }

    if (row.cover_storage_key) {
      try { fs.rmSync(thumbnailAbsolutePath(row.cover_storage_key), { force: true }); } catch { /* ignore */ }
    }
    db.prepare("UPDATE series SET cover_storage_key = NULL WHERE id = ?").run(id);
    reply.send({ deleted: true });
  });


  app.delete("/api/library/series/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const row = db.prepare("SELECT id, library_id FROM series WHERE id = ?").get(id) as { id: string; library_id: string } | undefined;
    if (!row) {
      reply.code(404).send({ error: "Series not found" });
      return;
    }

    const lib = getAccessibleLibrary(row.library_id, user.id, user.role);
    if (!lib || !canUserCurateLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Curator access required to manage series." });
      return;
    }

    db.transaction(() => {
      db.prepare("UPDATE books SET series_id = NULL, series_position = NULL, series_source = 'scan' WHERE series_id = ?").run(id);
      db.prepare("DELETE FROM series WHERE id = ?").run(id);
    })();

    reply.send({ deleted: true });
  });


  app.put("/api/library/series/:id/books", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const row = db.prepare("SELECT id, library_id FROM series WHERE id = ?").get(id) as { id: string; library_id: string } | undefined;
    if (!row) {
      reply.code(404).send({ error: "Series not found" });
      return;
    }

    const lib = getAccessibleLibrary(row.library_id, user.id, user.role);
    if (!lib || !canUserCurateLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Curator access required to manage series." });
      return;
    }

    const parsed = parseBody(
      z.object({ books: z.array(z.object({ bookId: z.string().min(1), position: z.number().nullable() })) }),
      request.body
    );
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid books list." });
      return;
    }

    const newBookIds = new Set(parsed.data.books.map((b) => b.bookId));

    db.transaction(() => {
      db.prepare("UPDATE books SET series_id = NULL, series_position = NULL, series_source = 'scan' WHERE series_id = ?").run(id);
      for (const { bookId, position } of parsed.data.books) {
        db.prepare("UPDATE books SET series_id = ?, series_position = ?, series_source = 'manual' WHERE id = ? AND library_id = ?")
          .run(id, position, bookId, row.library_id);
      }
    })();

    void newBookIds;
    reply.send({ updated: true });
  });
}
