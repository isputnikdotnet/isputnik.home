import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "../library/gallery/catalog-asset.js";
import { getAlbum, getAlbumItems } from "../library/gallery/albums.js";
import { getSlideshow, getSlideshowItems } from "../library/gallery/slideshows.js";
import { galleryScopeSql } from "../library/gallery/app-files-access.js";
import { STORY_AUDIO_ENTITY_TYPE, deleteStoryAudio } from "./audio.js";
import { nextPosition, touchStory } from "./chapters.js";
import {
  BLOCK_ENTITY_TYPE,
  BLOCK_PREVIEW_LIMIT,
  type BlockRow,
  PHOTO_GROUP_MAX,
  type RoutePoint,
  type StoryBlockKind
} from "./stories.js";
import type { StoryBlockItemRow, StoryBlockPointRow, StoryBlockRow } from "../../db/rows.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

type BlockPointRow = Pick<StoryBlockPointRow, "block_id" | "lat" | "lng" | "label" | "mode" | "geometry">;

/** One member of a photo group, as the editor sends it and the reader gets it. */
export interface BlockItem {
  itemId: string;
  caption: string | null;
}

export function getBlocks(storyId: string): BlockRow[] {
  return db.prepare(`
    SELECT story_blocks.* FROM story_blocks
    JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
    WHERE story_chapters.story_id = ?
    ORDER BY story_chapters.position ASC, story_blocks.position ASC
  `).all(storyId) as BlockRow[];
}

/** The stops of every given block, keyed by block id and already in travel
 *  order. A block with no stops is simply absent — that is a single-pin map. */
export function blockPointsByIds(blockIds: string[]): Map<string, RoutePoint[]> {
  const out = new Map<string, RoutePoint[]>();
  if (blockIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT block_id, lat, lng, label, mode, geometry FROM story_block_points
    WHERE block_id IN (${inClause(blockIds.length)})
    ORDER BY block_id, position ASC
  `).all(...blockIds) as BlockPointRow[];
  for (const row of rows) {
    const list = out.get(row.block_id) ?? [];
    list.push({ lat: row.lat, lng: row.lng, label: row.label, mode: row.mode, geometry: row.geometry });
    out.set(row.block_id, list);
  }
  return out;
}

/** Replace a block's stops wholesale. The editor always sends the whole list —
 *  reordering a route is the common edit, and diffing would buy nothing on a
 *  handful of rows. */
function writeBlockPoints(blockId: string, points: RoutePoint[]): void {
  // Stops are a map block's business; a list sent for any other kind is dropped
  // rather than left as rows nothing will ever read.
  const row = db.prepare("SELECT kind FROM story_blocks WHERE id = ?").get(blockId) as Pick<StoryBlockRow, "kind"> | undefined;
  if (row?.kind !== "map") return;
  db.prepare("DELETE FROM story_block_points WHERE block_id = ?").run(blockId);
  const insert = db.prepare(
    "INSERT INTO story_block_points (id, block_id, position, lat, lng, label, mode, geometry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  points.forEach((point, index) => {
    // The first stop is arrived at from nowhere, so it never carries a leg.
    insert.run(
      nanoid(16), blockId, index + 1, point.lat, point.lng, point.label ?? null,
      index === 0 ? null : point.mode ?? null,
      index === 0 ? null : point.geometry ?? null
    );
  });
}

/** The members of every given photo group, keyed by block id and already in
 *  authored order. A group with no photos is simply absent. */
export function blockItemsByIds(blockIds: string[]): Map<string, BlockItem[]> {
  const out = new Map<string, BlockItem[]>();
  if (blockIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT block_id, item_id, caption FROM story_block_items
    WHERE block_id IN (${inClause(blockIds.length)})
    ORDER BY block_id, position ASC
  `).all(...blockIds) as Pick<StoryBlockItemRow, "block_id" | "item_id" | "caption">[];
  for (const row of rows) {
    const list = out.get(row.block_id) ?? [];
    list.push({ itemId: row.item_id, caption: row.caption });
    out.set(row.block_id, list);
  }
  return out;
}

