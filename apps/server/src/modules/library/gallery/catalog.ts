// Read queries for the gallery: the date Timeline, the Folder view, single-asset
// detail, and lightweight facets. All are scoped to the libraries the user can
// access (resolved via the shared catalog-core scope helper). Gallery is not a
// "book-like" type, so it does not use the shared catalog engine — its queries are
// asset-centric (one row per photo/video) rather than work/edition-centric.
import { db } from "../../../db.js";
import { resolveScopeLibraryIds } from "../shared/catalog-core.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export function resolveGalleryScopeLibraryIds(user: { id: string; role: string }, scope: string, libraryId?: string) {
  return resolveScopeLibraryIds(user, scope, libraryId, "gallery");
}

interface AssetRow {
  id: string;
  library_id: string;
  folder_path: string;
  kind: string;
  title: string | null;
  description: string | null;
  taken_at: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  duration_seconds: number | null;
  mime_type: string | null;
  size: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
  camera_make: string | null;
  camera_model: string | null;
  cover_storage_key: string | null;
  preview_storage_key: string | null;
  saved: number | null;
}

const ASSET_COLUMNS = `
  library_items.id,
  library_items.library_id,
  library_items.folder_path,
  gallery_details.kind,
  item_metadata.title,
  item_metadata.description,
  gallery_details.taken_at,
  gallery_details.width,
  gallery_details.height,
  gallery_details.orientation,
  gallery_details.duration_seconds,
  gallery_details.mime_type,
  gallery_details.size,
  gallery_details.gps_lat,
  gallery_details.gps_lng,
  gallery_details.camera_make,
  gallery_details.camera_model,
  item_metadata.cover_storage_key,
  gallery_details.preview_storage_key,
  (item_saves.id IS NOT NULL) AS saved`;

const ASSET_JOINS = `
  FROM library_items
  JOIN gallery_details ON gallery_details.item_id = library_items.id
  LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
  LEFT JOIN item_saves ON item_saves.item_id = library_items.id AND item_saves.user_id = ?`;

const tagsFor = db.prepare(`
  SELECT tags.display_name AS name FROM taggables
  JOIN tags ON tags.id = taggables.tag_id
  WHERE taggables.entity_type = 'library_item' AND taggables.entity_id = ?
  ORDER BY tags.display_name COLLATE NOCASE
`);

function mapAsset(row: AssetRow) {
  const coverUrl = row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null;
  const previewUrl = row.preview_storage_key ? `/api/library/covers/${row.preview_storage_key}` : coverUrl;
  return {
    id: row.id,
    libraryId: row.library_id,
    folderPath: row.folder_path,
    folder: row.folder_path.includes("/") ? row.folder_path.slice(0, row.folder_path.lastIndexOf("/")) : "",
    kind: row.kind,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    description: row.description,
    takenAt: row.taken_at,
    width: row.width,
    height: row.height,
    orientation: row.orientation,
    durationSeconds: row.duration_seconds,
    mimeType: row.mime_type,
    size: row.size,
    gps: row.gps_lat != null && row.gps_lng != null ? { lat: row.gps_lat, lng: row.gps_lng } : null,
    camera: row.camera_make || row.camera_model ? { make: row.camera_make, model: row.camera_model } : null,
    coverUrl,
    previewUrl,
    fileUrl: `/api/library/gallery/assets/${row.id}/file`,
    tags: (tagsFor.all(row.id) as { name: string }[]).map((t) => t.name),
    saved: Boolean(row.saved)
  };
}

export interface GalleryTimelineQuery {
  q: string;
  kinds: string[];      // ['photo'|'video'] subset; empty = both
  limit: number;
  offset: number;
}

