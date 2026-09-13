// Read queries for the gallery: the date Timeline, the Folder view, single-asset
// detail, and lightweight facets. All are scoped to the libraries the user can
// access (resolved via the shared catalog-core scope helper). Gallery is not a
// "book-like" type, so it does not use the shared catalog engine — its queries are
// asset-centric (one row per photo/video) rather than work/edition-centric.
//
// The rest of the read side sits beside this file: catalog-scope.ts (which
// libraries), catalog-asset.ts (one asset's shape), catalog-filters.ts (the filter
// panel's WHERE) and catalog-memories.ts (On this day, Just added).
import { db } from "../../../db.js";
import { locksByLibrary, lockCoveredIn } from "../shared/folder-locks.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type AssetRow } from "./catalog-asset.js";
import { describePlace } from "./places.js";
import {
  CAMERA_SQL,
  EMPTY_GALLERY_FILTERS,
  galleryFilterClauses,
  type GalleryTimelineFilters
} from "./catalog-filters.js";
import type { GalleryDetailRow, GalleryPersonRow, ItemMetadataRow, LibraryItemRow, NonNull, Nullable, TagRow } from "../../../db/rows.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export interface GalleryTimelineQuery {
  q: string;
  kinds: string[];      // ['photo'|'video'|'audio'] subset; empty = all
  filters?: GalleryTimelineFilters;
  // 'taken' (default) = newest-first by the EXIF date; 'added' = newest-first by
  // when the scanner/upload discovered the item (library_items.discovered_at).
  sort?: "taken" | "added";
  limit: number;
  offset: number;
}

// Timeline: assets newest-first by taken_at (or discovered_at when sort='added').
// The client buckets consecutive assets into day headers from the sorted date
// (Immich-style), so this just returns an ordered, paged slice plus the total for
// infinite scroll.
export function queryGalleryTimeline(userId: string, libIds: string[], opts: GalleryTimelineQuery) {
  if (libIds.length === 0) return { assets: [], total: 0 };
  const where: string[] = [`library_items.library_id IN (${inClause(libIds.length)})`, "library_items.deleted_at IS NULL"];
  const args: unknown[] = [...libIds];
  if (opts.q) {
    // Match what a person would type: the title, the caption, any folder/file-name
    // segment, or a tagged person's name (audiobook search spans people the same way).
    where.push(`(item_metadata.title LIKE ? OR item_metadata.description LIKE ? OR library_items.folder_path LIKE ? OR EXISTS (
      SELECT 1 FROM gallery_faces gf JOIN gallery_people gp ON gp.id = gf.person_id
      WHERE gf.item_id = library_items.id AND gf.assignment != 'rejected' AND gp.name LIKE ?))`);
    const like = `%${opts.q}%`;
    args.push(like, like, like, like);
  }
  if (opts.kinds.length > 0) { where.push(`gallery_details.kind IN (${inClause(opts.kinds.length)})`); args.push(...opts.kinds); }
  const extra = galleryFilterClauses(opts.filters ?? EMPTY_GALLERY_FILTERS, userId);
  where.push(...extra.clauses);
  args.push(...extra.args);

  const whereSql = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id WHERE ${whereSql}`)
    .get(...args) as { n: number }).n;

  const orderSql = opts.sort === "added"
    ? "library_items.discovered_at DESC, library_items.id DESC"
    : "gallery_details.taken_at DESC, library_items.id DESC";
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?
  `).all(userId, ...args, opts.limit, opts.offset) as AssetRow[];

  return { assets: rows.map(mapAsset), total };
}

