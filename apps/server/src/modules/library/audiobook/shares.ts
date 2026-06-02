import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import archiver from "archiver";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { sha256 } from "../../../crypto.js";
import { addDays } from "../../../auth.js";
import { config } from "../../../config.js";
import { parseBody } from "../../../core/shared.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { thumbnailAbsolutePath } from "../shared/thumbnail.js";
import { canUserAccessLibrary, getLibraryForBook } from "../shared/library-access.js";
import { resolveShareLink } from "../shared/share-access.js";

const MODULE = "audiobook";

const createLinkSchema = z.object({
  bookId: z.string().min(1),
  expiresInDays: z.number().int().min(1).max(30).default(30),
  label: z.string().trim().max(100).optional()
});

const createUserShareSchema = z.object({
  bookId: z.string().min(1),
  userId: z.string().min(1),
  // Optional: omit for a permanent share (access stays gated to the account).
  expiresInDays: z.number().int().min(1).max(3650).optional()
});

// The book must exist and the caller must be able to access it (library owner,
// group member, admin, or public). That access is what lets them re-share it.
function getShareableBook(bookId: string, userId: string, userRole: string) {
  const library = getLibraryForBook(bookId);
  if (!library) return null;
  if (!canUserAccessLibrary(library, userId, userRole)) return null;
  return library;
}

interface ShareBookRow {
  source_path: string;
  cover_storage_key: string | null;
  title: string | null;
  folder_path: string;
  description: string | null;
  duration_seconds: number | null;
  author_names: string | null;
  narrator_names: string | null;
}

function loadShareBook(bookId: string): ShareBookRow | undefined {
  return db.prepare(`
    SELECT
      libraries.source_path,
      books.folder_path,
      book_metadata.cover_storage_key,
      book_metadata.title,
      book_metadata.description,
      book_metadata.duration_seconds,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    LEFT JOIN book_metadata ON book_metadata.book_id = books.id
    LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
    LEFT JOIN authors ON authors.id = book_authors.author_id
    LEFT JOIN book_authors AS book_narrators ON book_narrators.book_id = books.id AND book_narrators.role = 'narrator'
    LEFT JOIN authors AS narrators ON narrators.id = book_narrators.author_id
    WHERE books.id = ? AND books.deleted_at IS NULL
    GROUP BY books.id
  `).get(bookId) as ShareBookRow | undefined;
}

