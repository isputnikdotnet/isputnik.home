import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db, logActivity } from "../../../db.js";
import { pathIsInside } from "./storage-roots.js";
import { canUserAccessBook, canUserDownloadBook } from "./library-access.js";
import { mediaKind } from "./library-types.js";
import type { DocumentFileRow, ItemMetadataRow, LibraryRow } from "../../../db/rows.js";

/**
 * Pipe a file to a hijacked reply, closing the read stream when the response ends.
 *
 * Every media route here serves seekable files, which means clients abandon requests
 * constantly: a <video> scrubs by opening ranges and dropping them, and leaving a
 * page drops whatever was still loading. `pipe()` does not tear the source down when
 * the destination closes early, so each abandoned request leaves a descriptor open
 * until the garbage collector happens to reach it. Tying it to the response instead
 * makes the release deterministic.
 *
 * This is hygiene, not a fix for a known failure. In particular it does NOT affect
 * whether a file can be renamed, moved, or deleted afterwards: Node opens files with
 * FILE_SHARE_DELETE, so an in-flight read never blocked that, on Windows or anywhere
 * else. (Measured, after a render's EPERM was wrongly blamed on it — see
 * swapRenderIntoPlace in slideshow-render.ts for what actually causes those.)
 */
export function pipeFileToReply(
  reply: FastifyReply,
  filePath: string,
  options?: { start: number; end: number }
): void {
  const stream = fs.createReadStream(filePath, options);
  reply.raw.on("close", () => stream.destroy());
  // A read error after the headers are out cannot become a status code — the only
  // honest signal left is to break the connection so the client sees a short read.
  stream.on("error", () => reply.raw.destroy());
  stream.pipe(reply.raw);
}

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

export type ByteRange = NonNullable<ReturnType<typeof parseRangeHeader>>;

/**
 * Validators for a file on disk, so a browser can revalidate its cached copy
 * instead of downloading it again. The file routes send `private, no-cache`,
 * which already means "ask before reusing" — but without a validator there was
 * nothing to ask with, so every reopen of a photo, a PDF or a seek back in a
 * video was a full transfer.
 *
 * Size + mtime identify the content well enough for a library that edits by
 * rewriting files (rotate, replace, remux all bump mtime), and are free: the
 * routes stat the file anyway. Treated as a strong ETag, since If-Range needs one.
 */
export function fileValidators(stat: fs.Stats): { ETag: string; "Last-Modified": string } {
  return {
    ETag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
    "Last-Modified": stat.mtime.toUTCString()
  };
}

/**
 * True when the request's If-None-Match (or, failing that, If-Modified-Since)
 * says the client already holds this exact file. Call it only AFTER the route's
 * access check: a 304 is still an answer, and a revoked share or a lost library
 * grant must get its 404 instead.
 */
export function clientHasCurrentCopy(request: FastifyRequest, stat: fs.Stats): boolean {
  const { ETag } = fileValidators(stat);
  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch) {
    // Weak comparison is right for If-None-Match (RFC 9110 §13.1.2).
    return ifNoneMatch.split(",").some((tag) => {
      const t = tag.trim();
      return t === "*" || t.replace(/^W\//, "") === ETag;
    });
  }
  const ifModifiedSince = request.headers["if-modified-since"];
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates have whole seconds; the file's mtime has milliseconds.
    return !Number.isNaN(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

/**
 * Settle the conditional and range parts of a GET for a file: answers 304 when
 * the client's copy is current and 416 for an unsatisfiable range (both sent
 * here — the caller returns on null), otherwise returns the range to serve (null
 * = whole file) and the validator headers to send with it.
 *
 * An If-Range whose validator no longer matches drops the range, so a player
 * resuming a file that changed underneath it gets the new file whole instead of
 * a splice of old and new bytes.
 */
export function negotiateFileRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  stat: fs.Stats,
  cacheControl = "private, no-cache"
): { range: ByteRange | null; validators: ReturnType<typeof fileValidators> } | null {
  const validators = fileValidators(stat);
  if (clientHasCurrentCopy(request, stat)) {
    reply.code(304).headers({ ...validators, "Cache-Control": cacheControl }).send();
    return null;
  }

  let rangeHeader = request.headers["range"];
  const ifRange = request.headers["if-range"];
  if (rangeHeader && typeof ifRange === "string") {
    const stillSame = ifRange.startsWith("\"")
      ? ifRange === validators.ETag // strong comparison, as If-Range requires
      : Date.parse(ifRange) === Date.parse(validators["Last-Modified"]);
    if (!stillSame) rangeHeader = undefined;
  }

  const range = rangeHeader ? parseRangeHeader(rangeHeader, stat.size) : null;
  if (rangeHeader && !range) {
    reply.code(416).header("Content-Range", `bytes */${stat.size}`).send({ error: "Range not satisfiable" });
    return null;
  }
  return { range, validators };
}

type DocumentRow = Pick<DocumentFileRow, "relative_path" | "mime_type" | "status"> &
  Pick<LibraryRow, "source_path"> & {
    id: LibraryRow["id"]; // library id (aliased for canUserAccessBook)
    library_type: LibraryRow["type"]; // resolves the share module ("audiobook" | "ebook")
    item_title: ItemMetadataRow["title"] | null; // for the download audit detail
  };

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
      libraries.id AS id,
      libraries.type AS library_type,
      item_metadata.title AS item_title
    FROM document_files
    JOIN library_items ON library_items.id = document_files.item_id
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = document_files.item_id
    WHERE document_files.id = ?
      AND document_files.item_id = ?
      AND library_items.deleted_at IS NULL
  `).get(docId, itemId) as DocumentRow | undefined;

  if (!row || row.status !== "available") {
    reply.code(404).send({ error: "Document not found" });
    return;
  }

  const module = mediaKind(row.library_type);
  if (!canUserAccessBook(itemId, row, user.id, user.role, module)) {
    reply.code(404).send({ error: "Document not found" });
    return;
  }

  if (download && !canUserDownloadBook(itemId, row, user.id, user.role, module)) {
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
  const negotiated = negotiateFileRequest(request, reply, stat);
  if (!negotiated) return;
  const { range, validators } = negotiated;

  // Audit only real downloads (attachment), and only at the start of the transfer
  // so a ranged client fetching the file in chunks logs once, not per chunk.
  if (download && (!range || range.start === 0)) {
    const title = row.item_title ?? fileName;
    logActivity({
      event: `library.${module}.downloaded`,
      actorUserId: user.id,
      targetType: "book",
      targetId: itemId,
      detail: module === "ebook"
        ? `Downloaded ebook "${title}".`
        : `Downloaded document "${fileName}" from "${title}".`,
      ipAddress: request.ip
    });
  }

  reply.hijack();
  const baseHeaders = {
    "Content-Type": mimeType,
    "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    ...validators
  };
  if (range) {
    reply.raw.writeHead(206, { ...baseHeaders, "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`, "Content-Length": range.size });
    pipeFileToReply(reply, filePath, { start: range.start, end: range.end });
  } else {
    reply.raw.writeHead(200, { ...baseHeaders, "Content-Length": totalSize });
    pipeFileToReply(reply, filePath);
  }
}
