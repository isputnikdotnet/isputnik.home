import { nanoid } from "nanoid";
import { db, logActivity } from "../../../../db.js";
import { addDays } from "../../../../auth.js";
import { canUserAccessLibrary, canUserCurateLibrary, getLibraryForBook, type LibraryAccessRow } from "../library-access.js";
import { newlySharedResources, notifyShareGranted } from "../share-notify.js";
import { mediaKind } from "../library-types.js";
import { loadAlbumShareMeta, type AlbumShareMeta } from "./album-shares.js";
import type { UserRow } from "../../../../db/rows.js";

// Whether the caller may share a book. Sharing hands external/other-user access to
// the files, so it requires the Curator+ "curate" capability — not mere view. We
// distinguish "not_found" (book missing or no access at all — hide its existence)
// from "forbidden" (can view but lacks the curate capability to re-share).
export type ShareableResult = { library: LibraryAccessRow } | "not_found" | "forbidden";

export function getShareableBook(bookId: string, userId: string, userRole: string): ShareableResult {
  const library = getLibraryForBook(bookId);
  if (!library) return "not_found";
  if (!canUserAccessLibrary(library, userId, userRole)) return "not_found";
  if (!canUserCurateLibrary(library, userId, userRole)) return "forbidden";
  return { library };
}

/** Whether the caller may hand another account access to this item. Exported so
 *  "Send to" can offer people who cannot open a thing yet WITHOUT duplicating the
 *  rule about who is allowed to widen access. */
export function canGrantItemAccess(itemId: string, userId: string, userRole: string): boolean {
  return typeof getShareableBook(itemId, userId, userRole) === "object";
}

/** Grant one account read access to one item.
 *
 *  The single implementation of granting: POST /api/shares/user is a thin wrapper
 *  over it, and "Send to" calls it when the sender picks somebody who cannot open
 *  the thing yet. Two code paths that both widen access is how they drift apart.
 *  Returns a reason instead of throwing so each caller can shape its own reply. */
export function grantItemAccess(opts: {
  itemId: string;
  toUserId: string;
  by: { id: string; role: string };
  expiresInDays?: number;
  /** Origin of the page the sharer is on, for the notification link. */
  origin: string;
  ipAddress?: string;
}): "ok" | "self" | "not_found" | "forbidden" | "no_such_user" {
  if (opts.toUserId === opts.by.id) return "self";
  const result = getShareableBook(opts.itemId, opts.by.id, opts.by.role);
  if (result === "not_found" || result === "forbidden") return result;
  const module = mediaKind(result.library.type);

  const target = db.prepare(
    "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
  ).get(opts.toUserId) as Pick<UserRow, "id"> | undefined;
  if (!target) return "no_such_user";

  const expiresAt = opts.expiresInDays ? addDays(opts.expiresInDays).toISOString() : null;
  // Checked before the upsert: afterwards a refreshed grant is indistinguishable
  // from a new one, and only a new one is worth an email.
  const isNew = newlySharedResources(module, [opts.itemId], opts.toUserId).length > 0;
  db.prepare(`
    INSERT INTO shares (id, module, resource_id, user_id, permission, created_by, expires_at)
    VALUES (?, ?, ?, ?, 'read', ?, ?)
    ON CONFLICT (module, resource_id, user_id) DO UPDATE SET
      revoked_at = NULL,
      expires_at = excluded.expires_at,
      created_by = excluded.created_by,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(nanoid(16), module, opts.itemId, opts.toUserId, opts.by.id, expiresAt);

  logActivity({
    event: "share.granted",
    actorUserId: opts.by.id,
    targetType: "book",
    targetId: opts.itemId,
    detail: `Shared an ${module} with a user.`,
    ipAddress: opts.ipAddress
  });
  if (isNew) {
    notifyShareGranted({
      recipientId: opts.toUserId,
      sharedById: opts.by.id,
      origin: opts.origin,
      expiresAt,
      thing: { kind: "item", module, itemId: opts.itemId }
    });
  }
  return "ok";
}

// Only the album's creator or an admin may share it (it's their album). Used by
// every album-share write, and by "Send to" to decide whether to offer people
// who cannot see it yet.
function albumEditableBy(
  user: { id: string; role: string },
  albumId: string
): AlbumShareMeta | "not_found" | "forbidden" {
  const meta = loadAlbumShareMeta(albumId);
  if (!meta) return "not_found";
  if (user.role !== "admin" && meta.created_by !== user.id) return "forbidden";
  return meta;
}

/** Whether the caller may hand another account access to this album. */
export function canGrantAlbumAccess(albumId: string, user: { id: string; role: string }): boolean {
  return typeof albumEditableBy(user, albumId) === "object";
}

/** Grant one account read access to one album — the single implementation, shared
 *  by POST /api/shares/album/user and by "Send to". */
export function grantAlbumAccess(opts: {
  albumId: string;
  toUserId: string;
  by: { id: string; role: string };
  expiresInDays?: number;
  /** 'edit' lets the recipient write dates, places, people and notes on the
   *  album's photos — "Ask for notes" (docs/photo-review-plan.md, phase 3).
   *  A later plain share never takes an edit right back down to read. */
  permission?: "read" | "edit";
  origin: string;
  ipAddress?: string;
}): "ok" | "self" | "not_found" | "forbidden" | "no_such_user" {
  if (opts.toUserId === opts.by.id) return "self";
  const meta = albumEditableBy(opts.by, opts.albumId);
  if (meta === "not_found" || meta === "forbidden") return meta;

  const target = db.prepare(
    "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
  ).get(opts.toUserId) as Pick<UserRow, "id"> | undefined;
  if (!target) return "no_such_user";

  const expiresAt = opts.expiresInDays ? addDays(opts.expiresInDays).toISOString() : null;
  const isNew = newlySharedResources("gallery_album", [opts.albumId], opts.toUserId).length > 0;
  db.prepare(`
    INSERT INTO shares (id, module, resource_id, user_id, permission, created_by, expires_at)
    VALUES (?, 'gallery_album', ?, ?, ?, ?, ?)
    ON CONFLICT (module, resource_id, user_id) DO UPDATE SET
      revoked_at = NULL,
      expires_at = excluded.expires_at,
      created_by = excluded.created_by,
      permission = CASE WHEN excluded.permission = 'edit' THEN 'edit' ELSE shares.permission END,
      created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(nanoid(16), opts.albumId, opts.toUserId, opts.permission ?? "read", opts.by.id, expiresAt);

  logActivity({
    event: "share.granted",
    actorUserId: opts.by.id,
    targetType: "share",
    targetId: opts.toUserId,
    detail: `Shared gallery album \"${meta.name}\" with a user.`,
    ipAddress: opts.ipAddress
  });
  if (isNew) {
    notifyShareGranted({
      recipientId: opts.toUserId,
      sharedById: opts.by.id,
      origin: opts.origin,
      expiresAt,
      thing: { kind: "album", name: meta.name }
    });
  }
  return "ok";
}
