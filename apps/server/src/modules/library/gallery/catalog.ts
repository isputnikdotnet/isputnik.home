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
  rotation: number | null;
  duration_seconds: number | null;
  mime_type: string | null;
  size: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
  camera_make: string | null;
  camera_model: string | null;
  cover_storage_key: string | null;
  preview_storage_key: string | null;
  updated_at: string | null;
  saved: number | null;
}

export const ASSET_COLUMNS = `
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
  gallery_details.rotation,
  gallery_details.duration_seconds,
  gallery_details.mime_type,
  gallery_details.size,
  gallery_details.gps_lat,
  gallery_details.gps_lng,
  gallery_details.camera_make,
  gallery_details.camera_model,
  item_metadata.cover_storage_key,
  gallery_details.preview_storage_key,
  gallery_details.updated_at,
  (item_saves.id IS NOT NULL) AS saved`;

export const ASSET_JOINS = `
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

export type GalleryAssetRow = AssetRow;

export function mapAsset(row: AssetRow) {
  const rotation = row.rotation ?? 0;
  // Thumbnails are regenerated in place (same storage key) on rotate/edit, so bust
  // the image cache with updated_at — otherwise the <img> keeps the stale bytes.
  const v = row.updated_at ? `?v=${encodeURIComponent(row.updated_at)}` : "";
  const coverUrl = row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}${v}` : null;
  const previewUrl = row.preview_storage_key ? `/api/library/covers/${row.preview_storage_key}${v}` : coverUrl;
  // A 90/270° manual rotation swaps the displayed dimensions; the raw width/height
  // stay in the DB so a rescan can recompute them from the file.
  const swap = rotation === 90 || rotation === 270;
  return {
    id: row.id,
    libraryId: row.library_id,
    folderPath: row.folder_path,
    folder: row.folder_path.includes("/") ? row.folder_path.slice(0, row.folder_path.lastIndexOf("/")) : "",
    kind: row.kind,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    description: row.description,
    takenAt: row.taken_at,
    width: swap ? row.height : row.width,
    height: swap ? row.width : row.height,
    orientation: row.orientation,
    rotation,
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

// One display string per camera, shared by the facet list and the filter WHERE so
// the two always agree. Models usually embed the make ("Canon EOS 400D"), so the
// make is only prepended when the model doesn't already start with it.
const CAMERA_SQL = `
  CASE
    WHEN gallery_details.camera_model IS NULL THEN gallery_details.camera_make
    WHEN gallery_details.camera_make IS NULL THEN gallery_details.camera_model
    WHEN instr(lower(gallery_details.camera_model), lower(gallery_details.camera_make)) = 1 THEN gallery_details.camera_model
    ELSE gallery_details.camera_make || ' ' || gallery_details.camera_model
  END`;

// File-size buckets (the audiobook length buckets, for bytes). Boundaries are
// binary megabytes; each code maps to a half-open [min, max) range on
// gallery_details.size.
const MIB = 1024 * 1024;
const SIZE_BUCKETS: Record<string, { min: number; max: number | null }> = {
  small: { min: 0, max: MIB },            // under 1 MB
  medium: { min: MIB, max: 5 * MIB },     // 1–5 MB
  large: { min: 5 * MIB, max: 25 * MIB }, // 5–25 MB
  huge: { min: 25 * MIB, max: null }      // 25 MB+
};

// Advanced filters (mirrors the audiobook catalog's filter arrays): every list is
// OR within itself and AND against the others. `location` takes the codes
// 'with_gps' / 'no_gps' — selecting both is the same as selecting neither.
export interface GalleryTimelineFilters {
  people: string[];   // gallery_people names (named face groups / manual tags)
  tags: string[];     // tag display names
  years: string[];    // 'YYYY' from taken_at
  taken: string[];    // date-taken bounds: 'from:YYYY-MM-DD' / 'to:YYYY-MM-DD' (inclusive)
  cameras: string[];  // CAMERA_SQL display strings
  sizes: string[];    // SIZE_BUCKETS codes: small | medium | large | huge
  location: string[]; // 'with_gps' | 'no_gps'
}

export const EMPTY_GALLERY_FILTERS: GalleryTimelineFilters = {
  people: [], tags: [], years: [], taken: [], cameras: [], sizes: [], location: []
};

function galleryFilterClauses(filters: GalleryTimelineFilters): { clauses: string[]; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filters.people.length > 0) {
    clauses.push(`EXISTS (
      SELECT 1 FROM gallery_faces gf JOIN gallery_people gp ON gp.id = gf.person_id
      WHERE gf.item_id = library_items.id AND gf.assignment != 'rejected' AND gp.name IN (${inClause(filters.people.length)}))`);
    args.push(...filters.people);
  }
  if (filters.tags.length > 0) {
    clauses.push(`EXISTS (
      SELECT 1 FROM taggables JOIN tags ON tags.id = taggables.tag_id
      WHERE taggables.entity_type = 'library_item' AND taggables.entity_id = library_items.id
        AND tags.display_name IN (${inClause(filters.tags.length)}))`);
    args.push(...filters.tags);
  }
  if (filters.years.length > 0) {
    clauses.push(`substr(gallery_details.taken_at, 1, 4) IN (${inClause(filters.years.length)})`);
    args.push(...filters.years);
  }
  // Inclusive date bounds on the calendar day of taken_at. Comparing the date
  // prefix keeps both ends inclusive whatever the stored time-of-day is; an asset
  // with no taken_at compares NULL and drops out, which is what a date filter means.
  for (const bound of filters.taken) {
    if (bound.startsWith("from:")) {
      clauses.push("substr(gallery_details.taken_at, 1, 10) >= ?");
      args.push(bound.slice(5));
    } else if (bound.startsWith("to:")) {
      clauses.push("substr(gallery_details.taken_at, 1, 10) <= ?");
      args.push(bound.slice(3));
    }
  }
  if (filters.cameras.length > 0) {
    clauses.push(`${CAMERA_SQL} IN (${inClause(filters.cameras.length)})`);
    args.push(...filters.cameras);
  }
  const buckets = filters.sizes.map((code) => SIZE_BUCKETS[code]).filter(Boolean);
  if (buckets.length > 0) {
    clauses.push(`(${buckets.map((b) =>
      b.max == null ? "gallery_details.size >= ?" : "(gallery_details.size >= ? AND gallery_details.size < ?)"
    ).join(" OR ")})`);
    for (const b of buckets) {
      args.push(b.min);
      if (b.max != null) args.push(b.max);
    }
  }
  const withGps = filters.location.includes("with_gps");
  const noGps = filters.location.includes("no_gps");
  if (withGps !== noGps) {
    clauses.push(withGps
      ? "gallery_details.gps_lat IS NOT NULL AND gallery_details.gps_lng IS NOT NULL"
      : "(gallery_details.gps_lat IS NULL OR gallery_details.gps_lng IS NULL)");
  }
  return { clauses, args };
}

