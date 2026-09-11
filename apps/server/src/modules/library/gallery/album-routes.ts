// Album endpoints. Reads are open to every member (items filtered per viewer's
// library access); writes require canEditAlbum (creator + admins). Batch bodies
// follow the bulk contract: inaccessible items are skipped and counted.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ZipArchive } from "archiver";
import { db, logActivity } from "../../../db.js";
import { parseBody, parseQuery } from "../../../core/shared.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { deleteSharesForResource } from "../shared/share-access.js";
import { deleteStoryBlocksForResource } from "../../stories/cleanup.js";
import { deleteEntityTags, getEntityTags, setEntityTags } from "../shared/tagging.js";
import { loadAlbumShareMeta, loadAlbumShareItems, curatableGalleryLibraryIds } from "../shared/shares/album-shares.js";
import { resolveGalleryScopeLibraryIds } from "./catalog-scope.js";
import {
  getAlbum,
  canEditAlbum,
  createAlbum,
  updateAlbum,
  deleteAlbum,
  addAlbumItems,
  removeAlbumItems,
  listAlbums,
  getAlbumItems,
  getAlbumFilePaths,
  type AlbumRow
} from "./albums.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional()
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  sortMode: z.enum(["taken_at", "manual"]).optional(),
  coverItemId: z.string().trim().min(1).max(64).nullable().optional()
});

// An album's tags, replaced in one call — the same contract stories use.
const tagsSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(80)).max(50)
});

const itemsSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500)
});

// Strings, not numbers: junk falls back to the defaults in the handler.
const pageQuerySchema = z.object({ limit: z.string().optional(), offset: z.string().optional() });

export const ALBUM_ENTITY_TYPE = "gallery_album";

