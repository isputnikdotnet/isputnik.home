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
//
// This file is the model — the kinds, statuses and row shapes. The rest sits
// beside it: access.ts (who may see and edit), crud.ts (create, update, the
// Recycle Bin, favorites), list.ts (the index and back-links), chapters.ts and
// blocks.ts.
import type { StoryBlockRow, StoryChapterRow, StoryRow as DbStoryRow } from "../../db/rows.js";

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
 *  story can still become anything. A recipe is a memory with a method: it
 *  opens on three titled chapters (RECIPE_CHAPTERS) and is otherwise an
 *  ordinary story — no ingredient model, no scaling (docs/recipes-plan.md). */
export const STORY_KINDS = ["free", "memory", "journal", "review", "recipe"] as const;
export type StoryKind = (typeof STORY_KINDS)[number];

/** The chapters a recipe is born with, each holding one empty text block.
 *  Seeded as plain titles the author can rename — ordinary chapter titles
 *  from the moment they exist, not a template the story keeps. */
export const RECIPE_CHAPTERS = ["Ingredients", "Method", "Notes"] as const;

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

/** A `stories` row, with status and kind narrowed to the app's own lists.
 *  servings (free text) and cook_minutes are the recipe facts; author_name is
 *  the free-text byline (NULL = unsigned); deleted_at set = the story sits in
 *  the Recycle Bin, purge_after NULL = kept there until deleted by hand. */
export interface StoryRow extends Omit<DbStoryRow, "status" | "kind"> {
  status: StoryStatus;
  kind: StoryKind;
}

/** A `story_chapters` row. hero_map 1 = the chapter's pin is its cover, drawn
 *  instead of a photo hero. */
export type ChapterRow = StoryChapterRow;

/** A `story_blocks` row, kind narrowed. heading is the block's own heading,
 *  above it in the reader; null = untitled. */
export interface BlockRow extends Omit<StoryBlockRow, "kind"> {
  kind: StoryBlockKind;
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