/** Replace a group's photos wholesale — same bargain as writeBlockPoints: the
 *  editor always sends the whole list, because reordering and removing are the
 *  common edits and diffing would buy nothing on a handful of rows. */
function writeBlockItems(blockId: string, items: BlockItem[]): void {
  // Members are a photo group's business; a list sent for any other kind is
  // dropped rather than left as rows nothing will ever read.
  const row = db.prepare("SELECT kind FROM story_blocks WHERE id = ?").get(blockId) as Pick<StoryBlockRow, "kind"> | undefined;
  if (row?.kind !== "photos") return;
  db.prepare("DELETE FROM story_block_items WHERE block_id = ?").run(blockId);
  const insert = db.prepare(
    "INSERT INTO story_block_items (id, block_id, position, item_id, caption) VALUES (?, ?, ?, ?, ?)"
  );
  // The same photo twice in one group is a slip, not an intention, so the
  // first place it was put is the one that keeps it.
  const seen = new Set<string>();
  let position = 0;
  for (const item of items) {
    if (seen.has(item.itemId) || seen.size >= PHOTO_GROUP_MAX) continue;
    seen.add(item.itemId);
    insert.run(nanoid(16), blockId, ++position, item.itemId, item.caption ?? null);
  }
}

export function getBlock(blockId: string): BlockRow | undefined {
  return db.prepare("SELECT * FROM story_blocks WHERE id = ?").get(blockId) as BlockRow | undefined;
}

export interface BlockFields {
  entityId?: string | null;
  /** Book blocks only: which of BOOK_ENTITY_TYPES the reference is. */
  entityType?: string | null;
  body?: string | null;
  heading?: string | null;
  lat?: number | null;
  lng?: number | null;
  zoom?: number | null;
  label?: string | null;
  caption?: string | null;
  layout?: string | null;
  /** Map blocks: the route's stops, in travel order. Omitted leaves them as
   *  they are; an empty array clears them back to a single-pin map. */
  points?: RoutePoint[];
  /** Photo groups: the members, in authored order. Omitted leaves them as they
   *  are; an empty array empties the group. */
  items?: BlockItem[];
}

