// Gallery albums: hand-curated photo sets spanning every gallery library.
// Rules (see docs/gallery-memories-albums-proposal.md, Phase 3):
// - every member can view; items are filtered by the VIEWER's library access
// - edit (rename, add/remove, cover, sort, delete) = creator + admins
// - an album with zero visible items is hidden from everyone except its
//   creator and admins (a member without access would just see an empty shell)
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "./catalog.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export interface AlbumRow {
  id: string;
  name: string;
  description: string | null;
  cover_item_id: string | null;
  sort_mode: "taken_at" | "manual";
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function getAlbum(albumId: string): AlbumRow | undefined {
  return db.prepare("SELECT * FROM gallery_albums WHERE id = ?").get(albumId) as AlbumRow | undefined;
}

export function canEditAlbum(album: Pick<AlbumRow, "created_by">, user: { id: string; role: string }): boolean {
  return user.role === "admin" || album.created_by === user.id;
}

export function createAlbum(user: { id: string }, name: string, description: string | null): AlbumRow {
  const id = nanoid(16);
  db.prepare(
    "INSERT INTO gallery_albums (id, name, description, created_by) VALUES (?, ?, ?, ?)"
  ).run(id, name, description, user.id);
  return getAlbum(id)!;
}

const touchAlbum = (albumId: string) =>
  db.prepare("UPDATE gallery_albums SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(albumId);

export function updateAlbum(
  albumId: string,
  fields: { name?: string; description?: string | null; sortMode?: "taken_at" | "manual"; coverItemId?: string | null }
): boolean {
  const album = getAlbum(albumId);
  if (!album) return false;
  // A cover must be a member of the album (or null to fall back to the first item).
  if (fields.coverItemId) {
    const member = db.prepare(
      "SELECT 1 FROM gallery_album_items WHERE album_id = ? AND item_id = ?"
    ).get(albumId, fields.coverItemId);
    if (!member) return false;
  }
  db.prepare(`
    UPDATE gallery_albums SET
      name = COALESCE(?, name),
      description = CASE WHEN ? THEN ? ELSE description END,
      sort_mode = COALESCE(?, sort_mode),
      cover_item_id = CASE WHEN ? THEN ? ELSE cover_item_id END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    fields.name ?? null,
    fields.description !== undefined ? 1 : 0, fields.description ?? null,
    fields.sortMode ?? null,
    fields.coverItemId !== undefined ? 1 : 0, fields.coverItemId ?? null,
    albumId
  );
  return true;
}

export function deleteAlbum(albumId: string): boolean {
  return db.prepare("DELETE FROM gallery_albums WHERE id = ?").run(albumId).changes > 0;
}

// Batch add (the multi-select bar / lightbox). Only gallery items in libraries
// the CALLER can access are added — others are skipped and counted, the same
// contract as every other bulk action. Duplicates are skipped (idempotent).
export function addAlbumItems(albumId: string, accessibleLibIds: Set<string>, itemIds: string[]): { added: number; skipped: number } {
  const lookup = db.prepare(`
    SELECT library_items.library_id FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `);
  const existing = new Set((db.prepare(
    "SELECT item_id FROM gallery_album_items WHERE album_id = ?"
  ).all(albumId) as { item_id: string }[]).map((row) => row.item_id));
  let position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM gallery_album_items WHERE album_id = ?"
  ).get(albumId) as { pos: number }).pos;

  const insert = db.prepare(
    "INSERT INTO gallery_album_items (album_id, item_id, position) VALUES (?, ?, ?)"
  );
  let added = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const itemId of new Set(itemIds)) {
      const row = lookup.get(itemId) as { library_id: string } | undefined;
      if (!row || !accessibleLibIds.has(row.library_id) || existing.has(itemId)) {
        skipped += 1;
        continue;
      }
      insert.run(albumId, itemId, position);
      position += 1;
      added += 1;
    }
    if (added > 0) touchAlbum(albumId);
  })();
  return { added, skipped };
}

export function removeAlbumItems(albumId: string, itemIds: string[]): number {
  if (itemIds.length === 0) return 0;
  const removed = db.prepare(
    `DELETE FROM gallery_album_items WHERE album_id = ? AND item_id IN (${inClause(itemIds.length)})`
  ).run(albumId, ...itemIds).changes;
  if (removed > 0) touchAlbum(albumId);
  return removed;
}

interface AlbumListRow extends AlbumRow {
  visible_count: number;
  cover_key: string | null;
}

// Albums the viewer should see, newest-updated first. `visible_count` counts
// only items in the viewer's accessible libraries; zero-visible albums are
// kept only for the creator/admin (so a freshly created album shows up for
// its owner). The cover prefers the explicit cover item, else the first
// visible member with a thumbnail.
export function listAlbums(user: { id: string; role: string }, libIds: string[]) {
  // With no accessible gallery libraries every count is 0, but creators/admins
  // must still see their albums — so query with a never-matching placeholder
  // instead of returning early.
  const libArgs = libIds.length > 0 ? libIds : [""];
  const libIn = inClause(libArgs.length);
  const rows = db.prepare(`
    SELECT
      gallery_albums.*,
      (SELECT COUNT(*) FROM gallery_album_items
        JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
        WHERE gallery_album_items.album_id = gallery_albums.id
          AND library_items.library_id IN (${libIn})) AS visible_count,
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = gallery_albums.cover_item_id AND library_items.deleted_at IS NULL
            AND library_items.library_id IN (${libIn})),
        (SELECT item_metadata.cover_storage_key FROM gallery_album_items
          JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE gallery_album_items.album_id = gallery_albums.id
            AND library_items.library_id IN (${libIn})
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY gallery_album_items.position LIMIT 1)
      ) AS cover_key
    FROM gallery_albums
    ORDER BY datetime(gallery_albums.updated_at) DESC
  `).all(...libArgs, ...libArgs, ...libArgs) as AlbumListRow[];

  return rows
    .filter((row) => row.visible_count > 0 || canEditAlbum(row, user))
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      itemCount: row.visible_count,
      coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
      sortMode: row.sort_mode,
      canEdit: canEditAlbum(row, user),
      updatedAt: row.updated_at
    }));
}

// One album's visible items, paged. taken_at mode is chronological (an album
// reads like a story); manual mode follows position (append order today).
export function getAlbumItems(userId: string, libIds: string[], album: AlbumRow, limit: number, offset: number) {
  if (libIds.length === 0) return { assets: [], total: 0 };
  const libIn = inClause(libIds.length);
  const where = `
    gallery_album_items.album_id = ?
    AND library_items.library_id IN (${libIn})
    AND library_items.deleted_at IS NULL`;
  const total = (db.prepare(`
    SELECT COUNT(*) AS n FROM gallery_album_items
    JOIN library_items ON library_items.id = gallery_album_items.item_id
    WHERE ${where}
  `).get(album.id, ...libIds) as { n: number }).n;

  const order = album.sort_mode === "manual"
    ? "gallery_album_items.position ASC"
    : "datetime(gallery_details.taken_at) ASC, library_items.id ASC";
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    JOIN gallery_album_items ON gallery_album_items.item_id = library_items.id
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(userId, album.id, ...libIds, limit, offset) as GalleryAssetRow[];

  return { assets: rows.map(mapAsset), total };
}
