import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZipArchive } from "archiver";
import { db, logActivity } from "../../../../db.js";
import { optionalUser } from "../../../../auth.js";
import { pathIsInside } from "../storage-roots.js";
import { thumbnailAbsolutePath } from "../thumbnail.js";
import { resolveShareLink, type ResolvedShareLink } from "../share-access.js";
import { getShareKind } from "../share-kinds.js";
import type { MediaModule } from "../library-types.js";
import { coverMimeByExt, extForContentType, sendFile, sendGalleryFile, sendThumbnail, stripImageMetadata, withExtension } from "./serve.js";
import {
  loadGallerySetFiles,
  loadGallerySetItems,
  loadGallerySetMediaItem,
  type GallerySetFileRow,
  type GallerySetItemRow
} from "./gallery-set-shares.js";
import {
  curatableGalleryLibraryIds,
  loadAlbumShareFiles,
  loadAlbumShareItems,
  loadAlbumShareMediaItem,
  loadAlbumShareMeta,
  type AlbumShareMeta
} from "./album-shares.js";
import type {
  AudioFileRow, AudiobookDetailRow, DocumentFileRow, GalleryDetailRow, ItemMetadataRow, LibraryItemRow, LibraryRow, Nullable, ShareLinkRow, UserRow
} from "../../../../db/rows.js";

