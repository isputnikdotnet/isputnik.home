import { db } from "../../../../db.js";
import { ID_CHUNK } from "./items.js";

// ────────────────────────────────────────────────────────────────────────────
//  Keeper scoring
// ────────────────────────────────────────────────────────────────────────────

export interface DetailRow {
  item_id: string;
  kind: string;
  library_id: string;
  library_name: string;
  relative_path: string;
  discovered_at: string;
  size: number | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  taken_at_source: string;
  gps_source: string;
  camera_make: string | null;
  camera_model: string | null;
  content_hash: string | null;
  title: string | null;
  metadata_source: string | null;
  cover_storage_key: string | null;
  preview_storage_key: string | null;
  face_count: number;
  album_count: number;
  slideshow_count: number;
  collection_count: number;
  tag_count: number;
  save_count: number;
  share_count: number;
  ft_person_count: number;
  ft_event_count: number;
}

const DETAIL_COLUMNS = `
  gd.item_id, gd.kind, li.library_id, lib.name AS library_name, gd.relative_path, li.discovered_at,
  gd.size, gd.width, gd.height, gd.taken_at, gd.taken_at_source, gd.gps_source,
  gd.camera_make, gd.camera_model, gd.content_hash,
  im.title, im.source AS metadata_source, im.cover_storage_key, gd.preview_storage_key
`;

// The hand-filed work on each copy, which decides which one the scan suggests keeping.
// These were nine correlated subqueries on DETAIL_COLUMNS, so SQLite ran nine lookups
// for EVERY copy on the page — and this page loads every set it found, then polls
// itself every three seconds while a scan runs. Nine grouped scans over a chunk of ids
// answer the same question once each instead of once per row.
const LINK_COUNTS: { field: keyof DetailRow; table: string; column: string; extra?: string }[] = [
  { field: "face_count", table: "gallery_faces", column: "item_id", extra: "assignment != 'rejected'" },
  { field: "album_count", table: "gallery_album_items", column: "item_id" },
  { field: "slideshow_count", table: "gallery_slideshow_items", column: "item_id" },
  { field: "collection_count", table: "collection_items", column: "entity_id", extra: "entity_type = 'library_item'" },
  { field: "tag_count", table: "taggables", column: "entity_id", extra: "entity_type = 'library_item'" },
  { field: "save_count", table: "item_saves", column: "item_id" },
  { field: "share_count", table: "shares", column: "resource_id", extra: "module = 'gallery' AND revoked_at IS NULL" },
  { field: "ft_person_count", table: "family_tree_photos", column: "item_id" },
  { field: "ft_event_count", table: "family_tree_event_photos", column: "item_id" }
];

export function loadDetails(itemIds: string[]): Map<string, DetailRow> {
  const out = new Map<string, DetailRow>();
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const chunk = itemIds.slice(i, i + ID_CHUNK);
    const list = chunk.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT ${DETAIL_COLUMNS}
      FROM gallery_details gd
      JOIN library_items li ON li.id = gd.item_id
      JOIN libraries lib ON lib.id = li.library_id
      LEFT JOIN item_metadata im ON im.item_id = gd.item_id
      WHERE gd.item_id IN (${list})
    `).all(...chunk) as DetailRow[];

    for (const row of rows) {
      for (const source of LINK_COUNTS) (row[source.field] as number) = 0;
      out.set(row.item_id, row);
    }

    for (const source of LINK_COUNTS) {
      const counted = db.prepare(`
        SELECT ${source.column} AS item_id, COUNT(*) AS n FROM ${source.table}
        WHERE ${source.extra ? `${source.extra} AND ` : ""}${source.column} IN (${list})
        GROUP BY ${source.column}
      `).all(...chunk) as { item_id: string; n: number }[];
      for (const hit of counted) {
        const row = out.get(hit.item_id);
        if (row) (row[source.field] as number) = hit.n;
      }
    }
  }
  return out;
}
