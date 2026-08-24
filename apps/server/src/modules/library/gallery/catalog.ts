// Read queries for the gallery: the date Timeline, the Folder view, single-asset
// detail, and lightweight facets. All are scoped to the libraries the user can
// access (resolved via the shared catalog-core scope helper). Gallery is not a
// "book-like" type, so it does not use the shared catalog engine — its queries are
// asset-centric (one row per photo/video) rather than work/edition-centric.
import { db } from "../../../db.js";
import { canUserAccessLibrary } from "../shared/library-access.js";
import { locksByLibrary, lockCoveredIn } from "../shared/folder-locks.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

// A `?libraryIds=id1,id2` query param, the GET-route counterpart of the timeline
// POST's `filters.libraries` array. Bounded generously — the number of libraries
// on an install, not a payload someone controls the size of.
export function parseLibraryIds(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 200);
}

// Which gallery libraries a query runs over: every one the user can reach, or —
// when `libraryIds` narrows it — the intersection with that set. Narrows only,
// never widens: an id the caller can't reach (or that isn't a gallery library at
// all) simply drops out rather than granting access to it.
export function resolveGalleryScopeLibraryIds(user: { id: string; role: string }, libraryIds?: string[]): string[] {
  const rows = db.prepare("SELECT id FROM libraries WHERE type = 'gallery'").all() as { id: string }[];
  const accessible = rows.filter((row) => canUserAccessLibrary(row, user.id, user.role)).map((row) => row.id);
  if (!libraryIds || libraryIds.length === 0) return accessible;
  const requested = new Set(libraryIds);
  return accessible.filter((id) => requested.has(id));
}

interface AssetRow {
  id: string;
  library_id: string;
  library_name: string | null;
  folder_path: string;
  discovered_at: string;
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
  playable: number | null;
  web_video_key: string | null;
  updated_at: string | null;
  saved: number | null;
  face_focus_x: number | null;
  face_focus_y: number | null;
}

// Faces are detected on the EXIF-oriented photo (arcface.ts rotates before
// detecting), so a box already matches the thumbnail — except for a manual
// rotation, which the thumbnail applies afterwards. Turn the point with it.
// sharp rotates clockwise.
function turnFocus(x: number, y: number, rotation: number): { x: number; y: number } {
  const turn = ((rotation % 360) + 360) % 360;
  if (turn === 90) return { x: 1 - y, y: x };
  if (turn === 180) return { x: 1 - x, y: 1 - y };
  if (turn === 270) return { x: y, y: 1 - x };
  return { x, y };
}

export const ASSET_COLUMNS = `
  library_items.id,
  library_items.library_id,
  libraries.name AS library_name,
  library_items.folder_path,
  library_items.discovered_at,
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
  gallery_details.playable,
  gallery_details.web_video_key,
  gallery_details.updated_at,
  (item_saves.id IS NOT NULL) AS saved,
  -- Where the faces are, as the centre of the box enclosing all of them, so a
  -- square tile can aim its crop at heads instead of the middle of the photo.
  -- Whole-photo tags carry no box; rejected faces aren't this photo's subject.
  (SELECT (MIN(f.box_x) + MAX(f.box_x + f.box_w)) / 2 FROM gallery_faces f
    WHERE f.item_id = library_items.id AND f.box_x IS NOT NULL
      AND f.assignment <> 'rejected') AS face_focus_x,
  (SELECT (MIN(f.box_y) + MAX(f.box_y + f.box_h)) / 2 FROM gallery_faces f
    WHERE f.item_id = library_items.id AND f.box_y IS NOT NULL
      AND f.assignment <> 'rejected') AS face_focus_y`;

