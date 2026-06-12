import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { searchAllMetadataProviders, searchMetadataProvider, type MetadataProvider } from "./providers/index.js";
import { rescanSingleBook, writeCoverImages } from "./scanner.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { canUserWriteLibrary, getLibraryForBook } from "../shared/library-access.js";
import { imageMimeType, coverImageExtensions, getBookCoverFolder, coverFilePathFromRelative, updateBookCover, applyMetadataCandidate, updateManualMetadata, getAudiobookBookDetail, metadataMatchSchema, coverSourceSchema, manualMetadataSchema } from "./book-helpers.js";

export function registerMetadataRoutes(app: FastifyInstance) {

  app.get("/api/library/books/:id/metadata-search", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const book = getAudiobookBookDetail(id);
    if (!book) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const query = request.query as { q?: string; author?: string; provider?: string };
    const searchQuery = (query.q || book.title).trim();
    const author = query.author?.trim() ?? "";
    const provider = (query.provider || "all") as MetadataProvider | "all";
    if (!["all", "itunes", "openlibrary", "fantlab", "librivox"].includes(provider)) {
      reply.code(400).send({ error: "Unsupported metadata provider" });
      return;
    }
    if (!searchQuery) {
      reply.code(400).send({ error: "Search query is required" });
      return;
    }

    const input = { query: searchQuery, author, limit: 8 };
    try {
      const candidates = provider === "all"
        ? await searchAllMetadataProviders(input)
        : await searchMetadataProvider(provider, input);
      reply.send({ candidates });
    } catch (err) {
      reply.code(502).send({ error: err instanceof Error ? err.message : "Metadata provider search failed" });
    }
  });


  app.post("/api/library/books/:id/metadata-match", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to edit metadata." });
      return;
    }

    const parsed = parseBody(metadataMatchSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid metadata match", details: parsed.error });
      return;
    }

    try {
      const book = await applyMetadataCandidate(
        id,
        { ...parsed.data.candidate, authors: parsed.data.candidate.authors ?? [] },
        parsed.data.updateDetails ?? true,
        parsed.data.updateCover ?? true
      );
      if (!book) {
        reply.code(404).send({ error: "Audiobook not found" });
        return;
      }

      reply.send({ updated: true, book });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to apply metadata" });
    }
  });


  app.patch("/api/library/books/:id/metadata", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to edit metadata." });
      return;
    }

    const parsed = parseBody(manualMetadataSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid metadata details", details: parsed.error });
      return;
    }

    const book = updateManualMetadata(id, {
      ...parsed.data,
      authors: parsed.data.authors ?? [],
      narrators: parsed.data.narrators ?? [],
      tags: parsed.data.tags ?? []
    });
    if (!book) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    reply.send({ updated: true, book });
  });


  app.get("/api/library/books/:id/cover-candidates", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const context = getBookCoverFolder(id);
    if (!context) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const candidates = fs.readdirSync(context.folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && coverImageExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => {
        const filePath = path.join(context.folderPath, entry.name);
        const stat = fs.statSync(filePath);
        const relativePath = normaliseRelativePath(path.relative(context.folderPath, filePath));
        return {
          name: entry.name,
          relativePath,
          size: stat.size,
          previewUrl: `/api/library/books/${id}/cover-candidate?path=${encodeURIComponent(relativePath)}`
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

    reply.send({ covers: candidates });
  });


  app.get("/api/library/books/:id/cover-candidate", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const relativePath = String((request.query as { path?: string }).path ?? "");
    const filePath = coverFilePathFromRelative(id, relativePath);
    if (!filePath) {
      reply.code(404).send({ error: "Cover file not found" });
      return;
    }

    const buffer = await fs.promises.readFile(filePath);
    reply
      .type(imageMimeType(filePath))
      .header("Content-Length", buffer.byteLength)
      .header("Cache-Control", "private, max-age=300")
      .send(buffer);
  });


  app.post("/api/library/books/:id/cover", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to change covers." });
      return;
    }

    const parsed = parseBody(coverSourceSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid cover selection", details: parsed.error });
      return;
    }

    const filePath = coverFilePathFromRelative(id, parsed.data.relativePath);
    if (!filePath) {
      reply.code(404).send({ error: "Cover file not found" });
      return;
    }

    try {
      const coverStorageKey = await writeCoverImages(lib.id, id, filePath);
      const book = updateBookCover(id, coverStorageKey);
      reply.send({ updated: true, book });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to apply cover" });
    }
  });


  app.put("/api/library/books/:id/cover", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to change covers." });
      return;
    }

    const existing = db.prepare("SELECT id FROM books WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!existing) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const contentType = request.headers["content-type"]?.split(";")[0]?.toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      reply.code(415).send({ error: "Upload a JPEG, PNG, or WebP image." });
      return;
    }

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      reply.code(400).send({ error: "Cover image is required." });
      return;
    }
    if (body.byteLength > 10 * 1024 * 1024) {
      reply.code(400).send({ error: "Cover image is too large." });
      return;
    }

    try {
      const coverStorageKey = await writeCoverImages(lib.id, id, body);
      const book = updateBookCover(id, coverStorageKey);
      reply.send({ updated: true, book });
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to upload cover" });
    }
  });


  app.post("/api/library/books/:id/metadata-reset", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const lib = getLibraryForBook(id);
    if (!lib || !canUserWriteLibrary(lib, user.id, user.role)) {
      reply.code(403).send({ error: "Write access required to reset metadata." });
      return;
    }

    const existing = db.prepare("SELECT id FROM books WHERE id = ? AND deleted_at IS NULL").get(id);
    if (!existing) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    db.prepare("UPDATE book_metadata SET source = 'scan', updated_at = CURRENT_TIMESTAMP WHERE book_id = ?").run(id);

    try {
      await rescanSingleBook(id);
    } catch {
      // rescan best-effort; metadata source is already reset
    }

    const book = getAudiobookBookDetail(id);
    reply.send({ reset: true, book });
  });
}
