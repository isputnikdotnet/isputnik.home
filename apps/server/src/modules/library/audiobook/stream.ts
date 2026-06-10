import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import archiver from "archiver";
import { db } from "../../../db.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { canUserAccessBook, canUserDownloadBook } from "../shared/library-access.js";

function parseRangeHeader(header: string, totalSize: number) {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

  if (isNaN(start) || isNaN(end) || start > end || end >= totalSize) return null;

  return { start, end, size: end - start + 1 };
}

export async function audiobookStreamPlugin(app: FastifyInstance) {
  app.get("/api/library/books/:id/stream/:fileId", { preHandler: app.authenticate }, (request, reply) => {
    const { id, fileId } = request.params as { id: string; fileId: string };

    const row = db.prepare(`
      SELECT
        book_files.relative_path,
        book_files.mime_type,
        book_files.status,
        libraries.source_path,
        libraries.id AS id
      FROM book_files
      JOIN books ON books.id = book_files.book_id
      JOIN libraries ON libraries.id = books.library_id
      WHERE book_files.id = ?
        AND books.id = ?
        AND books.deleted_at IS NULL
    `).get(fileId, id) as {
      relative_path: string;
      mime_type: string | null;
      status: string;
      source_path: string;
      id: string;
    } | undefined;

    if (!row || row.status !== "available") {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const user = request.user!;
    if (!canUserAccessBook(id, row, user.id, user.role)) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const filePath = path.join(row.source_path, ...row.relative_path.split("/"));
    if (!pathIsInside(filePath, row.source_path) || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const mimeType = row.mime_type ?? "application/octet-stream";
    const rangeHeader = request.headers["range"];

    const range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;

    if (rangeHeader && !range) {
      reply.code(416).header("Content-Range", `bytes */${totalSize}`).send({ error: "Range not satisfiable" });
      return;
    }

    reply.hijack();
    if (range) {
      reply.raw.writeHead(206, {
        "Content-Type": mimeType,
        "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
        "Content-Length": range.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-cache"
      });
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(reply.raw);
    } else {
      reply.raw.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": totalSize,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-cache"
      });
      fs.createReadStream(filePath).pipe(reply.raw);
    }
  });

  app.get("/api/library/books/:id/download", { preHandler: app.authenticate }, (request, reply) => {
    const { id } = request.params as { id: string };

    const meta = db.prepare(`
      SELECT libraries.id AS library_id, libraries.source_path, book_metadata.title
      FROM books
      JOIN libraries ON libraries.id = books.library_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      WHERE books.id = ? AND books.deleted_at IS NULL
    `).get(id) as { library_id: string; source_path: string; title: string | null } | undefined;

    if (!meta) {
      reply.code(404).send({ error: "Book not found" });
      return;
    }

    const downloadUser = request.user!;
    const downloadLibrary = { id: meta.library_id };
    // View is not enough to download — require the Subscriber+ download capability
    // (or an explicit share). Distinguish "no access" (404) from "no download" (403).
    if (!canUserAccessBook(id, downloadLibrary, downloadUser.id, downloadUser.role)) {
      reply.code(404).send({ error: "Book not found" });
      return;
    }
    if (!canUserDownloadBook(id, downloadLibrary, downloadUser.id, downloadUser.role)) {
      reply.code(403).send({ error: "You don't have permission to download from this library." });
      return;
    }

    const files = db.prepare(`
      SELECT relative_path
      FROM book_files
      WHERE book_id = ? AND status = 'available'
      ORDER BY track_number, relative_path COLLATE NOCASE
    `).all(id) as { relative_path: string }[];

    if (files.length === 0) {
      reply.code(404).send({ error: "No audio files available" });
      return;
    }

    const safeTitle = (meta.title ?? id).replace(/[/\\?%*:|"<>]/g, "_").trim() || id;
    const zipName = `${safeTitle}.zip`;
    const asciiFilename = zipName.replace(/[^\x20-\x7E]/g, "_");
    const encodedFilename = encodeURIComponent(zipName);
    const archive = archiver("zip", { zlib: { level: 0 } });

    archive.on("error", (err) => {
      reply.raw.destroy(err);
    });

    // pipe must be set up before adding files
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
      "Cache-Control": "private, no-cache"
    });
    archive.pipe(reply.raw);

    for (const file of files) {
      const filePath = path.join(meta.source_path, ...file.relative_path.split("/"));
      if (pathIsInside(filePath, meta.source_path) && fs.existsSync(filePath)) {
        archive.file(filePath, { name: file.relative_path.split("/").pop() ?? path.basename(filePath) });
      }
    }

    archive.finalize();
  });

  // Serve a companion document (PDF/EPUB) for inline viewing or download. Range
  // support lets the browser's PDF viewer fetch pages on demand.
  app.get("/api/library/books/:id/documents/:docId", { preHandler: app.authenticate }, (request, reply) => {
    const { id, docId } = request.params as { id: string; docId: string };

    const row = db.prepare(`
      SELECT
        book_documents.relative_path,
        book_documents.mime_type,
        book_documents.status,
        libraries.source_path,
        libraries.id AS id
      FROM book_documents
      JOIN books ON books.id = book_documents.book_id
      JOIN libraries ON libraries.id = books.library_id
      WHERE book_documents.id = ?
        AND book_documents.book_id = ?
        AND books.deleted_at IS NULL
    `).get(docId, id) as {
      relative_path: string;
      mime_type: string | null;
      status: string;
      source_path: string;
      id: string;
    } | undefined;

    if (!row || row.status !== "available") {
      reply.code(404).send({ error: "Document not found" });
      return;
    }

    const user = request.user!;
    if (!canUserAccessBook(id, row, user.id, user.role)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }

    const wantsDownload = (request.query as { download?: string }).download != null;
    if (wantsDownload && !canUserDownloadBook(id, row, user.id, user.role)) {
      reply.code(403).send({ error: "You don't have permission to download from this library." });
      return;
    }

    const filePath = path.join(row.source_path, ...row.relative_path.split("/"));
    if (!pathIsInside(filePath, row.source_path) || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const mimeType = row.mime_type ?? "application/octet-stream";
    const fileName = row.relative_path.split("/").pop() ?? "document";
    const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_");
    const disposition = wantsDownload ? "attachment" : "inline";
    const rangeHeader = request.headers["range"];
    const range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;

    if (rangeHeader && !range) {
      reply.code(416).header("Content-Range", `bytes */${totalSize}`).send({ error: "Range not satisfiable" });
      return;
    }

    reply.hijack();
    const baseHeaders = {
      "Content-Type": mimeType,
      "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-cache"
    };
    if (range) {
      reply.raw.writeHead(206, { ...baseHeaders, "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`, "Content-Length": range.size });
      fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(reply.raw);
    } else {
      reply.raw.writeHead(200, { ...baseHeaders, "Content-Length": totalSize });
      fs.createReadStream(filePath).pipe(reply.raw);
    }
  });
}
