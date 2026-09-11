import { db } from "../../db.js";
import { entityTagsByIds, getEntityTags } from "../library/shared/tagging.js";
import { accessibleLibraryIds } from "../library/shared/library-access.js";
import { visibleCollectionIds } from "./collection-access.js";
import { canEditStory } from "./access.js";
import { STORY_ENTITY_TYPE, type StoryRow } from "./stories.js";
import type { LibraryRow, NonNull, StoryBlockRow, StoryChapterRow } from "../../db/rows.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

interface StoryListRow extends StoryRow {
  chapter_count: number;
  block_count: number;
  first_date: string | null;
  last_date: string | null;
  places_count: number;
  first_place: string | null;
  saved: number;
  cover_key: string | null;
}

// Stories the viewer should see, newest-updated first: everything published,
// plus their own drafts. The cover prefers the chosen cover photo, else the
// first visible photo any media block points at — so a story looks like
// something on the index page before anyone sets a cover.
//
// `tagId` narrows to the stories carrying that tag, which is what the cross-type
// tag browse asks for — same visibility rule, same card shape.
//
// `ref` narrows to the stories whose blocks reference one of the given
// entities — the back-links query ("Reviews & stories" on a book page,
// "Stories featuring…" on a person). Types come as a list because a book's
// back-links span its whole WORK: every edition, audiobook and ebook alike.
export function listStories(
  user: { id: string; role: string },
  libIds: string[],
  tagId?: string,
  ref?: { entityTypes: string[]; entityIds: string[] },
  collectionId?: string
) {
  const libArgs = libIds.length > 0 ? libIds : [""];
  const libIn = inClause(libArgs.length);
  // The CHOSEN cover may be a photo or a book's own artwork — a review wearing
  // the book it is about — so that one lookup reaches past the gallery into
  // whichever book libraries this viewer can open. The fallback below stays
  // gallery-only: it is looking for a photograph the story shows.
  const coverLibArgs = [...new Set([
    ...libArgs,
    ...accessibleLibraryIds(user.id, user.role, "audiobook"),
    ...accessibleLibraryIds(user.id, user.role, "ebook")
  ])];
  const coverLibIn = inClause(coverLibArgs.length);
  // Collection access overrides member visibility: a story on a restricted
  // shelf lists only for that shelf's members — its author aside. null =
  // admin, no clause at all.
  const visibleCollections = visibleCollectionIds(user);
  const collectionClause = visibleCollections === null
    ? ""
    : `AND (stories.collection_id IS NULL OR stories.created_by = ?
        ${visibleCollections.length > 0 ? `OR stories.collection_id IN (${inClause(visibleCollections.length)})` : ""})`;
  const refClause = ref && ref.entityTypes.length > 0 && ref.entityIds.length > 0
    ? `AND EXISTS (SELECT 1 FROM story_blocks
        JOIN story_chapters AS ref_chapters ON ref_chapters.id = story_blocks.chapter_id
        WHERE ref_chapters.story_id = stories.id
          AND story_blocks.entity_type IN (${inClause(ref.entityTypes.length)})
          AND story_blocks.entity_id IN (${inClause(ref.entityIds.length)}))`
    : "";
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
      (SELECT COUNT(*) FROM story_chapters
        WHERE story_chapters.story_id = stories.id AND place_lat IS NOT NULL) AS places_count,
      (SELECT place FROM story_chapters
        WHERE story_chapters.story_id = stories.id AND place IS NOT NULL AND place != ''
        ORDER BY position LIMIT 1) AS first_place,
      EXISTS (SELECT 1 FROM story_saves
        WHERE story_saves.story_id = stories.id AND story_saves.user_id = ?) AS saved,
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = stories.cover_item_id AND library_items.deleted_at IS NULL
            AND library_items.library_id IN (${coverLibIn})),
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
    WHERE stories.deleted_at IS NULL
      AND (stories.status = 'published' OR stories.created_by = ? OR ? = 'admin')
      ${collectionClause}
      ${collectionId ? "AND stories.collection_id = ?" : ""}
      ${tagId ? `AND EXISTS (SELECT 1 FROM taggables WHERE taggables.entity_type = '${STORY_ENTITY_TYPE}'
            AND taggables.entity_id = stories.id AND taggables.tag_id = ?)` : ""}
      ${refClause}
    ORDER BY stories.updated_at DESC
  `).all(
    user.id, ...coverLibArgs, ...libArgs, user.id, user.role,
    ...(collectionClause ? [user.id, ...(visibleCollections ?? [])] : []),
    ...(collectionId ? [collectionId] : []),
    ...(tagId ? [tagId] : []),
    ...(refClause ? [...ref!.entityTypes, ...ref!.entityIds] : [])
  ) as StoryListRow[];

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
    placesCount: row.places_count,
    firstPlace: row.first_place,
    saved: Boolean(row.saved),
    rating: row.rating,
    authorName: row.author_name,
    collectionId: row.collection_id,
    kind: row.kind,
    coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
    tags: tags.get(row.id) ?? [],
    canEdit: canEditStory(row, user),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

/** Which of the given entities each story's blocks actually reference — the
 *  edition note on a work-wide book query ("reviewed the audiobook edition").
 *  First match per story, in reading order. */
export function storyRefMatches(
  storyIds: string[],
  entityTypes: string[],
  entityIds: string[]
): Map<string, { entityType: string; entityId: string }> {
  const out = new Map<string, { entityType: string; entityId: string }>();
  if (storyIds.length === 0 || entityTypes.length === 0 || entityIds.length === 0) return out;
  const rows = db.prepare(`
    SELECT story_chapters.story_id AS story_id, story_blocks.entity_type AS entity_type, story_blocks.entity_id AS entity_id
    FROM story_blocks
    JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
    WHERE story_chapters.story_id IN (${inClause(storyIds.length)})
      AND story_blocks.entity_type IN (${inClause(entityTypes.length)})
      AND story_blocks.entity_id IN (${inClause(entityIds.length)})
    ORDER BY story_chapters.position ASC, story_blocks.position ASC
  `).all(...storyIds, ...entityTypes, ...entityIds) as (Pick<StoryChapterRow, "story_id">
    & NonNull<Pick<StoryBlockRow, "entity_type" | "entity_id">, "entity_type" | "entity_id">)[];
  for (const row of rows) {
    if (!out.has(row.story_id)) out.set(row.story_id, { entityType: row.entity_type, entityId: row.entity_id });
  }
  return out;
}

/** One story's tags, and tags for many stories at once — thin names over the
 *  shared tag readers, so a caller doesn't have to remember the entity type. */
export function getStoryTags(storyId: string): string[] {
  return getEntityTags(STORY_ENTITY_TYPE, storyId);
}

export function storyTagsByStory(storyIds: string[]): Map<string, string[]> {
  return entityTagsByIds(STORY_ENTITY_TYPE, storyIds);
}

/** Which kind of library the story's cover item lives in. A cover is usually a
 *  photo, but a review can wear the book's own artwork, and the two are checked
 *  — and resolved — differently. Null = gone, or a type that has no cover to
 *  lend. The story CARD has always read the cover straight off the item, so
 *  this only teaches the rest of the app what those rows already allowed. */
export function coverItemKind(itemId: string): "gallery" | "audiobook" | "ebook" | null {
  const row = db.prepare(`
    SELECT libraries.type AS type FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `).get(itemId) as Pick<LibraryRow, "type"> | undefined;
  if (row?.type === "gallery" || row?.type === "audiobook" || row?.type === "ebook") return row.type;
  return null;
}