export const ASSET_JOINS = `
  FROM library_items
  JOIN gallery_details ON gallery_details.item_id = library_items.id
  LEFT JOIN libraries ON libraries.id = library_items.library_id
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
    libraryName: row.library_name,
    folderPath: row.folder_path,
    folder: row.folder_path.includes("/") ? row.folder_path.slice(0, row.folder_path.lastIndexOf("/")) : "",
    kind: row.kind,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    description: row.description,
    takenAt: row.taken_at,
    addedAt: row.discovered_at,
    width: swap ? row.height : row.width,
    height: swap ? row.width : row.height,
    orientation: row.orientation,
    rotation,
    durationSeconds: row.duration_seconds,
    // Video-only browser-playability flag; null for photos / un-probed videos. A video
    // with a converted web copy plays inline, so report it playable.
    playable: row.web_video_key ? true : row.playable == null ? null : Boolean(row.playable),
    mimeType: row.mime_type,
    size: row.size,
    gps: row.gps_lat != null && row.gps_lng != null ? { lat: row.gps_lat, lng: row.gps_lng } : null,
    camera: row.camera_make || row.camera_model ? { make: row.camera_make, model: row.camera_model } : null,
    coverUrl,
    previewUrl,
    // fileUrl is always the ORIGINAL (downloads); playbackUrl is the web copy when one
    // exists, else the original — that's what the <video> element plays.
    fileUrl: `/api/library/gallery/assets/${row.id}/file`,
    playbackUrl: `/api/library/gallery/assets/${row.id}/file${row.web_video_key ? "?web=1" : ""}`,
    tags: (tagsFor.all(row.id) as { name: string }[]).map((t) => t.name),
    saved: Boolean(row.saved),
    // null when this photo has no detected face — the tile then crops from the
    // centre as before. Percentages, ready for CSS object-position.
    faceFocus: focusOf(row, rotation)
  };
}

function focusOf(row: AssetRow, rotation: number): { x: number; y: number } | null {
  if (row.face_focus_x == null || row.face_focus_y == null) return null;
  const turned = turnFocus(row.face_focus_x, row.face_focus_y, rotation);
  const clamp = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 10;
  return { x: clamp(turned.x), y: clamp(turned.y) };
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
  months: string[];   // 'MM' (01–12) from taken_at, any year
  taken: string[];    // date-taken bounds: 'from:YYYY-MM-DD' / 'to:YYYY-MM-DD' (inclusive)
  cameras: string[];  // CAMERA_SQL display strings
  sizes: string[];    // SIZE_BUCKETS codes: small | medium | large | huge
  location: string[]; // 'with_gps' | 'no_gps'
}

export const EMPTY_GALLERY_FILTERS: GalleryTimelineFilters = {
  people: [], tags: [], years: [], months: [], taken: [], cameras: [], sizes: [], location: []
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
  if (filters.months.length > 0) {
    clauses.push(`substr(gallery_details.taken_at, 6, 2) IN (${inClause(filters.months.length)})`);
    args.push(...filters.months);
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
  const extra = galleryFilterClauses(opts.filters ?? EMPTY_GALLERY_FILTERS);
  where.push(...extra.clauses);
  args.push(...extra.args);

  const whereSql = where.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id WHERE ${whereSql}`)
    .get(...args) as { n: number }).n;

  const orderSql = opts.sort === "added"
    ? "datetime(library_items.discovered_at) DESC, library_items.id DESC"
    : "datetime(gallery_details.taken_at) DESC, library_items.id DESC";
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
        ROW_NUMBER() OVER (PARTITION BY substr(r, 1, instr(r, '/') - 1) ORDER BY datetime(taken_at) DESC) AS rn,
        COUNT(*) OVER (PARTITION BY substr(r, 1, instr(r, '/') - 1)) AS cnt
      FROM rel WHERE instr(r, '/') > 0
    )
    SELECT name, cover, cnt FROM sub WHERE rn = 1 ORDER BY name COLLATE NOCASE
  `).all(...scopeArgs) as { name: string; cover: string | null; cnt: number }[];

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
    ORDER BY datetime(gallery_details.taken_at) DESC, library_items.id DESC
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
  if (libIds.length === 0 || !term) return { folders: [], total: 0 };

  const rows = db.prepare(`
    SELECT library_items.folder_path AS p, COUNT(*) AS n
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.library_id IN (${inClause(libIds.length)}) AND library_items.deleted_at IS NULL
    GROUP BY library_items.folder_path
  `).all(...libIds) as { p: string; n: number }[];

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
    ORDER BY datetime(gallery_details.taken_at) DESC LIMIT 1
  `);

  const locks = locksByLibrary(libIds);
  const folders = matched.slice(0, limit).map(([folderPath, count]) => {
    const row = coverStmt.get(...libIds, folderPath, `${folderPath}/%`) as { cover: string | null } | undefined;
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

// Bulk asset lookup by ids, access-filtered — the suggestion-preview grid needs
// thumbnails for a montage's item ids in one round trip. Results come back in the
// REQUESTED order (a suggestion's ids are chronological); inaccessible or unknown ids
// are silently omitted (the standard bulk contract).
export function getGalleryAssets(userId: string, libIds: string[], itemIds: string[]) {
  if (libIds.length === 0 || itemIds.length === 0) return [];
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE library_items.id IN (${inClause(itemIds.length)})
      AND library_items.library_id IN (${inClause(libIds.length)})
      AND library_items.deleted_at IS NULL
  `).all(userId, ...itemIds, ...libIds) as AssetRow[];
  const byId = new Map(rows.map((row) => [row.id, mapAsset(row)]));
  return itemIds.map((id) => byId.get(id)).filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
}

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

// Load one asset by id WITHOUT the library-scope filter — for callers that have
// authorized access another way (an item-level user share of a photo whose
// library the viewer can't otherwise see). The caller MUST check access first.
export function getGalleryAssetUnscoped(userId: string, id: string) {
  const row = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `).get(userId, id) as AssetRow | undefined;
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
// month/day, grouped by year (newest year first). Assets without taken_at never
// match (substr on NULL yields NULL); the current year is excluded — today's
// photos are not memories yet.
//
// Widening is decided PER YEAR, not once for the whole row. It used to be three
// tiers tried in order — exact day, ±3 days, whole month — returning on the first
// that produced any row at all, which quietly lost a year whose photos were dated
// a day or two off whenever some other year matched exactly: tier one succeeded,
// so the ±3-day tier that would have caught it never ran. A scanned photo dated
// from its negative's sleeve rather than its EXIF is exactly that case, and those
// are the oldest photos in a library — the ones most worth surfacing.
//
// So the day and ±3-day tiers are now one pass, and each year takes the narrowest
// of the two it has anything in. Each group reports its own `precision` so a year
// that had to widen can say so; the top-level one is the narrowest across the
// groups, which is what titles the row. The whole-month tier stays a fallback for
// the whole row, since a month-wide match is a different proposition from an
// anniversary and is only worth offering when there is no anniversary at all.
export interface GalleryMemoryGroup {
  year: number;
  count: number;
  /** How far this year's match had to widen: exactly today, or within ±3 days. */
  precision: GalleryMemoriesPrecision;
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

type MemoryRow = AssetRow & { mem_year: string; mem_count: number; mem_exact: number };

export function queryGalleryMemories(userId: string, libIds: string[], today: string, perYear: number): {
  precision: GalleryMemoriesPrecision;
  groups: GalleryMemoryGroup[];
} {
  if (libIds.length === 0) return { precision: "day", groups: [] };
  const libIn = inClause(libIds.length);
  const exactDay = today.slice(5, 10);

  // Day and ±3 days in one pass. Ranking and counting partition on (year, exact)
  // so each year carries a usable count for whichever of the two it ends up
  // shown at, and the ordering puts a year's exact rows ahead of its near ones
  // so the grouping below can simply take the first kind it sees.
  const nearRows = db.prepare(`
    WITH matched AS (
      SELECT ${ASSET_COLUMNS},
        substr(gallery_details.taken_at, 1, 4) AS mem_year,
        CASE WHEN substr(gallery_details.taken_at, 6, 5) = ? THEN 1 ELSE 0 END AS mem_exact
      ${ASSET_JOINS}
      WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
        AND substr(gallery_details.taken_at, 1, 4) < ?
        AND substr(gallery_details.taken_at, 6, 5) IN (${inClause(7)})
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY mem_year, mem_exact ORDER BY datetime(taken_at), id) AS mem_rank,
        COUNT(*) OVER (PARTITION BY mem_year, mem_exact) AS mem_count
      FROM matched
    )
    SELECT * FROM ranked WHERE mem_rank <= ? ORDER BY mem_year DESC, mem_exact DESC, mem_rank
  `).all(exactDay, userId, ...libIds, today.slice(0, 4), ...monthDayWindow(today, 3), perYear) as MemoryRow[];

  if (nearRows.length > 0) {
    const groups: GalleryMemoryGroup[] = [];
    const byYear = new Map<number, GalleryMemoryGroup>();
    for (const row of nearRows) {
      const year = Number.parseInt(row.mem_year, 10);
      const group = byYear.get(year);
      if (!group) {
        const fresh: GalleryMemoryGroup = {
          year,
          count: row.mem_count,
          precision: row.mem_exact ? "day" : "near",
          items: [mapAsset(row)]
        };
        byYear.set(year, fresh);
        groups.push(fresh);
        continue;
      }
      // Exact rows come first within a year, so a year that has any is already a
      // "day" group and its looser neighbours are not part of the anniversary.
      if (group.precision === "day" && !row.mem_exact) continue;
      group.items.push(mapAsset(row));
    }
    // The row is titled by the best match in it: one year being a couple of days
    // out does not stop the others from being on this day.
    const precision = groups.some((group) => group.precision === "day") ? "day" : "near";
    return { precision, groups };
  }

  // Nothing anywhere near today — offer the month instead, all years alike.
  const monthRows = db.prepare(`
    WITH matched AS (
      SELECT ${ASSET_COLUMNS},
        substr(gallery_details.taken_at, 1, 4) AS mem_year,
        ROW_NUMBER() OVER (
          PARTITION BY substr(gallery_details.taken_at, 1, 4)
          ORDER BY datetime(gallery_details.taken_at), library_items.id
        ) AS mem_rank,
        COUNT(*) OVER (PARTITION BY substr(gallery_details.taken_at, 1, 4)) AS mem_count
      ${ASSET_JOINS}
      WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
        AND substr(gallery_details.taken_at, 1, 4) < ?
        AND substr(gallery_details.taken_at, 6, 2) = ?
    )
    SELECT * FROM matched WHERE mem_rank <= ? ORDER BY mem_year DESC, mem_rank
  `).all(userId, ...libIds, today.slice(0, 4), today.slice(5, 7), perYear) as (AssetRow & { mem_year: string; mem_count: number })[];
  if (monthRows.length === 0) return { precision: "day", groups: [] };

  const groups: GalleryMemoryGroup[] = [];
  for (const row of monthRows) {
    const year = Number.parseInt(row.mem_year, 10);
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.items.push(mapAsset(row));
    else groups.push({ year, count: row.mem_count, precision: "month", items: [mapAsset(row)] });
  }
  return { precision: "month", groups };
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