// Folder view: the immediate subfolders of `parent` (with an asset count + a cover
// from each subtree's most recent asset) plus the assets that live directly in
// `parent`. `parent` is a normalised relative path ("" = library root).
export function queryGalleryFolders(userId: string, libIds: string[], parent: string, limit: number, offset: number) {
  if (libIds.length === 0) return { parent, folders: [], assets: [], total: 0 };
  // Trim leading/trailing slashes with a linear scan, not /^\/+|\/+$/g: `parent`
  // is a raw query param, and that regex is quadratic (js/polynomial-redos) on an
  // input with a long internal slash run (e.g. "a/////…////b").
  let start = 0;
  let end = parent.length;
  while (start < end && parent.charCodeAt(start) === 47) start += 1;   // 47 = '/'
  while (end > start && parent.charCodeAt(end - 1) === 47) end -= 1;
  const cleanParent = parent.slice(start, end);
  const libArgs = [...libIds];
  const libIn = inClause(libIds.length);

  // relative path of each asset within `parent`; only assets at or below `parent`.
  const scopeWhere = cleanParent
    ? `library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL AND library_items.folder_path LIKE ?`
    : `library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL`;
  const scopeArgs = cleanParent ? [...libArgs, `${cleanParent}/%`] : [...libArgs];
  // SQL expr giving the path relative to `parent`.
  const relExpr = cleanParent
    ? `substr(library_items.folder_path, ${cleanParent.length + 2})`
    : `library_items.folder_path`;

  // Immediate subfolders: first segment of the relative path, when it has one.
  const folderRows = db.prepare(`
    WITH rel AS (
      SELECT library_items.id AS id, gallery_details.taken_at AS taken_at,
        item_metadata.cover_storage_key AS cover,
        ${relExpr} AS r
      FROM library_items
      JOIN gallery_details ON gallery_details.item_id = library_items.id
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      WHERE ${scopeWhere}
    ),
    sub AS (
      SELECT substr(r, 1, instr(r, '/') - 1) AS name, cover, taken_at,
        ROW_NUMBER() OVER (PARTITION BY substr(r, 1, instr(r, '/') - 1) ORDER BY taken_at DESC) AS rn,
        COUNT(*) OVER (PARTITION BY substr(r, 1, instr(r, '/') - 1)) AS cnt
      FROM rel WHERE instr(r, '/') > 0
    )
    SELECT name, cover, cnt FROM sub WHERE rn = 1 ORDER BY name COLLATE NOCASE
  `).all(...scopeArgs) as { name: string; cover: ItemMetadataRow["cover_storage_key"] | null; cnt: number }[];

  // Locked = a folder lock covers the tile's path in ANY in-scope library. A tile
  // can aggregate several libraries sharing a relative path; "locked in any" is
  // close enough for a badge — enforcement is per item, inside trashBook.
  const locks = locksByLibrary(libIds);
  const lockedIn = (folderPath: string): boolean =>
    libIds.some((id) => lockCoveredIn(locks.get(id), folderPath));

  const folders = folderRows.map((f) => {
    const folderPath = cleanParent ? `${cleanParent}/${f.name}` : f.name;
    return {
      name: f.name,
      path: folderPath,
      assetCount: f.cnt,
      coverUrl: f.cover ? `/api/library/covers/${f.cover}` : null,
      locked: lockedIn(folderPath)
    };
  });

  // Assets directly in `parent` (no further "/" in the relative path).
  const directWhere = cleanParent
    ? `library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL AND library_items.folder_path LIKE ? AND library_items.folder_path NOT LIKE ?`
    : `library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL AND library_items.folder_path NOT LIKE ?`;
  const directArgs = cleanParent ? [...libArgs, `${cleanParent}/%`, `${cleanParent}/%/%`] : [...libArgs, `%/%`];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE ${directWhere}`).get(...directArgs) as { n: number }).n;
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE ${directWhere}
    ORDER BY gallery_details.taken_at DESC, library_items.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, ...directArgs, limit, offset) as AssetRow[];

  return {
    parent: cleanParent,
    // Whether the folder being LOOKED AT is itself locked — what the Lock/Unlock
    // toggle in the folder bar renders its state from. False at the root: the
    // whole library is the library policy's job, not a lock's.
    parentLocked: cleanParent !== "" && lockedIn(cleanParent),
    folders, assets: rows.map(mapAsset), total
  };
}

// Find folders BY NAME, anywhere in the scope. The browse query above answers "what
// is inside this folder"; this answers "where is the folder called wedding", which is
// a different question — the folder being hunted is usually buried levels deep, so
// matching only the level on screen would find nothing.
//
// Folders are derived from the items' folder_path values, and a folder that holds
// only subfolders never appears as anyone's folder_path — it exists purely as a
// middle segment ("2004/wedding/day1" is the only path, yet "2004/wedding" is a real
// folder to the person who made it). So every ancestor of every path is enumerated,
// in memory: distinct folder paths number in the thousands where items number in the
// hundreds of thousands, and SQL has no clean way to split a path into rows.
export function searchGalleryFolders(libIds: string[], q: string, limit: number) {
  const term = q.trim().toLowerCase();
  // No term lists the scope's folders instead of nothing: the Keep dialog's
  // "use an existing folder" tab opens on the whole list and narrows as you type.
  if (libIds.length === 0) return { folders: [], total: 0 };

  const rows = db.prepare(`
    SELECT library_items.folder_path AS p, COUNT(*) AS n
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.library_id IN (${inClause(libIds.length)}) AND library_items.deleted_at IS NULL
    GROUP BY library_items.folder_path
  `).all(...libIds) as { p: LibraryItemRow["folder_path"]; n: number }[];

  // Cumulative count per folder — its own items plus everything below. A gallery
  // item's folder_path is the FILE's relative path, so its last segment is the file
  // name, not a folder: only the prefixes above it are folders. (Counting the file
  // too once made "mp4" match every video as a folder that then opened empty.)
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.p) continue;
    const segments = row.p.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i).join("/");
      counts.set(prefix, (counts.get(prefix) ?? 0) + row.n);
    }
  }

  const matched = [...counts.entries()]
    .filter(([folderPath]) => {
      if (!term) return true;
      const name = folderPath.slice(folderPath.lastIndexOf("/") + 1);
      return name.toLowerCase().includes(term);
    })
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));

  // Cover: the newest item's, exactly as the browse tiles choose theirs.
  const coverStmt = db.prepare(`
    SELECT item_metadata.cover_storage_key AS cover
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.library_id IN (${inClause(libIds.length)}) AND library_items.deleted_at IS NULL
      AND (library_items.folder_path = ? OR library_items.folder_path LIKE ?)
    ORDER BY gallery_details.taken_at DESC LIMIT 1
  `);

  const locks = locksByLibrary(libIds);
  const folders = matched.slice(0, limit).map(([folderPath, count]) => {
    const row = coverStmt.get(...libIds, folderPath, `${folderPath}/%`) as { cover: ItemMetadataRow["cover_storage_key"] | null } | undefined;
    return {
      name: folderPath.slice(folderPath.lastIndexOf("/") + 1),
      path: folderPath,
      assetCount: count,
      coverUrl: row?.cover ? `/api/library/covers/${row.cover}` : null,
      locked: libIds.some((id) => lockCoveredIn(locks.get(id), folderPath))
    };
  });

  return { folders, total: matched.length };
}

// Facets: which kinds exist, the year range, how many assets carry GPS (drives
// whether the Map view is offered), and the filter-panel option lists (people,
// tags, cameras) — all scoped to the libraries the user can see.
export function galleryFacets(libIds: string[], language = "en") {
  if (libIds.length === 0) return { kinds: [], years: [], withGps: 0, people: [], tags: [], cameras: [], places: [] };
  const libIn = inClause(libIds.length);
  const kinds = (db.prepare(`
    SELECT gallery_details.kind AS v, COUNT(*) AS n
    FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
    GROUP BY gallery_details.kind ORDER BY gallery_details.kind
  `).all(...libIds) as { v: GalleryDetailRow["kind"]; n: number }[]).map((r) => ({ kind: r.v, count: r.n }));
  const years = (db.prepare(`
    SELECT DISTINCT substr(gallery_details.taken_at, 1, 4) AS y
    FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL AND gallery_details.taken_at IS NOT NULL
    ORDER BY y DESC
  `).all(...libIds) as { y: string | null }[]).map((r) => r.y).filter((y): y is string => Boolean(y));
  const withGps = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
      AND gallery_details.gps_lat IS NOT NULL AND gallery_details.gps_lng IS NOT NULL
  `).get(...libIds) as { n: number }).n;
  // Named, visible people who appear in at least one asset in scope. Auto-clusters
  // are unnamed (name = '') and stay out of the filter list.
  const people = (db.prepare(`
    SELECT DISTINCT gp.name AS v
    FROM gallery_people gp
    WHERE gp.name != '' AND gp.hidden = 0 AND EXISTS (
      SELECT 1 FROM gallery_faces gf JOIN library_items li ON li.id = gf.item_id
      WHERE gf.person_id = gp.id AND gf.assignment != 'rejected'
        AND li.deleted_at IS NULL AND li.library_id IN (${libIn}))
    ORDER BY v COLLATE NOCASE
  `).all(...libIds) as { v: GalleryPersonRow["name"] }[]).map((r) => r.v);
  const tags = (db.prepare(`
    SELECT DISTINCT tags.display_name AS v
    FROM tags
    JOIN taggables ON taggables.tag_id = tags.id AND taggables.entity_type = 'library_item'
    JOIN library_items ON library_items.id = taggables.entity_id
    WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
    ORDER BY v COLLATE NOCASE
  `).all(...libIds) as { v: TagRow["display_name"] }[]).map((r) => r.v);
  const cameras = (db.prepare(`
    SELECT DISTINCT v FROM (
      SELECT ${CAMERA_SQL} AS v
      FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id
      WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
    ) WHERE v IS NOT NULL AND v != '' ORDER BY v COLLATE NOCASE
  `).all(...libIds) as { v: string }[]).map((r) => r.v);
  return { kinds, years, withGps, people, tags, cameras, places: placeFacet(libIds, language) };
}

