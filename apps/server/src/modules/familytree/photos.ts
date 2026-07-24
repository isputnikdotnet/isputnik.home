// Gallery photos/videos on a family member's profile: explicitly attached items
// first (admin-curated, ordered), then photos surfaced automatically through the
// linked gallery person (face cluster), deduped against the attached set.
//
// Listings are always scoped to the gallery libraries the VIEWER can access —
// like gallery people, a member never learns a photo exists in a library they
// can't see, even when an admin attached it. Reuses the gallery's asset
// column/join/mapper trio so profile photos carry the same URLs and metadata as
// every other gallery surface (precedent: collections hydrators).
import { db } from "../../db.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "../library/gallery/catalog.js";
import { accessibleLibraryIds } from "../library/shared/library-access.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export type AttachError = "person_not_found" | "item_not_found";

// Attach gallery items to a person, appending after the current last position.
// Idempotent per (person, item); re-attaching keeps the original position.
// Items must be existing, non-deleted gallery assets — only admins attach, so
// no per-library write check is needed beyond existence.
export function attachFamilyPhotos(
  personId: string,
  itemIds: string[],
  addedBy: string
): { attached: number } | { error: AttachError; itemId?: string } {
  const person = db.prepare("SELECT 1 FROM family_tree_persons WHERE id = ?").get(personId);
  if (!person) return { error: "person_not_found" };

  const isGalleryItem = db.prepare(`
    SELECT 1 FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `);
  for (const itemId of itemIds) {
    if (!isGalleryItem.get(itemId)) return { error: "item_not_found", itemId };
  }

  const attached = db.transaction(() => {
    let position = (db.prepare(
      "SELECT COALESCE(MAX(position), 0) AS max FROM family_tree_photos WHERE person_id = ?"
    ).get(personId) as { max: number }).max;
    let count = 0;
    const insert = db.prepare(`
      INSERT OR IGNORE INTO family_tree_photos (person_id, item_id, position, added_by)
      VALUES (?, ?, ?, ?)
    `);
    for (const itemId of itemIds) {
      position += 1;
      count += insert.run(personId, itemId, position, addedBy).changes;
    }
    return count;
  })();
  return { attached };
}

export function detachFamilyPhoto(personId: string, itemId: string): boolean {
  return db.prepare(
    "DELETE FROM family_tree_photos WHERE person_id = ? AND item_id = ?"
  ).run(personId, itemId).changes > 0;
}

export function attachedFamilyPhotoIds(personId: string): string[] {
  return (db.prepare(
    "SELECT item_id FROM family_tree_photos WHERE person_id = ? ORDER BY position"
  ).all(personId) as { item_id: string }[]).map((r) => r.item_id);
}

// One merged, paged listing: attached items by curated position, then automatic
// face-cluster photos newest-first. Each asset carries `attached` so the UI can
// offer "Remove" only for curated ones (auto photos are managed in the gallery).
export function getFamilyPersonPhotos(
  user: { id: string; role: string },
  personId: string,
  limit: number,
  offset: number
): { assets: (ReturnType<typeof mapAsset> & { attached: boolean })[]; total: number } | null {
  const person = db.prepare(
    "SELECT id, gallery_person_id FROM family_tree_persons WHERE id = ?"
  ).get(personId) as { id: string; gallery_person_id: string | null } | undefined;
  if (!person) return null;

  const libIds = [...accessibleLibraryIds(user.id, user.role, "gallery")];
  if (libIds.length === 0) return { assets: [], total: 0 };
  const libIn = inClause(libIds.length);

  // The `sources` subquery yields one row per candidate item: rank 0 = attached
  // (ordered by position), rank 1 = auto via the linked face cluster, excluding
  // items already attached. When no cluster is linked the auto arm matches
  // nothing (gallery_person_id parameter is NULL).
  const sourcesSql = `
    SELECT item_id, 0 AS rank, position AS pos
    FROM family_tree_photos WHERE person_id = ?
    UNION ALL
    SELECT DISTINCT gf.item_id, 1 AS rank, NULL AS pos
    FROM gallery_faces gf
    WHERE gf.person_id = ? AND gf.assignment != 'rejected'
      AND gf.item_id NOT IN (SELECT item_id FROM family_tree_photos WHERE person_id = ?)`;
  const filterSql = `
    library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL`;

  const total = (db.prepare(`
    SELECT COUNT(*) AS n FROM (${sourcesSql}) src
    JOIN library_items ON library_items.id = src.item_id
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE ${filterSql}
  `).get(personId, person.gallery_person_id, personId, ...libIds) as { n: number }).n;

  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS}, src.rank AS src_rank
    ${ASSET_JOINS}
    JOIN (${sourcesSql}) src ON src.item_id = library_items.id
    WHERE ${filterSql}
    ORDER BY src.rank, src.pos, datetime(gallery_details.taken_at) DESC, library_items.id DESC
    LIMIT ? OFFSET ?
  `).all(
    user.id, personId, person.gallery_person_id, personId, ...libIds, limit, offset
  ) as (GalleryAssetRow & { src_rank: number })[];

  return {
    assets: rows.map((row) => ({ ...mapAsset(row), attached: row.src_rank === 0 })),
    total
  };
}
