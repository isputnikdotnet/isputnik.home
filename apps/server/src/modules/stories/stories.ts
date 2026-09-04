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
import { accessibleLibraryIds } from "../library/shared/library-access.js";
import { getTrashRetentionDays } from "../library/shared/trash.js";
import { STORY_AUDIO_ENTITY_TYPE, deleteStoryAudio, deleteStoryAudioFiles } from "./audio.js";
import { canManageCollection, canViewCollection, visibleCollectionIds } from "./collection-access.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

/** How a story appears in `taggables` — the same polymorphic tag table that
 *  carries library items, family-tree people and quotes. */
export const STORY_ENTITY_TYPE = "story";

export const STORY_BLOCK_KINDS = [
  "text", "media", "album", "slideshow", "map", "person", "quote", "audio", "book"
] as const;
export type StoryBlockKind = (typeof STORY_BLOCK_KINDS)[number];

/** A book card references an ebook or an audiobook — the one block whose
 *  entity type is chosen per block rather than fixed by its kind. */
export const BOOK_ENTITY_TYPES = ["audiobook", "ebook"] as const;

export const STORY_STATUSES = ["draft", "published"] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/** What shape a story was created as. A kind does exactly three things —
 *  picks the creation template, sets defaults (journal → chapter noun "Day"),
 *  and adds surfacing (a review joins its book's page via back-links). It
 *  NEVER affects permissions, validation, or what the editor allows: any
 *  story can still become anything. */
export const STORY_KINDS = ["free", "memory", "journal", "review"] as const;
export type StoryKind = (typeof STORY_KINDS)[number];

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
  audio: "gallery",
  // Nominal only: a book block's REAL type is per block (BOOK_ENTITY_TYPES),
  // chosen by the picker and stored on the row — this entry just marks the
  // kind as a reference. createBlock and reachability use the chosen type.
  book: "audiobook"
};

export interface StoryRow {
  id: string;
  title: string;
  subtitle: string | null;
  cover_item_id: string | null;
  status: StoryStatus;
  chapter_noun: string | null;
  intro: string | null;
  rating: number | null;
  /** Free-text byline; NULL = the story is unsigned. */
  author_name: string | null;
  collection_id: string | null;
  kind: StoryKind;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Set = the story sits in the Recycle Bin (soft-deleted). */
  deleted_at: string | null;
  /** When the auto-purge may take it; NULL = kept until deleted by hand. */
  purge_after: string | null;
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
  /** 1 = the chapter's pin is its cover, drawn instead of a photo hero. */
  hero_map: number;
}

export interface BlockRow {
  id: string;
  chapter_id: string;
  position: number;
  kind: StoryBlockKind;
  entity_type: string | null;
  entity_id: string | null;
  body: string | null;
  /** The block's own heading, above it in the reader; null = untitled. */
  heading: string | null;
  lat: number | null;
  lng: number | null;
  zoom: number | null;
  label: string | null;
  caption: string | null;
  layout: string | null;
}

/** One stop of a map block's route, in travel order. `mode` and `geometry`
 *  belong to the leg that ARRIVES here — how the traveller got from the stop
 *  before, and the line it followed — so the first stop has neither. */
export interface RoutePoint {
  lat: number;
  lng: number;
  label: string | null;
  mode: string | null;
  /** An encoded polyline (precision 5), fetched once when the route was saved.
   *  Null = draw the leg rather than follow it. */
  geometry: string | null;
}

interface BlockPointRow {
  block_id: string;
  lat: number;
  lng: number;
  label: string | null;
  mode: string | null;
  geometry: string | null;
}

export function getStory(storyId: string): StoryRow | undefined {
  return db.prepare("SELECT * FROM stories WHERE id = ?").get(storyId) as StoryRow | undefined;
}

