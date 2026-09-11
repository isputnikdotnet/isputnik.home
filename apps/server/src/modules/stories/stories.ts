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

export interface StoryRow {
  id: string;
  title: string;
  subtitle: string | null;
  cover_item_id: string | null;
  status: StoryStatus;
  chapter_noun: string | null;
  intro: string | null;
  rating: number | null;
  /** Recipe facts, both optional: serves as free text; total time in minutes. */
  servings: string | null;
  cook_minutes: number | null;
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