function splitNames(value: string | null): string[] {
  return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

// Common item fields needed by every public route, independent of media type. Authors
// apply to both books; type-specific extras (narrators, files, documents) are loaded
// per branch below.
interface ShareItemRow
  extends Pick<LibraryRow, "source_path">,
  Pick<LibraryItemRow, "folder_path">,
  Nullable<Pick<ItemMetadataRow, "cover_storage_key" | "title" | "description">> {
  library_type: LibraryRow["type"];
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
type ShareDocumentRow = Pick<DocumentFileRow, "id" | "relative_path" | "mime_type" | "format">;

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
type ShareGalleryRow = Pick<GalleryDetailRow, "kind" | "relative_path" | "mime_type" | "width" | "height" | "duration_seconds">;

// The link's own label and expiry, and who made it (LEFT JOINed, so possibly NULL).
type ShareMetaRow = Pick<ShareLinkRow, "label" | "expires_at"> & { shared_by: UserRow["display_name"] | null };

function loadShareGalleryAsset(resourceId: string): ShareGalleryRow | undefined {
  return db.prepare(`
    SELECT kind, relative_path, mime_type, width, height, duration_seconds
    FROM gallery_details
    WHERE item_id = ?
  `).get(resourceId) as ShareGalleryRow | undefined;
}

// --- Serving a gallery multi-share (set snapshot OR live album), one seam -----
// The public routes below don't care which kind they hold: they resolve items,
// files, and single media rows through these dispatchers. Album links resolve
// live against the link creator's current curate rights.
const GALLERY_MULTI_MODULES = new Set(["gallery_set", "gallery_album"]);

function albumLinkCtx(link: ResolvedShareLink): { meta: AlbumShareMeta; libIds: string[] } | null {
  const meta = loadAlbumShareMeta(link.resource_id);
  if (!meta) return null;
  const creator = db.prepare("SELECT id, role FROM users WHERE id = ?").get(link.created_by) as Pick<UserRow, "id" | "role"> | undefined;
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

export function registerShareGuestRoutes(app: FastifyInstance) {
  // --- Public: guest access (no authentication) ---------------------------

  // These are the only routes on the box reachable without an account, so they get
  // their own per-IP buckets instead of riding the generous global ceiling. The
  // token can't be guessed (~216 bits), so this isn't about brute force — it bounds
  // what a *leaked* link can cost in bandwidth and CPU. Sized per shape: opening a
  // shared album fans out into one page load plus a thumbnail per photo, seeking
  // within a video issues many range requests, and building a zip of a whole album
  // is expensive enough to deserve a hard ceiling.
  const SHARE_PAGE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  const SHARE_THUMB_LIMIT = { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } };
  const SHARE_MEDIA_LIMIT = { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } };
  const SHARE_ZIP_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  // Who opened a share link, when we can tell. A share link authenticates nobody
  // by design, so this is never a condition of being served — it only decides
  // whether the log entry carries a name. A signed-in visitor's cookie reaches
  // these routes because the share page is same-origin, so most opens from inside
  // the household resolve; a stranger with the link, or someone signed out, stays
  // anonymous and is recorded by IP exactly as before.
  //
  // Deliberately NOT wired into the sign-in dashboard: that view counts
  // authentications, and a share link is the case where none happened. Naming the
  // visitor here answers "who looked at the thing I shared", which belongs in the
  // activity log, not in the count of who got past the front door.
  function shareVisitor(request: FastifyRequest): string | null {
    return optionalUser(request)?.id ?? null;
  }

  // Resolve a token to its (link, item), or send 404. Used by every public route.
  // Only digital-library modules are servable here.
  function resolveOr404(request: FastifyRequest, reply: FastifyReply) {
    const token = (request.params as { token: string }).token;
    const link = resolveShareLink(token, request);
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

  app.get("/api/share/:token", SHARE_PAGE_LIMIT, async (request, reply) => {
    // Multi-item gallery links dispatch before the single-item resolver — they
    // have no single resource for it to load.
    const rawToken = (request.params as { token: string }).token;
    const setLink = resolveShareLink(rawToken, request);

    // A link of another module's kind (a story) has no single library item
    // either; the module that registered the kind owns the shape of what it
    // serves (share-kinds.ts).
    const setKind = setLink ? getShareKind(setLink.module) : undefined;
    if (setLink && setKind) {
      const built = setKind.buildPage(setLink, rawToken);
      if (!built) {
        return reply.code(404).send({ error: "Share not found or expired" });
      }
      logActivity({
        event: "share.accessed",
        actorUserId: shareVisitor(request),
        targetType: "share_link",
        targetId: setLink.id,
        detail: `Opened a shared ${setKind.noun} "${built.title}" (${built.photoCount} photo${built.photoCount === 1 ? "" : "s"}).`,
        ipAddress: request.ip
      });
      return reply.send(built.payload);
    }

    if (setLink && GALLERY_MULTI_MODULES.has(setLink.module)) {
      const meta = db.prepare(`
        SELECT share_links.label, share_links.expires_at, users.display_name AS shared_by
        FROM share_links LEFT JOIN users ON users.id = share_links.created_by
        WHERE share_links.id = ?
      `).get(setLink.id) as ShareMetaRow;
      const setItems = galleryMultiShareItems(setLink);
      // A live album has its own name; a quick set only has the link's optional
      // label. Prefer the label (the sharer's own wording) and fall back to the
      // album name, so the log always says which collection was opened.
      const isAlbum = setLink.module === "gallery_album";
      const resourceName = meta.label ?? (isAlbum ? loadAlbumShareMeta(setLink.resource_id)?.name ?? null : null);
      const kindWord = isAlbum ? "album" : "photo set";
      logActivity({
        event: "share.accessed",
        actorUserId: shareVisitor(request),
        targetType: "share_link",
        targetId: setLink.id,
        detail: `Opened a shared ${kindWord}${resourceName ? ` "${resourceName}"` : ""} (${setItems.length} item${setItems.length === 1 ? "" : "s"}).`,
        ipAddress: request.ip
      });
      return reply.send({
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
    }

    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { token, link, module, item } = resolved;

    const meta = db.prepare(`
      SELECT share_links.label, share_links.expires_at, users.display_name AS shared_by
      FROM share_links LEFT JOIN users ON users.id = share_links.created_by
      WHERE share_links.id = ?
    `).get(link.id) as ShareMetaRow;

    logActivity({
      event: "share.accessed",
      actorUserId: shareVisitor(request),
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
        return reply.code(404).send({ error: "Share not found or expired" });
      }
      return reply.send({
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
    }

    if (module === "ebook") {
      const doc = loadShareDocument(link.resource_id);
      if (!doc) {
        return reply.code(404).send({ error: "Share not found or expired" });
      }
      return reply.send({
        type: "ebook",
        share,
        book: { title, authors, description: item.description, coverUrl, format: doc.format }
      });
    }

    // Audiobook: chapter/track list + narrators + total duration for the player.
    const detail = db.prepare(
      "SELECT duration_seconds FROM audiobook_details WHERE item_id = ?"
    ).get(link.resource_id) as Pick<AudiobookDetailRow, "duration_seconds"> | undefined;
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
    `).all(link.resource_id) as (Pick<AudioFileRow, "id" | "track_number" | "duration_seconds"> & { chapter_title: AudioFileRow["title"] })[];

    return reply.send({
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

  app.get("/api/share/:token/cover", SHARE_THUMB_LIMIT, async (request, reply) => {
    const resolved = resolveOr404(request, reply);
    if (!resolved) return;
    const { item } = resolved;
    if (!item.cover_storage_key) {
      return reply.code(404).send({ error: "Cover not found" });
    }
    try {
      const absolutePath = thumbnailAbsolutePath(item.cover_storage_key);
      const cover = await fsp.readFile(absolutePath);
      return reply
        .type(coverMimeByExt[path.extname(item.cover_storage_key).toLowerCase()] ?? "application/octet-stream")
        .header("Content-Length", cover.byteLength)
        .header("Cache-Control", "public, max-age=3600")
        .send(cover);
    } catch {
      return reply.code(404).send({ error: "Cover not found" });
    }
  });

  // --- Public: gallery quick-link members ---------------------------------
  // Membership in share_link_items is the whole authorization: a valid set
  // token plus an item id inside that set. Anything else is a uniform 404.

  // The item routes below serve any link whose resource is a SET of photos —
  // a quick link, an album, or a registered kind (a story). Each module answers
  // "is this item mine to serve?" its own way, and that answer IS the
  // authorization: an id the link doesn't cover is indistinguishable from a
  // missing file.
  const resolveSetItem = (request: FastifyRequest, reply: FastifyReply) => {
    const { token, itemId } = request.params as { token: string; itemId: string };
    const link = resolveShareLink(token, request);
    const kind = link ? getShareKind(link.module) : undefined;
    if (!link || !(GALLERY_MULTI_MODULES.has(link.module) || kind)) {
      reply.code(404).send({ error: "Share not found or expired" });
      return null;
    }
    const item = kind
      ? kind.loadMediaItem(link, itemId)
      : galleryMultiShareMediaItem(link, itemId);
    if (!item) {
      reply.code(404).send({ error: "File not found" });
      return null;
    }
    return { link, item };
  };

  // A shared story's narration (/api/share/:token/audio/:audioId) is served by
  // the stories module (stories/share-routes.ts).

  app.get("/api/share/:token/items/:itemId/cover", SHARE_THUMB_LIMIT, async (request, reply) => {
    const resolved = resolveSetItem(request, reply);
    if (!resolved) return;
    if (!resolved.item.cover_storage_key) {
      return reply.code(404).send({ error: "Cover not found" });
    }
    return sendThumbnail(reply, resolved.item.cover_storage_key);
  });

  // Larger render for the viewer overlay; falls back to the grid thumbnail.
  app.get("/api/share/:token/items/:itemId/preview", SHARE_THUMB_LIMIT, async (request, reply) => {
    const resolved = resolveSetItem(request, reply);
    if (!resolved) return;
    const key = resolved.item.preview_storage_key ?? resolved.item.cover_storage_key;
    if (!key) {
      return reply.code(404).send({ error: "Preview not found" });
    }
    return sendThumbnail(reply, key);
  });

  app.get("/api/share/:token/items/:itemId/file", SHARE_MEDIA_LIMIT, (request, reply) => {
    const resolved = resolveSetItem(request, reply);
    if (!resolved) return;
    const { item } = resolved;
    const filePath = path.join(item.source_path, ...item.relative_path.split("/"));
    if (!pathIsInside(filePath, item.source_path) || !fs.existsSync(filePath)) {
      reply.code(404).send({ error: "File not found" });
      return;
    }
    return sendGalleryFile(request, reply, {
      absolutePath: filePath,
      mimeType: item.mime_type,
      fileName: item.relative_path.split("/").pop() ?? "file",
      kind: item.kind,
      download: false
    });
  });

  app.get("/api/share/:token/items/:itemId/download", SHARE_MEDIA_LIMIT, (request, reply) => {
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
      actorUserId: shareVisitor(request),
      targetType: "share_link",
      targetId: link.id,
      detail: `Downloaded a ${item.kind === "video" ? "video" : "photo"} "${item.relative_path.split("/").pop() ?? "file"}" from a shared set.`,
      ipAddress: request.ip
    });
    return sendGalleryFile(request, reply, {
      absolutePath: filePath,
      mimeType: item.mime_type,
      fileName: item.relative_path.split("/").pop() ?? "file",
      kind: item.kind,
      download: true
    });
  });

  // Download every photo/video in a shared set as one zip. Stored (level 0) — the
  // members are already-compressed JP/MP4, so compression only burns CPU. Missing
  // files are skipped; duplicate basenames get a " (n)" suffix so none overwrite.
  app.get("/api/share/:token/download-all", SHARE_ZIP_LIMIT, async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const link = resolveShareLink(token, request);
    const kind = link ? getShareKind(link.module) : undefined;
    if (!link || !(GALLERY_MULTI_MODULES.has(link.module) || kind)) {
      return reply.code(404).send({ error: "Share not found or expired" });
    }

    // A registered kind (a story) says which files its link exposes.
    const available = (kind ? kind.listFiles(link) : galleryMultiShareFiles(link)).filter((file) => {
      const filePath = path.join(file.source_path, ...file.relative_path.split("/"));
      return pathIsInside(filePath, file.source_path) && fs.existsSync(filePath);
    });
    if (available.length === 0) {
      return reply.code(404).send({ error: "No files available" });
    }

    const meta = db.prepare("SELECT label FROM share_links WHERE id = ?").get(link.id) as Pick<ShareLinkRow, "label"> | undefined;
    const isAlbum = link.module === "gallery_album";
    const resourceName = meta?.label
      ?? (isAlbum ? loadAlbumShareMeta(link.resource_id)?.name : null)
      ?? (kind ? kind.title(link.resource_id) : null);
    const kindWord = kind ? kind.noun : isAlbum ? "album" : "set";
    const safeBase = (resourceName ?? "shared-photos").replace(/[/\\?%*:|"<>]/g, "_").trim() || "shared-photos";
    const zipName = `${safeBase}.zip`;

    logActivity({
      event: "share.downloaded",
      actorUserId: shareVisitor(request),
      targetType: "share_link",
      targetId: link.id,
      detail: `Downloaded all ${available.length} item${available.length === 1 ? "" : "s"} from a shared ${kindWord}${resourceName ? ` "${resourceName}"` : ""}.`,
      ipAddress: request.ip
    });

    const asciiFilename = zipName.replace(/[^\x20-\x7E]/g, "_");
    const encodedFilename = encodeURIComponent(zipName);
    const archive = new ZipArchive({ zlib: { level: 0 } });
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
      const originalName = file.relative_path.split("/").pop() ?? "file";
      // Strip a photo first, so its FINAL (possibly re-extensioned) name is known
      // before de-dup. A photo that can't be decoded at all is SKIPPED, not
      // archived as the original — the fail-safe that never leaks EXIF. Videos are
      // archived as the original.
      let buffer: Buffer | null = null;
      let finalName = originalName;
      if (file.kind === "photo") {
        const stripped = await stripImageMetadata(filePath);
        if (!stripped) continue;
        buffer = stripped.buffer;
        finalName = withExtension(originalName, extForContentType(stripped.contentType));
      }
      // De-dup on the FINAL name, so a HEIC + JPG pair sharing a basename (both now
      // ".jpg") don't collide into one entry that overwrites the other on extract.
      const seen = usedNames.get(finalName) ?? 0;
      usedNames.set(finalName, seen + 1);
      let name = finalName;
      if (seen > 0) {
        const ext = path.extname(name);
        name = `${name.slice(0, name.length - ext.length)} (${seen})${ext}`;
      }
      if (buffer) {
        archive.append(buffer, { name });
      } else {
        archive.file(filePath, { name });
      }
    }
    archive.finalize();
  });

  // Audiobook only: stream one audio track (direct play, no transcode, range).
  app.get("/api/share/:token/stream/:fileId", SHARE_MEDIA_LIMIT, (request, reply) => {
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
    `).get(fileId, resolved.link.resource_id) as Pick<AudioFileRow, "relative_path" | "mime_type" | "status"> | undefined;

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
  app.get("/api/share/:token/file", SHARE_MEDIA_LIMIT, (request, reply) => {
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
      return sendGalleryFile(request, reply, {
        absolutePath: galPath,
        mimeType: gal.mime_type,
        fileName: gal.relative_path.split("/").pop() ?? "file",
        kind: gal.kind,
        download: false
      });
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

  app.get("/api/share/:token/download", SHARE_MEDIA_LIMIT, (request, reply) => {
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
        actorUserId: shareVisitor(request),
        targetType: "share_link",
        targetId: link.id,
        detail: `Downloaded a shared ${gal.kind === "video" ? "video" : "photo"} "${displayTitle}".`,
        ipAddress: request.ip
      });
      const ext = path.extname(gal.relative_path);
      return sendGalleryFile(request, reply, {
        absolutePath: galPath,
        mimeType: gal.mime_type,
        fileName: `${safeTitle || "file"}${ext}`,
        kind: gal.kind,
        download: true
      });
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
        actorUserId: shareVisitor(request),
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
    `).all(link.resource_id) as Pick<AudioFileRow, "relative_path">[];

    if (files.length === 0) {
      reply.code(404).send({ error: "No audio files available" });
      return;
    }

    logActivity({
      event: "share.downloaded",
      actorUserId: shareVisitor(request),
      targetType: "share_link",
      targetId: link.id,
      detail: `Downloaded a shared audiobook "${displayTitle}".`,
      ipAddress: request.ip
    });

    const zipName = `${safeTitle || "audiobook"}.zip`;
    const asciiFilename = zipName.replace(/[^\x20-\x7E]/g, "_");
    const encodedFilename = encodeURIComponent(zipName);
    const archive = new ZipArchive({ zlib: { level: 0 } });
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
