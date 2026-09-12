import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { configuredThumbnailPathValue } from "./thumbnail.js";
import { normaliseRelativePath, pathIsInside } from "./storage-roots.js";

// The pictures in the thumbnail store that a rescan could NOT put back.
//
// Nearly all of that store is derived work. Every photo's preview, every video
// poster, every face crop is recomputed from the original file the moment a scan
// or a thumbnail sweep finds it missing, and the originals are the one thing a
// backup never carries because they already are the library. Losing them costs
// an evening of CPU, not a memory.
//
// The rest was never in a file to begin with: a book cover someone uploaded or
// took from a metadata provider, a series cover, an author portrait, a category
// tile, a family-tree portrait. Nothing on disk can recreate those — re-scanning
// the library brings back the covers that live beside the media and leaves every
// hand-picked one blank. So they travel in the MINIMAL backup, which is otherwise
// exactly the things that cannot be recreated (modules/backups/run.ts).
//
// Which file is which would need provenance the database does not keep — one
// `cover_storage_key` column holds the cover found beside the media, the one
// fetched from OpenLibrary and the one dragged in from a desktop alike. So the
// line is drawn per library TYPE instead: a gallery item's cover is always
// rendered from the photo it belongs to, and a book-like item's cover may be any
// of the three. Carrying every book cover therefore carries some that a rescan
// could have rebuilt, which costs a little room and no correctness; the count is
// bounded by how many books there are, not how many photos.
//
// Deliberately NOT here:
//
//   • gallery covers/previews and the -web.mp4 transcodes — rendered from the
//     original file, and a sweep already rebuilds them on demand.
//   • face crops — cut from the photo, rebuilt by the next face scan.
//   • the Recycle Bin's `trashed_items.cover_key` — the item's files are still in
//     the bin's own folder, so restoring it re-catalogues and re-renders the
//     cover. Until then the bin row shows no picture, which is worth more than
//     putting thousands of thumbnails from a duplicate cleanup into every
//     nightly backup.
//   • the render buckets (music, slideshows, narration) — a slideshow movie can
//     be rendered again, and uploaded music and narration are library items in
//     their own right these days (docs/app-storage-plan.md).

/** Library types whose item covers are rendered from the item's own file, and so
 *  come back on their own. Everything else is treated as possibly hand-picked. */
const DERIVED_COVER_TYPES = ["gallery"] as const;

export interface StoredArt {
  /** Storage key, relative to the thumbnail store, forward slashes. */
  key: string;
  absolutePath: string;
}

function largeSibling(coverKey: string): string {
  return coverKey.replace(/-cover\.webp$/i, "-cover-large.webp");
}

/** Every stored image a library rescan could not recreate, as storage keys that
 *  exist on disk right now. Empty when no thumbnail store is configured. */
export function listIrreplaceableArt(): StoredArt[] {
  const configured = configuredThumbnailPathValue();
  if (!configured) return [];
  const root = path.resolve(configured);

  const keys = new Set<string>();
  const add = (key: string | null | undefined) => {
    if (key) keys.add(normaliseRelativePath(key));
  };

  const placeholders = DERIVED_COVER_TYPES.map(() => "?").join(", ");
  // Item covers of the book-like types, soft-deleted items included: a cover
  // chosen by hand is part of what restoring that item from the bin gives back.
  const itemCovers = db.prepare(`
    SELECT item_metadata.cover_storage_key AS key
    FROM item_metadata
    JOIN library_items ON library_items.id = item_metadata.item_id
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE item_metadata.cover_storage_key IS NOT NULL
      AND libraries.type NOT IN (${placeholders})
  `).all(...DERIVED_COVER_TYPES) as { key: string }[];
  for (const row of itemCovers) {
    add(row.key);
    // The detail page's larger cover is written beside the grid one and is not
    // in the database; its key is the same name with -cover-large.webp.
    add(largeSibling(row.key));
  }

  // Series covers, author/narrator portraits, category tiles and family-tree
  // portraits are only ever uploaded or fetched — there is no local file a scan
  // could read one back from.
  const shared: { table: string; column: string }[] = [
    { table: "series", column: "cover_storage_key" },
    { table: "people", column: "image_storage_key" },
    { table: "categories", column: "image_storage_key" },
    { table: "family_tree_persons", column: "portrait_storage_key" }
  ];
  for (const { table, column } of shared) {
    const rows = db.prepare(`SELECT ${column} AS key FROM ${table} WHERE ${column} IS NOT NULL`).all() as { key: string }[];
    for (const row of rows) add(row.key);
  }

  const art: StoredArt[] = [];
  for (const key of keys) {
    const absolutePath = path.resolve(root, key);
    if (!pathIsInside(absolutePath, root)) continue;
    try {
      if (!fs.statSync(absolutePath).isFile()) continue;
    } catch {
      continue; // a key whose file is gone: nothing to carry
    }
    art.push({ key, absolutePath });
  }
  return art.sort((a, b) => a.key.localeCompare(b.key));
}
