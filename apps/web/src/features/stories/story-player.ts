import type { GalleryAsset } from "../gallery/types";
import type { StoryDetail } from "./types";
import type { StorySharePayload, StoryShareAsset } from "../../pages/StoryShareView";

// Turning a story into a show. The player is a sequencer, not a second reader:
// it flattens chapters and blocks into one list of slides and steps through
// them, so nothing here knows how anything is drawn.
//
// Both the signed-in reading view and the public share page feed it, from their
// two different payload shapes. They meet at PlayerSlide — which is why the
// player component itself needs no branch for "is this a guest".

export type PlayerSlide =
  | { id: string; kind: "chapter"; title: string | null; date: string | null; endDate: string | null; dateApprox: boolean; place: string | null; description: string | null }
  | { id: string; kind: "text"; body: string }
  | { id: string; kind: "media"; title: string; src: string; poster: string | null; isVideo: boolean; caption: string | null; durationSeconds: number | null }
  | { id: string; kind: "map"; lat: number; lng: number; zoom: number; label: string | null }
  | { id: string; kind: "person"; name: string; years: string; caption: string | null }
  | { id: string; kind: "quote"; text: string; attribution: string | null }
  | { id: string; kind: "audio"; title: string; src: string; durationSeconds: number | null };

/** Seconds a photo holds before the show moves on, unless the viewer overrides it. */
export const DEFAULT_PHOTO_SECONDS = 6;

const CHAPTER_SECONDS = 4.5;
const MAP_SECONDS = 7;
const PERSON_SECONDS = 5;

// Reading pace for prose and quotes: ~3 words a second is an unhurried
// out-loud pace, floored so a one-line slide doesn't blink past and capped so a
// long passage doesn't strand the room.
const WORDS_PER_SECOND = 3;
const MIN_READ_SECONDS = 5;
const MAX_READ_SECONDS = 24;

function readSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(MAX_READ_SECONDS, Math.max(MIN_READ_SECONDS, words / WORDS_PER_SECOND));
}

/**
 * How long this slide holds. A video is absent from this: it plays to its own
 * end and the player advances on the media event, because guessing a duration
 * would either cut it off or leave dead air.
 */
export function slideSeconds(slide: PlayerSlide, photoSeconds = DEFAULT_PHOTO_SECONDS): number {
  switch (slide.kind) {
    case "chapter": return CHAPTER_SECONDS;
    case "text": return readSeconds(slide.body);
    case "quote": return readSeconds(slide.text);
    case "map": return MAP_SECONDS;
    case "person": return PERSON_SECONDS;
    case "media": return photoSeconds;
    // Narration runs to its own end; this is only the fallback if it never loads.
    case "audio": return slide.durationSeconds ?? MIN_READ_SECONDS;
  }
}

/** Whether the player should wait for the media element rather than a timer.
 *  True for anything with its own runtime — a video, or a narration clip. */
export function waitsForMedia(slide: PlayerSlide): boolean {
  return (slide.kind === "media" && slide.isVideo) || slide.kind === "audio";
}

// A chapter earns an opening card only when it says something — a title, a date
// or a place. The single untitled chapter a plain journal page carries would
// otherwise open the show with a blank card.
function chapterHasCard(chapter: { title: string | null; date: string | null; place: string | null; description: string | null }): boolean {
  return Boolean(chapter.title || chapter.date || chapter.place || chapter.description);
}

/**
 * Slides for the signed-in reading view.
 *
 * `expansions` carries the FULL contents of album and slideshow blocks, which
 * the reading view only holds a preview strip of. A block missing from the map
 * falls back to its preview — the show still runs, just shorter.
 */