/** How many places the filter offers, most photographed first. */
const PLACE_FACET_LIMIT = 200;

// The places photos in scope were taken in, spelled in the viewer's language —
// empty without a place names database, since gallery_places is emptied with it.
function placeFacet(libIds: string[], language: string) {
  const rows = db.prepare(`
    SELECT gallery_places.place_id AS id, COUNT(*) AS n
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN gallery_places ON gallery_places.item_id = library_items.id
      AND gallery_places.lat = gallery_details.gps_lat AND gallery_places.lng = gallery_details.gps_lng
    WHERE library_items.library_id IN (${inClause(libIds.length)}) AND library_items.deleted_at IS NULL
      AND gallery_places.place_id IS NOT NULL
    GROUP BY gallery_places.place_id ORDER BY n DESC LIMIT ${PLACE_FACET_LIMIT}
  `).all(...libIds) as { id: number; n: number }[];
  const facet: { id: number; name: string; region: string | null; country: string; count: number }[] = [];
  for (const row of rows) {
    const label = describePlace(row.id, language);
    if (label) facet.push({ id: row.id, name: label.place, region: label.region, country: label.country, count: row.n });
  }
  return facet;
}

type MapPointRow = Pick<LibraryItemRow, "id" | "folder_path">
  & NonNull<Pick<GalleryDetailRow, "kind" | "gps_lat" | "gps_lng">, "gps_lat" | "gps_lng">
  & Nullable<Pick<ItemMetadataRow, "title" | "cover_storage_key">>;

