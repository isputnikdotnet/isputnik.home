import type { GalleryAsset } from "../gallery/types";

// Story shapes as the API returns them. See docs/stories-proposal.md — a story
// is a presentation layer: every block REFERENCES library content, and a block
// whose target has gone (or that this viewer can't reach) arrives with
// `available: false` and renders as a placeholder rather than breaking the page.

export type StoryStatus = "draft" | "published";

/** text = markdown prose · media = one photo/video · album/slideshow = a set ·
 *  map = a place. Only the middle three carry an entity reference. */
export type StoryBlockKind = "text" | "media" | "album" | "slideshow" | "map";

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
  coverUrl: string | null;
  canEdit: boolean;
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
  blocks: StoryBlock[];
}

export interface StoryDetail {
  id: string;
  title: string;
  subtitle: string | null;
  status: StoryStatus;
  coverItemId: string | null;
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
  /** How many photos an album/slideshow block previews inline. */
  previewLimit: number;
  chapters: StoryChapter[];
}

/** A story with one untitled, undated chapter is a flat journal page — the
 *  reader and editor hide the chapter chrome rather than showing "Chapter 1". */
export function hasChapterStructure(story: StoryDetail): boolean {
  if (story.chapters.length > 1) return true;
  const only = story.chapters[0];
  return Boolean(only && (only.title || only.date || only.place || only.description));
}
