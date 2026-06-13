// Routes that WRITE NEW FILES TO THE LIBRARY SOURCE on disk — uploading audiobooks.
// Uploading is policy-gated (see core/permissions.ts): it needs contributor+ and is
// refused on external (read-only) libraries or when the library policy disables it.
// Deleting (now: moving to the Recycle Bin) lives in shared/trash-routes.ts.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { receiveUploadBatch, UploadError } from "../../../core/uploads.js";
import { can, parsePolicy } from "../../../core/permissions.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { normalizeLibrarySettings, uploadAcceptExtensions } from "../shared/library-settings.js";
import { rescanSingleBook } from "./scanner.js";
import { getAudiobookBookDetail } from "./book-helpers.js";

// One audiobook = one folder of tracks; 500 covers even big episodic shows.
const MAX_BOOK_UPLOAD_FILES = 500;

// Turn a user-supplied book title into a safe folder name: keep unicode (titles
// are often Cyrillic here), drop path separators and Windows-invalid characters,
// and refuse leading dots so an upload can never create a hidden folder (the
// scanner skips those — they are reserved for upload staging).
function sanitizeFolderName(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = Array.from(value)
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 150)
    .replace(/[\s.]+$/g, "");
  return cleaned || null;
}

interface UploadLibraryRow {
  id: string;
  name: string;
  source_path: string;
  settings_json: string;
  policy_json: string;
}

export function registerSourceRoutes(app: FastifyInstance) {

  // Upload one audiobook: every file of the multipart request lands in ONE new book
  // folder (?folder= names it; default = first file's name), which is then scanned
  // into the catalog. Files stream into a hidden ".upload-*" staging folder first —
  // the scanner ignores dot-folders — and the finished folder is moved into place
  // with a single rename, so a cancelled upload never leaves a half-visible book.
  app.post("/api/library/audiobook-libraries/:id/books/upload", { preHandler: app.authenticate }, async (request, reply) => {
    const libraryId = (request.params as { id: string }).id;
    const user = request.user!;

    const library = db.prepare(
      "SELECT id, name, source_path, settings_json, policy_json FROM libraries WHERE id = ? AND type = 'audiobook'"
    ).get(libraryId) as UploadLibraryRow | undefined;
    if (!library || !canUserAccessLibrary(library, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook library not found" });
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

    const requestedFolder = sanitizeFolderName((request.query as { folder?: string }).folder);
    if (requestedFolder && fs.existsSync(path.join(root, requestedFolder))) {
      reply.code(409).send({ error: `An audiobook folder named "${requestedFolder}" already exists in this library.` });
      return;
    }

    const settings = normalizeLibrarySettings("audiobook", library.settings_json);
    const maxBytes = policy.maxUploadMB != null ? policy.maxUploadMB * 1024 * 1024 : null;
    const stagingDir = path.join(root, `.upload-${nanoid(10)}`);

    let received;
    try {
      // Audio extensions plus the library's configured companion files (covers,
      // metadata sidecars, documents), so a whole book folder uploads as-is. The
      // scan below sorts out each kind.
      received = await receiveUploadBatch(
        request,
        { accept: uploadAcceptExtensions(settings), maxBytes },
        stagingDir,
        MAX_BOOK_UPLOAD_FILES
      );
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const status = err instanceof UploadError ? err.statusCode : 400;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Upload failed" });
      return;
    }

    // Companions alone make no book — there must be something to listen to.
    const audioExtensions = new Set(settings.scan_extensions);
    const firstAudio = received.find((file) => audioExtensions.has(file.extension));
    if (!firstAudio) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      reply.code(400).send({ error: `Include at least one audio file (${settings.scan_extensions.map((ext) => `.${ext}`).join(", ")}).` });
      return;
    }

    let folderPath: string;
    try {
      // Give the temp files their real names (deduplicating case-insensitively),
      // then move the whole staging folder into place as the book folder.
      const usedNames = new Set<string>();
      for (const file of received) {
        let name = file.filename;
        if (usedNames.has(name.toLowerCase())) {
          const extension = path.extname(name);
          const stem = name.slice(0, name.length - extension.length);
          let counter = 2;
          while (usedNames.has(`${stem} (${counter})${extension}`.toLowerCase())) counter += 1;
          name = `${stem} (${counter})${extension}`;
        }
        usedNames.add(name.toLowerCase());
        fs.renameSync(file.tmpPath, path.join(stagingDir, name));
      }

      // Fall back to the first AUDIO file's name — never "cover" or "metadata".
      const folderName = requestedFolder
        ?? sanitizeFolderName(path.basename(firstAudio.filename, path.extname(firstAudio.filename)))
        ?? `Audiobook ${new Date().toISOString().slice(0, 10)}`;
      const finalDir = path.join(root, folderName);
      if (fs.existsSync(finalDir)) {
        throw new UploadError(`An audiobook folder named "${folderName}" already exists in this library.`, 409);
      }
      fs.renameSync(stagingDir, finalDir);
      folderPath = normaliseRelativePath(path.relative(root, finalDir));
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const status = err instanceof UploadError ? err.statusCode : 500;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Could not store the uploaded files." });
      return;
    }

    // Catalog the new folder: revive a previous row for this path if one exists
    // (the folder was deleted or went missing earlier), otherwise insert fresh.
    const existing = db.prepare("SELECT id FROM books WHERE library_id = ? AND folder_path = ?")
      .get(library.id, folderPath) as { id: string } | undefined;
    const bookId = existing?.id ?? nanoid(16);
    if (existing) {
      db.prepare("UPDATE books SET deleted_at = NULL, status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(bookId);
    } else {
      db.prepare("INSERT INTO books (id, library_id, folder_path, status) VALUES (?, ?, ?, 'pending')")
        .run(bookId, library.id, folderPath);
    }

    try {
      const scanned = await rescanSingleBook(bookId);
      if (!scanned) {
        throw new Error("The uploaded files could not be scanned.");
      }
    } catch (err) {
      // Files are safely in place; a library rescan will pick the folder up.
      const message = err instanceof Error ? err.message : "Scan failed";
      reply.code(500).send({ error: `Files were uploaded, but scanning failed (${message}). Rescan the library to finish adding the book.` });
      return;
    }

    const totalBytes = received.reduce((total, file) => total + file.sizeBytes, 0);
    logActivity({
      event: "library.audiobook.book_uploaded",
      actorUserId: user.id,
      targetType: "book",
      targetId: bookId,
      detail: `Uploaded "${folderPath}" (${received.length} file${received.length === 1 ? "" : "s"}, ${totalBytes} bytes) to library "${library.name}".`,
      ipAddress: request.ip
    });

    reply.code(201).send({ book: getAudiobookBookDetail(bookId), uploadedFiles: received.length });
  });
}