function splitNames(value: string | null): string[] {
  return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

const coverMimeByExt: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

export async function audiobookSharesPlugin(app: FastifyInstance) {
  // --- Owner: guest link shares -------------------------------------------

  app.post("/api/shares", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createLinkSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid share details", details: parsed.error });
      return;
    }

    const user = request.user!;
    if (!getShareableBook(parsed.data.bookId, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const token = nanoid(36);
    const shareId = nanoid(16);
    const expiresAt = addDays(parsed.data.expiresInDays ?? 30).toISOString();
    db.prepare(`
      INSERT INTO share_links (id, module, resource_id, token_hash, permission, label, expires_at, created_by)
      VALUES (?, ?, ?, ?, 'read', ?, ?, ?)
    `).run(shareId, MODULE, parsed.data.bookId, sha256(token), parsed.data.label ?? null, expiresAt, user.id);
    logActivity({
      event: "share.created",
      actorUserId: user.id,
      targetType: "share_link",
      targetId: shareId,
      detail: "Created a guest share link for an audiobook.",
      ipAddress: request.ip
    });

    // Build the link from the configured front-end origin (also the CORS origin),
    // not the request Host — behind a dev proxy the API Host is the wrong port.
    const base = config.appUrl.replace(/\/+$/, "");
    reply.code(201).send({
      share: {
        id: shareId,
        label: parsed.data.label ?? null,
        expiresAt,
        // Shown exactly once — the raw token is not stored and cannot be re-displayed.
        url: `${base}/share/${token}`
      }
    });
  });

  app.get("/api/shares", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT
        share_links.id,
        share_links.resource_id,
        share_links.label,
        share_links.created_at,
        share_links.expires_at,
        book_metadata.title,
        books.folder_path
      FROM share_links
      LEFT JOIN books ON books.id = share_links.resource_id
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      WHERE share_links.module = ?
        AND share_links.created_by = ?
        AND share_links.revoked_at IS NULL
      ORDER BY datetime(share_links.created_at) DESC
    `).all(MODULE, user.id) as {
      id: string;
      resource_id: string;
      label: string | null;
      created_at: string;
      expires_at: string;
      title: string | null;
      folder_path: string | null;
    }[];
    const now = Date.now();

    return {
      shares: rows.map((row) => ({
        id: row.id,
        bookId: row.resource_id,
        bookTitle: row.title ?? (row.folder_path ? path.basename(row.folder_path) : "Unknown"),
        label: row.label,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        status: new Date(row.expires_at).getTime() <= now ? "expired" : "active"
      }))
    };
  });

  app.delete("/api/shares/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const where = user.role === "admin" ? "" : "AND created_by = ?";
    const params = user.role === "admin" ? [id] : [id, user.id];
    const result = db.prepare(`
      UPDATE share_links SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL ${where}
    `).run(...params);

    if (result.changes === 0) {
      reply.code(404).send({ error: "Share link not found" });
      return;
    }

    logActivity({
      event: "share.revoked",
      actorUserId: user.id,
      targetType: "share_link",
      targetId: id,
      detail: "Revoked a guest share link.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  // --- Owner: user-to-user shares -----------------------------------------

  // Minimal directory for the recipient picker — any signed-in user, since this
  // is a self-hosted family app. Returns id + display name only (no emails).
  app.get("/api/shares/directory", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const users = db.prepare(`
      SELECT id, display_name
      FROM users
      WHERE deleted_at IS NULL AND is_active = 1 AND id != ?
      ORDER BY display_name COLLATE NOCASE
    `).all(user.id) as { id: string; display_name: string }[];
    return { users: users.map((u) => ({ id: u.id, displayName: u.display_name })) };
  });

  app.post("/api/shares/user", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createUserShareSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid share details", details: parsed.error });
      return;
    }

    const user = request.user!;
    if (parsed.data.userId === user.id) {
      reply.code(400).send({ error: "You already have access to this book" });
      return;
    }
    if (!getShareableBook(parsed.data.bookId, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const target = db.prepare(
      "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
    ).get(parsed.data.userId) as { id: string } | undefined;
    if (!target) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    const shareId = nanoid(16);
    const expiresAt = parsed.data.expiresInDays ? addDays(parsed.data.expiresInDays).toISOString() : null;
    db.prepare(`
      INSERT INTO shares (id, module, resource_id, user_id, permission, created_by, expires_at)
      VALUES (?, ?, ?, ?, 'read', ?, ?)
      ON CONFLICT (module, resource_id, user_id) DO UPDATE SET
        revoked_at = NULL,
        expires_at = excluded.expires_at,
        created_by = excluded.created_by,
        created_at = CURRENT_TIMESTAMP
    `).run(shareId, MODULE, parsed.data.bookId, parsed.data.userId, user.id, expiresAt);
    logActivity({
      event: "share.granted",
      actorUserId: user.id,
      targetType: "book",
      targetId: parsed.data.bookId,
      detail: "Shared an audiobook with a user.",
      ipAddress: request.ip
    });

    reply.code(201).send({ ok: true });
  });

  app.get("/api/shares/user", { preHandler: app.authenticate }, async (request, reply) => {
    const query = request.query as { bookId?: string };
    if (!query.bookId) {
      reply.code(400).send({ error: "bookId is required" });
      return;
    }
    const user = request.user!;
    if (!getShareableBook(query.bookId, user.id, user.role)) {
      reply.code(404).send({ error: "Audiobook not found" });
      return;
    }

    const rows = db.prepare(`
      SELECT shares.id, shares.user_id, shares.expires_at, shares.created_at,
             users.display_name, users.email
      FROM shares
      JOIN users ON users.id = shares.user_id
      WHERE shares.module = ? AND shares.resource_id = ? AND shares.revoked_at IS NULL
      ORDER BY datetime(shares.created_at) DESC
    `).all(MODULE, query.bookId) as {
      id: string;
      user_id: string;
      expires_at: string | null;
      created_at: string;
      display_name: string;
      email: string;
    }[];

    return {
      shares: rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email,
        expiresAt: row.expires_at,
        createdAt: row.created_at
      }))
    };
  });

  app.delete("/api/shares/user/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const user = request.user!;
    const where = user.role === "admin" ? "" : "AND created_by = ?";
    const params = user.role === "admin" ? [id] : [id, user.id];
    const result = db.prepare(`
      UPDATE shares SET revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL ${where}
    `).run(...params);

    if (result.changes === 0) {
      reply.code(404).send({ error: "Share not found" });
      return;
    }

    logActivity({
      event: "share.revoked",
      actorUserId: user.id,
      targetType: "share",
      targetId: id,
      detail: "Revoked a user share.",
      ipAddress: request.ip
    });
    reply.send({ ok: true });
  });

  // Items shared *to* the calling user.
  app.get("/api/shared-with-me", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT shares.resource_id, shares.created_at, shares.expires_at,
             book_metadata.title, book_metadata.cover_storage_key, books.folder_path,
             owner.display_name AS shared_by
      FROM shares
      JOIN books ON books.id = shares.resource_id AND books.deleted_at IS NULL
      LEFT JOIN book_metadata ON book_metadata.book_id = books.id
      LEFT JOIN users AS owner ON owner.id = shares.created_by
      WHERE shares.module = ?
        AND shares.user_id = ?
        AND shares.revoked_at IS NULL
        AND (shares.expires_at IS NULL OR datetime(shares.expires_at) > CURRENT_TIMESTAMP)
      ORDER BY datetime(shares.created_at) DESC
    `).all(MODULE, user.id) as {
      resource_id: string;
      created_at: string;
      expires_at: string | null;
      title: string | null;
      cover_storage_key: string | null;
      folder_path: string;
      shared_by: string | null;
    }[];

    return {
      books: rows.map((row) => ({
        id: row.resource_id,
        title: row.title ?? path.basename(row.folder_path),
        coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
        sharedBy: row.shared_by,
        sharedAt: row.created_at,
        expiresAt: row.expires_at
      }))
    };
  });

  // --- Public: guest access (no authentication) ---------------------------

  // Resolve a token to its book, or send 404. Used by every public route.
  function resolveOr404(request: FastifyRequest, reply: FastifyReply) {
    const token = (request.params as { token: string }).token;
    const link = resolveShareLink(token);
    if (!link || link.module !== MODULE) {
      reply.code(404).send({ error: "Share not found or expired" });
      return null;
    }
    const book = loadShareBook(link.resource_id);
    if (!book) {
      reply.code(404).send({ error: "Share not found or expired" });
      return null;
    }
    return { token, link, book };
  }

  app.get("/api/share/:token", async (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { token, link, book } = resolved;

    const meta = db.prepare(
      "SELECT label, expires_at FROM share_links WHERE id = ?"
    ).get(link.id) as { label: string | null; expires_at: string };

    const files = db.prepare(`
      SELECT id, track_number, chapter_title, duration_seconds
      FROM book_files
      WHERE book_id = ? AND status = 'available'
      ORDER BY track_number, relative_path COLLATE NOCASE
    `).all(link.resource_id) as {
      id: string;
      track_number: number | null;
      chapter_title: string | null;
      duration_seconds: number | null;
    }[];

    logActivity({
      event: "share.accessed",
      actorUserId: null,
      targetType: "share_link",
      targetId: link.id,
      detail: "Opened a shared audiobook.",
      ipAddress: request.ip
    });

    reply.send({
      share: { label: meta.label, expiresAt: meta.expires_at },
      book: {
        title: book.title ?? path.basename(book.folder_path),
        authors: splitNames(book.author_names),
        narrators: splitNames(book.narrator_names),
        description: book.description,
        durationSeconds: book.duration_seconds,
        coverUrl: book.cover_storage_key ? `/api/share/${token}/cover` : null,
        files: files.map((file) => ({
          id: file.id,
          trackNumber: file.track_number,
          chapterTitle: file.chapter_title,
          durationSeconds: file.duration_seconds
        }))
      }
    });
  });

  app.get("/api/share/:token/cover", async (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { book } = resolved;
    if (!book.cover_storage_key) {
      reply.code(404).send({ error: "Cover not found" });
      return;
    }
    try {
      const absolutePath = thumbnailAbsolutePath(book.cover_storage_key);
      const cover = await fsp.readFile(absolutePath);
      reply
        .type(coverMimeByExt[path.extname(book.cover_storage_key).toLowerCase()] ?? "application/octet-stream")
        .header("Content-Length", cover.byteLength)
        .header("Cache-Control", "public, max-age=3600")
        .send(cover);
    } catch {
      reply.code(404).send({ error: "Cover not found" });
    }
  });

  app.get("/api/share/:token/stream/:fileId", (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { link, book } = resolved;
    const { fileId } = request.params as { fileId: string };

    const file = db.prepare(`
      SELECT relative_path, mime_type, status
      FROM book_files
      WHERE id = ? AND book_id = ?
    `).get(fileId, link.resource_id) as { relative_path: string; mime_type: string | null; status: string } | undefined;

    if (!file || file.status !== "available") {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const filePath = path.join(book.source_path, ...file.relative_path.split("/"));
    if (!pathIsInside(filePath, book.source_path) || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const mimeType = file.mime_type ?? "application/octet-stream";
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

  app.get("/api/share/:token/download", (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { link, book } = resolved;

    const files = db.prepare(`
      SELECT relative_path
      FROM book_files
      WHERE book_id = ? AND status = 'available'
      ORDER BY track_number, relative_path COLLATE NOCASE
    `).all(link.resource_id) as { relative_path: string }[];

    if (files.length === 0) {
      reply.code(404).send({ error: "No audio files available" });
      return;
    }

    logActivity({
      event: "share.downloaded",
      actorUserId: null,
      targetType: "share_link",
      targetId: link.id,
      detail: "Downloaded a shared audiobook.",
      ipAddress: request.ip
    });

    const safeTitle = (book.title ?? path.basename(book.folder_path)).replace(/[/\\?%*:|"<>]/g, "_").trim() || "audiobook";
    const zipName = `${safeTitle}.zip`;
    const asciiFilename = zipName.replace(/[^\x20-\x7E]/g, "_");
    const encodedFilename = encodeURIComponent(zipName);
    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("error", (err) => {
      reply.raw.destroy(err);
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
      "Cache-Control": "private, no-cache"
    });
    archive.pipe(reply.raw);

    for (const file of files) {
      const filePath = path.join(book.source_path, ...file.relative_path.split("/"));
      if (pathIsInside(filePath, book.source_path) && fs.existsSync(filePath)) {
        archive.file(filePath, { name: file.relative_path.split("/").pop() ?? path.basename(filePath) });
      }
    }
    archive.finalize();
  });
}

function parseRangeHeader(header: string, totalSize: number) {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
  if (isNaN(start) || isNaN(end) || start > end || end >= totalSize) return null;
  return { start, end, size: end - start + 1 };
}
