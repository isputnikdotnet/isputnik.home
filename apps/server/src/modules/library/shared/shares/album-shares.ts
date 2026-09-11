import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { sha256 } from "../../../../crypto.js";
import { addDays } from "../../../../auth.js";
import { canUserCurateLibrary, type LibraryAccessRow } from "../library-access.js";
import type { GallerySetFileRow, GallerySetItemRow, GallerySetMediaRow } from "./gallery-set-shares.js";
import type { GalleryAlbumRow } from "../../../../db/rows.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

// --- Live album shares (`gallery_album`) --------------------------------------
// A guest link or user share whose resource_id is an ALBUM id. Unlike a set link,
// nothing is snapshotted: the members are resolved live from the album each time,
// bounded to the libraries the share's CREATOR can curate — so the share always
// reflects the album now, and can never leak a photo the creator couldn't share.

export type AlbumShareMeta = Pick<GalleryAlbumRow, "sort_mode" | "created_by" | "name">;

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
    : "gallery_details.taken_at ASC, library_items.id ASC";
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

export function loadAlbumShareFiles(albumId: string, sortMode: string, libIds: string[]): GallerySetFileRow[] {
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
export function loadAlbumShareMediaItem(albumId: string, itemId: string, libIds: string[]) {
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
  `).get(albumId, itemId, ...libIds) as GallerySetMediaRow | undefined;
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