export function slidesFromStory(
  story: StoryDetail,
  expansions: Map<string, GalleryAsset[]> = new Map()
): PlayerSlide[] {
  const slides: PlayerSlide[] = [];

  for (const chapter of story.chapters) {
    if (chapterHasCard(chapter)) {
      slides.push({
        id: `chapter-${chapter.id}`,
        kind: "chapter",
        title: chapter.title,
        date: chapter.date,
        endDate: chapter.endDate,
        dateApprox: chapter.dateApprox,
        place: chapter.place,
        description: chapter.description
      });
    }

    for (const block of chapter.blocks) {
      if (!block.available) continue;

      if (block.kind === "text" && block.body?.trim()) {
        slides.push({ id: block.id, kind: "text", body: block.body });
      } else if (block.kind === "media" && block.asset) {
        slides.push(mediaSlide(block.id, block.asset, block.caption));
      } else if (block.kind === "album" || block.kind === "slideshow") {
        const assets = expansions.get(block.id) ?? block.preview;
        assets.forEach((asset, index) => {
          slides.push(mediaSlide(`${block.id}-${index}`, asset, null));
        });
      } else if (block.kind === "map" && block.lat != null && block.lng != null) {
        slides.push({
          id: block.id, kind: "map", lat: block.lat, lng: block.lng,
          zoom: block.zoom ?? 12, label: block.label ?? block.caption
        });
      } else if (block.kind === "person" && block.title) {
        slides.push({
          id: block.id, kind: "person", name: block.title,
          years: block.subtitle ?? "", caption: block.caption
        });
      } else if (block.kind === "quote" && block.title) {
        slides.push({
          id: block.id, kind: "quote", text: block.title, attribution: block.subtitle
        });
      } else if (block.kind === "audio" && block.audio) {
        slides.push({
          id: block.id, kind: "audio", title: block.audio.title ?? "",
          src: block.audio.url, durationSeconds: block.audio.durationSeconds
        });
      }
    }
  }

  return slides;
}

function mediaSlide(id: string, asset: GalleryAsset, caption: string | null): PlayerSlide {
  const isVideo = asset.kind === "video";
  return {
    id,
    kind: "media",
    title: asset.title,
    src: isVideo ? asset.playbackUrl : (asset.previewUrl ?? asset.coverUrl ?? asset.fileUrl),
    poster: asset.previewUrl ?? asset.coverUrl,
    isVideo,
    caption,
    durationSeconds: asset.durationSeconds
  };
}

/**
 * Slides for the public share page. The guest payload already contains exactly
 * what the link exposes, so an album plays through only as far as the link's
 * `expandAlbums` setting allows — the option carries into the show for free.
 */
export function slidesFromShare(payload: StorySharePayload): PlayerSlide[] {
  const slides: PlayerSlide[] = [];

  payload.story.chapters.forEach((chapter, chapterIndex) => {
    if (chapterHasCard(chapter)) {
      slides.push({
        id: `chapter-${chapterIndex}`,
        kind: "chapter",
        title: chapter.title,
        date: chapter.date,
        endDate: chapter.endDate,
        dateApprox: chapter.dateApprox,
        place: chapter.place,
        description: chapter.description
      });
    }

    chapter.blocks.forEach((block, blockIndex) => {
      const id = `c${chapterIndex}-b${blockIndex}`;
      if (block.kind === "text" && block.body.trim()) {
        slides.push({ id, kind: "text", body: block.body });
      } else if (block.kind === "media") {
        slides.push(shareMediaSlide(id, block.asset, block.caption));
      } else if (block.kind === "album" || block.kind === "slideshow") {
        block.items.forEach((asset, index) => {
          slides.push(shareMediaSlide(`${id}-${index}`, asset, null));
        });
      } else if (block.kind === "map") {
        slides.push({
          id, kind: "map", lat: block.lat, lng: block.lng,
          zoom: block.zoom ?? 12, label: block.label ?? block.caption
        });
      } else if (block.kind === "person") {
        slides.push({
          id, kind: "person", name: block.name,
          years: [block.birthDate, block.deathDate].filter(Boolean).join(" – "),
          caption: block.caption
        });
      } else if (block.kind === "quote") {
        slides.push({ id, kind: "quote", text: block.text, attribution: block.attribution });
      } else if (block.kind === "audio") {
        slides.push({
          id, kind: "audio", title: block.title ?? "",
          src: block.url, durationSeconds: block.durationSeconds
        });
      }
    });
  });

  return slides;
}

function shareMediaSlide(id: string, asset: StoryShareAsset, caption: string | null): PlayerSlide {
  const isVideo = asset.kind === "video";
  return {
    id,
    kind: "media",
    title: asset.title,
    src: isVideo ? asset.fileUrl : asset.previewUrl,
    poster: asset.previewUrl,
    isVideo,
    caption,
    durationSeconds: asset.durationSeconds
  };
}
