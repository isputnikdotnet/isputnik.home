import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { sha256 } from "../../../../crypto.js";
import { addDays } from "../../../../auth.js";
import { canUserAccessLibrary, canUserCurateLibrary, getLibraryForBook } from "../library-access.js";
import type { GalleryDetailRow, ItemMetadataRow, LibraryItemRow, LibraryRow, Nullable } from "../../../../db/rows.js";

// --- Gallery "quick links": one guest link over a snapshot of selected assets ---
// module 'gallery_set'; resource_id self-references the link id (there is no
// single resource). Membership lives in share_link_items, fixed at share time.

// The subset of a selection the caller may share (gallery items in a library
// they can curate) plus how many were dropped. Sharing hands out file access,
// so it needs the curate capability — the same contract as the bulk endpoints
// and the guest set link.
export function shareableGalleryItems(
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

export type GallerySetItemRow = Pick<LibraryItemRow, "id" | "folder_path">
  & Pick<GalleryDetailRow, "kind" | "width" | "height" | "duration_seconds" | "taken_at" | "preview_storage_key">
  & Nullable<Pick<ItemMetadataRow, "title" | "cover_storage_key">>;

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
export type GallerySetFileRow = Pick<LibraryItemRow, "id" | "folder_path">
  & Pick<GalleryDetailRow, "relative_path" | "kind">
  & Pick<LibraryRow, "source_path">
  & Nullable<Pick<ItemMetadataRow, "title">>;

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

/** A set link's (or a live album share's) member as the media routes read it. */
export type GallerySetMediaRow = Pick<LibraryItemRow, "folder_path">
  & Pick<GalleryDetailRow, "kind" | "relative_path" | "mime_type" | "preview_storage_key">
  & Pick<LibraryRow, "source_path">
  & Nullable<Pick<ItemMetadataRow, "title" | "cover_storage_key">>;

// One member of a set link with everything the media routes need. The WHERE on
// share_link_items IS the authorization: an item id outside this link 404s.
export function loadGallerySetMediaItem(linkId: string, itemId: string) {
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
  `).get(linkId, itemId) as GallerySetMediaRow | undefined;
}
