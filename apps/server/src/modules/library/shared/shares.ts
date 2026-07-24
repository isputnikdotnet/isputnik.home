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
import { parseBody, requestOrigin } from "../../../core/shared.js";
import { pathIsInside } from "./storage-roots.js";
import { thumbnailAbsolutePath } from "./thumbnail.js";
import { canUserAccessLibrary, canUserCurateLibrary, getLibraryForBook, type LibraryAccessRow } from "./library-access.js";
import { resolveShareLink, type ResolvedShareLink } from "./share-access.js";
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

const createSetLinkSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
  expiresInDays: z.number().int().min(1).max(30).default(30),
  label: z.string().trim().max(100).optional()
});

const setUserShareSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
  userId: z.string().min(1),
  // Optional: omit for a permanent share (access stays gated to the account).
  expiresInDays: z.number().int().min(1).max(3650).optional()
});

const setSelectionSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
  userId: z.string().min(1)
});

// Live album shares are keyed on the album, not a snapshot of items.
const createAlbumLinkSchema = z.object({
  albumId: z.string().trim().min(1).max(64),
  expiresInDays: z.number().int().min(1).max(30).default(30),
  label: z.string().trim().max(100).optional()
});

const albumUserShareSchema = z.object({
  albumId: z.string().trim().min(1).max(64),
  userId: z.string().min(1),
  // Optional: omit for a permanent share (access stays gated to the account).
  expiresInDays: z.number().int().min(1).max(3650).optional()
});

const albumSelectionSchema = z.object({
  albumId: z.string().trim().min(1).max(64),
  userId: z.string().min(1)
});

const albumRecipientsSchema = z.object({
  albumId: z.string().trim().min(1).max(64)
});

const setRecipientsSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500)
});

const inClause = (n: number) => Array(n).fill("?").join(", ");

// The subset of a selection the caller may share (gallery items in a library
// they can curate) plus how many were dropped. Sharing hands out file access,
// so it needs the curate capability — the same contract as the bulk endpoints
// and the guest set link.
function shareableGalleryItems(
  user: { id: string; role: string },
  itemIds: string[]
): { included: string[]; skipped: number } {
  const included: string[] = [];
  let skipped = 0;
  for (const itemId of new Set(itemIds)) {
    const library = getLibraryForBook(itemId);
    if (
      !library ||
      library.type !== "gallery" ||
      !canUserAccessLibrary(library, user.id, user.role) ||
      !canUserCurateLibrary(library, user.id, user.role)
    ) {
      skipped += 1;
      continue;
    }
    included.push(itemId);
  }
  return { included, skipped };
}

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

// --- Gallery "quick links": one guest link over a snapshot of selected assets ---
// module 'gallery_set'; resource_id self-references the link id (there is no
// single resource). Membership lives in share_link_items, fixed at share time.

