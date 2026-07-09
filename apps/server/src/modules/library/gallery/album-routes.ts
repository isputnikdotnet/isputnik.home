// Album endpoints. Reads are open to every member (items filtered per viewer's
// library access); writes require canEditAlbum (creator + admins). Batch bodies
// follow the bulk contract: inaccessible items are skipped and counted.
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import archiver from "archiver";
import { logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { resolveGalleryScopeLibraryIds } from "./catalog.js";
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

const itemsSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500)
});

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
    const libIds = resolveGalleryScopeLibraryIds(request.user!, "all");
    return { albums: listAlbums(request.user!, libIds) };
  });

  app.post("/api/library/gallery/albums", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid album details", details: parsed.error });
      return;
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
    reply.code(201).send({
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
      reply.code(404).send({ error: "Album not found" });
      return;
    }
    const qp = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number.parseInt(qp.limit ?? "80", 10) || 80, 1), 200);
    const offset = Math.max(Number.parseInt(qp.offset ?? "0", 10) || 0, 0);
    const libIds = resolveGalleryScopeLibraryIds(user, "all");
    const { assets, total } = getAlbumItems(user.id, libIds, album, limit, offset);
    // The zero-visible rule from the list applies here too: a member who can't
    // see any of the album's items shouldn't learn it exists via deep link.
    if (total === 0 && !canEditAlbum(album, user)) {
      reply.code(404).send({ error: "Album not found" });
      return;
    }
    reply.send({
      album: {
        id: album.id,
        name: album.name,
        description: album.description,
        sortMode: album.sort_mode,
        coverItemId: album.cover_item_id,
        canEdit: canEditAlbum(album, user),
        updatedAt: album.updated_at
      },
      assets,
      total
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
    const libIds = resolveGalleryScopeLibraryIds(user, "all");
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

  app.patch("/api/library/gallery/albums/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return;
    const parsed = parseBody(updateSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid album details", details: parsed.error });
      return;
    }
    if (!updateAlbum(album.id, parsed.data)) {
      reply.code(400).send({ error: "The cover must be a photo inside the album." });
      return;
    }
    reply.send({ updated: true });
  });

  app.delete("/api/library/gallery/albums/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return;
    deleteAlbum(album.id);
    logActivity({
      event: "gallery.album.deleted",
      actorUserId: user.id,
      targetType: "gallery_album",
      targetId: album.id,
      detail: `Deleted gallery album "${album.name}". The photos themselves were not affected.`,
      ipAddress: request.ip
    });
    reply.send({ deleted: true });
  });

  app.post("/api/library/gallery/albums/:id/items", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return;
    const parsed = parseBody(itemsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid items", details: parsed.error });
      return;
    }
    const libIds = new Set(resolveGalleryScopeLibraryIds(user, "all"));
    reply.send(addAlbumItems(album.id, libIds, parsed.data.itemIds));
  });

  // Batch remove (detach only — the photos stay in the gallery). A body on
  // DELETE is awkward for some clients, so removal is a POST like the add.
  app.post("/api/library/gallery/albums/:id/items/remove", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const album = editableAlbum((request.params as { id: string }).id, user, reply);
    if (!album) return;
    const parsed = parseBody(itemsSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid items", details: parsed.error });
      return;
    }
    reply.send({ removed: removeAlbumItems(album.id, parsed.data.itemIds) });
  });
}