export interface GalleryTimelineQuery {
  q: string;
  kinds: string[];      // ['photo'|'video'] subset; empty = both
  filters?: GalleryTimelineFilters;
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
  const extra = galleryFilterClauses(opts.filters ?? EMPTY_GALLERY_FILTERS);
  where.push(...extra.clauses);
  args.push(...extra.args);

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

// People tagged in one asset (distinct, name-sorted). Attached only to the
// single-asset detail — the lightbox needs it, the list/timeline views do not.
const peopleForAssetStmt = db.prepare(`
  SELECT DISTINCT gallery_people.id, gallery_people.name
  FROM gallery_faces
  JOIN gallery_people ON gallery_people.id = gallery_faces.person_id
  WHERE gallery_faces.item_id = ? AND gallery_faces.person_id IS NOT NULL
    AND gallery_faces.assignment != 'rejected'
  ORDER BY gallery_people.name COLLATE NOCASE
`);

export function getGalleryAsset(userId: string, libIds: string[], id: string) {
  if (libIds.length === 0) return null;
  const row = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE library_items.id = ? AND library_items.library_id IN (${inClause(libIds.length)}) AND library_items.deleted_at IS NULL
  `).get(userId, id, ...libIds) as AssetRow | undefined;
  if (!row) return null;
  const people = peopleForAssetStmt.all(id) as { id: string; name: string }[];
  return { ...mapAsset(row), people };
}

// Facets: which kinds exist, the year range, how many assets carry GPS (drives
// whether the Map view is offered), and the filter-panel option lists (people,
// tags, cameras) — all scoped to the libraries the user can see.
export function galleryFacets(libIds: string[]) {
  if (libIds.length === 0) return { kinds: [], years: [], withGps: 0, people: [], tags: [], cameras: [] };
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
  `).all(...libIds) as { v: string }[]).map((r) => r.v);
  const tags = (db.prepare(`
    SELECT DISTINCT tags.display_name AS v
    FROM tags
    JOIN taggables ON taggables.tag_id = tags.id AND taggables.entity_type = 'library_item'
    JOIN library_items ON library_items.id = taggables.entity_id
    WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
    ORDER BY v COLLATE NOCASE
  `).all(...libIds) as { v: string }[]).map((r) => r.v);
  const cameras = (db.prepare(`
    SELECT DISTINCT v FROM (
      SELECT ${CAMERA_SQL} AS v
      FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id
      WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
    ) WHERE v IS NOT NULL AND v != '' ORDER BY v COLLATE NOCASE
  `).all(...libIds) as { v: string }[]).map((r) => r.v);
  return { kinds, years, withGps, people, tags, cameras };
}

