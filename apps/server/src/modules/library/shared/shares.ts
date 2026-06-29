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
import { pathIsInside } from "./storage-roots.js";
import { thumbnailAbsolutePath } from "./thumbnail.js";
import { canUserAccessLibrary, canUserCurateLibrary, getLibraryForBook, type LibraryAccessRow } from "./library-access.js";
import { resolveShareLink } from "./share-access.js";
import { parseRangeHeader } from "./document-stream.js";
import { mediaKind, type MediaModule } from "./library-types.js";

// Item-level sharing for the digital library, shared across media types. Guest
// links (anonymous, no account) and user-to-user shares both live on the generic
// `share_links` / `shares` tables, keyed by (module, resource_id) — the module is
// the item's library type ("audiobook" | "ebook"), derived once at the seam so a
// share is always stamped with the right namespace. Owner endpoints are type-aware;
// the public guest routes dispatch by the resolved link's module so one set of
// /api/share/:token routes serves every book type.

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

// Whether the caller may share a book. Sharing hands external/other-user access to
// the files, so it requires the Curator+ "curate" capability — not mere view. We
// distinguish "not_found" (book missing or no access at all — hide its existence)
// from "forbidden" (can view but lacks the curate capability to re-share).
type ShareableResult = { library: LibraryAccessRow } | "not_found" | "forbidden";

function getShareableBook(bookId: string, userId: string, userRole: string): ShareableResult {
  const library = getLibraryForBook(bookId);
  if (!library) return "not_found";
  if (!canUserAccessLibrary(library, userId, userRole)) return "not_found";
  if (!canUserCurateLibrary(library, userId, userRole)) return "forbidden";
  return { library };
}