export function createBlock(chapterId: string, storyId: string, kind: StoryBlockKind, fields: BlockFields): BlockRow {
  const id = nanoid(16);
  // A book block stores whichever of the two book types the picker chose;
  // every other kind's entity type is fixed by the kind itself.
  const entityType = kind === "book" ? fields.entityType ?? null : BLOCK_ENTITY_TYPE[kind];
  db.transaction(() => {
    db.prepare(`
      INSERT INTO story_blocks
        (id, chapter_id, position, kind, entity_type, entity_id, body, heading, lat, lng, zoom, label, caption, layout)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      chapterId,
      nextPosition("story_blocks", "chapter_id", chapterId),
      kind,
      entityType,
      entityType ? fields.entityId ?? null : null,
      fields.body ?? null,
      fields.heading ?? null,
      fields.lat ?? null,
      fields.lng ?? null,
      fields.zoom ?? null,
      fields.label ?? null,
      fields.caption ?? null,
      fields.layout ?? null
    );
    if (fields.points) writeBlockPoints(id, fields.points);
    if (fields.items) writeBlockItems(id, fields.items);
    touchStory(storyId);
  })();
  return getBlock(id)!;
}

export function updateBlock(blockId: string, storyId: string, fields: BlockFields): void {
  const set = (key: keyof BlockFields) => (fields[key] !== undefined ? 1 : 0);
  db.transaction(() => {
    db.prepare(`
      UPDATE story_blocks SET
        entity_id = CASE WHEN ? THEN ? ELSE entity_id END,
        body      = CASE WHEN ? THEN ? ELSE body END,
        heading   = CASE WHEN ? THEN ? ELSE heading END,
        lat       = CASE WHEN ? THEN ? ELSE lat END,
        lng       = CASE WHEN ? THEN ? ELSE lng END,
        zoom      = CASE WHEN ? THEN ? ELSE zoom END,
        label     = CASE WHEN ? THEN ? ELSE label END,
        caption   = CASE WHEN ? THEN ? ELSE caption END,
        layout    = CASE WHEN ? THEN ? ELSE layout END
      WHERE id = ?
    `).run(
      set("entityId"), fields.entityId ?? null,
      set("body"), fields.body ?? null,
      set("heading"), fields.heading ?? null,
      set("lat"), fields.lat ?? null,
      set("lng"), fields.lng ?? null,
      set("zoom"), fields.zoom ?? null,
      set("label"), fields.label ?? null,
      set("caption"), fields.caption ?? null,
      set("layout"), fields.layout ?? null,
      blockId
    );
    if (fields.points !== undefined) writeBlockPoints(blockId, fields.points);
    if (fields.items !== undefined) writeBlockItems(blockId, fields.items);
    touchStory(storyId);
  })();
}

export function deleteBlock(blockId: string, storyId: string): boolean {
  const block = getBlock(blockId);
  let removed = false;
  db.transaction(() => {
    removed = db.prepare("DELETE FROM story_blocks WHERE id = ?").run(blockId).changes > 0;
    if (removed) touchStory(storyId);
  })();
  // A LEGACY narration clip exists only for its block, so it goes with it —
  // file and all. Outside the transaction because it touches the filesystem.
  // A gallery-backed recording (entity_type 'gallery') is library content and
  // is never deleted with the block that referenced it.
  if (removed && block?.kind === "audio" && block.entity_type === STORY_AUDIO_ENTITY_TYPE && block.entity_id) {
    deleteStoryAudio(block.entity_id);
  }
  return removed;
}

// Reorder within one chapter, and move blocks between chapters in the same
// call: every id named is reparented to `chapterId`, which is what dragging a
// block into another chapter means. Ids from other stories are ignored.
export function reorderBlocks(storyId: string, chapterId: string, orderedIds: string[]): void {
  const owned = new Set(getBlocks(storyId).map((row) => row.id));
  const move = db.prepare("UPDATE story_blocks SET position = ?, chapter_id = ? WHERE id = ?");
  db.transaction(() => {
    let pos = 1;
    for (const id of orderedIds) {
      if (owned.has(id)) move.run(pos++, chapterId, id);
    }
    touchStory(storyId);
  })();
}

/** Gallery assets by id, filtered to the viewer's libraries, keyed by id.
 *  Media blocks and the inline previews both render from these. */
export function galleryAssetsByIds(userId: string, libIds: string[], itemIds: string[]) {
  const assets = new Map<string, ReturnType<typeof mapAsset>>();
  if (libIds.length === 0 || itemIds.length === 0) return assets;
  const unique = [...new Set(itemIds)];
  const scope = galleryScopeSql(libIds);
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE library_items.id IN (${inClause(unique.length)})
      AND ${scope.sql}
      AND library_items.deleted_at IS NULL
  `).all(userId, ...unique, ...scope.params) as GalleryAssetRow[];
  for (const row of rows) {
    assets.set(row.id, mapAsset(row));
  }
  return assets;
}

/** The first few visible photos of an album/slideshow block, so the reading
 *  view can show the set rather than just a link to it. */
export function blockPreviewAssets(
  kind: StoryBlockKind,
  entityId: string,
  userId: string,
  libIds: string[]
) {
  if (kind === "album") {
    const album = getAlbum(entityId);
    if (!album) return [];
    return getAlbumItems(userId, libIds, album, BLOCK_PREVIEW_LIMIT, 0).assets;
  }
  if (kind === "slideshow") {
    const slideshow = getSlideshow(entityId);
    if (!slideshow) return [];
    // Drop the per-slide dwell — a story preview is a strip of thumbnails, and
    // both branches should hand back the same asset shape.
    return getSlideshowItems(userId, libIds, slideshow, BLOCK_PREVIEW_LIMIT, 0)
      .assets.map(({ dwellSeconds: _dwell, ...asset }) => asset);
  }
  return [];
}