export async function galleryAlbumRoutesPlugin(app: FastifyInstance) {
  // Load + authorize an album for a write. Uniform 404 for "missing" and
  // "exists but not yours to edit" would hide too much — editors are members
  // here, so a clear 403 is friendlier and leaks nothing (albums are listable).
  const editableAlbum = (albumId: string, user: { id: string; role: string }, reply: FastifyReply): AlbumRow | null => {
    const album = getAlbum(albumId);
    if (!album) {
      reply.code(404).send({ error: "Album not found" });
      return null;
    }
    if (!canEditAlbum(album, user)) {
      reply.code(403).send({ error: "Only the album's creator or an admin can change it." });
      return null;
    }
    return album;
  };

  app.get("/api/library/gallery/albums", { preHandler: app.authenticate }, async (request) => {
    const libIds = resolveGalleryScopeLibraryIds(request.user!);
    return { albums: listAlbums(request.user!, libIds) };
  });

  app.post("/api/library/gallery/albums", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid album details", details: parsed.error });
    }
    const album = createAlbum(request.user!, parsed.data.name, parsed.data.description ?? null);
    logActivity({
      event: "gallery.album.created",
      actorUserId: request.user!.id,
      targetType: "gallery_album",
      targetId: album.id,
      detail: `Created gallery album "${album.name}".`,
      ipAddress: request.ip
    });
    return reply.code(201).send({
      album: {
        id: album.id,
        name: album.name,
        description: album.description,
        itemCount: 0,
        coverUrl: null,
        sortMode: album.sort_mode,
        canEdit: true,
        updatedAt: album.updated_at
      }
    });
  });

  // Album detail: metadata + one page of the viewer's visible items.
  app.get("/api/library/gallery/albums/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const album = getAlbum((request.params as { id: string }).id);
    const user = request.user!;
    if (!album) {
      return reply.code(404).send({ error: "Album not found" });
    }
    const parsed = parseQuery(pageQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const qp = parsed.data;
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    const libIds = resolveGalleryScopeLibraryIds(user);
    const { assets, total } = getAlbumItems(user.id, libIds, album, limit, offset);
    // The zero-visible rule from the list applies here too: a member who can't
    // see any of the album's items shouldn't learn it exists via deep link.
    if (total === 0 && !canEditAlbum(album, user)) {
      return reply.code(404).send({ error: "Album not found" });
    }
    return reply.send({
      album: {
        id: album.id,
        name: album.name,
        description: album.description,
        sortMode: album.sort_mode,
        coverItemId: album.cover_item_id,
        canEdit: canEditAlbum(album, user),
        updatedAt: album.updated_at,
        tags: getEntityTags(ALBUM_ENTITY_TYPE, album.id)
      },
      assets,
      total
    });
  });

  // Tagging an album is what connects it to the stories, photos and people that
  // share the tag — the cross-type browse treats it as one more taggable thing.
  app.put("/api/library/gallery/albums/:id/tags", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return reply;
    const parsed = parseBody(tagsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid tags", details: parsed.error });
    }
    setEntityTags(ALBUM_ENTITY_TYPE, album.id, parsed.data.tags);
    return reply.send({ tags: getEntityTags(ALBUM_ENTITY_TYPE, album.id) });
  });

  // A recipient's view of an album shared *with them* (or the owner previewing
  // their own). Items resolve LIVE, bounded to the libraries the share's creator
  // may curate — so it always mirrors the album and never over-exposes. Access to
  // each photo's file/cover flows through the normal gallery routes (canUserAccessBook
  // now honors an album share), so this only needs to return the item list + URLs.
  app.get("/api/library/gallery/shared-albums/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const albumId = (request.params as { id: string }).id;
    const user = request.user!;
    const meta = loadAlbumShareMeta(albumId);
    if (!meta) { return reply.code(404).send({ error: "Album not found" }); }

    // Whose curate rights vouch for the photos: the owner/admin previewing sees it
    // with their own; a recipient sees it through the share creator's.
    let creator: { id: string; role: string } | null = null;
    if (user.role === "admin" || meta.created_by === user.id) {
      creator = user;
    } else {
      const share = db.prepare(`
        SELECT created_by FROM shares
        WHERE module = 'gallery_album' AND resource_id = ? AND user_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).get(albumId, user.id) as { created_by: string } | undefined;
      if (share) {
        creator = db.prepare("SELECT id, role FROM users WHERE id = ?").get(share.created_by) as { id: string; role: string } | undefined ?? null;
      }
    }
    if (!creator) { return reply.code(404).send({ error: "Album not found" }); }

    const items = loadAlbumShareItems(albumId, meta.sort_mode, curatableGalleryLibraryIds(creator));
    return reply.send({
      album: { id: albumId, name: meta.name },
      items: items.map((row) => ({
        id: row.id,
        title: row.title ?? path.basename(row.folder_path),
        kind: row.kind,
        width: row.width,
        height: row.height,
        durationSeconds: row.duration_seconds,
        takenAt: row.taken_at,
        coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
        previewUrl: row.preview_storage_key
          ? `/api/library/covers/${row.preview_storage_key}`
          : (row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null),
        fileUrl: `/api/library/gallery/assets/${row.id}/file`
      }))
    });
  });

  // Download the album as one zip of the items the viewer can see (library-access
  // filtered, in the album's sort order). Stored (level 0) — photos/videos are
  // already compressed. Missing files skip; duplicate basenames get a " (n)".
  app.get("/api/library/gallery/albums/:id/download", { preHandler: app.authenticate }, (request, reply) => {
    const album = getAlbum((request.params as { id: string }).id);
    const user = request.user!;
    if (!album) {
      reply.code(404).send({ error: "Album not found" });
      return;
    }
    const libIds = resolveGalleryScopeLibraryIds(user);
    const available = getAlbumFilePaths(libIds, album).filter((file) => {
      const filePath = path.join(file.source_path, ...file.relative_path.split("/"));
      return pathIsInside(filePath, file.source_path) && fs.existsSync(filePath);
    });
    if (available.length === 0) {
      reply.code(404).send({ error: "No files available" });
      return;
    }

    const safeBase = album.name.replace(/[/\\?%*:|"<>]/g, "_").trim() || "album";
    const zipName = `${safeBase}.zip`;

    logActivity({
      event: "gallery.album.downloaded",
      actorUserId: user.id,
      targetType: "gallery_album",
      targetId: album.id,
      detail: `Downloaded ${available.length} item${available.length === 1 ? "" : "s"} from album "${album.name}".`,
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

  app.patch("/api/library/gallery/albums/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return reply;
    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid album details", details: parsed.error });
    }
    if (!updateAlbum(album.id, parsed.data)) {
      return reply.code(400).send({ error: "The cover must be a photo inside the album." });
    }
    return reply.send({ updated: true });
  });

  app.delete("/api/library/gallery/albums/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return reply;
    deleteAlbum(album.id);
    // Live album shares reference the album by id with no FK, so drop them here or
    // they'd linger as dead links / phantom "Shared with me" tiles. Story blocks
    // point at it the same way — same reason, same sweep.
    deleteSharesForResource(ALBUM_ENTITY_TYPE, album.id);
    deleteStoryBlocksForResource(ALBUM_ENTITY_TYPE, album.id);
    deleteEntityTags(ALBUM_ENTITY_TYPE, album.id);
    logActivity({
      event: "gallery.album.deleted",
      actorUserId: user.id,
      targetType: "gallery_album",
      targetId: album.id,
      detail: `Deleted gallery album "${album.name}". The photos themselves were not affected.`,
      ipAddress: request.ip
    });
    return reply.send({ deleted: true });
  });

  // An album made in one step from a selection or a whole folder — the carrier
  // for "Ask someone" (docs/for-you-plan.md, docs/photo-review-plan.md phase 3):
  // the question rides on an album share, so a folder or a handful of photos
  // becomes an album first, named by the sender, and is then sent with the
  // question or opened in Review mode. Capped like the items route; a folder
  // takes its first 500 photos in the viewer's scope.
  const fromSchema = z.object({
    name: z.string().trim().min(1).max(120),
    itemIds: z.array(z.string().trim().min(1).max(64)).max(500).optional(),
    folder: z.object({
      libraryId: z.string().trim().min(1).max(64),
      path: z.string().trim().max(1024)
    }).optional()
  }).refine((body) => (body.itemIds?.length ?? 0) > 0 || body.folder !== undefined, { message: "Pick some photos or a folder." });

  app.post("/api/library/gallery/albums/from", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const parsed = parseBody(fromSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid album details", details: parsed.error });
    }
    const libIds = new Set(resolveGalleryScopeLibraryIds(user));
    let itemIds = parsed.data.itemIds ?? [];
    if (parsed.data.folder) {
      if (!libIds.has(parsed.data.folder.libraryId)) {
        return reply.code(404).send({ error: "Folder not found" });
      }
      const folderPath = parsed.data.folder.path.replace(/^\/+|\/+$/g, "");
      const rows = db.prepare(`
        SELECT library_items.id FROM library_items
        JOIN gallery_details ON gallery_details.item_id = library_items.id
        WHERE library_items.library_id = ? AND library_items.deleted_at IS NULL
          AND (? = '' OR library_items.folder_path LIKE ? ESCAPE '\\')
        ORDER BY gallery_details.taken_at ASC, library_items.folder_path COLLATE NOCASE
        LIMIT 500
      `).all(parsed.data.folder.libraryId, folderPath, `${folderPath.replace(/[\\%_]/g, "\\$&")}/%`) as { id: string }[];
      itemIds = rows.map((row) => row.id);
    }
    if (itemIds.length === 0) {
      return reply.code(400).send({ error: "There are no photos to put in the album." });
    }
    const album = createAlbum(user, parsed.data.name, null);
    const { added } = addAlbumItems(album.id, libIds, itemIds);
    logActivity({
      event: "gallery.album.created",
      actorUserId: user.id,
      targetType: "gallery_album",
      targetId: album.id,
      detail: `Created gallery album "${album.name}" from ${added} photo${added === 1 ? "" : "s"}${parsed.data.folder ? " in a folder" : ""}.`,
      ipAddress: request.ip
    });
    return reply.code(201).send({
      album: {
        id: album.id,
        name: album.name,
        description: album.description,
        itemCount: added,
        coverUrl: null,
        sortMode: album.sort_mode,
        canEdit: true,
        updatedAt: album.updated_at
      }
    });
  });

  app.post("/api/library/gallery/albums/:id/items", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return reply;
    const parsed = parseBody(itemsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid items", details: parsed.error });
    }
    const libIds = new Set(resolveGalleryScopeLibraryIds(user));
    return reply.send(addAlbumItems(album.id, libIds, parsed.data.itemIds));
  });

  // Batch remove (detach only — the photos stay in the gallery). A body on
  // DELETE is awkward for some clients, so removal is a POST like the add.
  app.post("/api/library/gallery/albums/:id/items/remove", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return reply;
    const parsed = parseBody(itemsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid items", details: parsed.error });
    }
    return reply.send({ removed: removeAlbumItems(album.id, parsed.data.itemIds) });
  });
}
