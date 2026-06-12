import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import type { FastifyRequest } from "fastify";

// Generic, streaming file-upload primitive shared by every module that accepts
// uploads (backups today; library media, etc. later). The defining rule: the file
// is streamed straight to a temp file on disk and never buffered in memory, so a
// 600 MB audiobook costs the same memory as a 1 KB note. Each caller supplies its
// own policy (allowed extensions + max size); the route owns what happens to the
// temp file afterwards (validate, move into place) and final cleanup.
//
// @fastify/multipart is registered globally in index.ts; this just drives its
// request.file() stream with explicit, version-agnostic size enforcement.

export interface UploadPolicy {
  // Dotless, lowercase extensions, e.g. ["zip", "sqlite"]. Matched case-insensitively.
  accept: string[];
  // Hard cap in bytes, or null for no limit (enforced while streaming).
  maxBytes: number | null;
}

export interface ReceivedUpload {
  // Temp file the upload was streamed into; caller moves it into place, then ensures
  // it is removed (receiveUpload already removes it on every failure path).
  tmpPath: string;
  // Sanitized original filename as sent by the client (basename only).
  filename: string;
  // Dotless, lowercase extension derived from filename.
  extension: string;
  sizeBytes: number;
}

// Thrown for client-correctable problems; statusCode maps straight onto the reply.
export class UploadError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "UploadError";
    this.statusCode = statusCode;
  }
}

function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Strip any path components and unusual characters so a client can't influence where
// the file lands; the real destination name is chosen by the caller anyway.
function sanitizeFilename(name: string): string {
  const base = path.basename(name || "").replace(/[^\w.\- ]+/g, "_").trim();
  return base || "upload";
}

// Streams the single uploaded file into a temp file under destDir, enforcing the
// policy. Resolves with the temp file's details; rejects with UploadError on a
// policy violation (and always removes the partial temp file first).
export async function receiveUpload(
  request: FastifyRequest,
  policy: UploadPolicy,
  destDir: string
): Promise<ReceivedUpload> {
  if (!request.isMultipart()) {
    throw new UploadError("Expected a multipart/form-data upload.", 415);
  }

  const part = await request.file();
  if (!part) {
    throw new UploadError("No file was uploaded.", 400);
  }

  const filename = sanitizeFilename(part.filename);
  const extension = path.extname(filename).slice(1).toLowerCase();
  const accept = policy.accept.map((ext) => ext.toLowerCase());
  if (!accept.includes(extension)) {
    part.file.resume(); // drain the stream so the request can complete cleanly
    throw new UploadError(`Unsupported file type. Allowed: ${policy.accept.join(", ")}.`, 415);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const tmpPath = path.join(destDir, `.upload-${nanoid(12)}.${extension}`);

  let bytes = 0;
  let tooLarge = false;
  part.file.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (policy.maxBytes != null && bytes > policy.maxBytes && !tooLarge) {
      tooLarge = true;
      part.file.destroy(); // stop reading; pipeline below rejects, we map to 413
    }
  });

  try {
    await pipeline(part.file, fs.createWriteStream(tmpPath));
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    if (tooLarge) {
      throw new UploadError(`File is larger than the ${formatLimit(policy.maxBytes!)} limit.`, 413);
    }
    throw new UploadError(err instanceof Error ? err.message : "Upload failed.", 400);
  }

  // destroy() can land after pipeline resolves on the last chunk — re-check.
  if (tooLarge) {
    fs.rmSync(tmpPath, { force: true });
    throw new UploadError(`File is larger than the ${formatLimit(policy.maxBytes!)} limit.`, 413);
  }
  if (bytes === 0) {
    fs.rmSync(tmpPath, { force: true });
    throw new UploadError("The uploaded file is empty.", 400);
  }

  return { tmpPath, filename, extension, sizeBytes: bytes };
}