export function canEditStory(
  story: Pick<StoryRow, "created_by" | "collection_id" | "deleted_at">,
  user: { id: string; role: string }
): boolean {
  // A story in the Recycle Bin is not edited, it is restored — from the bin.
  if (story.deleted_at) return false;
  if (user.role === "admin" || story.created_by === user.id) return true;
  // A collection manager edits every story on their shelf.
  return story.collection_id != null && canManageCollection(user, story.collection_id);
}

/** A draft is visible only to the people who could edit it — and a story in a
 *  restricted collection only to that collection's members. The author always
 *  sees their own story, or an access change could take their writing away.
 *  A story in the Recycle Bin is visible to nobody here — it exists only on
 *  the bin's own page until restored. */
export function canViewStory(story: StoryRow, user: { id: string; role: string }): boolean {
  if (story.deleted_at) return false;
  const base = story.status === "published" || canEditStory(story, user);
  if (!base) return false;
  if (story.collection_id == null || story.created_by === user.id || user.role === "admin") return true;
  return canViewCollection(user, story.collection_id);
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
/** How many chapters a journal's date range may seed — a month of days. A
 *  longer trip gets the range on chapter one and adds days by hand. */
export const MAX_SEEDED_DAYS = 31;

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createStory(
  user: { id: string },
  title: string,
  subtitle: string | null,
  collectionId: string | null = null,
  opts: {
    kind?: StoryKind;
    /** review kind, started from a book page or the picker: the card to seed. */
    reviewOf?: { entityType: string; entityId: string } | null;
    /** Seeds the first chapter's date (any kind); with endDate on a journal,
     *  seeds one chapter per day when both are full dates. Partial dates
     *  ("2004", "2004-07") land as-is on chapter one. */
    date?: string | null;
    endDate?: string | null;
    place?: string | null;
  } = {}
): StoryRow {
  const id = nanoid(16);
  const kind = opts.kind ?? "free";
  // The kind's whole template power, exercised once at creation: a travel
  // journal counts its days, a review opens on the book it judges. From here
  // on the story is just a story — everything seeded is an ordinary field.
  const chapterNoun = kind === "journal" ? "Day" : null;
  db.transaction(() => {
    db.prepare("INSERT INTO stories (id, title, subtitle, created_by, collection_id, kind, chapter_noun) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, title, subtitle, user.id, collectionId, kind, chapterNoun);
    const chapterId = nanoid(16);
    db.prepare("INSERT INTO story_chapters (id, story_id, position) VALUES (?, ?, 1)")
      .run(chapterId, id);

    // A journal with a full from–to range opens with its days already laid
    // out: Day 1 … Day N, each dated — the Polarsteps shape, built in one go.
    let seededDays = false;
    if (kind === "journal" && opts.date && opts.endDate
      && FULL_DATE.test(opts.date) && FULL_DATE.test(opts.endDate)) {
      const start = Date.parse(`${opts.date}T00:00:00Z`);
      const end = Date.parse(`${opts.endDate}T00:00:00Z`);
      const days = Math.round((end - start) / 86_400_000) + 1;
      if (days >= 2 && days <= MAX_SEEDED_DAYS) {
        db.prepare("UPDATE story_chapters SET date = ? WHERE id = ?").run(opts.date, chapterId);
        const insert = db.prepare("INSERT INTO story_chapters (id, story_id, position, date) VALUES (?, ?, ?, ?)");
        for (let day = 1; day < days; day += 1) {
          insert.run(nanoid(16), id, day + 1, new Date(start + day * 86_400_000).toISOString().slice(0, 10));
        }
        seededDays = true;
      }
    }
    if (!seededDays && (opts.date || opts.place)) {
      db.prepare("UPDATE story_chapters SET date = ?, end_date = ?, place = ? WHERE id = ?")
        .run(opts.date ?? null, opts.endDate ?? null, opts.place ?? null, chapterId);
    }

    if (kind === "review" && opts.reviewOf) {
      db.prepare(`
        INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id)
        VALUES (?, ?, 1, 'book', ?, ?)
      `).run(nanoid(16), chapterId, opts.reviewOf.entityType, opts.reviewOf.entityId);
    }
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
  rating?: number | null;
  authorName?: string | null;
  collectionId?: string | null;
}

export function updateStory(storyId: string, fields: StoryUpdate): void {
  db.prepare(`
    UPDATE stories SET
      title         = COALESCE(?, title),
      subtitle      = CASE WHEN ? THEN ? ELSE subtitle END,
      status        = COALESCE(?, status),
      -- Stamped on the way from draft to published (the row's old status is
      -- what the CASE sees), cleared on the way back, untouched otherwise: a
      -- second PATCH saying 'published' does not make the story news again.
      published_at  = CASE
        WHEN ? = 'published' AND status != 'published' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHEN ? = 'draft' THEN NULL
        ELSE published_at END,
      cover_item_id = CASE WHEN ? THEN ? ELSE cover_item_id END,
      chapter_noun  = CASE WHEN ? THEN ? ELSE chapter_noun END,
      intro         = CASE WHEN ? THEN ? ELSE intro END,
      rating        = CASE WHEN ? THEN ? ELSE rating END,
      author_name   = CASE WHEN ? THEN ? ELSE author_name END,
      collection_id = CASE WHEN ? THEN ? ELSE collection_id END,
      updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    fields.title ?? null,
    fields.subtitle !== undefined ? 1 : 0,
    fields.subtitle ?? null,
    fields.status ?? null,
    fields.status ?? null,
    fields.status ?? null,
    fields.coverItemId !== undefined ? 1 : 0,
    fields.coverItemId ?? null,
    fields.chapterNoun !== undefined ? 1 : 0,
    fields.chapterNoun ?? null,
    fields.intro !== undefined ? 1 : 0,
    fields.intro ?? null,
    fields.rating !== undefined ? 1 : 0,
    fields.rating ?? null,
    fields.authorName !== undefined ? 1 : 0,
    fields.authorName ?? null,
    fields.collectionId !== undefined ? 1 : 0,
    fields.collectionId ?? null,
    storyId
  );
}

/** Move a story to the Recycle Bin. Everything stays — chapters, blocks,
 *  tags, favorites, guest links — so a restore brings the story back exactly
 *  as it was; while it sits in the bin nothing serves it (canViewStory says
 *  no, and guest links resolve to nothing). The purge date is stamped from
 *  the bin's retention NOW, the same promise trashed_items makes: changing
 *  the setting later never re-times what is already in the bin. */
export function softDeleteStory(storyId: string): boolean {
  const retention = getTrashRetentionDays();
  return db.prepare(`
    UPDATE stories SET
      deleted_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      purge_after = ${retention > 0 ? "strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)" : "NULL"}
    WHERE id = ? AND deleted_at IS NULL
  `).run(...(retention > 0 ? [`+${retention} days`] : []), storyId).changes > 0;
}

/** Bring a story back from the Recycle Bin, exactly as it was. */
export function restoreStory(storyId: string): boolean {
  return db.prepare(
    "UPDATE stories SET deleted_at = NULL, purge_after = NULL WHERE id = ? AND deleted_at IS NOT NULL"
  ).run(storyId).changes > 0;
}

/** Permanent removal — the Recycle Bin's "delete forever" and the auto-purge. */
export function purgeStory(storyId: string): boolean {
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

/** The bin's story rows, newest deletion first — the Recycle Bin page. The
 *  cover lookup is UNBOUNDED by library access on purpose: this feeds an
 *  admin-only route, and it's the same thumbnail the story's card showed. */
export function listDeletedStories() {
  const rows = db.prepare(`
    SELECT stories.*, users.display_name AS author_name,
      (SELECT COUNT(*) FROM story_chapters WHERE story_chapters.story_id = stories.id) AS chapter_count,
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = stories.cover_item_id AND library_items.deleted_at IS NULL),
        (SELECT item_metadata.cover_storage_key FROM story_blocks
          JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
          JOIN library_items ON library_items.id = story_blocks.entity_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE story_chapters.story_id = stories.id
            AND story_blocks.entity_type = 'gallery' AND story_blocks.kind = 'media'
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY story_chapters.position, story_blocks.position LIMIT 1)
      ) AS cover_key
    FROM stories
    LEFT JOIN users ON users.id = stories.created_by
    WHERE stories.deleted_at IS NOT NULL
    ORDER BY datetime(stories.deleted_at) DESC
  `).all() as (StoryRow & { author_name: string | null; chapter_count: number; cover_key: string | null })[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    kind: row.kind,
    chapterCount: row.chapter_count,
    authorName: row.author_name,
    coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
    deletedAt: row.deleted_at,
    purgesAt: row.purge_after
  }));
}

/** Purge every binned story that has outlived its promised window. Run by the
 *  same scheduled job that purges expired trashed_items. */
export function purgeExpiredStories(): { purged: number } {
  const rows = db.prepare(
    "SELECT id FROM stories WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND datetime(purge_after) <= datetime('now')"
  ).all() as { id: string }[];
  for (const row of rows) purgeStory(row.id);
  return { purged: rows.length };
}

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

/** Mark or unmark a story as one of the user's favorites. Idempotent both
 *  ways — saving twice or unsaving a story never saved is fine. */
export function setStorySaved(storyId: string, userId: string, saved: boolean): void {
  if (saved) {
    db.prepare(
      "INSERT OR IGNORE INTO story_saves (story_id, user_id) VALUES (?, ?)"
    ).run(storyId, userId);
  } else {
    db.prepare("DELETE FROM story_saves WHERE story_id = ? AND user_id = ?").run(storyId, userId);
  }
}

export function isStorySaved(storyId: string, userId: string): boolean {
  return db.prepare(
    "SELECT 1 FROM story_saves WHERE story_id = ? AND user_id = ?"
  ).get(storyId, userId) !== undefined;
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
    ORDER BY datetime(stories.updated_at) DESC
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
  `).all(...storyIds, ...entityTypes, ...entityIds) as { story_id: string; entity_type: string; entity_id: string }[];
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
  `).get(itemId) as { type: string } | undefined;
  if (row?.type === "gallery" || row?.type === "audiobook" || row?.type === "ebook") return row.type;
  return null;
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
  heroMap?: boolean;
}

function nextPosition(table: "story_chapters" | "story_blocks", column: "story_id" | "chapter_id", parentId: string): number {
  return (db.prepare(
    `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM ${table} WHERE ${column} = ?`
  ).get(parentId) as { pos: number }).pos;
}

export function createChapter(storyId: string, fields: ChapterFields, actorId?: string): ChapterRow {
  const id = nanoid(16);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO story_chapters
        (id, story_id, position, title, date, end_date, date_approx, place, place_lat, place_lng, description, standfirst, hero_item_id, hero_map)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      fields.heroItemId ?? null,
      fields.heroMap ? 1 : 0
    );
    // A chapter added to a story the house has already been shown is news to
    // the house; one added while drafting is not — the publish is. Recorded
    // here so every way of adding a chapter counts, whoever adds it.
    const status = db.prepare("SELECT status FROM stories WHERE id = ?").get(storyId) as { status: string } | undefined;
    if (status?.status === "published") {
      db.prepare("INSERT INTO story_updates (id, story_id, chapter_id, actor_id) VALUES (?, ?, ?, ?)")
        .run(nanoid(16), storyId, id, actorId ?? null);
    }
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
        hero_item_id = CASE WHEN ? THEN ? ELSE hero_item_id END,
        hero_map    = COALESCE(?, hero_map)
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
      fields.heroMap === undefined ? null : fields.heroMap ? 1 : 0,
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
  const row = db.prepare("SELECT kind FROM story_blocks WHERE id = ?").get(blockId) as { kind: string } | undefined;
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
