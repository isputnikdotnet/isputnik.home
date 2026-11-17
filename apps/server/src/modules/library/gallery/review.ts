// Review mode over an album — docs/photo-review-plan.md, phase 3.
//
// An album sent with "Ask for notes" reaches its recipient as a card that opens
// Review mode over the album's photos rather than the album itself. This is
// what that page reads: the album's photos in the order she should see them
// (the ones nobody has gone through first, then the album's own order), and
// whether she may write on them. Reach is the album page's reach (albumScopeSql)
// — her own libraries, the photos shared with her by person, plus whatever a
// live album share from its creator exposes — and
// the write right is per photo (canUserWriteAsset), so the page can say
// "Viewing only" honestly for an album that was merely sent, not asked about.
import { db } from "../../../db.js";
import { canUserWriteAsset } from "../shared/library-access.js";
import { albumScopeSql, getAlbum } from "./albums.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "./catalog-asset.js";
import { resolveGalleryScopeLibraryIds } from "./catalog-scope.js";
import type { LibraryRow } from "../../../db/rows.js";

type LibraryAccessRow = Pick<LibraryRow, "id" | "type" | "owner_id" | "owner_type" | "policy_json">;

/** More than a box of prints; fewer than a lifetime. */
const REVIEW_CAP = 500;

export interface AlbumReview {
  album: { id: string; name: string };
  items: ReturnType<typeof mapAsset>[];
  canEdit: boolean;
}

/** The album as Review mode walks it, or null when the viewer cannot see it. */
export function loadAlbumReview(user: { id: string; role: string }, albumId: string): AlbumReview | null {
  const album = getAlbum(albumId);
  if (!album) return null;

  // The album page's reach: her own (libraries, and photos shared with her by
  // person), widened by a live share of this album from its creator — bounded, as
  // every album share is, by what the creator may curate. It once read libraries
  // only, so a relative who sees photos by person found Review mode empty on an
  // album whose page showed them their photos.
  const scope = albumScopeSql(resolveGalleryScopeLibraryIds(user), "gallery_album_items.album_id", user.id);
  if (scope.empty && album.created_by !== user.id && user.role !== "admin") return null;

  const order = album.sort_mode === "manual"
    ? "gallery_album_items.position ASC"
    : "gallery_details.taken_at ASC, library_items.id ASC";
  const rows = scope.empty ? [] : db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    JOIN gallery_album_items ON gallery_album_items.item_id = library_items.id
    WHERE gallery_album_items.album_id = ?
      AND ${scope.sql}
      AND library_items.deleted_at IS NULL
    ORDER BY (gallery_details.reviewed_at IS NOT NULL), ${order}
    LIMIT ?
  `).all(user.id, albumId, ...scope.params, REVIEW_CAP) as GalleryAssetRow[];
  if (rows.length === 0 && album.created_by !== user.id && user.role !== "admin") return null;

  // Writable when every photo she can see is: one library she may edit, or an
  // edit share from someone who may. A mixed album reads as viewing only rather
  // than failing halfway through.
  const libraryById = new Map<string, LibraryAccessRow>();
  const canEdit = rows.length > 0 && rows.every((row) => {
    let library = libraryById.get(row.library_id);
    if (!library) {
      library = db.prepare("SELECT id, type, owner_id, owner_type, policy_json FROM libraries WHERE id = ?")
        .get(row.library_id) as LibraryAccessRow | undefined;
      if (library) libraryById.set(row.library_id, library);
    }
    return library ? canUserWriteAsset(row.id, library, user.id, user.role) : false;
  });

  return {
    album: { id: album.id, name: album.name },
    items: rows.map(mapAsset),
    canEdit
  };
}