// Timeline: assets newest-first by taken_at. The client buckets consecutive assets
// into month headers from each asset's takenAt (Immich-style), so this just returns
// an ordered, paged slice plus the total for infinite scroll.
export function queryGalleryTimeline(userId: string, libIds: string[], opts: GalleryTimelineQuery) {
  if (libIds.length === 0) return { assets: [], total: 0 };
  const where: string[] = [`library_items.library_id IN (${inClause(libIds.length)})`, "library_items.deleted_at IS NULL"];
  const args: unknown[] = [...libIds];
  if (opts.q) { where.push("item_metadata.title LIKE ?"); args.push(`%${opts.q}%`); }
  if (opts.kinds.length > 0) { where.push(`gallery_details.kind IN (${inClause(opts.kinds.length)})`); args.push(...opts.kinds); }

  const whereSql = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id WHERE ${whereSql}`)
    .get(...args) as { n: number }).n;

  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE ${whereSql}
    ORDER BY datetime(gallery_details.taken_at) DESC, library_items.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, ...args, opts.limit, opts.offset) as AssetRow[];

  return { assets: rows.map(mapAsset), total };
}

// Folder view: the immediate subfolders of `parent` (with an asset count + a cover
// from each subtree's most recent asset) plus the assets that live directly in
// `parent`. `parent` is a normalised relative path ("" = library root).
export function queryGalleryFolders(userId: string, libIds: string[], parent: string, limit: number, offset: number) {
  if (libIds.length === 0) return { parent, folders: [], assets: [], total: 0 };
  const cleanParent = parent.replace(/^\/+|\/+$/g, "");
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
        ROW_NUMBER() OVER (PARTITION BY substr(r, 1, instr(r, '/') - 1) ORDER BY datetime(taken_at) DESC) AS rn,
        COUNT(*) OVER (PARTITION BY substr(r, 1, instr(r, '/') - 1)) AS cnt
      FROM rel WHERE instr(r, '/') > 0
    )
    SELECT name, cover, cnt FROM sub WHERE rn = 1 ORDER BY name COLLATE NOCASE
  `).all(...scopeArgs) as { name: string; cover: string | null; cnt: number }[];

  const folders = folderRows.map((f) => ({
    name: f.name,
    path: cleanParent ? `${cleanParent}/${f.name}` : f.name,
    assetCount: f.cnt,
    coverUrl: f.cover ? `/api/library/covers/${f.cover}` : null
  }));

  // Assets directly in `parent` (no further "/" in the relative path).
  const directWhere = cleanParent
    ? `library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL AND library_items.folder_path LIKE ? AND library_items.folder_path NOT LIKE ?`
    : `library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL AND library_items.folder_path NOT LIKE ?`;
  const directArgs = cleanParent ? [...libArgs, `${cleanParent}/%`, `${cleanParent}/%/%`] : [...libArgs, `%/%`];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE ${directWhere}`).get(...directArgs) as { n: number }).n;
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE ${directWhere}
    ORDER BY datetime(gallery_details.taken_at) DESC, library_items.id DESC
    LIMIT ? OFFSET ?
  `).all(userId, ...directArgs, limit, offset) as AssetRow[];

  return { parent: cleanParent, folders, assets: rows.map(mapAsset), total };
}

export function getGalleryAsset(userId: string, libIds: string[], id: string) {
  if (libIds.length === 0) return null;
  const row = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE library_items.id = ? AND library_items.library_id IN (${inClause(libIds.length)}) AND library_items.deleted_at IS NULL
  `).get(userId, id, ...libIds) as AssetRow | undefined;
  return row ? mapAsset(row) : null;
}

// Facets: which kinds exist, the year range, and how many assets carry GPS (drives
// whether the Map view is offered), for the filter UI.
export function galleryFacets(libIds: string[]) {
  if (libIds.length === 0) return { kinds: [], years: [], withGps: 0 };
  const libIn = inClause(libIds.length);
  const kinds = (db.prepare(`
    SELECT gallery_details.kind AS v, COUNT(*) AS n
    FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
    GROUP BY gallery_details.kind ORDER BY gallery_details.kind
  `).all(...libIds) as { v: string; n: number }[]).map((r) => ({ kind: r.v, count: r.n }));
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
  return { kinds, years, withGps };
}

interface MapPointRow {
  id: string;
  kind: string;
  title: string | null;
  folder_path: string;
  cover_storage_key: string | null;
  gps_lat: number;
  gps_lng: number;
}

export interface GalleryMapQuery {
  kinds: string[];  // ['photo'|'video'] subset; empty = both
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
    ORDER BY datetime(gallery_details.taken_at) DESC, library_items.id DESC
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