// Resolve sharing permission into a reply, or return true when allowed. Centralizes
// the 404/403 split so every share route reports it the same way.
function denyIfNotShareable(result: ShareableResult, reply: FastifyReply): boolean {
  if (result === "not_found") {
    reply.code(404).send({ error: "Book not found" });
    return true;
  }
  if (result === "forbidden") {
    reply.code(403).send({ error: "Curator access required to share this book." });
    return true;
  }
  return false;
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

// Common item fields needed by every public route, independent of media type. Authors
// apply to both books; type-specific extras (narrators, files, documents) are loaded
// per branch below.
interface ShareItemRow {
  source_path: string;
  library_type: string;
  folder_path: string;
  cover_storage_key: string | null;
  title: string | null;
  description: string | null;
  author_names: string | null;
}

function loadShareItem(resourceId: string): ShareItemRow | undefined {
  return db.prepare(`
    SELECT
      libraries.source_path,
      libraries.type AS library_type,
      library_items.folder_path,
      item_metadata.cover_storage_key,
      item_metadata.title,
      item_metadata.description,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
    LEFT JOIN people AS authors ON authors.id = item_people.person_id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
    GROUP BY library_items.id
  `).get(resourceId) as ShareItemRow | undefined;
}

// The first available document of an ebook item. Ebooks are one-file-per-book, so a
// share resolves to a single document for both reading (inline) and download.
interface ShareDocumentRow {
  id: string;
  relative_path: string;
  mime_type: string | null;
  format: string;
}

function loadShareDocument(resourceId: string): ShareDocumentRow | undefined {
  return db.prepare(`
    SELECT id, relative_path, mime_type, format
    FROM document_files
    WHERE item_id = ? AND status = 'available'
    ORDER BY relative_path COLLATE NOCASE
    LIMIT 1
  `).get(resourceId) as ShareDocumentRow | undefined;
}

// A shared gallery item is a single asset (one photo or video), described directly
// in gallery_details. Both the inline viewer and the download resolve to this file.
interface ShareGalleryRow {
  kind: string;
  relative_path: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
}

function loadShareGalleryAsset(resourceId: string): ShareGalleryRow | undefined {
  return db.prepare(`
    SELECT kind, relative_path, mime_type, width, height, duration_seconds
    FROM gallery_details
    WHERE item_id = ?
  `).get(resourceId) as ShareGalleryRow | undefined;
}

// Stream a single file from disk with range support, inline or as an attachment.
// Token-gated callers have already authorized access, so there is no per-user check
// here (unlike the authenticated document-stream helper).
function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: { absolutePath: string; mimeType: string; fileName: string; download: boolean }
): void {
  const stat = fs.statSync(opts.absolutePath);
  const totalSize = stat.size;
  const asciiName = opts.fileName.replace(/[^\x20-\x7E]/g, "_");
  const disposition = opts.download ? "attachment" : "inline";
  const rangeHeader = request.headers["range"];
  const range = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;

  if (rangeHeader && !range) {
    reply.code(416).header("Content-Range", `bytes */${totalSize}`).send({ error: "Range not satisfiable" });
    return;
  }

  reply.hijack();
  const baseHeaders = {
    "Content-Type": opts.mimeType,
    "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache"
  };
  if (range) {
    reply.raw.writeHead(206, { ...baseHeaders, "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`, "Content-Length": range.size });
    fs.createReadStream(opts.absolutePath, { start: range.start, end: range.end }).pipe(reply.raw);
  } else {
    reply.raw.writeHead(200, { ...baseHeaders, "Content-Length": totalSize });
    fs.createReadStream(opts.absolutePath).pipe(reply.raw);
  }
}

export async function librarySharesPlugin(app: FastifyInstance) {
  // --- Owner: guest link shares -------------------------------------------

  app.post("/api/shares", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createLinkSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid share details", details: parsed.error });
      return;
    }

    const user = request.user!;
    const result = getShareableBook(parsed.data.bookId, user.id, user.role);
    if (denyIfNotShareable(result, reply)) return;
    const module = mediaKind((result as { library: LibraryAccessRow }).library.type);

    const token = nanoid(36);
    const shareId = nanoid(16);
    const expiresAt = addDays(parsed.data.expiresInDays ?? 30).toISOString();
    db.prepare(`
      INSERT INTO share_links (id, module, resource_id, token_hash, permission, label, expires_at, created_by)
      VALUES (?, ?, ?, ?, 'read', ?, ?, ?)
    `).run(shareId, module, parsed.data.bookId, sha256(token), parsed.data.label ?? null, expiresAt, user.id);
    logActivity({
      event: "share.created",
      actorUserId: user.id,
      targetType: "share_link",
      targetId: shareId,
      detail: `Created a guest share link for an ${module}.`,
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
    // Cross-type: a JOIN to library_items scopes the list to digital-library shares
    // (the only modules that write these tables), regardless of book type.
    const rows = db.prepare(`
      SELECT
        share_links.id,
        share_links.resource_id,
        share_links.label,
        share_links.created_at,
        share_links.expires_at,
        item_metadata.title,
        library_items.folder_path
      FROM share_links
      JOIN library_items ON library_items.id = share_links.resource_id
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      WHERE share_links.created_by = ?
        AND share_links.revoked_at IS NULL
      ORDER BY datetime(share_links.created_at) DESC
    `).all(user.id) as {
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
      UPDATE share_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
    const result = getShareableBook(parsed.data.bookId, user.id, user.role);
    if (denyIfNotShareable(result, reply)) return;
    const module = mediaKind((result as { library: LibraryAccessRow }).library.type);

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
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(shareId, module, parsed.data.bookId, parsed.data.userId, user.id, expiresAt);
    logActivity({
      event: "share.granted",
      actorUserId: user.id,
      targetType: "book",
      targetId: parsed.data.bookId,
      detail: `Shared an ${module} with a user.`,
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
    const result = getShareableBook(query.bookId, user.id, user.role);
    if (denyIfNotShareable(result, reply)) return;
    const module = mediaKind((result as { library: LibraryAccessRow }).library.type);

    const rows = db.prepare(`
      SELECT shares.id, shares.user_id, shares.expires_at, shares.created_at,
             users.display_name, users.email
      FROM shares
      JOIN users ON users.id = shares.user_id
      WHERE shares.module = ? AND shares.resource_id = ? AND shares.revoked_at IS NULL
      ORDER BY datetime(shares.created_at) DESC
    `).all(module, query.bookId) as {
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
      UPDATE shares SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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

  // Items shared *to* the calling user, across every book type. `type` lets the
  // client route each tile to the right detail page (audiobook vs ebook reader).
  app.get("/api/shared-with-me", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT shares.resource_id, shares.created_at, shares.expires_at,
             libraries.type AS library_type,
             item_metadata.title, item_metadata.cover_storage_key, library_items.folder_path,
             owner.display_name AS shared_by
      FROM shares
      JOIN library_items ON library_items.id = shares.resource_id AND library_items.deleted_at IS NULL
      JOIN libraries ON libraries.id = library_items.library_id
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN users AS owner ON owner.id = shares.created_by
      WHERE shares.user_id = ?
        AND shares.revoked_at IS NULL
        AND (shares.expires_at IS NULL OR datetime(shares.expires_at) > datetime('now'))
      ORDER BY datetime(shares.created_at) DESC
    `).all(user.id) as {
      resource_id: string;
      created_at: string;
      expires_at: string | null;
      library_type: string;
      title: string | null;
      cover_storage_key: string | null;
      folder_path: string;
      shared_by: string | null;
    }[];

    return {
      books: rows.map((row) => ({
        id: row.resource_id,
        type: mediaKind(row.library_type),
        title: row.title ?? path.basename(row.folder_path),
        coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
        sharedBy: row.shared_by,
        sharedAt: row.created_at,
        expiresAt: row.expires_at
      }))
    };
  });

  // --- Public: guest access (no authentication) ---------------------------

  // Resolve a token to its (link, item), or send 404. Used by every public route.
  // Only digital-library modules are servable here.
  function resolveOr404(request: FastifyRequest, reply: FastifyReply) {
    const token = (request.params as { token: string }).token;
    const link = resolveShareLink(token);
    if (!link || (link.module !== "audiobook" && link.module !== "ebook" && link.module !== "gallery")) {
      reply.code(404).send({ error: "Share not found or expired" });
      return null;
    }
    const item = loadShareItem(link.resource_id);
    if (!item) {
      reply.code(404).send({ error: "Share not found or expired" });
      return null;
    }
    return { token, link, module: link.module as MediaModule, item };
  }

  app.get("/api/share/:token", async (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { token, link, module, item } = resolved;

    const meta = db.prepare(
      "SELECT label, expires_at FROM share_links WHERE id = ?"
    ).get(link.id) as { label: string | null; expires_at: string };

    logActivity({
      event: "share.accessed",
      actorUserId: null,
      targetType: "share_link",
      targetId: link.id,
      detail: `Opened a shared ${module}.`,
      ipAddress: request.ip
    });

    const share = { label: meta.label, expiresAt: meta.expires_at };
    const coverUrl = item.cover_storage_key ? `/api/share/${token}/cover` : null;
    const title = item.title ?? path.basename(item.folder_path);
    const authors = splitNames(item.author_names);

    if (module === "gallery") {
      const gal = loadShareGalleryAsset(link.resource_id);
      if (!gal) {
        reply.code(404).send({ error: "Share not found or expired" });
        return;
      }
      reply.send({
        type: "gallery",
        share,
        asset: {
          title,
          kind: gal.kind,
          description: item.description,
          coverUrl,
          width: gal.width,
          height: gal.height,
          durationSeconds: gal.duration_seconds
        }
      });
      return;
    }

    if (module === "ebook") {
      const doc = loadShareDocument(link.resource_id);
      if (!doc) {
        reply.code(404).send({ error: "Share not found or expired" });
        return;
      }
      reply.send({
        type: "ebook",
        share,
        book: { title, authors, description: item.description, coverUrl, format: doc.format }
      });
      return;
    }

    // Audiobook: chapter/track list + narrators + total duration for the player.
    const detail = db.prepare(
      "SELECT duration_seconds FROM audiobook_details WHERE item_id = ?"
    ).get(link.resource_id) as { duration_seconds: number | null } | undefined;
    const narratorRow = db.prepare(`
      SELECT GROUP_CONCAT(DISTINCT people.name) AS names
      FROM item_people
      JOIN people ON people.id = item_people.person_id
      WHERE item_people.item_id = ? AND item_people.role = 'narrator'
    `).get(link.resource_id) as { names: string | null } | undefined;
    const files = db.prepare(`
      SELECT id, track_number, title AS chapter_title, duration_seconds
      FROM audio_files
      WHERE item_id = ? AND status = 'available'
      ORDER BY track_number, relative_path COLLATE NOCASE
    `).all(link.resource_id) as {
      id: string;
      track_number: number | null;
      chapter_title: string | null;
      duration_seconds: number | null;
    }[];

    reply.send({
      type: "audiobook",
      share,
      book: {
        title,
        authors,
        narrators: splitNames(narratorRow?.names ?? null),
        description: item.description,
        durationSeconds: detail?.duration_seconds ?? null,
        coverUrl,
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
    const { item } = resolved;
    if (!item.cover_storage_key) {
      reply.code(404).send({ error: "Cover not found" });
      return;
    }
    try {
      const absolutePath = thumbnailAbsolutePath(item.cover_storage_key);
      const cover = await fsp.readFile(absolutePath);
      reply
        .type(coverMimeByExt[path.extname(item.cover_storage_key).toLowerCase()] ?? "application/octet-stream")
        .header("Content-Length", cover.byteLength)
        .header("Cache-Control", "public, max-age=3600")
        .send(cover);
    } catch {
      reply.code(404).send({ error: "Cover not found" });
    }
  });

  // Audiobook only: stream one audio track (direct play, no transcode, range).
  app.get("/api/share/:token/stream/:fileId", (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { module, item } = resolved;
    if (module !== "audiobook") {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    const { fileId } = request.params as { fileId: string };

    const file = db.prepare(`
      SELECT relative_path, mime_type, status
      FROM audio_files
      WHERE id = ? AND item_id = ?
    `).get(fileId, resolved.link.resource_id) as { relative_path: string; mime_type: string | null; status: string } | undefined;

    if (!file || file.status !== "available") {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    const filePath = path.join(item.source_path, ...file.relative_path.split("/"));
    if (!pathIsInside(filePath, item.source_path) || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "Audio file not found" });
      return;
    }

    sendFile(request, reply, {
      absolutePath: filePath,
      mimeType: file.mime_type ?? "application/octet-stream",
      fileName: file.relative_path.split("/").pop() ?? "audio",
      download: false
    });
  });

  // Ebook: serve the book's document inline for the guest reader (range support lets
  // the browser's PDF viewer fetch pages on demand). Gallery: serve the original
  // photo/video inline, with range so a guest's <video> can seek.
  app.get("/api/share/:token/file", (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { module, item } = resolved;

    if (module === "gallery") {
      const gal = loadShareGalleryAsset(resolved.link.resource_id);
      if (!gal) {
        reply.code(404).send({ error: "File not found" });
        return;
      }
      const galPath = path.join(item.source_path, ...gal.relative_path.split("/"));
      if (!pathIsInside(galPath, item.source_path) || !fs.existsSync(galPath)) {
        reply.code(404).send({ error: "File not found" });
        return;
      }
      sendFile(request, reply, {
        absolutePath: galPath,
        mimeType: gal.mime_type ?? "application/octet-stream",
        fileName: gal.relative_path.split("/").pop() ?? "file",
        download: false
      });
      return;
    }

    if (module !== "ebook") {
      reply.code(404).send({ error: "Not found" });
      return;
    }

    const doc = loadShareDocument(resolved.link.resource_id);
    if (!doc) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }
    const filePath = path.join(item.source_path, ...doc.relative_path.split("/"));
    if (!pathIsInside(filePath, item.source_path) || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "Document not found" });
      return;
    }

    sendFile(request, reply, {
      absolutePath: filePath,
      mimeType: doc.mime_type ?? "application/octet-stream",
      fileName: doc.relative_path.split("/").pop() ?? "document",
      download: false
    });
  });

  app.get("/api/share/:token/download", (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { module, item, link } = resolved;

    const safeTitle = (item.title ?? path.basename(item.folder_path)).replace(/[/\\?%*:|"<>]/g, "_").trim();

    if (module === "gallery") {
      const gal = loadShareGalleryAsset(link.resource_id);
      if (!gal) {
        reply.code(404).send({ error: "File not found" });
        return;
      }
      const galPath = path.join(item.source_path, ...gal.relative_path.split("/"));
      if (!pathIsInside(galPath, item.source_path) || !fs.existsSync(galPath)) {
        reply.code(404).send({ error: "File not found" });
        return;
      }
      logActivity({
        event: "share.downloaded",
        actorUserId: null,
        targetType: "share_link",
        targetId: link.id,
        detail: `Downloaded a shared ${gal.kind === "video" ? "video" : "photo"}.`,
        ipAddress: request.ip
      });
      const ext = path.extname(gal.relative_path);
      sendFile(request, reply, {
        absolutePath: galPath,
        mimeType: gal.mime_type ?? "application/octet-stream",
        fileName: `${safeTitle || "file"}${ext}`,
        download: true
      });
      return;
    }

    if (module === "ebook") {
      const doc = loadShareDocument(link.resource_id);
      if (!doc) {
        reply.code(404).send({ error: "Document not found" });
        return;
      }
      const filePath = path.join(item.source_path, ...doc.relative_path.split("/"));
      if (!pathIsInside(filePath, item.source_path) || !fs.existsSync(filePath)) {
        reply.code(404).send({ error: "Document not found" });
        return;
      }
      logActivity({
        event: "share.downloaded",
        actorUserId: null,
        targetType: "share_link",
        targetId: link.id,
        detail: "Downloaded a shared ebook.",
        ipAddress: request.ip
      });
      const ext = path.extname(doc.relative_path);
      sendFile(request, reply, {
        absolutePath: filePath,
        mimeType: doc.mime_type ?? "application/octet-stream",
        fileName: `${safeTitle || "ebook"}${ext}`,
        download: true
      });
      return;
    }

    // Audiobook: zip every available track.
    const files = db.prepare(`
      SELECT relative_path
      FROM audio_files
      WHERE item_id = ? AND status = 'available'
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

    const zipName = `${safeTitle || "audiobook"}.zip`;
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
      const filePath = path.join(item.source_path, ...file.relative_path.split("/"));
      if (pathIsInside(filePath, item.source_path) && fs.existsSync(filePath)) {
        archive.file(filePath, { name: file.relative_path.split("/").pop() ?? path.basename(filePath) });
      }
    }
    archive.finalize();
  });
}
