// Routes that WRITE TO THE LIBRARY SOURCE on disk — upload new books and delete
// existing ones. These are the two policy-gated actions in the permission model
// (see core/permissions.ts): "upload" needs contributor+, "delete" needs manager+,
// and both are refused outright on external (read-only) libraries or when the
// library policy disables them.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { receiveUploadBatch, UploadError } from "../../../core/uploads.js";
import { can, parsePolicy } from "../../../core/permissions.js";
import { canUserAccessLibrary, getLibraryForBook } from "../shared/library-access.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { pathIsInside, normaliseRelativePath } from "../shared/storage-roots.js";
import { thumbnailStorageKey, thumbnailAbsolutePath } from "../shared/thumbnail.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { deleteSharesForResource } from "../shared/share-access.js";
import { deleteCollectionItemsForResource } from "../../collections/cleanup.js";
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

interface BookDeleteRow {
  id: string;
  folder_path: string;
  library_id: string;
  library_name: string;
  source_path: string;
  title: string;
  cover_storage_key: string | null;
  file_count: number;
}

function loadBookForDelete(bookId: string): BookDeleteRow | undefined {
  return db.prepare(`
    SELECT
      books.id,
      books.folder_path,
      books.library_id,
      libraries.name AS library_name,
      libraries.source_path,
      COALESCE(book_metadata.title, books.folder_path) AS title,
      book_metadata.cover_storage_key,
      (SELECT COUNT(*) FROM book_files WHERE book_files.book_id = books.id AND book_files.deleted_at IS NULL) AS file_count
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    LEFT JOIN book_metadata ON book_metadata.book_id = books.id
    WHERE books.id = ? AND books.deleted_at IS NULL
  `).get(bookId) as BookDeleteRow | undefined;
}

// Remove the book's audio/companion files from the library source. Books normally
// own a folder (delete it whole); books grouped at the library root (".") own no
// folder, so only their catalogued files are removed — never the root itself.
function deleteBookSourceFiles(row: BookDeleteRow) {
  const root = validateLibrarySource(row.source_path);
  if (row.folder_path === ".") {
    const files = db.prepare(`
      SELECT relative_path FROM book_files WHERE book_id = ?
      UNION
      SELECT relative_path FROM book_documents WHERE book_id = ?
    `).all(row.id, row.id) as { relative_path: string }[];
    for (const file of files) {
      const absolute = path.resolve(root, file.relative_path);
      if (pathIsInside(absolute, root) && absolute !== root) {
        fs.rmSync(absolute, { force: true });
      }
    }
    return;
  }

  const target = path.resolve(root, row.folder_path);
  if (!pathIsInside(target, root) || target === root) {
    throw new Error("Refusing to delete outside the library folder.");
  }
  fs.rmSync(target, { recursive: true, force: true });
}

// Cover thumbnails live outside the source dir; remove the book's webp pair plus
// whatever key metadata points at (manual covers). Best-effort — a missing
// thumbnail store must not block the delete.
function deleteBookCovers(row: BookDeleteRow) {
  const keys = new Set([
    thumbnailStorageKey(row.library_id, row.id, `${row.id}-cover.webp`),
    thumbnailStorageKey(row.library_id, row.id, `${row.id}-cover-large.webp`)
  ]);
  if (row.cover_storage_key) keys.add(row.cover_storage_key);
  for (const key of keys) {
    try {
      fs.rmSync(thumbnailAbsolutePath(key), { force: true });
    } catch {
      // thumbnail storage unconfigured or key invalid — nothing to remove
    }
  }
}

// DB teardown. FK cascades clear book_files/metadata/authors/documents/progress/
// bookmarks/saves; the polymorphic tables (taggables, shares, collections) have no
// FK to books and are cleaned explicitly — same list the library delete uses.
function deleteBookRecord(bookId: string) {
  db.transaction(() => {
    db.prepare("DELETE FROM taggables WHERE entity_type = 'book' AND entity_id = ?").run(bookId);
    deleteSharesForResource("audiobook", bookId);
    deleteCollectionItemsForResource("audiobook", bookId);
    db.prepare("DELETE FROM books WHERE id = ?").run(bookId);
  })();
}

