// One gallery asset as every read hands it back: the columns, the joins, the
// row-to-JSON mapping, and the by-id lookups (scoped and not).
import { db } from "../../../db.js";
import type { TakenPrecision } from "./taken-precision.js";
import { listVoiceNotes } from "./voice-notes.js";
import type { GalleryDetailRow, GalleryPersonRow, ItemMetadataRow, LibraryItemRow, LibraryRow, Nullable, TagRow } from "../../../db/rows.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export type AssetRow = Pick<LibraryItemRow, "id" | "library_id" | "folder_path" | "discovered_at">
  & Pick<GalleryDetailRow,
    | "kind" | "taken_at" | "taken_precision" | "taken_approx" | "place_text" | "reviewed_at"
    | "width" | "height" | "orientation" | "rotation" | "duration_seconds" | "mime_type" | "size"
    | "gps_lat" | "gps_lng" | "camera_make" | "camera_model" | "preview_storage_key" | "playable"
    | "web_video_key" | "updated_at">
  & Nullable<Pick<ItemMetadataRow, "title" | "description" | "cover_storage_key">>
  & {
    library_name: LibraryRow["name"] | null;
    reviewed_by_name: string | null;
    saved: number | null;
    face_focus_x: number | null;
    face_focus_y: number | null;
  };

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
  gallery_details.taken_precision,
  gallery_details.taken_approx,
  gallery_details.place_text,
  gallery_details.reviewed_at,
  (SELECT users.display_name FROM users WHERE users.id = gallery_details.reviewed_by) AS reviewed_by_name,
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
    // How much of takenAt to believe (docs/photo-review-plan.md): a reviewed print
    // may be known only to the year, and "about" reads as "around 1962".
    takenPrecision: (row.taken_precision ?? "time") as TakenPrecision,
    takenApprox: row.taken_approx === 1,
    placeText: row.place_text,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_at ? row.reviewed_by_name : null,
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
    tags: (tagsFor.all(row.id) as { name: TagRow["display_name"] }[]).map((t) => t.name),
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
  const people = peopleForAssetStmt.all(id) as Pick<GalleryPersonRow, "id" | "name">[];
  return { ...mapAsset(row), people, voiceNotes: listVoiceNotes(id) };
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
  const people = peopleForAssetStmt.all(id) as Pick<GalleryPersonRow, "id" | "name">[];
  return { ...mapAsset(row), people, voiceNotes: listVoiceNotes(id) };
}
