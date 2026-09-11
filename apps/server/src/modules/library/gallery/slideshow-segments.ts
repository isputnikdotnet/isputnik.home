// What goes into a slideshow movie, in order: the canvas it is rendered at, each
// slide's on-screen time, and the opening and closing cards (drawn here, before
// ffmpeg runs). Shared by the render and the editor's previews.
import fs from "node:fs";
import path from "node:path";
import { validateLibrarySource } from "../shared/library-source.js";
import { titleCardLines, closingCardLines, type SlideshowRow, type SlideshowRenderItem } from "./slideshows.js";
import { renderTitleCardPng, titleCardPngBuffer, type TitleBackground, type TitlePhoto } from "./slideshow-title-card.js";

export const WIDTH = 1920;
export const HEIGHT = 1080;
export const FPS = 30;
// Default xfade duration between slides; each slideshow can tune its own via
// `transition_seconds` (route-validated 0.5–5; clamped again here for safety).
export const DEFAULT_TRANSITION_SEC = 2;
export const clampTransitionSec = (value: number | undefined): number =>
  Math.min(5, Math.max(0.5, Number.isFinite(value) ? (value as number) : DEFAULT_TRANSITION_SEC));
const VIDEO_CAP = 20; // cap a single clip so one long video can't dominate the movie
// Bound render time / filtergraph size — a movie of every item in a 900-item
// slideshow would take an age. The Memories montage already caps at 40.
const MAX_ITEMS = 120;

// `dwell` is the slide's ON-SCREEN time — the user's "seconds per photo" — NOT the
// ffmpeg input length. buildFfmpegArgs pads each input by the transition duration,
// because xfade overlaps neighbours: without that padding a 4s slide behind a 2s
// transition would only hold the screen for 2s (and never sit still at all).
export interface Segment { file: string; dwell: number; isVideo: boolean }

// Minimum on-screen time for a slide, whatever the per-slide override says.
const MIN_DISPLAY_SEC = 1;

export function segmentsFor(items: SlideshowRenderItem[], slideSeconds: number, _transitionSec = DEFAULT_TRANSITION_SEC): Segment[] {
  return items.slice(0, MAX_ITEMS).map((item) => {
    const isVideo = item.kind === "video";
    let dwell: number;
    if (isVideo) {
      // A clip plays for its own length (capped) so it isn't cut mid-action; if the
      // scanner never probed a duration, fall back to the slide default.
      const len = item.duration_seconds ?? slideSeconds;
      dwell = Math.min(Math.max(Number.isFinite(len) && len > 0 ? len : slideSeconds, MIN_DISPLAY_SEC), VIDEO_CAP);
    } else {
      const raw = item.dwell_seconds ?? slideSeconds;
      dwell = Math.min(Math.max(Number.isFinite(raw) ? raw : slideSeconds, MIN_DISPLAY_SEC), 30);
    }
    return { file: path.join(item.source_path, ...item.relative_path.split("/")), dwell, isVideo };
  });
}

// ── Opening title card ───────────────────────────────────────────────────────
// Unless it is turned off, a render opens on a card carrying the slideshow's name,
// cross-fading into the first photo with the slideshow's own transition. Its words,
// its length and what it sits on are per-slideshow settings (the title_* columns);
// the defaults are the card every 3.1.x movie opened with — the name over black for
// three seconds, subtitled with the photo count.
//
// The card arrives as a finished PNG (slideshow-title-card.ts) and enters the graph
// as an ordinary still — the same input shape as a photo. It used to be built inside
// ffmpeg with drawtext, which is an optional filter the Linux build doesn't have, so
// the card cost every Linux user their whole movie. A picture costs nobody anything.

// The default length of the title card, and the fallback when a slideshow's own
// title_seconds is missing or nonsense. The card is an ordinary still segment (see
// titleCardSegment), so it is padded and cross-faded exactly like a photo — no
// special case anywhere in the graph.
export const TITLE_CARD_SECONDS = 3;
const clampTitleSec = (value: number | undefined): number =>
  Math.min(15, Math.max(1, Number.isFinite(value) ? (value as number) : TITLE_CARD_SECONDS));

export function titleCardSegment(imageFile: string, seconds: number = TITLE_CARD_SECONDS): Segment {
  return { file: imageFile, dwell: clampTitleSec(seconds), isVideo: false };
}

// Absolute path of one render item's file, or null when its library root is unusable
// or the path escapes it. Path-safety lives here so every caller gets it.
export function renderItemAbsolutePath(item: Pick<SlideshowRenderItem, "source_path" | "relative_path">): string | null {
  let root: string;
  try { root = validateLibrarySource(item.source_path); } catch { return null; }
  const abs = path.join(root, ...item.relative_path.split("/"));
  return abs.startsWith(root) ? abs : null;
}

