// Stories: authored narrative pages composed from content the library already
// holds — prose, photos, albums, slideshows and maps, in dated chapters.
// See docs/stories-proposal.md (Phase 1).
//
// Rules, mirroring gallery albums:
// - every member may read a PUBLISHED story; a draft belongs to its author
//   (and admins), so work in progress is never on the shelf
// - edit (title, chapters, blocks, delete) = creator + admins
// - referenced content resolves against the VIEWER's own library access at read
//   time, so a story can never widen access to anything it points at
//
// Nothing here copies media. A block stores (entity_type, entity_id) — the same
// polymorphic pair collection_items and taggables use, deliberately without a
// foreign key — and a target that has since been deleted degrades to an
// "unavailable" placeholder instead of taking the story's rows with it.
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import {
  ASSET_COLUMNS,
  ASSET_JOINS,
  mapAsset,
  type GalleryAssetRow
} from "../library/gallery/catalog.js";
import { getAlbum, getAlbumItems } from "../library/gallery/albums.js";
import { getSlideshow, getSlideshowItems } from "../library/gallery/slideshows.js";
import { deleteEntityTags, entityTagsByIds, getEntityTags } from "../library/audiobook/categorize.js";
import { deleteSharesForResource } from "../library/shared/share-access.js";
import { STORY_AUDIO_ENTITY_TYPE, deleteStoryAudio, deleteStoryAudioFiles } from "./audio.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

/** How a story appears in `taggables` — the same polymorphic tag table that
 *  carries library items, family-tree people and quotes. */
export const STORY_ENTITY_TYPE = "story";

export const STORY_BLOCK_KINDS = [
  "text", "media", "album", "slideshow", "map", "person", "quote", "audio"
] as const;
export type StoryBlockKind = (typeof STORY_BLOCK_KINDS)[number];