// Create a set link from a selection. Only items the sharer can CURATE are
// included (sharing hands out file access) — others are skipped and counted,
// the same contract as the bulk endpoints. Returns null when nothing survives.
export function createGallerySetShare(
  user: { id: string; role: string },
  opts: { itemIds: string[]; expiresInDays: number; label: string | null }
): { shareId: string; token: string; expiresAt: string; itemCount: number; skipped: number } | null {
  const { included, skipped } = shareableGalleryItems(user, opts.itemIds);
  if (included.length === 0) return null;

  const token = nanoid(36);
  const shareId = nanoid(16);
  const expiresAt = addDays(opts.expiresInDays).toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO share_links (id, module, resource_id, token_hash, permission, label, expires_at, created_by)
      VALUES (?, 'gallery_set', ?, ?, 'read', ?, ?, ?)
    `).run(shareId, shareId, sha256(token), opts.label, expiresAt, user.id);
    const insert = db.prepare(
      "INSERT INTO share_link_items (id, share_link_id, item_id, position) VALUES (?, ?, ?, ?)"
    );
    included.forEach((itemId, index) => insert.run(nanoid(16), shareId, itemId, index + 1));
  })();
  return { shareId, token, expiresAt, itemCount: included.length, skipped };
}

interface GallerySetItemRow {
  id: string;
  title: string | null;
  folder_path: string;
  kind: string;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  taken_at: string | null;
  cover_storage_key: string | null;
  preview_storage_key: string | null;
}

// The live members of a set link, in share order. Soft-deleted items drop out
// (and come back if restored from the Recycle Bin); hard deletes cascade away.
export function loadGallerySetItems(linkId: string): GallerySetItemRow[] {
  return db.prepare(`
    SELECT
      library_items.id,
      item_metadata.title,
      library_items.folder_path,
      gallery_details.kind,
      gallery_details.width,
      gallery_details.height,
      gallery_details.duration_seconds,
      gallery_details.taken_at,
      item_metadata.cover_storage_key,
      gallery_details.preview_storage_key
    FROM share_link_items
    JOIN library_items ON library_items.id = share_link_items.item_id AND library_items.deleted_at IS NULL
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE share_link_items.share_link_id = ?
    ORDER BY share_link_items.position
  `).all(linkId) as GallerySetItemRow[];
}

// Every live member of a set link with its on-disk path — for the "download all"
// zip. Source path is per-library (a set can span libraries), so it's joined per
// row. Soft-deleted items drop out, same as the public listing.
interface GallerySetFileRow {
  id: string;
  title: string | null;
  folder_path: string;
  relative_path: string;
  kind: string;
  source_path: string;
}

export function loadGallerySetFiles(linkId: string): GallerySetFileRow[] {
  return db.prepare(`
    SELECT
      library_items.id,
      item_metadata.title,
      library_items.folder_path,
      gallery_details.relative_path,
      gallery_details.kind,
      libraries.source_path
    FROM share_link_items
    JOIN library_items ON library_items.id = share_link_items.item_id AND library_items.deleted_at IS NULL
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE share_link_items.share_link_id = ?
    ORDER BY share_link_items.position
  `).all(linkId) as GallerySetFileRow[];
}

// One member of a set link with everything the media routes need. The WHERE on
// share_link_items IS the authorization: an item id outside this link 404s.
function loadGallerySetMediaItem(linkId: string, itemId: string) {
  return db.prepare(`
    SELECT
      library_items.folder_path,
      gallery_details.kind,
      gallery_details.relative_path,
      gallery_details.mime_type,
      item_metadata.title,
      item_metadata.cover_storage_key,
      gallery_details.preview_storage_key,
      libraries.source_path
    FROM share_link_items
    JOIN library_items ON library_items.id = share_link_items.item_id AND library_items.deleted_at IS NULL
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE share_link_items.share_link_id = ? AND share_link_items.item_id = ?
  `).get(linkId, itemId) as {
    folder_path: string;
    kind: string;
    relative_path: string;
    mime_type: string | null;
    title: string | null;
    cover_storage_key: string | null;
    preview_storage_key: string | null;
    source_path: string;
  } | undefined;
}

// --- Live album shares (`gallery_album`) --------------------------------------
// A guest link or user share whose resource_id is an ALBUM id. Unlike a set link,
// nothing is snapshotted: the members are resolved live from the album each time,
// bounded to the libraries the share's CREATOR can curate — so the share always
// reflects the album now, and can never leak a photo the creator couldn't share.

interface AlbumShareMeta {
  sort_mode: "taken_at" | "manual";
  created_by: string;
  name: string;
}

export function loadAlbumShareMeta(albumId: string): AlbumShareMeta | undefined {
  return db.prepare(
    "SELECT sort_mode, created_by, name FROM gallery_albums WHERE id = ?"
  ).get(albumId) as AlbumShareMeta | undefined;
}

// Gallery libraries a user may curate (edit) — the ones whose photos they're
// allowed to hand out. An album share exposes only members in these libraries.
export function curatableGalleryLibraryIds(user: { id: string; role: string }): string[] {
  const libs = db.prepare(
    "SELECT id, owner_id, owner_type, policy_json, type FROM libraries WHERE type = 'gallery'"
  ).all() as LibraryAccessRow[];
  return libs.filter((lib) => canUserCurateLibrary(lib, user.id, user.role)).map((lib) => lib.id);
}

function albumShareOrder(sortMode: string): string {
  return sortMode === "manual"
    ? "gallery_album_items.position ASC"
    : "datetime(gallery_details.taken_at) ASC, library_items.id ASC";
}

// The live members of an album share (same shape as a set link's items), in album
// order, filtered to the creator's curatable libraries. Soft-deleted items drop.
export function loadAlbumShareItems(albumId: string, sortMode: string, libIds: string[]): GallerySetItemRow[] {
  if (libIds.length === 0) return [];
  return db.prepare(`
    SELECT
      library_items.id,
      item_metadata.title,
      library_items.folder_path,
      gallery_details.kind,
      gallery_details.width,
      gallery_details.height,
      gallery_details.duration_seconds,
      gallery_details.taken_at,
      item_metadata.cover_storage_key,
      gallery_details.preview_storage_key
    FROM gallery_album_items
    JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE gallery_album_items.album_id = ? AND library_items.library_id IN (${inClause(libIds.length)})
    ORDER BY ${albumShareOrder(sortMode)}
  `).all(albumId, ...libIds) as GallerySetItemRow[];
}

function loadAlbumShareFiles(albumId: string, sortMode: string, libIds: string[]): GallerySetFileRow[] {
  if (libIds.length === 0) return [];
  return db.prepare(`
    SELECT
      library_items.id,
      item_metadata.title,
      library_items.folder_path,
      gallery_details.relative_path,
      gallery_details.kind,
      libraries.source_path
    FROM gallery_album_items
    JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE gallery_album_items.album_id = ? AND library_items.library_id IN (${inClause(libIds.length)})
    ORDER BY ${albumShareOrder(sortMode)}
  `).all(albumId, ...libIds) as GallerySetFileRow[];
}

// One member of an album share with everything the media routes need. The WHERE
// (album membership + creator-curatable library) IS the authorization.
function loadAlbumShareMediaItem(albumId: string, itemId: string, libIds: string[]) {
  if (libIds.length === 0) return undefined;
  return db.prepare(`
    SELECT
      library_items.folder_path,
      gallery_details.kind,
      gallery_details.relative_path,
      gallery_details.mime_type,
      item_metadata.title,
      item_metadata.cover_storage_key,
      gallery_details.preview_storage_key,
      libraries.source_path
    FROM gallery_album_items
    JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE gallery_album_items.album_id = ? AND gallery_album_items.item_id = ?
      AND library_items.library_id IN (${inClause(libIds.length)})
  `).get(albumId, itemId, ...libIds) as {
    folder_path: string;
    kind: string;
    relative_path: string;
    mime_type: string | null;
    title: string | null;
    cover_storage_key: string | null;
    preview_storage_key: string | null;
    source_path: string;
  } | undefined;
}

// Create a live guest link over an album. Only the album's creator or an admin can
// (it's their album), and only if it currently exposes at least one photo they may
// curate — otherwise the link would be dead. Nothing is snapshotted.
export type AlbumShareResult =
  | { shareId: string; token: string; expiresAt: string }
  | "not_found" | "forbidden" | "empty";

export function createGalleryAlbumShare(
  user: { id: string; role: string },
  opts: { albumId: string; expiresInDays: number; label: string | null }
): AlbumShareResult {
  const meta = loadAlbumShareMeta(opts.albumId);
  if (!meta) return "not_found";
  if (user.role !== "admin" && meta.created_by !== user.id) return "forbidden";
  const libIds = curatableGalleryLibraryIds(user);
  if (loadAlbumShareItems(opts.albumId, meta.sort_mode, libIds).length === 0) return "empty";

  const token = nanoid(36);
  const shareId = nanoid(16);
  const expiresAt = addDays(opts.expiresInDays).toISOString();
  db.prepare(`
    INSERT INTO share_links (id, module, resource_id, token_hash, permission, label, expires_at, created_by)
    VALUES (?, 'gallery_album', ?, ?, 'read', ?, ?, ?)
  `).run(shareId, opts.albumId, sha256(token), opts.label, expiresAt, user.id);
  return { shareId, token, expiresAt };
}

// --- Serving a gallery multi-share (set snapshot OR live album), one seam -----
// The public routes below don't care which kind they hold: they resolve items,
// files, and single media rows through these dispatchers. Album links resolve
// live against the link creator's current curate rights.
const GALLERY_MULTI_MODULES = new Set(["gallery_set", "gallery_album"]);

function albumLinkCtx(link: ResolvedShareLink): { meta: AlbumShareMeta; libIds: string[] } | null {
  const meta = loadAlbumShareMeta(link.resource_id);
  if (!meta) return null;
  const creator = db.prepare("SELECT id, role FROM users WHERE id = ?").get(link.created_by) as { id: string; role: string } | undefined;
  return { meta, libIds: creator ? curatableGalleryLibraryIds(creator) : [] };
}

function galleryMultiShareItems(link: ResolvedShareLink): GallerySetItemRow[] {
  if (link.module !== "gallery_album") return loadGallerySetItems(link.id);
  const ctx = albumLinkCtx(link);
  return ctx ? loadAlbumShareItems(link.resource_id, ctx.meta.sort_mode, ctx.libIds) : [];
}

function galleryMultiShareFiles(link: ResolvedShareLink): GallerySetFileRow[] {
  if (link.module !== "gallery_album") return loadGallerySetFiles(link.id);
  const ctx = albumLinkCtx(link);
  return ctx ? loadAlbumShareFiles(link.resource_id, ctx.meta.sort_mode, ctx.libIds) : [];
}

function galleryMultiShareMediaItem(link: ResolvedShareLink, itemId: string) {
  if (link.module !== "gallery_album") return loadGallerySetMediaItem(link.id, itemId);
  const ctx = albumLinkCtx(link);
  return ctx ? loadAlbumShareMediaItem(link.resource_id, itemId, ctx.libIds) : undefined;
}

// Serve a stored thumbnail (cover/preview) by storage key for guest routes.
async function sendThumbnail(reply: FastifyReply, storageKey: string): Promise<void> {
  try {
    const absolutePath = thumbnailAbsolutePath(storageKey);
    const bytes = await fsp.readFile(absolutePath);
    reply
      .type(coverMimeByExt[path.extname(storageKey).toLowerCase()] ?? "application/octet-stream")
      .header("Content-Length", bytes.byteLength)
      .header("Cache-Control", "public, max-age=3600")
      .send(bytes);
  } catch {
    reply.code(404).send({ error: "Image not found" });
  }
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

    // Build the link from the origin the sharer is actually using (the browser's
    // Origin header — the front-end/CORS origin, never the API Host, which is the
    // wrong port behind a dev proxy), so the link follows whichever domain they
    // arrived through. Falls back to config.appUrl. Same helper as invite links.
    const base = requestOrigin(request);
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

  // Create a gallery quick link: one guest link over a snapshot of selected
  // photos/videos (the multi-select bar's Share).
  app.post("/api/shares/set", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createSetLinkSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid share details", details: parsed.error });
      return;
    }

    const user = request.user!;
    const result = createGallerySetShare(user, {
      itemIds: parsed.data.itemIds,
      expiresInDays: parsed.data.expiresInDays ?? 30,
      label: parsed.data.label ?? null
    });
    if (!result) {
      reply.code(403).send({ error: "Curator access required to share these photos." });
      return;
    }

    logActivity({
      event: "share.created",
      actorUserId: user.id,
      targetType: "share_link",
      targetId: result.shareId,
      detail: `Created a guest share link for a set of ${result.itemCount} gallery item${result.itemCount === 1 ? "" : "s"}.`,
      ipAddress: request.ip
    });

    const base = requestOrigin(request);
    reply.code(201).send({
      share: {
        id: result.shareId,
        label: parsed.data.label ?? null,
        expiresAt: result.expiresAt,
        itemCount: result.itemCount,
        skipped: result.skipped,
        // Shown exactly once — the raw token is not stored and cannot be re-displayed.
        url: `${base}/share/${result.token}`
      }
    });
  });

  // The caller's active quick links (revocation goes through DELETE /api/shares/:id,
  // which is module-agnostic).
  app.get("/api/shares/sets", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT
        share_links.id,
        share_links.label,
        share_links.created_at,
        share_links.expires_at,
        COUNT(share_link_items.id) AS item_count
      FROM share_links
      LEFT JOIN share_link_items ON share_link_items.share_link_id = share_links.id
      WHERE share_links.created_by = ? AND share_links.module = 'gallery_set' AND share_links.revoked_at IS NULL
      GROUP BY share_links.id
      ORDER BY datetime(share_links.created_at) DESC
    `).all(user.id) as { id: string; label: string | null; created_at: string; expires_at: string; item_count: number }[];
    const now = Date.now();
    return {
      shares: rows.map((row) => ({
        id: row.id,
        label: row.label,
        itemCount: row.item_count,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        status: new Date(row.expires_at).getTime() <= now ? "expired" : "active"
      }))
    };
  });

  // --- Owner: live album shares (guest link + per-user) -------------------

  // Only the album's creator or an admin may share it (it's their album). Used by
  // every album-share write below.
  const albumEditableBy = (user: { id: string; role: string }, albumId: string): AlbumShareMeta | "not_found" | "forbidden" => {
    const meta = loadAlbumShareMeta(albumId);
    if (!meta) return "not_found";
    if (user.role !== "admin" && meta.created_by !== user.id) return "forbidden";
    return meta;
  };

  // Create a live guest link over an album — the URL always reflects the album's
  // current photos (no snapshot, no item cap).
  app.post("/api/shares/album", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createAlbumLinkSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid share details", details: parsed.error });
      return;
    }
    const user = request.user!;
    const result = createGalleryAlbumShare(user, {
      albumId: parsed.data.albumId,
      expiresInDays: parsed.data.expiresInDays ?? 30,
      label: parsed.data.label ?? null
    });
    if (result === "not_found") { reply.code(404).send({ error: "Album not found" }); return; }
    if (result === "forbidden") { reply.code(403).send({ error: "Only the album's creator or an admin can share it." }); return; }
    if (result === "empty") { reply.code(403).send({ error: "There are no photos in this album you can share." }); return; }

    logActivity({
      event: "share.created",
      actorUserId: user.id,
      targetType: "share_link",
      targetId: result.shareId,
      detail: "Created a live guest link for a gallery album.",
      ipAddress: request.ip
    });

    const base = requestOrigin(request);
    reply.code(201).send({
      share: {
        id: result.shareId,
        label: parsed.data.label ?? null,
        expiresAt: result.expiresAt,
        // Shown exactly once — the raw token is not stored and cannot be re-displayed.
        url: `${base}/share/${result.token}`
      }
    });
  });

  // The caller's active album links, with the album's name + current photo count.
  app.get("/api/shares/albums", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT
        share_links.id,
        share_links.resource_id AS album_id,
        share_links.label,
        share_links.created_at,
        share_links.expires_at,
        gallery_albums.name AS album_name,
        (SELECT COUNT(*) FROM gallery_album_items
           JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
         WHERE gallery_album_items.album_id = share_links.resource_id) AS item_count
      FROM share_links
      JOIN gallery_albums ON gallery_albums.id = share_links.resource_id
      WHERE share_links.created_by = ? AND share_links.module = 'gallery_album' AND share_links.revoked_at IS NULL
      ORDER BY datetime(share_links.created_at) DESC
    `).all(user.id) as {
      id: string; album_id: string; label: string | null; created_at: string;
      expires_at: string; album_name: string; item_count: number;
    }[];
    const now = Date.now();
    return {
      shares: rows.map((row) => ({
        id: row.id,
        albumId: row.album_id,
        albumName: row.album_name,
        label: row.label,
        itemCount: row.item_count,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        status: new Date(row.expires_at).getTime() <= now ? "expired" : "active"
      }))
    };
  });

  // Share an album *with a registered user* — a live grant (module 'gallery_album',
  // resource_id = the album). The recipient sees the album under "Shared with me"
  // and it tracks the album's membership. Upsert refreshes the expiry.
  app.post("/api/shares/album/user", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(albumUserShareSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid share details", details: parsed.error });
      return;
    }
    const user = request.user!;
    if (parsed.data.userId === user.id) {
      reply.code(400).send({ error: "You already have access to this album" });
      return;
    }
    const meta = albumEditableBy(user, parsed.data.albumId);
    if (meta === "not_found") { reply.code(404).send({ error: "Album not found" }); return; }
    if (meta === "forbidden") { reply.code(403).send({ error: "Only the album's creator or an admin can share it." }); return; }
    const target = db.prepare(
      "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
    ).get(parsed.data.userId) as { id: string } | undefined;
    if (!target) { reply.code(404).send({ error: "User not found" }); return; }

    const expiresAt = parsed.data.expiresInDays ? addDays(parsed.data.expiresInDays).toISOString() : null;
    db.prepare(`
      INSERT INTO shares (id, module, resource_id, user_id, permission, created_by, expires_at)
      VALUES (?, 'gallery_album', ?, ?, 'read', ?, ?)
      ON CONFLICT (module, resource_id, user_id) DO UPDATE SET
        revoked_at = NULL,
        expires_at = excluded.expires_at,
        created_by = excluded.created_by,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(nanoid(16), parsed.data.albumId, parsed.data.userId, user.id, expiresAt);
    logActivity({
      event: "share.granted",
      actorUserId: user.id,
      targetType: "share",
      targetId: parsed.data.userId,
      detail: `Shared gallery album "${meta.name}" with a user.`,
      ipAddress: request.ip
    });
    reply.code(201).send({ ok: true });
  });

  // Recipients of an album — the People list for the album-share dialog. Only the
  // caller's own grants (admins see all).
  app.post("/api/shares/album/recipients", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(albumRecipientsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error });
      return;
    }
    const user = request.user!;
    const scope = user.role === "admin" ? "" : "AND shares.created_by = ?";
    const params = user.role === "admin" ? [parsed.data.albumId] : [parsed.data.albumId, user.id];
    const rows = db.prepare(`
      SELECT shares.user_id, users.display_name, users.email, shares.expires_at
      FROM shares
      JOIN users ON users.id = shares.user_id
      WHERE shares.module = 'gallery_album' AND shares.resource_id = ? AND shares.revoked_at IS NULL ${scope}
      ORDER BY users.display_name COLLATE NOCASE
    `).all(...params) as { user_id: string; display_name: string; email: string; expires_at: string | null }[];
    reply.send({
      recipients: rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email,
        expiresAt: row.expires_at
      }))
    });
  });

  // Revoke a user's access to a shared album.
  app.post("/api/shares/album/user/revoke", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(albumSelectionSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error });
      return;
    }
    const user = request.user!;
    const scope = user.role === "admin" ? "" : "AND created_by = ?";
    const params = user.role === "admin"
      ? [parsed.data.userId, parsed.data.albumId]
      : [parsed.data.userId, parsed.data.albumId, user.id];
    const result = db.prepare(`
      UPDATE shares SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE module = 'gallery_album' AND revoked_at IS NULL AND user_id = ? AND resource_id = ? ${scope}
    `).run(...params);
    logActivity({
      event: "share.revoked",
      actorUserId: user.id,
      targetType: "share",
      targetId: parsed.data.userId,
      detail: "Revoked a user's access to a shared album.",
      ipAddress: request.ip
    });
    reply.send({ revoked: result.changes });
  });

  // Share a selection of gallery items *with a registered user* (the set dialog's
  // People tab). Grants a per-item user share for every item the caller can
  // curate; the rest are skipped and counted. Upsert so re-sharing refreshes the
  // expiry rather than erroring. The recipient sees them under "Shared with me".
  app.post("/api/shares/set/user", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(setUserShareSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid share details", details: parsed.error });
      return;
    }

    const user = request.user!;
    if (parsed.data.userId === user.id) {
      reply.code(400).send({ error: "You already have access to these photos" });
      return;
    }
    const target = db.prepare(
      "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
    ).get(parsed.data.userId) as { id: string } | undefined;
    if (!target) {
      reply.code(404).send({ error: "User not found" });
      return;
    }

    const { included, skipped } = shareableGalleryItems(user, parsed.data.itemIds);
    if (included.length === 0) {
      reply.code(403).send({ error: "Curator access required to share these photos." });
      return;
    }

    const expiresAt = parsed.data.expiresInDays ? addDays(parsed.data.expiresInDays).toISOString() : null;
    const insert = db.prepare(`
      INSERT INTO shares (id, module, resource_id, user_id, permission, created_by, expires_at)
      VALUES (?, 'gallery', ?, ?, 'read', ?, ?)
      ON CONFLICT (module, resource_id, user_id) DO UPDATE SET
        revoked_at = NULL,
        expires_at = excluded.expires_at,
        created_by = excluded.created_by,
        created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `);
    db.transaction(() => {
      for (const itemId of included) insert.run(nanoid(16), itemId, parsed.data.userId, user.id, expiresAt);
    })();
    logActivity({
      event: "share.granted",
      actorUserId: user.id,
      targetType: "share",
      targetId: parsed.data.userId,
      detail: `Shared ${included.length} gallery item${included.length === 1 ? "" : "s"} with a user.`,
      ipAddress: request.ip
    });

    reply.code(201).send({ granted: included.length, skipped });
  });

  // Recipients of a gallery selection — the People list for the set dialog. Only
  // the caller's own shares over items they can curate are reported, so this never
  // leaks (or lets them revoke) another curator's sharing. itemCount is how many of
  // the passed set each user currently has.
  app.post("/api/shares/set/recipients", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(setRecipientsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error });
      return;
    }
    const user = request.user!;
    const { included } = shareableGalleryItems(user, parsed.data.itemIds);
    if (included.length === 0) {
      reply.send({ recipients: [] });
      return;
    }
    const rows = db.prepare(`
      SELECT shares.user_id, users.display_name, users.email,
             COUNT(*) AS item_count,
             MIN(shares.expires_at) AS min_expires,
             SUM(CASE WHEN shares.expires_at IS NULL THEN 1 ELSE 0 END) AS never_expiring
      FROM shares
      JOIN users ON users.id = shares.user_id
      WHERE shares.module = 'gallery' AND shares.revoked_at IS NULL
        AND shares.created_by = ?
        AND shares.resource_id IN (${inClause(included.length)})
      GROUP BY shares.user_id
      ORDER BY users.display_name COLLATE NOCASE
    `).all(user.id, ...included) as {
      user_id: string;
      display_name: string;
      email: string;
      item_count: number;
      min_expires: string | null;
      never_expiring: number;
    }[];
    reply.send({
      recipients: rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email,
        itemCount: row.item_count,
        // If any share in the group never expires, present it as permanent; else the soonest.
        expiresAt: row.never_expiring > 0 ? null : row.min_expires
      }))
    });
  });

  // Revoke a user's access to a gallery selection — drops every share of theirs
  // over these items that the caller created (admins can drop any).
  app.post("/api/shares/set/user/revoke", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(setSelectionSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid request", details: parsed.error });
      return;
    }
    const user = request.user!;
    const ids = [...new Set(parsed.data.itemIds)];
    const scope = user.role === "admin" ? "" : "AND created_by = ?";
    const params = user.role === "admin"
      ? [parsed.data.userId, ...ids]
      : [parsed.data.userId, ...ids, user.id];
    const result = db.prepare(`
      UPDATE shares SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE module = 'gallery' AND revoked_at IS NULL AND user_id = ?
        AND resource_id IN (${inClause(ids.length)}) ${scope}
    `).run(...params);
    logActivity({
      event: "share.revoked",
      actorUserId: user.id,
      targetType: "share",
      targetId: parsed.data.userId,
      detail: `Revoked a user's access to ${result.changes} shared gallery item${result.changes === 1 ? "" : "s"}.`,
      ipAddress: request.ip
    });
    reply.send({ revoked: result.changes });
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

    const books = rows.map((row) => ({
      id: row.resource_id,
      type: mediaKind(row.library_type),
      title: row.title ?? path.basename(row.folder_path),
      coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
      sharedBy: row.shared_by,
      sharedAt: row.created_at,
      expiresAt: row.expires_at as string | null
    }));

    // Live album shares (module 'gallery_album', resource_id = album id) don't join
    // to a single library_item, so they're gathered separately. The cover + count
    // reflect only photos the SHARE CREATOR may curate — the same bound the album
    // viewer and file access enforce.
    const albumRows = db.prepare(`
      SELECT shares.resource_id AS album_id, shares.created_by, shares.created_at, shares.expires_at,
             gallery_albums.name AS album_name, gallery_albums.sort_mode,
             owner.display_name AS shared_by
      FROM shares
      JOIN gallery_albums ON gallery_albums.id = shares.resource_id
      LEFT JOIN users AS owner ON owner.id = shares.created_by
      WHERE shares.user_id = ? AND shares.module = 'gallery_album'
        AND shares.revoked_at IS NULL
        AND (shares.expires_at IS NULL OR datetime(shares.expires_at) > datetime('now'))
      ORDER BY datetime(shares.created_at) DESC
    `).all(user.id) as {
      album_id: string; created_by: string; created_at: string; expires_at: string | null;
      album_name: string; sort_mode: "taken_at" | "manual"; shared_by: string | null;
    }[];

    const albums = albumRows.map((row) => {
      const creator = db.prepare("SELECT id, role FROM users WHERE id = ?").get(row.created_by) as { id: string; role: string } | undefined;
      const items = creator ? loadAlbumShareItems(row.album_id, row.sort_mode, curatableGalleryLibraryIds(creator)) : [];
      const cover = items.find((item) => item.cover_storage_key)?.cover_storage_key ?? null;
      return {
        id: row.album_id,
        type: "gallery_album" as const,
        title: row.album_name,
        itemCount: items.length,
        coverUrl: cover ? `/api/library/covers/${cover}` : null,
        sharedBy: row.shared_by,
        sharedAt: row.created_at,
        expiresAt: row.expires_at
      };
    });

    // Merge and present newest-shared first (both lists are already sorted).
    const merged = [...books, ...albums].sort((a, b) => (a.sharedAt < b.sharedAt ? 1 : -1));
    return { books: merged };
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
    // Multi-item gallery links dispatch before the single-item resolver — they
    // have no single resource for it to load.
    const rawToken = (request.params as { token: string }).token;
    const setLink = resolveShareLink(rawToken);
    if (setLink && GALLERY_MULTI_MODULES.has(setLink.module)) {
      const meta = db.prepare(`
        SELECT share_links.label, share_links.expires_at, users.display_name AS shared_by
        FROM share_links LEFT JOIN users ON users.id = share_links.created_by
        WHERE share_links.id = ?
      `).get(setLink.id) as { label: string | null; expires_at: string; shared_by: string | null };
      const setItems = galleryMultiShareItems(setLink);
      // A live album has its own name; a quick set only has the link's optional
      // label. Prefer the label (the sharer's own wording) and fall back to the
      // album name, so the log always says which collection was opened.
      const isAlbum = setLink.module === "gallery_album";
      const resourceName = meta.label ?? (isAlbum ? loadAlbumShareMeta(setLink.resource_id)?.name ?? null : null);
      const kindWord = isAlbum ? "album" : "photo set";
      logActivity({
        event: "share.accessed",
        actorUserId: null,
        targetType: "share_link",
        targetId: setLink.id,
        detail: `Opened a shared ${kindWord}${resourceName ? ` "${resourceName}"` : ""} (${setItems.length} item${setItems.length === 1 ? "" : "s"}).`,
        ipAddress: request.ip
      });
      reply.send({
        type: "gallery_set",
        share: { label: meta.label, expiresAt: meta.expires_at, sharedBy: meta.shared_by },
        items: setItems.map((row) => ({
          id: row.id,
          title: row.title ?? path.basename(row.folder_path),
          kind: row.kind,
          width: row.width,
          height: row.height,
          durationSeconds: row.duration_seconds,
          takenAt: row.taken_at,
          coverUrl: row.cover_storage_key ? `/api/share/${rawToken}/items/${row.id}/cover` : null,
          previewUrl: row.preview_storage_key || row.cover_storage_key
            ? `/api/share/${rawToken}/items/${row.id}/preview`
            : null,
          fileUrl: `/api/share/${rawToken}/items/${row.id}/file`,
          downloadUrl: `/api/share/${rawToken}/items/${row.id}/download`
        }))
      });
      return;
    }

    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { token, link, module, item } = resolved;

    const meta = db.prepare(`
      SELECT share_links.label, share_links.expires_at, users.display_name AS shared_by
      FROM share_links LEFT JOIN users ON users.id = share_links.created_by
      WHERE share_links.id = ?
    `).get(link.id) as { label: string | null; expires_at: string; shared_by: string | null };

    logActivity({
      event: "share.accessed",
      actorUserId: null,
      targetType: "share_link",
      targetId: link.id,
      detail: `Opened a shared ${module} "${item.title ?? path.basename(item.folder_path)}".`,
      ipAddress: request.ip
    });

    const share = { label: meta.label, expiresAt: meta.expires_at, sharedBy: meta.shared_by };
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

  // --- Public: gallery quick-link members ---------------------------------
  // Membership in share_link_items is the whole authorization: a valid set
  // token plus an item id inside that set. Anything else is a uniform 404.

  const resolveSetItem = (request: FastifyRequest, reply: FastifyReply) => {
    const { token, itemId } = request.params as { token: string; itemId: string };
    const link = resolveShareLink(token);
    if (!link || !GALLERY_MULTI_MODULES.has(link.module)) {
      reply.code(404).send({ error: "Share not found or expired" });
      return null;
    }
    const item = galleryMultiShareMediaItem(link, itemId);
    if (!item) {
      reply.code(404).send({ error: "File not found" });
      return null;
    }
    return { link, item };
  };

  app.get("/api/share/:token/items/:itemId/cover", async (request, reply) => {
    const resolved = resolveSetItem(request, reply);
    if (!resolved) return;
    if (!resolved.item.cover_storage_key) {
      reply.code(404).send({ error: "Cover not found" });
      return;
    }
    await sendThumbnail(reply, resolved.item.cover_storage_key);
  });

  // Larger render for the viewer overlay; falls back to the grid thumbnail.
  app.get("/api/share/:token/items/:itemId/preview", async (request, reply) => {
    const resolved = resolveSetItem(request, reply);
    if (!resolved) return;
    const key = resolved.item.preview_storage_key ?? resolved.item.cover_storage_key;
    if (!key) {
      reply.code(404).send({ error: "Preview not found" });
      return;
    }
    await sendThumbnail(reply, key);
  });

  app.get("/api/share/:token/items/:itemId/file", (request, reply) => {
    const resolved = resolveSetItem(request, reply);
    if (!resolved) return;
    const { item } = resolved;
    const filePath = path.join(item.source_path, ...item.relative_path.split("/"));
    if (!pathIsInside(filePath, item.source_path) || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "File not found" });
      return;
    }
    sendFile(request, reply, {
      absolutePath: filePath,
      mimeType: item.mime_type ?? "application/octet-stream",
      fileName: item.relative_path.split("/").pop() ?? "file",
      download: false
    });
  });

  app.get("/api/share/:token/items/:itemId/download", (request, reply) => {
    const resolved = resolveSetItem(request, reply);
    if (!resolved) return;
    const { link, item } = resolved;
    const filePath = path.join(item.source_path, ...item.relative_path.split("/"));
    if (!pathIsInside(filePath, item.source_path) || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "File not found" });
      return;
    }
    logActivity({
      event: "share.downloaded",
      actorUserId: null,
      targetType: "share_link",
      targetId: link.id,
      detail: `Downloaded a ${item.kind === "video" ? "video" : "photo"} "${item.relative_path.split("/").pop() ?? "file"}" from a shared set.`,
      ipAddress: request.ip
    });
    sendFile(request, reply, {
      absolutePath: filePath,
      mimeType: item.mime_type ?? "application/octet-stream",
      fileName: item.relative_path.split("/").pop() ?? "file",
      download: true
    });
  });

  // Download every photo/video in a shared set as one zip. Stored (level 0) — the
  // members are already-compressed JP/MP4, so compression only burns CPU. Missing
  // files are skipped; duplicate basenames get a " (n)" suffix so none overwrite.
  app.get("/api/share/:token/download-all", (request, reply) => {
    const token = (request.params as { token: string }).token;
    const link = resolveShareLink(token);
    if (!link || !GALLERY_MULTI_MODULES.has(link.module)) {
      reply.code(404).send({ error: "Share not found or expired" });
      return;
    }

    const available = galleryMultiShareFiles(link).filter((file) => {
      const filePath = path.join(file.source_path, ...file.relative_path.split("/"));
      return pathIsInside(filePath, file.source_path) && fs.existsSync(filePath);
    });
    if (available.length === 0) {
      reply.code(404).send({ error: "No files available" });
      return;
    }

    const meta = db.prepare("SELECT label FROM share_links WHERE id = ?").get(link.id) as { label: string | null } | undefined;
    const isAlbum = link.module === "gallery_album";
    const resourceName = meta?.label ?? (isAlbum ? loadAlbumShareMeta(link.resource_id)?.name ?? null : null);
    const kindWord = isAlbum ? "album" : "set";
    const safeBase = (resourceName ?? "shared-photos").replace(/[/\\?%*:|"<>]/g, "_").trim() || "shared-photos";
    const zipName = `${safeBase}.zip`;

    logActivity({
      event: "share.downloaded",
      actorUserId: null,
      targetType: "share_link",
      targetId: link.id,
      detail: `Downloaded all ${available.length} item${available.length === 1 ? "" : "s"} from a shared ${kindWord}${resourceName ? ` "${resourceName}"` : ""}.`,
      ipAddress: request.ip
    });

    const asciiFilename = zipName.replace(/[^\x20-\x7E]/g, "_");
    const encodedFilename = encodeURIComponent(zipName);
    const archive = archiver("zip", { zlib: { level: 0 } });
    archive.on("error", (err) => { reply.raw.destroy(err); });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
      "Cache-Control": "private, no-cache"
    });
    archive.pipe(reply.raw);

    const usedNames = new Map<string, number>();
    for (const file of available) {
      const filePath = path.join(file.source_path, ...file.relative_path.split("/"));
      let name = file.relative_path.split("/").pop() ?? "file";
      const seen = usedNames.get(name) ?? 0;
      usedNames.set(name, seen + 1);
      if (seen > 0) {
        const ext = path.extname(name);
        name = `${name.slice(0, name.length - ext.length)} (${seen})${ext}`;
      }
      archive.file(filePath, { name });
    }
    archive.finalize();
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

    const displayTitle = item.title ?? path.basename(item.folder_path);
    const safeTitle = displayTitle.replace(/[/\\?%*:|"<>]/g, "_").trim();

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
        detail: `Downloaded a shared ${gal.kind === "video" ? "video" : "photo"} "${displayTitle}".`,
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
        detail: `Downloaded a shared ebook "${displayTitle}".`,
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
      detail: `Downloaded a shared audiobook "${displayTitle}".`,
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