// Memories ("On this day"): past-year assets whose taken_at matches today's
// month/day, grouped by year (newest year first). The match widens until it finds
// something — exact day → ±3 days → same month — so the row is only empty when no
// past-year asset is dated at all in this month. `precision` reports which tier
// matched so the UI can label the row honestly. Assets without taken_at never
// match (substr on NULL yields NULL); the current year is excluded — today's
// photos are not memories yet.
export interface GalleryMemoryGroup {
  year: number;
  count: number;
  items: ReturnType<typeof mapAsset>[];
}

export type GalleryMemoriesPrecision = "day" | "near" | "month";

// MM-DD strings for `today` ± span days. UTC date arithmetic so a DST boundary
// can't skip or repeat a day; the year-end wrap (Dec 29 → Jan 03) falls out free.
function monthDayWindow(today: string, span: number): string[] {
  const base = new Date(`${today}T00:00:00Z`);
  const out: string[] = [];
  for (let offset = -span; offset <= span; offset += 1) {
    out.push(new Date(base.getTime() + offset * 86_400_000).toISOString().slice(5, 10));
  }
  return out;
}

export function queryGalleryMemories(userId: string, libIds: string[], today: string, perYear: number): {
  precision: GalleryMemoriesPrecision;
  groups: GalleryMemoryGroup[];
} {
  if (libIds.length === 0) return { precision: "day", groups: [] };
  const tiers: { precision: GalleryMemoriesPrecision; clause: string; args: string[] }[] = [
    { precision: "day", clause: "substr(gallery_details.taken_at, 6, 5) = ?", args: [today.slice(5, 10)] },
    { precision: "near", clause: `substr(gallery_details.taken_at, 6, 5) IN (${inClause(7)})`, args: monthDayWindow(today, 3) },
    { precision: "month", clause: "substr(gallery_details.taken_at, 6, 2) = ?", args: [today.slice(5, 7)] }
  ];
  for (const tier of tiers) {
    // Per-year count + the first `perYear` items in one pass: window functions
    // partitioned on the year prefix of taken_at, then a rank cut.
    const rows = db.prepare(`
      WITH matched AS (
        SELECT ${ASSET_COLUMNS},
          substr(gallery_details.taken_at, 1, 4) AS mem_year,
          ROW_NUMBER() OVER (
            PARTITION BY substr(gallery_details.taken_at, 1, 4)
            ORDER BY datetime(gallery_details.taken_at), library_items.id
          ) AS mem_rank,
          COUNT(*) OVER (PARTITION BY substr(gallery_details.taken_at, 1, 4)) AS mem_count
        ${ASSET_JOINS}
        WHERE library_items.library_id IN (${inClause(libIds.length)}) AND library_items.deleted_at IS NULL
          AND substr(gallery_details.taken_at, 1, 4) < ?
          AND ${tier.clause}
      )
      SELECT * FROM matched WHERE mem_rank <= ? ORDER BY mem_year DESC, mem_rank
    `).all(userId, ...libIds, today.slice(0, 4), ...tier.args, perYear) as (AssetRow & { mem_year: string; mem_count: number })[];
    if (rows.length === 0) continue;

    const groups: GalleryMemoryGroup[] = [];
    for (const row of rows) {
      const year = Number.parseInt(row.mem_year, 10);
      const last = groups[groups.length - 1];
      if (last && last.year === year) last.items.push(mapAsset(row));
      else groups.push({ year, count: row.mem_count, items: [mapAsset(row)] });
    }
    return { precision: tier.precision, groups };
  }
  return { precision: "day", groups: [] };
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