function deleteBookEverywhere(row: BookDeleteRow) {
  deleteBookSourceFiles(row);
  deleteBookCovers(row);
  deleteBookRecord(row.id);
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
      received = await receiveUploadBatch(
        request,
        { accept: settings.scan_extensions, maxBytes },
        stagingDir,
        MAX_BOOK_UPLOAD_FILES
      );
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      const status = err instanceof UploadError ? err.statusCode : 400;
      reply.code(status).send({ error: err instanceof Error ? err.message : "Upload failed" });
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

      const folderName = requestedFolder
        ?? sanitizeFolderName(path.basename(received[0].filename, path.extname(received[0].filename)))
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

  // Permanently delete one audiobook: its folder on disk, its covers, and every
  // DB trace (progress, bookmarks, saves, shares, collection entries) for all users.
  app.delete("/api/library/books/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;

    const lib = getLibraryForBook(id);
    if (!lib) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }
    if (!can(user, { objectType: "library", objectId: lib.id, policy: parsePolicy(lib.policy_json) }, "delete")) {
      reply.code(403).send({ error: "Deleting books is not allowed in this library." });
      return;
    }

    const row = loadBookForDelete(id);
    if (!row) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    try {
      deleteBookEverywhere(row);
    } catch (err) {
      reply.code(500).send({ error: err instanceof Error ? err.message : "Could not delete the audiobook." });
      return;
    }

    logActivity({
      event: "library.audiobook.book_deleted",
      actorUserId: user.id,
      targetType: "book",
      targetId: id,
      detail: `Deleted audiobook "${row.title}" (${row.file_count} file${row.file_count === 1 ? "" : "s"}) from library "${row.library_name}", including its files on disk.`,
      ipAddress: request.ip
    });

    reply.send({ deleted: true });
  });

  const bulkDeleteSchema = z.object({
    bookIds: z.array(z.string().trim().min(1)).min(1).max(200)
  });

  // Bulk delete (selection mode). Permission is checked per book's library —
  // mirrors bulk-metadata: books the user can't delete are counted, not fatal.
  app.post("/api/library/books/bulk-delete", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(bulkDeleteSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid bulk delete", details: parsed.error });
      return;
    }

    const user = request.user!;
    let deleted = 0;
    let forbidden = 0;
    let missing = 0;
    let failed = 0;
    let failure = "";

    for (const bookId of parsed.data.bookIds) {
      const lib = getLibraryForBook(bookId);
      if (!lib) { missing += 1; continue; }
      if (!can(user, { objectType: "library", objectId: lib.id, policy: parsePolicy(lib.policy_json) }, "delete")) {
        forbidden += 1;
        continue;
      }
      const row = loadBookForDelete(bookId);
      if (!row) { missing += 1; continue; }
      try {
        deleteBookEverywhere(row);
        deleted += 1;
        logActivity({
          event: "library.audiobook.book_deleted",
          actorUserId: user.id,
          targetType: "book",
          targetId: bookId,
          detail: `Deleted audiobook "${row.title}" (${row.file_count} file${row.file_count === 1 ? "" : "s"}) from library "${row.library_name}", including its files on disk.`,
          ipAddress: request.ip
        });
      } catch (err) {
        failed += 1;
        if (!failure) failure = err instanceof Error ? err.message : "Delete failed";
      }
    }

    if (deleted === 0 && forbidden > 0 && failed === 0) {
      reply.code(403).send({ error: "Deleting books is not allowed in the selected libraries." });
      return;
    }

    reply.send({ deleted, forbidden, missing, failed, ...(failure ? { error: failure } : {}) });
  });
}
