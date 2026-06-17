import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../../db.js";
import { pathIsInside } from "./storage-roots.js";
import { canUserAccessBook, canUserDownloadBook } from "./library-access.js";

// Parse a single-range `Range` header against the resource size. Returns null for
// a malformed or unsatisfiable range. Shared by the audio and document streamers.
export function parseRangeHeader(header: string, totalSize: number) {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

  if (isNaN(start) || isNaN(end) || start > end || end >= totalSize) return null;

  return { start, end, size: end - start + 1 };
}

interface DocumentRow {
  relative_path: string;
  mime_type: string | null;
  status: string;
  source_path: string;
  id: string; // library id (aliased for canUserAccessBook)
}

interface StreamOptions {
  itemId: string;
  docId: string;
  user: { id: string; role: string };
  // download=true streams as an attachment AND requires the library's download
  // capability; download=false serves inline (browser viewer) and needs only read
  // access. OPDS acquisition always downloads.
  download: boolean;
}

// Stream a document file (PDF/EPUB) for an item with range support, enforcing the
// same access/download checks regardless of how the caller authenticated (cookie
// session or OPDS token). Sends its own response — the route should `return` after.
export function streamDocumentFile(request: FastifyRequest, reply: FastifyReply, opts: StreamOptions): void {
  const { itemId, docId, user, download } = opts;

  const row = db.prepare(`
    SELECT
      document_files.relative_path,
      document_files.mime_type,
      document_files.status,
      libraries.source_path,
      libraries.id AS id
    FROM document_files
    JOIN library_items ON library_items.id = document_files.item_id
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE document_files.id = ?
      AND document_files.item_id = ?
      AND library_items.deleted_at IS NULL
  `).get(docId, itemId) as DocumentRow | undefined;

  if (!row || row.status !== "available") {
    reply.code(404).send({ error: "Document not found" });
    return;
  }

  if (!canUserAccessBook(itemId, row, user.id, user.role)) {
    reply.code(404).send({ error: "Document not found" });
    return;
  }

  if (download && !canUserDownloadBook(itemId, row, user.id, user.role)) {
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
  const disposition = download ? "attachment" : "inline";
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
}
