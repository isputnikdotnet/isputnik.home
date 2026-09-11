import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../../db.js";
import { sha256 } from "../../../../crypto.js";
import { addDays } from "../../../../auth.js";
import { parseBody, parseQuery, requestOrigin } from "../../../../core/shared.js";
import type { LibraryAccessRow } from "../library-access.js";
import { newlySharedResources, notifyShareGranted } from "../share-notify.js";
import { mediaKind } from "../library-types.js";
import { getShareableBook, grantAlbumAccess, grantItemAccess, type ShareableResult } from "./grants.js";
import { createGallerySetShare, shareableGalleryItems } from "./gallery-set-shares.js";
import { createGalleryAlbumShare, curatableGalleryLibraryIds, loadAlbumShareItems } from "./album-shares.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

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

export function registerShareManageRoutes(app: FastifyInstance) {
  // --- Owner: guest link shares -------------------------------------------

  app.post("/api/shares", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createLinkSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid share details", details: parsed.error });
    }

    const user = request.user!;
    const result = getShareableBook(parsed.data.bookId, user.id, user.role);
    if (denyIfNotShareable(result, reply)) return reply;
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
    return reply.code(201).send({
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
      return reply.code(400).send({ error: "Invalid share details", details: parsed.error });
    }

    const user = request.user!;
    const result = createGallerySetShare(user, {
      itemIds: parsed.data.itemIds,
      expiresInDays: parsed.data.expiresInDays ?? 30,
      label: parsed.data.label ?? null
    });
    if (!result) {
      return reply.code(403).send({ error: "Curator access required to share these photos." });
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
    return reply.code(201).send({
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
      ORDER BY share_links.created_at DESC
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

  // Create a live guest link over an album — the URL always reflects the album's
  // current photos (no snapshot, no item cap).
  app.post("/api/shares/album", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createAlbumLinkSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid share details", details: parsed.error });
    }
    const user = request.user!;
    const result = createGalleryAlbumShare(user, {
      albumId: parsed.data.albumId,
      expiresInDays: parsed.data.expiresInDays ?? 30,
      label: parsed.data.label ?? null
    });
    if (result === "not_found") { return reply.code(404).send({ error: "Album not found" }); }
    if (result === "forbidden") { return reply.code(403).send({ error: "Only the album's creator or an admin can share it." }); }
    if (result === "empty") { return reply.code(403).send({ error: "There are no photos in this album you can share." }); }

    logActivity({
      event: "share.created",
      actorUserId: user.id,
      targetType: "share_link",
      targetId: result.shareId,
      detail: "Created a live guest link for a gallery album.",
      ipAddress: request.ip
    });

    const base = requestOrigin(request);
    return reply.code(201).send({
      share: {
        id: result.shareId,
        label: parsed.data.label ?? null,
        expiresAt: result.expiresAt,
        // Shown exactly once — the raw token is not stored and cannot be re-displayed.
        url: `${base}/share/${result.token}`
      }
    });
  });

  // Story links are minted and listed by the stories module
  // (stories/share-routes.ts: POST /api/shares/story, GET /api/shares/stories).

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
      ORDER BY share_links.created_at DESC
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
  // A thin wrapper over grantAlbumAccess(): "Send to" calls the same function,
  // so there is one implementation of widening access to an album.
  app.post("/api/shares/album/user", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(albumUserShareSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid share details", details: parsed.error });
    }
    const user = request.user!;
    const outcome = grantAlbumAccess({
      albumId: parsed.data.albumId,
      toUserId: parsed.data.userId,
      by: user,
      expiresInDays: parsed.data.expiresInDays,
      origin: requestOrigin(request),
      ipAddress: request.ip
    });

    if (outcome === "self") {
      return reply.code(400).send({ error: "You already have access to this album" });
    }
    if (outcome === "not_found") {
      return reply.code(404).send({ error: "Album not found" });
    }
    if (outcome === "forbidden") {
      return reply.code(403).send({ error: "Only the album's creator or an admin can share it." });
    }
    if (outcome === "no_such_user") {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.code(201).send({ ok: true });
  });

  // Recipients of an album — the People list for the album-share dialog. Only the
  // caller's own grants (admins see all).
  app.post("/api/shares/album/recipients", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(albumRecipientsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error });
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
    return reply.send({
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
      return reply.code(400).send({ error: "Invalid request", details: parsed.error });
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
    return reply.send({ revoked: result.changes });
  });

  // Share a selection of gallery items *with a registered user* (the set dialog's
  // People tab). Grants a per-item user share for every item the caller can
  // curate; the rest are skipped and counted. Upsert so re-sharing refreshes the
  // expiry rather than erroring. The recipient sees them under "Shared with me".
  app.post("/api/shares/set/user", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(setUserShareSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid share details", details: parsed.error });
    }

    const user = request.user!;
    if (parsed.data.userId === user.id) {
      return reply.code(400).send({ error: "You already have access to these photos" });
    }
    const target = db.prepare(
      "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
    ).get(parsed.data.userId) as { id: string } | undefined;
    if (!target) {
      return reply.code(404).send({ error: "User not found" });
    }

    const { included, skipped } = shareableGalleryItems(user, parsed.data.itemIds);
    if (included.length === 0) {
      return reply.code(403).send({ error: "Curator access required to share these photos." });
    }

    const expiresAt = parsed.data.expiresInDays ? addDays(parsed.data.expiresInDays).toISOString() : null;
    // Re-sharing a selection that overlaps one already sent should only announce
    // the part that's actually new — and stay silent when none of it is.
    const fresh = newlySharedResources("gallery", included, parsed.data.userId);
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
    if (fresh.length > 0) {
      notifyShareGranted({
        recipientId: parsed.data.userId,
        sharedById: user.id,
        origin: requestOrigin(request),
        expiresAt,
        // One photo shared on its own reads better named than counted.
        thing: fresh.length === 1
          ? { kind: "item", module: "gallery", itemId: fresh[0] }
          : { kind: "photos", count: fresh.length }
      });
    }

    return reply.code(201).send({ granted: included.length, skipped });
  });

  // Recipients of a gallery selection — the People list for the set dialog. Only
  // the caller's own shares over items they can curate are reported, so this never
  // leaks (or lets them revoke) another curator's sharing. itemCount is how many of
  // the passed set each user currently has.
  app.post("/api/shares/set/recipients", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(setRecipientsSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error });
    }
    const user = request.user!;
    const { included } = shareableGalleryItems(user, parsed.data.itemIds);
    if (included.length === 0) {
      return reply.send({ recipients: [] });
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
    return reply.send({
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
      return reply.code(400).send({ error: "Invalid request", details: parsed.error });
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
    return reply.send({ revoked: result.changes });
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
      ORDER BY share_links.created_at DESC
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

  // Every guest link the caller owns, of every kind, in one list — the three
  // endpoints above are each scoped to one kind because they back a share modal
  // for that kind. This one backs Profile → Shared links, where the point is to
  // see everything that is currently handing out access. Expired links are kept
  // in the result (nothing prunes them) and marked, because "this expired last
  // week" is part of the answer. The token is not here and cannot be: only
  // sha256(token) is ever stored, so a link's URL is unrecoverable after it is
  // first shown.
  app.get("/api/shares/mine", { preHandler: app.authenticate }, async (request) => {
    const user = request.user!;
    const rows = db.prepare(`
      SELECT
        share_links.id,
        share_links.module,
        share_links.resource_id,
        share_links.label,
        share_links.created_at,
        share_links.expires_at,
        item_metadata.title      AS item_title,
        library_items.folder_path AS item_folder,
        gallery_albums.name      AS album_name,
        stories.title            AS story_title,
        inbox.name               AS inbox_name,
        (SELECT COUNT(*) FROM share_link_drops
          WHERE share_link_drops.share_link_id = share_links.id) AS drop_count,
        (SELECT COUNT(*) FROM share_link_items
          WHERE share_link_items.share_link_id = share_links.id) AS set_count,
        (SELECT COUNT(*) FROM gallery_album_items
           JOIN library_items AS album_item
             ON album_item.id = gallery_album_items.item_id AND album_item.deleted_at IS NULL
          WHERE gallery_album_items.album_id = share_links.resource_id) AS album_count
      FROM share_links
      -- Guarded joins: a 'gallery_set' link's resource_id self-references the link
      -- id, so an unguarded join to library_items would match nothing useful.
      LEFT JOIN library_items
        ON library_items.id = share_links.resource_id
       AND share_links.module NOT IN ('gallery_set', 'gallery_album', 'story')
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN gallery_albums
        ON gallery_albums.id = share_links.resource_id
       AND share_links.module = 'gallery_album'
      LEFT JOIN stories
        ON stories.id = share_links.resource_id
       AND share_links.module = 'story'
      -- A drop link (docs/photo-inbox-proposal.md, phase 3) points at a Photo
      -- Inbox library; what it received is counted from its own drops table.
      LEFT JOIN libraries AS inbox
        ON inbox.id = share_links.resource_id
       AND share_links.module = 'gallery-inbox'
      WHERE share_links.created_by = ? AND share_links.revoked_at IS NULL
      ORDER BY share_links.created_at DESC
    `).all(user.id) as {
      id: string; module: string; resource_id: string; label: string | null;
      created_at: string; expires_at: string;
      item_title: string | null; item_folder: string | null;
      album_name: string | null; story_title: string | null; inbox_name: string | null;
      drop_count: number; set_count: number; album_count: number;
    }[];
    const now = Date.now();

    return {
      shares: rows.map((row) => {
        const isAlbum = row.module === "gallery_album";
        const isSet = row.module === "gallery_set";
        const isStory = row.module === "story";
        const isDrop = row.module === "gallery-inbox";
        const kind = isAlbum ? "album" : isSet ? "set" : isStory ? "story" : isDrop ? "drop" : "item";
        // A set is a bag of photos with no resource of its own to name; an item
        // whose row has since been deleted leaves the joins null.
        const title = isAlbum
          ? row.album_name ?? "Deleted album"
          : isSet
            ? "Selected photos"
            : isStory
              ? row.story_title ?? "Deleted story"
              : isDrop
                ? row.inbox_name ?? "Deleted Photo Inbox"
                : row.item_title ?? (row.item_folder ? path.basename(row.item_folder) : "Deleted item");
        return {
          id: row.id,
          kind,
          module: row.module,
          resourceId: isSet ? null : row.resource_id,
          title,
          label: row.label,
          // A drop link counts what came in through it rather than what it shows.
          itemCount: isAlbum ? row.album_count : isSet ? row.set_count : isDrop ? row.drop_count : 1,
          // A story is one thing, however many photos it happens to show.
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          status: new Date(row.expires_at).getTime() <= now ? "expired" : "active"
        };
      })
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
      return reply.code(404).send({ error: "Share link not found" });
    }

    logActivity({
      event: "share.revoked",
      actorUserId: user.id,
      targetType: "share_link",
      targetId: id,
      detail: "Revoked a guest share link.",
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
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

  // A thin wrapper over grantItemAccess(): validation and the HTTP shape live
  // here, the grant itself lives in one place that "Send to" also calls.
  app.post("/api/shares/user", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createUserShareSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid share details", details: parsed.error });
    }

    const user = request.user!;
    const outcome = grantItemAccess({
      itemId: parsed.data.bookId,
      toUserId: parsed.data.userId,
      by: user,
      expiresInDays: parsed.data.expiresInDays,
      origin: requestOrigin(request),
      ipAddress: request.ip
    });

    if (outcome === "self") {
      return reply.code(400).send({ error: "You already have access to this book" });
    }
    if (outcome === "not_found") {
      return reply.code(404).send({ error: "Book not found" });
    }
    if (outcome === "forbidden") {
      return reply.code(403).send({ error: "Curator access required to share this book." });
    }
    if (outcome === "no_such_user") {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.code(201).send({ ok: true });
  });

  const userSharesQuerySchema = z.object({ bookId: z.string().optional() });

  app.get("/api/shares/user", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseQuery(userSharesQuerySchema, request.query);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    }
    const query = parsed.data;
    if (!query.bookId) {
      return reply.code(400).send({ error: "bookId is required" });
    }
    const user = request.user!;
    const result = getShareableBook(query.bookId, user.id, user.role);
    if (denyIfNotShareable(result, reply)) return reply;
    const module = mediaKind((result as { library: LibraryAccessRow }).library.type);

    const rows = db.prepare(`
      SELECT shares.id, shares.user_id, shares.expires_at, shares.created_at,
             users.display_name, users.email
      FROM shares
      JOIN users ON users.id = shares.user_id
      WHERE shares.module = ? AND shares.resource_id = ? AND shares.revoked_at IS NULL
      ORDER BY shares.created_at DESC
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
      return reply.code(404).send({ error: "Share not found" });
    }

    logActivity({
      event: "share.revoked",
      actorUserId: user.id,
      targetType: "share",
      targetId: id,
      detail: "Revoked a user share.",
      ipAddress: request.ip
    });
    return reply.send({ ok: true });
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
        AND (shares.expires_at IS NULL OR shares.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ORDER BY shares.created_at DESC
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
        AND (shares.expires_at IS NULL OR shares.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ORDER BY shares.created_at DESC
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
}
