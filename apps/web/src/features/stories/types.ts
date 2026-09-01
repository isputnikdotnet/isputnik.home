import type { GalleryAsset } from "../gallery/types";

// Story shapes as the API returns them. See docs/stories-proposal.md — a story
// is a presentation layer: every block REFERENCES library content, and a block
// whose target has gone (or that this viewer can't reach) arrives with
// `available: false` and renders as a placeholder rather than breaking the page.

export type StoryStatus = "draft" | "published";

/** What shape a story was created as — a template choice, nothing more. */
export type StoryKind = "free" | "memory" | "journal" | "review";
export const STORY_KINDS: StoryKind[] = ["free", "memory", "journal", "review"];

/** text = markdown prose · media = one photo/video · album/slideshow = a set ·
 *  map = a place · person = someone in the family tree · quote = a pull quote.
 *  Everything but text and map carries an entity reference. */
export type StoryBlockKind =
  | "text" | "media" | "album" | "slideshow" | "map" | "person" | "quote" | "audio" | "book";

export type StoryBlockLayout = "default" | "wide" | "grid";

export interface StorySummary {
  id: string;
  title: string;
  subtitle: string | null;
  status: StoryStatus;
  chapterCount: number;
  blockCount: number;
  /** Span of the chapters that carry dates — partial ISO, may be null. */
  firstDate: string | null;
  lastDate: string | null;
  /** How many chapters are pinned on the map — the card's "7 places". */
  placesCount: number;
  /** The first chapter's named place — the card cover's location chip. */
  firstPlace: string | null;
  /** This viewer marked it a favorite. */
  saved: boolean;
  /** Stars (1–5), mostly on review-shaped stories; null = unrated. */
  rating: number | null;
  /** The shelf this story sits on; null = standalone. */
  collectionId: string | null;
  kind: StoryKind;
  coverUrl: string | null;
  tags: string[];
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A shelf of stories ("Family Story", "Trips") — date span and count derived
 *  from its member stories, never entered. */
export interface StoryCollectionSummary {
  id: string;
  title: string;
  description: string | null;
  storyCount: number;
  firstDate: string | null;
  lastDate: string | null;
  coverUrl: string | null;
  /** May create stories in it (contributor and up). */
  canContribute: boolean;
  /** May edit every story in it and the access itself (manager and up). */
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoryBlock {
  id: string;
  chapterId: string;
  position: number;
  kind: StoryBlockKind;
  entityType: string | null;
  entityId: string | null;
  /** Markdown source (text blocks). */
  body: string | null;
  lat: number | null;
  lng: number | null;
  zoom: number | null;
  label: string | null;
  caption: string | null;
  layout: StoryBlockLayout | null;
  /** False when the referenced album/photo/slideshow is gone or out of reach. */
  available: boolean;
  title: string | null;
  subtitle: string | null;
  coverUrl: string | null;
  itemCount: number;
  href: string | null;
  /** The photo/video itself (media blocks). */
  asset: GalleryAsset | null;
  /** First few visible photos of an album/slideshow, for the inline strip. */
  preview: GalleryAsset[];
  /** Narration recorded for this story (audio blocks only). */
  audio: { id: string; title: string | null; durationSeconds: number | null; url: string } | null;
}

export interface StoryChapter {
  id: string;
  position: number;
  title: string | null;
  /** Partial ISO ("2004", "2004-07", "2004-07-15"); endDate makes it a range. */
  date: string | null;
  endDate: string | null;
  dateApprox: boolean;
  place: string | null;
  placeLat: number | null;
  placeLng: number | null;
  description: string | null;
  /** One-line teaser under the chapter page's dateline. */
  standfirst: string | null;
  heroItemId: string | null;
  /** The hero photo resolved for this viewer; null = unset or out of reach. */
  hero: GalleryAsset | null;
  blocks: StoryBlock[];
}

export interface StoryDetail {
  id: string;
  title: string;
  subtitle: string | null;
  status: StoryStatus;
  coverItemId: string | null;
  /** The chosen cover resolved for this viewer — the Story Home hero. */
  cover: GalleryAsset | null;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
  /** How many photos an album/slideshow block previews inline. */
  previewLimit: number;
  /** Story-level tags — how a story joins the cross-type tag browse. */
  tags: string[];
  /** What this story calls a chapter ("Day", "Stop") — authored, renders "Day 1". */
  chapterNoun: string | null;
  /** Story Home opening prose (markdown, like text blocks). */
  intro: string | null;
  /** Stars (1–5), mostly on review-shaped stories; null = unrated. */
  rating: number | null;
  /** This viewer marked it a favorite. */
  saved: boolean;
  /** The shelf this story sits on; null = standalone. */
  collectionId: string | null;
  collection: { id: string; title: string } | null;
  kind: StoryKind;
  chapters: StoryChapter[];
}

/** "Day 1" / the chapter's title / its date / a bare number — the strip label,
 *  card eyebrow and chapter-page fallback title all resolve the same way. */
export function chapterLabel(story: Pick<StoryDetail, "chapterNoun">, chapter: StoryChapter, index: number): string {
  if (story.chapterNoun) return `${story.chapterNoun} ${index + 1}`;
  return chapter.title ?? chapter.date ?? String(index + 1);
}

/** A story with one untitled, undated chapter is a flat journal page — the
 *  reader and editor hide the chapter chrome rather than showing "Chapter 1". */
export function hasChapterStructure(story: StoryDetail): boolean {
  if (story.chapters.length > 1) return true;
  const only = story.chapters[0];
  return Boolean(only && (only.title || only.date || only.place || only.description));
}