export interface GalleryMapQuery {
  kinds: string[];  // ['photo'|'video'|'audio'] subset; empty = all
  limit: number;
}

// Map points: every geotagged asset (newest first), as lightweight markers. Only the
// fields a pin + its popup thumbnail need — the lightbox fetches the full asset on
// click via getGalleryAsset, so this payload stays small even for big libraries.
export function queryGalleryMapPoints(libIds: string[], opts: GalleryMapQuery) {
  if (libIds.length === 0) return { points: [] };
  const where: string[] = [
    `library_items.library_id IN (${inClause(libIds.length)})`,
    "library_items.deleted_at IS NULL",
    "gallery_details.gps_lat IS NOT NULL",
    "gallery_details.gps_lng IS NOT NULL"
  ];
  const args: unknown[] = [...libIds];
  if (opts.kinds.length > 0) { where.push(`gallery_details.kind IN (${inClause(opts.kinds.length)})`); args.push(...opts.kinds); }

  const rows = db.prepare(`
    SELECT
      library_items.id,
      gallery_details.kind,
      item_metadata.title,
      library_items.folder_path,
      item_metadata.cover_storage_key,
      gallery_details.gps_lat,
      gallery_details.gps_lng
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE ${where.join(" AND ")}
    ORDER BY gallery_details.taken_at DESC, library_items.id DESC
    LIMIT ?
  `).all(...args, opts.limit) as MapPointRow[];

  return {
    points: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title ?? r.folder_path.split("/").pop() ?? r.folder_path,
      lat: r.gps_lat,
      lng: r.gps_lng,
      coverUrl: r.cover_storage_key ? `/api/library/covers/${r.cover_storage_key}` : null
    }))
  };
}