export const STORY_STATUSES = ["draft", "published"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/** How many photos an album/slideshow block shows inline before "View all". */
export const BLOCK_PREVIEW_LIMIT = 6;

// Which subject type backs each reference kind — the bridge between a block's
// `kind` (what it looks like) and the subjects registry (what it points at).
// Text and map blocks hold no reference.
export const BLOCK_ENTITY_TYPE: Record<StoryBlockKind, string | null> = {
  text: null,
  media: "gallery",
  album: "gallery_album",
  slideshow: "gallery_slideshow",
  map: null,
  // Both are already subjects, so they hydrate (and access-check) for free.
  // A person block is the family-tree bridge; a quote block is a pull quote.
  person: "family_tree_person",
  quote: "quote",
  // A recording is a gallery audio asset in the recordings library (v2 —
  // "stories reference, period"). Blocks written before that change carry
  // entity_type 'story_audio' (a story-owned clip, audio.ts) and keep serving
  // until the one-time import in recordings.ts moves them; the read paths
  // accept both shapes.
  audio: "gallery"
};

export interface StoryRow {
  id: string;
  title: string;
  subtitle: string | null;
  cover_item_id: string | null;
  status: StoryStatus;
  chapter_noun: string | null;
  intro: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ChapterRow {
  id: string;
  story_id: string;
  position: number;
  title: string | null;
  date: string | null;
  end_date: string | null;
  date_approx: number;
  place: string | null;
  place_lat: number | null;
  place_lng: number | null;
  description: string | null;
  standfirst: string | null;
  hero_item_id: string | null;
}

export interface BlockRow {
  id: string;
  chapter_id: string;
  position: number;
  kind: StoryBlockKind;
  entity_type: string | null;
  entity_id: string | null;
  body: string | null;
  lat: number | null;
  lng: number | null;
  zoom: number | null;
  label: string | null;
  caption: string | null;
  layout: string | null;
}

export function getStory(storyId: string): StoryRow | undefined {
  return db.prepare("SELECT * FROM stories WHERE id = ?").get(storyId) as StoryRow | undefined;
}

export function canEditStory(story: Pick<StoryRow, "created_by">, user: { id: string; role: string }): boolean {
  return user.role === "admin" || story.created_by === user.id;
}

/** A draft is visible only to the people who could edit it. */
export function canViewStory(story: StoryRow, user: { id: string; role: string }): boolean {
  return story.status === "published" || canEditStory(story, user);
}

function touchStory(storyId: string): void {
  db.prepare("UPDATE stories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(storyId);
}

/** The story a chapter belongs to — every chapter/block write authorizes through this. */
export function storyOfChapter(chapterId: string): StoryRow | undefined {
  return db.prepare(`
    SELECT stories.* FROM stories
    JOIN story_chapters ON story_chapters.story_id = stories.id
    WHERE story_chapters.id = ?
  `).get(chapterId) as StoryRow | undefined;
}

export function storyOfBlock(blockId: string): StoryRow | undefined {
  return db.prepare(`
    SELECT stories.* FROM stories
    JOIN story_chapters ON story_chapters.story_id = stories.id
    JOIN story_blocks ON story_blocks.chapter_id = story_chapters.id
    WHERE story_blocks.id = ?
  `).get(blockId) as StoryRow | undefined;
}

// Every story owns at least one chapter, so the reader, the editor and (later)
// the player only ever handle one shape. A story that needs no structure just
// leaves its single chapter untitled and undated, and the UI hides the chapter
// chrome — "flat journal page" and "chaptered documentary" are the same rows.
export function createStory(user: { id: string }, title: string, subtitle: string | null): StoryRow {
  const id = nanoid(16);
  db.transaction(() => {
    db.prepare("INSERT INTO stories (id, title, subtitle, created_by) VALUES (?, ?, ?, ?)")
      .run(id, title, subtitle, user.id);
    db.prepare("INSERT INTO story_chapters (id, story_id, position) VALUES (?, ?, 1)")
      .run(nanoid(16), id);
  })();
  return getStory(id)!;
}

export interface StoryUpdate {
  title?: string;
  subtitle?: string | null;
  status?: StoryStatus;
  coverItemId?: string | null;
  chapterNoun?: string | null;
  intro?: string | null;
}

export function updateStory(storyId: string, fields: StoryUpdate): void {
  db.prepare(`
    UPDATE stories SET
      title         = COALESCE(?, title),
      subtitle      = CASE WHEN ? THEN ? ELSE subtitle END,
      status        = COALESCE(?, status),
      cover_item_id = CASE WHEN ? THEN ? ELSE cover_item_id END,
      chapter_noun  = CASE WHEN ? THEN ? ELSE chapter_noun END,
      intro         = CASE WHEN ? THEN ? ELSE intro END,
      updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    fields.title ?? null,
    fields.subtitle !== undefined ? 1 : 0,
    fields.subtitle ?? null,
    fields.status ?? null,
    fields.coverItemId !== undefined ? 1 : 0,
    fields.coverItemId ?? null,
    fields.chapterNoun !== undefined ? 1 : 0,
    fields.chapterNoun ?? null,
    fields.intro !== undefined ? 1 : 0,
    fields.intro ?? null,
    storyId
  );
}

export function deleteStory(storyId: string): boolean {
  let removed = false;
  db.transaction(() => {
    // taggables is polymorphic with no FK, so the story's tags are dropped here
    // — the same contract every other taggable type follows. Guest links point
    // at the story the same way and go with it, or they'd linger as dead URLs.
    deleteEntityTags(STORY_ENTITY_TYPE, storyId);
    deleteSharesForResource(STORY_ENTITY_TYPE, storyId);
    // Narration rows cascade with the story; their FILES would not.
    deleteStoryAudioFiles(storyId);
    // Chapters cascade, and blocks cascade from chapters.
    removed = db.prepare("DELETE FROM stories WHERE id = ?").run(storyId).changes > 0;
  })();
  return removed;
}

interface StoryListRow extends StoryRow {
  chapter_count: number;
  block_count: number;
  first_date: string | null;
  last_date: string | null;
  cover_key: string | null;
}

// Stories the viewer should see, newest-updated first: everything published,
// plus their own drafts. The cover prefers the chosen cover photo, else the
// first visible photo any media block points at — so a story looks like
// something on the index page before anyone sets a cover.
//
// `tagId` narrows to the stories carrying that tag, which is what the cross-type
// tag browse asks for — same visibility rule, same card shape.
export function listStories(user: { id: string; role: string }, libIds: string[], tagId?: string) {
  const libArgs = libIds.length > 0 ? libIds : [""];
  const libIn = inClause(libArgs.length);
  const rows = db.prepare(`
    SELECT
      stories.*,
      (SELECT COUNT(*) FROM story_chapters WHERE story_chapters.story_id = stories.id) AS chapter_count,
      (SELECT COUNT(*) FROM story_blocks
        JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
        WHERE story_chapters.story_id = stories.id) AS block_count,
      (SELECT MIN(date) FROM story_chapters
        WHERE story_chapters.story_id = stories.id AND date IS NOT NULL) AS first_date,
      (SELECT MAX(COALESCE(end_date, date)) FROM story_chapters
        WHERE story_chapters.story_id = stories.id AND date IS NOT NULL) AS last_date,
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = stories.cover_item_id AND library_items.deleted_at IS NULL
            AND library_items.library_id IN (${libIn})),
        (SELECT item_metadata.cover_storage_key FROM story_blocks
          JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
          JOIN library_items ON library_items.id = story_blocks.entity_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE story_chapters.story_id = stories.id
            AND story_blocks.entity_type = 'gallery'
            -- media only: a recording's embedded cover art must not become the
            -- story's card (audio blocks are entity_type 'gallery' too).
            AND story_blocks.kind = 'media'
            AND library_items.library_id IN (${libIn})
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY story_chapters.position, story_blocks.position LIMIT 1)
      ) AS cover_key
    FROM stories
    WHERE (stories.status = 'published' OR stories.created_by = ? OR ? = 'admin')
      ${tagId ? `AND EXISTS (SELECT 1 FROM taggables WHERE taggables.entity_type = '${STORY_ENTITY_TYPE}'
            AND taggables.entity_id = stories.id AND taggables.tag_id = ?)` : ""}
    ORDER BY datetime(stories.updated_at) DESC
  `).all(...libArgs, ...libArgs, user.id, user.role, ...(tagId ? [tagId] : [])) as StoryListRow[];

  const tags = storyTagsByStory(rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    chapterCount: row.chapter_count,
    blockCount: row.block_count,
    firstDate: row.first_date,
    lastDate: row.last_date,
    coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
    tags: tags.get(row.id) ?? [],
    canEdit: canEditStory(row, user),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

/** One story's tags, and tags for many stories at once — thin names over the
 *  shared tag readers, so a caller doesn't have to remember the entity type. */
export function getStoryTags(storyId: string): string[] {
  return getEntityTags(STORY_ENTITY_TYPE, storyId);
}

export function storyTagsByStory(storyIds: string[]): Map<string, string[]> {
  return entityTagsByIds(STORY_ENTITY_TYPE, storyIds);
}

export function getChapters(storyId: string): ChapterRow[] {
  return db.prepare(
    "SELECT * FROM story_chapters WHERE story_id = ? ORDER BY position ASC"
  ).all(storyId) as ChapterRow[];
}

export function getChapter(chapterId: string): ChapterRow | undefined {
  return db.prepare("SELECT * FROM story_chapters WHERE id = ?").get(chapterId) as ChapterRow | undefined;
}

export interface ChapterFields {
  title?: string | null;
  date?: string | null;
  endDate?: string | null;
  dateApprox?: boolean;
  place?: string | null;
  placeLat?: number | null;
  placeLng?: number | null;
  description?: string | null;
  standfirst?: string | null;
  heroItemId?: string | null;
}

function nextPosition(table: "story_chapters" | "story_blocks", column: "story_id" | "chapter_id", parentId: string): number {
  return (db.prepare(
    `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM ${table} WHERE ${column} = ?`
  ).get(parentId) as { pos: number }).pos;
}

export function createChapter(storyId: string, fields: ChapterFields): ChapterRow {
  const id = nanoid(16);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO story_chapters
        (id, story_id, position, title, date, end_date, date_approx, place, place_lat, place_lng, description, standfirst, hero_item_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      storyId,
      nextPosition("story_chapters", "story_id", storyId),
      fields.title ?? null,
      fields.date ?? null,
      fields.endDate ?? null,
      fields.dateApprox ? 1 : 0,
      fields.place ?? null,
      fields.placeLat ?? null,
      fields.placeLng ?? null,
      fields.description ?? null,
      fields.standfirst ?? null,
      fields.heroItemId ?? null
    );
    touchStory(storyId);
  })();
  return getChapter(id)!;
}

export function updateChapter(chapterId: string, storyId: string, fields: ChapterFields): void {
  const set = (key: keyof ChapterFields) => (fields[key] !== undefined ? 1 : 0);
  db.transaction(() => {
    db.prepare(`
      UPDATE story_chapters SET
        title       = CASE WHEN ? THEN ? ELSE title END,
        date        = CASE WHEN ? THEN ? ELSE date END,
        end_date    = CASE WHEN ? THEN ? ELSE end_date END,
        date_approx = COALESCE(?, date_approx),
        place       = CASE WHEN ? THEN ? ELSE place END,
        place_lat   = CASE WHEN ? THEN ? ELSE place_lat END,
        place_lng   = CASE WHEN ? THEN ? ELSE place_lng END,
        description = CASE WHEN ? THEN ? ELSE description END,
        standfirst  = CASE WHEN ? THEN ? ELSE standfirst END,
        hero_item_id = CASE WHEN ? THEN ? ELSE hero_item_id END
      WHERE id = ?
    `).run(
      set("title"), fields.title ?? null,
      set("date"), fields.date ?? null,
      set("endDate"), fields.endDate ?? null,
      fields.dateApprox === undefined ? null : fields.dateApprox ? 1 : 0,
      set("place"), fields.place ?? null,
      set("placeLat"), fields.placeLat ?? null,
      set("placeLng"), fields.placeLng ?? null,
      set("description"), fields.description ?? null,
      set("standfirst"), fields.standfirst ?? null,
      set("heroItemId"), fields.heroItemId ?? null,
      chapterId
    );
    touchStory(storyId);
  })();
}

/** Delete a chapter and its blocks. The last chapter can't go — a story always
 *  has one (see createStory); the route turns that into a 400. */
export function deleteChapter(chapterId: string, storyId: string): boolean {
  const remaining = (db.prepare(
    "SELECT COUNT(*) AS n FROM story_chapters WHERE story_id = ?"
  ).get(storyId) as { n: number }).n;
  if (remaining <= 1) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM story_chapters WHERE id = ?").run(chapterId);
    touchStory(storyId);
  })();
  return true;
}

export function reorderChapters(storyId: string, orderedIds: string[]): void {
  const owned = new Set(getChapters(storyId).map((row) => row.id));
  const setPosition = db.prepare("UPDATE story_chapters SET position = ? WHERE id = ? AND story_id = ?");
  db.transaction(() => {
    let pos = 1;
    for (const id of orderedIds) {
      if (owned.has(id)) setPosition.run(pos++, id, storyId);
    }
    touchStory(storyId);
  })();
}

export function getBlocks(storyId: string): BlockRow[] {
  return db.prepare(`
    SELECT story_blocks.* FROM story_blocks
    JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
    WHERE story_chapters.story_id = ?
    ORDER BY story_chapters.position ASC, story_blocks.position ASC
  `).all(storyId) as BlockRow[];
}

export function getBlock(blockId: string): BlockRow | undefined {
  return db.prepare("SELECT * FROM story_blocks WHERE id = ?").get(blockId) as BlockRow | undefined;
}

export interface BlockFields {
  entityId?: string | null;
  body?: string | null;
  lat?: number | null;
  lng?: number | null;
  zoom?: number | null;
  label?: string | null;
  caption?: string | null;
  layout?: string | null;
}

export function createBlock(chapterId: string, storyId: string, kind: StoryBlockKind, fields: BlockFields): BlockRow {
  const id = nanoid(16);
  const entityType = BLOCK_ENTITY_TYPE[kind];
  db.transaction(() => {
    db.prepare(`
      INSERT INTO story_blocks
        (id, chapter_id, position, kind, entity_type, entity_id, body, lat, lng, zoom, label, caption, layout)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      chapterId,
      nextPosition("story_blocks", "chapter_id", chapterId),
      kind,
      entityType,
      entityType ? fields.entityId ?? null : null,
      fields.body ?? null,
      fields.lat ?? null,
      fields.lng ?? null,
      fields.zoom ?? null,
      fields.label ?? null,
      fields.caption ?? null,
      fields.layout ?? null
    );
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
      set("lat"), fields.lat ?? null,
      set("lng"), fields.lng ?? null,
      set("zoom"), fields.zoom ?? null,
      set("label"), fields.label ?? null,
      set("caption"), fields.caption ?? null,
      set("layout"), fields.layout ?? null,
      blockId
    );
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
  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE library_items.id IN (${inClause(unique.length)})
      AND library_items.library_id IN (${inClause(libIds.length)})
      AND library_items.deleted_at IS NULL
  `).all(userId, ...unique, ...libIds) as GalleryAssetRow[];
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