/** The items whose files are actually on disk, in order. */
export function presentRenderItems(items: SlideshowRenderItem[]): SlideshowRenderItem[] {
  return items.filter((item) => {
    const abs = renderItemAbsolutePath(item);
    return abs !== null && fs.existsSync(abs);
  });
}

// What a card's background is built from. Only PHOTOS qualify: sharp reads stills,
// and a video frame would have to be decoded first. A slideshow of nothing but videos
// therefore falls back to the black card rather than failing. Shared by the opening
// and closing cards — each brings its own background setting and chosen photo.
export function cardBackgroundFor(
  background: SlideshowRow["title_background"],
  photoItemId: string | null,
  items: SlideshowRenderItem[]
): TitleBackground {
  if (background === "black") return { kind: "black" };
  const photos = items
    .filter((item) => item.kind === "photo")
    .map((item) => ({ id: item.id, file: renderItemAbsolutePath(item), rotation: item.rotation ?? 0 }))
    .filter((photo): photo is { id: string; file: string; rotation: number } => photo.file !== null);
  if (photos.length === 0) return { kind: "black" };

  if (background === "collage") {
    return { kind: "collage", photos: photos.map(({ file, rotation }): TitlePhoto => ({ file, rotation })) };
  }
  // A chosen photo that has since left the slideshow (or whose file is gone) falls
  // back to the first slide rather than to black — the setting still means "a photo".
  const chosen = photos.find((photo) => photo.id === photoItemId) ?? photos[0];
  return { kind: background, photo: { file: chosen.file, rotation: chosen.rotation } };
}

export function titleBackgroundFor(slideshow: SlideshowRow, items: SlideshowRenderItem[]): TitleBackground {
  return cardBackgroundFor(slideshow.title_background, slideshow.title_photo_item_id, items);
}

export function closingBackgroundFor(slideshow: SlideshowRow, items: SlideshowRenderItem[]): TitleBackground {
  return cardBackgroundFor(slideshow.closing_background, slideshow.closing_photo_item_id, items);
}

// Draw one slideshow's title card to `outPath`. Shared by the render and the editor's
// preview so what you choose is exactly what the movie opens with. Returns false when
// the card can't be drawn at all (see renderTitleCardPng).
export async function renderSlideshowTitleCard(
  slideshow: SlideshowRow,
  items: SlideshowRenderItem[],
  outPath: string
): Promise<boolean> {
  const { title, subtitle } = titleCardLines(slideshow, items.length);
  return renderTitleCardPng(title, subtitle, outPath, titleBackgroundFor(slideshow, items), {
    font: slideshow.card_font,
    size: slideshow.card_size
  });
}

// The closing card, drawn by the same drawer with the same shared lettering — only
// its words (closingCardLines) and background come from the closing_* settings.
export async function renderSlideshowClosingCard(
  slideshow: SlideshowRow,
  items: SlideshowRenderItem[],
  outPath: string
): Promise<boolean> {
  const { title, subtitle } = closingCardLines(slideshow);
  return renderTitleCardPng(title, subtitle, outPath, closingBackgroundFor(slideshow, items), {
    font: slideshow.card_font,
    size: slideshow.card_size
  });
}

// The same cards as PNGs in memory, scaled down for the editor's preview. Null when
// one can't be drawn — the editor then shows nothing rather than a broken image.
export async function slideshowTitleCardPreview(
  slideshow: SlideshowRow,
  items: SlideshowRenderItem[],
  width: number
): Promise<Buffer | null> {
  // The same slides the movie would carry — a long slideshow is capped, and a preview
  // that counted the ones left out would promise a card the movie never draws.
  const inMovie = items.slice(0, MAX_ITEMS);
  const { title, subtitle } = titleCardLines(slideshow, inMovie.length);
  return titleCardPngBuffer(title, subtitle, titleBackgroundFor(slideshow, inMovie), width, {
    font: slideshow.card_font,
    size: slideshow.card_size
  });
}

export async function slideshowClosingCardPreview(
  slideshow: SlideshowRow,
  items: SlideshowRenderItem[],
  width: number
): Promise<Buffer | null> {
  const inMovie = items.slice(0, MAX_ITEMS);
  const { title, subtitle } = closingCardLines(slideshow);
  return titleCardPngBuffer(title, subtitle, closingBackgroundFor(slideshow, inMovie), width, {
    font: slideshow.card_font,
    size: slideshow.card_size
  });
}
