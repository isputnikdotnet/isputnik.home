// MP4 render pipeline for slideshows (docs/gallery-slideshows-proposal.md, Phase 4).
// Rides the generic `jobs` table + a 2s poller (like the scan/face workers): a render
// is enqueued, the worker claims it, runs ONE ffmpeg command (normalize each photo →
// transition → mux the music bed), writes the MP4 into the thumbnail store's
// "slideshows" bucket, and moves the slideshow through queued → rendering → ready |
// failed. Live progress (elapsed/total seconds) is written into the job payload so the
// Tasks page and the editor can show a percentage + ETA.
//
// Decisions, learned by measuring on real photos:
// - H.264 (yuv420p) + AAC in MP4 — the format the gallery already assumes plays.
// - Videos ARE included: each contributes its own clip (capped, normalized to the same
//   canvas/framerate) with its audio dropped — the movie's soundtrack is the music bed
//   (or silence). Mixing per-clip audio into the transition timeline is a future step.
// - Ken Burns is NOT rendered: ffmpeg's zoompan re-renders every frame and took ~25×
//   real-time on a modest box (impractical on an Unraid host), so a 'kenburns'
//   slideshow exports with a crossfade. The animated zoom stays a live-preview effect.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { db } from "../../../db.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { jobProgressWriter } from "../shared/job-progress.js";
import { requeueInterruptedJobs } from "../shared/job-recovery.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import {
  getSlideshow,
  getSlideshowRenderItems,
  getClipRenderItem,
  setSlideshowRenderState,
  setSlideshowMovieAsset,
  titleCardLines,
  closingCardLines,
  type SlideshowRow,
  type SlideshowRenderItem
} from "./slideshows.js";
import { getMusicTrack, musicFileAbsolutePath } from "./music.js";
import { renderTitleCardPng, titleCardPngBuffer, type TitleBackground, type TitlePhoto } from "./slideshow-title-card.js";
import { resolveGalleryScopeLibraryIds } from "./catalog.js";
import { getRenderLibraryId } from "./slideshow-settings.js";
import { scanSingleGalleryFile } from "./scanner.js";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";
const FFPROBE_BIN: string = ffprobeStatic?.path || "ffprobe";

// ── Leaving the machine usable ───────────────────────────────────────────────
//
// This runs on someone's NAS, beside everything else that box does. Left alone,
// ffmpeg takes every core and as many frame buffers as the filtergraph implies,
// which on an Unraid host reads as "the server fell over" — because everything
// else on it did.
//
// Half the cores, capped: the render is background work nobody is watching, and
// giving it the whole machine buys minutes at the cost of every other service.
// Filter threads are held lower still — each one holds decoded 1080p frames in
// flight, and a slideshow's graph has one chain per photo.
const cores = Math.max(1, os.cpus().length);
const ENCODER_THREADS = Math.max(1, Math.min(4, Math.floor(cores / 2)));
const FILTER_THREADS = Math.max(1, Math.min(2, Math.floor(cores / 2)));

// Nice the child to the bottom of the run queue (best-effort: unsupported on some
// platforms, and lowering our own priority never needs privileges where it is).
// The render still gets every idle cycle; it just stops competing with the web
// server, the scanners, and whatever else the box is for.
function deprioritise(pid: number | undefined): void {
  if (pid === undefined) return;
  try { os.setPriority(pid, 19); } catch { /* not supported here — the thread caps still apply */ }
}

export const RENDER_JOB_TYPE = "gallery-slideshow-render";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
// Default xfade duration between slides; each slideshow can tune its own via
// `transition_seconds` (route-validated 0.5–5; clamped again here for safety).
const DEFAULT_TRANSITION_SEC = 2;
const clampTransitionSec = (value: number | undefined): number =>
  Math.min(5, Math.max(0.5, Number.isFinite(value) ? (value as number) : DEFAULT_TRANSITION_SEC));
const VIDEO_CAP = 20; // cap a single clip so one long video can't dominate the movie
// Bound render time / filtergraph size — a movie of every item in a 900-item
// slideshow would take an age. The Memories montage already caps at 40.
const MAX_ITEMS = 120;

interface RenderPayload {
  slideshowId: string;
  userId: string;
}

// ── Build the ffmpeg invocation ──────────────────────────────────────────────

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

// Total video length: with transitions, adjacent nodes overlap by transitionSec.
// `dwells` covers every node in the chain, title card included.
function totalDuration(dwells: number[], useXfade: boolean, transitionSec: number): number {
  const sum = dwells.reduce((n, d) => n + d, 0);
  return useXfade && dwells.length > 1 ? sum - (dwells.length - 1) * transitionSec : sum;
}

// The xfade styles a "random" slideshow draws from at each cut — a tasteful subset of
// ffmpeg's catalogue (every entry verified against the bundled ffmpeg-static build).
export const RANDOM_XFADES = ["fade", "dissolve", "slideleft", "slideright", "wipeleft", "wiperight", "circleopen", "smoothup"] as const;

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

// ── A clip's own sound ───────────────────────────────────────────────────────
//
// An intro/outro clip is often chosen FOR its sound — a recorded greeting, a
// toast — so a sounded clip contributes its audio to the movie, and the music
// PAUSES underneath it: silent while the clip plays, resuming from where it left
// off (not from where the timeline got to). Everything is arithmetic over the
// same dwell list the video graph uses: a node's on-screen start is the sum of
// the dwells before it, with or without transitions (the xfade overlap cancels).

/** One clip's audio: the source file and its absolute window on the movie's timeline. */
export interface ClipSound { file: string; start: number; duration: number }

/**
 * Where the music actually plays: the gaps between sounded-clip windows, each
 * carrying the music offset it resumes from (`from`) — a paused song continues,
 * it doesn't jump. Pure, exported for the tests. Windows shorter than 0.3s are
 * dropped: a blink of music between clips is noise, not a resume.
 */
export function musicWindows(
  clips: ClipSound[],
  total: number
): { at: number; len: number; from: number }[] {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const windows: { at: number; len: number; from: number }[] = [];
  let cursor = 0;
  let consumed = 0;
  for (const clip of sorted) {
    const len = clip.start - cursor;
    if (len >= 0.3) {
      windows.push({ at: cursor, len, from: consumed });
      consumed += len;
    }
    cursor = Math.max(cursor, clip.start + clip.duration);
  }
  const tail = total - cursor;
  if (tail >= 0.3) windows.push({ at: cursor, len: tail, from: consumed });
  return windows;
}

export interface BuildOptions {
  // The inputs are BATCH VIDEOS whose lengths already contain the transition
  // overlap (each was rendered with its own padding), so padding them again would
  // ask for footage that isn't there. See renderInBatches.
  prePadded?: boolean;
  // Batch intermediates are encoded finer than the finished movie, because they get
  // encoded a second time when the batches are joined.
  crf?: number;
  // The closing card's on-screen seconds, when the movie ends on one. The music
  // then fades out UNDER the credits — starting where the card starts — instead
  // of the fixed two-second tail. Only meaningful on a call that muxes music (the
  // single pass, or the batch JOIN; batch intermediates are video-only).
  closingDwell?: number;
  // Sounded intro/outro clips (see ClipSound). Like closingDwell, only meaningful
  // where audio is muxed: the clip files are added as extra AUDIO inputs there —
  // which is what makes this work in the batched path, where the clips' video is
  // already baked into intermediates but their sound comes from the originals.
  // Every entry must have an audio stream (probeHasAudio) — a missing [n:a]
  // fails the whole graph.
  clipSounds?: ClipSound[];
}

export function buildFfmpegArgs(
  segs: Segment[],
  transition: SlideshowRow["transition"],
  musicPath: string | null,
  outPath: string,
  transitionSec = DEFAULT_TRANSITION_SEC,
  // Injectable for tests; the default picks uniformly per slide boundary.
  pickTransition: (boundaryIndex: number) => string = () => RANDOM_XFADES[Math.floor(Math.random() * RANDOM_XFADES.length)],
  options: BuildOptions = {}
): { args: string[]; total: number } {
  const TRANSITION_SEC = clampTransitionSec(transitionSec);
  // Ken Burns is too expensive to render; fall back to a crossfade (see file header).
  const useXfade = transition !== "none";
  const xfadeName = transition === "slide" ? "slideleft" : transition === "dipblack" ? "fadeblack" : "fade";
  // xfade OVERLAPS neighbours by TRANSITION_SEC, so an input that runs exactly its
  // on-screen time would leave the screen that much sooner — a 4s slide with a 2s
  // transition would advance every 2s and never sit still. Padding every input by the
  // transition makes the photo-to-photo cadence equal the user's "seconds per photo",
  // matching the live player (where the transition animates over a full-length slide).
  // With 'none' the inputs are concatenated back to back, a lone node never transitions
  // at all, and a batch video already carries its own tail — none of those need padding.
  const pad = useXfade && segs.length > 1 && !options.prePadded ? TRANSITION_SEC : 0;
  const inputDur = (seg: Segment) => seg.dwell + pad;

  // Errors only, banner suppressed: whatever ffmpeg writes here is captured and
  // reported verbatim when a render fails, and the per-input stream dumps it
  // prints by default would bury the one line that says what went wrong.
  const args: string[] = ["-hide_banner", "-v", "error", "-filter_complex_threads", String(FILTER_THREADS)];
  for (const seg of segs) {
    // ONE DECODER THREAD PER INPUT. ffmpeg gives each input a decoder threaded across
    // every core by default, and each of those threads holds frames — with an input
    // per slide that is where a render's memory actually goes. Measured on a six-way
    // join: 1621 MB as-is, 541 MB with this, for 16% more time. It is the single
    // biggest lever in this file.
    args.push("-threads", "1");
    // A photo is a still looped for its input length; a video is read for that many
    // seconds of its own footage (its audio is ignored — only [i:v] is referenced below).
    if (seg.isVideo) args.push("-t", inputDur(seg).toFixed(3), "-i", seg.file);
    else args.push("-loop", "1", "-t", inputDur(seg).toFixed(3), "-i", seg.file);
  }
  if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);
  // Sounded clips ride as EXTRA audio-only inputs after the music — their video
  // is one of the segment inputs (single pass) or baked into a batch video (join).
  const clipSounds = (options.clipSounds ?? []).filter((clip) => clip.duration > 0.2);
  for (const clip of clipSounds) args.push("-i", clip.file);

  // Normalize every input to the same canvas (letterboxed), fixed fps + pixel format —
  // photos, video frames and the title card alike, so they transition cleanly.
  const per = segs.map((_, i) =>
    `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${WIDTH}:${HEIGHT}:-1:-1:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i}]`
  );

  // Every node's INPUT length in presentation order — each already padded for the
  // overlap, so the offsets below line up.
  const dwells = segs.map(inputDur);
  const nodes = dwells.length;

  let filter: string;
  let mapV: string;
  if (nodes === 1) {
    filter = per.join(";");
    mapV = "[v0]";
  } else if (!useXfade) {
    const concatIn = dwells.map((_, i) => `[v${i}]`).join("");
    filter = `${per.join(";")};${concatIn}concat=n=${nodes}:v=1:a=0[vout]`;
    mapV = "[vout]";
  } else {
    const chain: string[] = [];
    let last = "v0";
    let cumulative = dwells[0];
    for (let i = 1; i < nodes; i += 1) {
      const outLabel = i === nodes - 1 ? "vout" : `x${i}`;
      const offset = (cumulative - TRANSITION_SEC).toFixed(3);
      // "random" varies the style at every cut; fixed transitions use one style throughout.
      const name = transition === "random" ? pickTransition(i - 1) : xfadeName;
      chain.push(`[${last}][v${i}]xfade=transition=${name}:duration=${TRANSITION_SEC}:offset=${offset}[${outLabel}]`);
      last = outLabel;
      cumulative += dwells[i] - TRANSITION_SEC;
    }
    filter = `${per.join(";")};${chain.join(";")}`;
    mapV = "[vout]";
  }

  const total = totalDuration(dwells, useXfade, TRANSITION_SEC);

  // With a closing card the music fades out UNDER it: the slides end at full
  // volume, the credits play it down, the movie ends in silence. Capped at 8s —
  // a 15s card doesn't need 15s of fade to feel finished. Without one, the
  // 2-second tail every movie has always had, byte for byte.
  const closing = options.closingDwell;
  const fadeDur = closing && closing > 0 ? Math.min(closing, 8) : 2;
  const fadeStart = Math.max(0, total - (closing && closing > 0 ? closing : 2));

  const audioCodec = ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "44100"];
  if (clipSounds.length === 0) {
    // No clip sound: the original path, untouched — music mapped straight with
    // the tail fade, or no audio at all.
    args.push("-filter_complex", filter, "-map", mapV);
    if (musicPath) {
      args.push(
        "-map", `${segs.length}:a`,
        "-af", `afade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeDur}`,
        ...audioCodec,
        "-shortest"
      );
    }
  } else {
    // Clip sound: the soundtrack is assembled in the filtergraph. Each clip's
    // audio is trimmed to its on-screen window, eased in and out (0.3s/0.5s, so a
    // 20s cap never cuts mid-word with a click), and delayed to its absolute
    // position; the music fills the gaps BETWEEN clips, resuming from where it
    // paused. The pieces never overlap, so amix (normalize=0) just lays them on
    // one timeline, and the closing fade applies to the whole soundtrack.
    const chains: string[] = [];
    const mixIn: string[] = [];
    const firstClipInput = segs.length + (musicPath ? 1 : 0);
    clipSounds.forEach((clip, k) => {
      const outFade = Math.min(0.5, clip.duration / 2);
      const delay = Math.round(clip.start * 1000);
      chains.push(
        `[${firstClipInput + k}:a]atrim=0:${clip.duration.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0, clip.duration - outFade).toFixed(3)}:d=${outFade.toFixed(2)}` +
        (delay > 0 ? `,adelay=${delay}:all=1` : "") +
        `[clip${k}]`
      );
      mixIn.push(`[clip${k}]`);
    });
    if (musicPath) {
      musicWindows(clipSounds, total).forEach((window, j) => {
        const delay = Math.round(window.at * 1000);
        chains.push(
          `[${segs.length}:a]atrim=${window.from.toFixed(3)}:${(window.from + window.len).toFixed(3)},asetpts=PTS-STARTPTS` +
          // A resumed window eases back in; the movie-opening window starts clean.
          (window.at > 0 ? `,afade=t=in:st=0:d=0.3` : "") +
          (delay > 0 ? `,adelay=${delay}:all=1` : "") +
          `[music${j}]`
        );
        mixIn.push(`[music${j}]`);
      });
    }
    const soundtrack = mixIn.length === 1
      ? `${mixIn[0]}afade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeDur}[aout]`
      : `${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0,` +
        `afade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeDur}[aout]`;
    args.push("-filter_complex", `${filter};${chains.join(";")};${soundtrack}`, "-map", mapV);
    // No -shortest: every audio piece is trimmed to the timeline by construction,
    // and the video stream is what bounds the movie.
    args.push("-map", "[aout]", ...audioCodec);
  }
  args.push(
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(options.crf ?? 22), "-preset", "veryfast",
    "-threads", String(ENCODER_THREADS),
    "-r", String(FPS), "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", "-y", outPath
  );
  return { args, total };
}

// ── Feeding ffmpeg pictures the size of the movie ────────────────────────────
//
// Every photo in a slideshow becomes its own ffmpeg input, and every input holds
// decoded frames AT THE SOURCE'S RESOLUTION for as long as the render runs. The
// movie is 1920x1080 whatever goes in, so a 40-megapixel original is scaled down
// inside ffmpeg anyway — after paying for it. Measured over 63 photos: ~1.9 GB from
// 1080p sources, ~3.9 GB from 12 MP phone photos, ~17 GB from a modern camera's,
// which is a self-hosted server falling over rather than rendering a movie.
//
// So the scaling happens here first, with sharp, ONE PHOTO AT A TIME — bounded
// memory by construction — and ffmpeg is handed pictures already the size it wants.
// It also cuts the work: scaling the originals was most of the render's CPU, and
// libvips does it far faster than the filtergraph.
//
// Videos are left alone: a video decodes frame by frame, so its cost doesn't grow
// with the length of the slideshow the way a still's does.
const SCALED_QUALITY = 90;

async function scalePhotoForRender(source: string, destination: string, rotation: number): Promise<boolean> {
  try {
    // rotate() applies the EXIF orientation and a second rotate(angle) adds the
    // user's own, exactly as the gallery's thumbnails do (media.ts) — so the movie
    // shows photos the way the gallery does, upright, which ffmpeg never did.
    const image = sharp(source, { failOn: "none" }).rotate();
    await (rotation ? image.rotate(rotation) : image)
      .resize(WIDTH, HEIGHT, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: SCALED_QUALITY })
      .toFile(destination);
    return true;
  } catch {
    return false; // unreadable or an odd format: fall back to the original, as before
  }
}

// Replace each photo's path with a render-sized copy. A photo that can't be scaled
// keeps its original path — one heavy input is survivable, a failed render is not.
export async function prescaleSegments(
  segments: Segment[],
  rotations: number[],
  tempPathFor: (index: number) => string,
  onScaled?: (done: number, total: number) => void,
  isCancelled: () => boolean = () => false
): Promise<{ segments: Segment[]; written: string[] }> {
  const written: string[] = [];
  const out: Segment[] = [];
  const photos = segments.filter((segment) => !segment.isVideo).length;
  let done = 0;

  for (const [index, segment] of segments.entries()) {
    if (isCancelled()) break;
    if (segment.isVideo) { out.push(segment); continue; }
    const destination = tempPathFor(index);
    if (await scalePhotoForRender(segment.file, destination, rotations[index] ?? 0)) {
      written.push(destination);
      out.push({ ...segment, file: destination });
    } else {
      out.push(segment);
    }
    done += 1;
    onScaled?.(done, photos);
  }

  // Cancelled part-way: hand back what we have plus the untouched remainder, so the
  // caller still sees every segment (and its cleanup, every file written).
  for (let i = out.length; i < segments.length; i += 1) out.push(segments[i]);
  return { segments: out, written };
}

// ── Rendering a long slideshow in batches ────────────────────────────────────
//
// Even from render-sized photos, a single pass keeps EVERY slide's decoder and
// filter chain alive at once: ~1.9 GB for 63 slides, and it grows with the length
// of the slideshow. So a long one is rendered in batches — a dozen slides at a
// time, each to its own intermediate — and the batches are then joined. Peak memory
// becomes a property of the batch size, not of the slideshow.
//
// The timing works out to exactly the same movie, which is the only reason this is
// safe. A batch rendered with the usual padding runs sum(dwell) + T: it ends with a
// T-long tail of its last slide, which is precisely what the NEXT batch needs to
// cross-fade over. Joining the batches with the same overlap therefore gives
// sum(all dwells) + T — the single-pass total — and n-1 transitions all told
// ((slides - batches) inside them, plus (batches - 1) at the seams).
export const BATCH_SIZE = 12;

// Intermediates are encoded finer than the finished movie: they are about to be
// encoded a second time, and generation loss is the one cost batching could add.
const BATCH_CRF = 18;

export function chunkSegments(segs: Segment[], size = BATCH_SIZE): Segment[][] {
  if (size < 2) return [segs];
  const chunks: Segment[][] = [];
  for (let i = 0; i < segs.length; i += size) chunks.push(segs.slice(i, i + size));
  // A trailing chunk of one would be a batch with nothing to cross-fade — fold it
  // back into its predecessor rather than rendering a single-slide movie.
  if (chunks.length > 1 && chunks[chunks.length - 1].length === 1) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1].push(...last);
  }
  return chunks;
}

// A batch video's length as ffmpeg actually wrote it. The join's cross-fade offsets
// are absolute times, so a file a few frames shorter than predicted would ask xfade
// for footage past the end; measuring beats trusting the arithmetic.
export async function probeDurationSeconds(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(FFPROBE_BIN, [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file
      ], { windowsHide: true });
    } catch { resolve(null); return; }
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.stderr?.on("data", () => { /* drained */ });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const seconds = Number.parseFloat(text.trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    });
  });
}

// Whether a media file carries an audio stream at all. A sounded clip without one
// keeps the music running instead — and must never reach the filtergraph, where a
// reference to a missing [n:a] fails the whole render.
export async function probeHasAudio(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(FFPROBE_BIN, [
        "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type",
        "-of", "default=nw=1:nk=1", file
      ], { windowsHide: true });
    } catch { resolve(false); return; }
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.stderr?.on("data", () => { /* drained */ });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(text.includes("audio")));
  });
}

interface BatchRenderPlan {
  nodes: Segment[];
  transition: SlideshowRow["transition"];
  transitionSec: number;
  musicPath: string | null;
  /** See BuildOptions.closingDwell — applied at the JOIN, where the music is muxed. */
  closingDwell?: number;
  /** See BuildOptions.clipSounds — likewise applied at the JOIN. */
  clipSounds?: ClipSound[];
  outPath: string;
  tempPathFor: (index: number) => string;
  onProgress: (elapsedSec: number, totalSec: number) => void;
  isCancelled: () => boolean;
  onTempFile: (file: string) => void;
  encodeFailed: (detail: string) => Error;
}

// Render the slides a batch at a time, then join the batches. See the note above
// BATCH_SIZE for why the result is the same movie a single pass would produce.
async function renderInBatches(plan: BatchRenderPlan): Promise<void> {
  const batches = chunkSegments(plan.nodes);
  // Progress spans both passes: the batches encode every second of the movie once,
  // and the join encodes it again, so the work is roughly twice its length.
  const halfway = plan.nodes.reduce((sum, node) => sum + node.dwell, 0);
  let encoded = 0;
  const report = (done: number) => plan.onProgress(Math.min(encoded + done, halfway * 2), halfway * 2);

  const joinSegments: Segment[] = [];
  for (const [index, batch] of batches.entries()) {
    if (plan.isCancelled()) throw new Error("Render cancelled.");
    const file = plan.tempPathFor(index);
    plan.onTempFile(file);
    const { args, total } = buildFfmpegArgs(
      batch, plan.transition, null, file, plan.transitionSec, undefined, { crf: BATCH_CRF }
    );
    const { ok, detail } = await runRender(args, total, (done) => report(done), plan.isCancelled);
    if (!ok) {
      if (plan.isCancelled()) throw new Error("Render cancelled.");
      throw plan.encodeFailed(detail);
    }
    encoded += total;
    // Measured, not predicted: the join's offsets are absolute times into these files.
    joinSegments.push({ file, dwell: (await probeDurationSeconds(file)) ?? total, isVideo: true });
  }

  if (plan.isCancelled()) throw new Error("Render cancelled.");
  const { args, total } = buildFfmpegArgs(
    joinSegments, plan.transition, plan.musicPath, plan.outPath, plan.transitionSec,
    undefined, { prePadded: true, closingDwell: plan.closingDwell, clipSounds: plan.clipSounds }
  );
  const { ok, detail } = await runRender(args, total, (done) => report(done), plan.isCancelled);
  if (!ok) {
    fs.rmSync(plan.outPath, { force: true });
    if (plan.isCancelled()) throw new Error("Render cancelled.");
    throw plan.encodeFailed(detail);
  }
}

// ── What this ffmpeg build can actually do ───────────────────────────────────
//
// ffmpeg-static ships a DIFFERENT build per platform, and they don't have the same
// filters. The Windows build (gyan 6.1.1) has drawtext; the Linux one (John Van
// Sickle 7.0.2) does not, despite linking libfreetype — so the title card's
// drawtext made every render on a Linux host fail at "Filter not found" while
// working perfectly in development. A missing optional filter must cost a feature,
// never the movie.

const FILTER_LINE = /^\s*[TSC.]{3}\s+(\S+)\s+\S+->\S+/;

// Parse `ffmpeg -filters` output. Its lines look like:
//   " TS. drawtext          V->V       Draw text on top of video frames."
export function parseFilterList(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split(/\r?\n/)) {
    const match = FILTER_LINE.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

export interface RenderCapabilities {
  /** Use xfade transitions; without it slides are concatenated. */
  xfade: boolean;
}

// An EMPTY set means the probe itself failed (no binary, unreadable output). Then
// nothing is disabled: an unprobeable ffmpeg is assumed capable, exactly as before
// this check existed, and a real failure still reports ffmpeg's own words.
//
// The title card is no longer asked about — it is drawn before ffmpeg runs and
// arrives as a picture, so no filter can take it away.
export function capabilitiesFrom(filters: Set<string>): RenderCapabilities {
  if (filters.size === 0) return { xfade: true };
  return { xfade: filters.has("xfade") };
}

let filterProbe: Promise<Set<string>> | null = null;

// Ask the binary once per process — the answer can't change while it runs.
export function ffmpegFilters(): Promise<Set<string>> {
  if (!filterProbe) {
    filterProbe = new Promise<Set<string>>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawn(FFMPEG_BIN, ["-hide_banner", "-filters"], { windowsHide: true }); }
      catch { resolve(new Set()); return; }
      let text = "";
      child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      child.stderr?.on("data", () => { /* drained; the listing goes to stdout */ });
      child.on("error", () => resolve(new Set()));
      child.on("close", () => resolve(parseFilterList(text)));
    });
  }
  return filterProbe;
}

// How much of ffmpeg's error output to keep. The tail, not the head: the line that
// explains a failure is the last thing written.
const STDERR_TAIL_CHARS = 12_000;

// Turn a dead ffmpeg into one sentence a person can act on. Exported for tests —
// this string is what the editor shows and what lands in the job's error.
export function describeFfmpegFailure(stderr: string, code: number | null, signal: string | null): string {
  // 137 is the exit code Docker reports for a SIGKILL, which on Unraid (or any
  // container with a memory ceiling) almost always means the OOM killer: a long
  // slideshow holds every input open at once. Naming it saves an hour of hunting
  // through ffmpeg output that was never written.
  if (signal === "SIGKILL" || code === 137) {
    return "ffmpeg was killed part-way through — usually the container hitting its memory limit. Try a shorter slideshow, or give the container more memory.";
  }
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (!last) {
    return `ffmpeg exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`} without saying why.`;
  }
  return last.length > 240 ? `${last.slice(0, 240)}…` : last;
}

export interface RenderOutcome {
  ok: boolean;
  /** Why it failed, in ffmpeg's own words. Empty on success and on cancellation. */
  detail: string;
}

// Run ffmpeg, parsing -progress output for elapsed seconds so the caller can report a
// live percentage. `isCancelled` is polled once a second; when it flips true (the job
// was cancelled from the Tasks page) the ffmpeg child is killed so a cancelled render
// doesn't burn CPU for minutes.
//
// stderr is always drained, and its tail kept. Both halves matter: a pipe nobody
// reads fills at around 64 KB and the child then blocks forever — a render that
// hangs rather than fails — and without the text there is nothing to report but
// "it didn't work", which is what this used to say while pointing at server logs
// that never had a word of ffmpeg in them.
function runRender(
  args: string[],
  totalSeconds: number,
  onProgress: (elapsedSec: number, totalSec: number) => void,
  isCancelled: () => boolean = () => false
): Promise<RenderOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(FFMPEG_BIN, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, detail: `ffmpeg could not be started (${err instanceof Error ? err.message : "unknown error"}).` });
      return;
    }
    deprioritise(child.pid);
    const totalRounded = Math.max(1, Math.round(totalSeconds));
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      resolve({ ok, detail });
    };
    const poll = setInterval(() => {
      if (isCancelled()) { try { child.kill(); } catch { /* already gone */ } finish(false, ""); }
    }, 1000);

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) onProgress(Math.min(totalRounded, Math.round(Number(match[1]) / 1_000_000)), totalRounded);
      }
    });

    let errText = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      errText += chunk.toString();
      if (errText.length > STDERR_TAIL_CHARS) errText = errText.slice(-STDERR_TAIL_CHARS);
    });

    // A spawn failure (a missing or unrunnable binary) surfaces here, not as an
    // exit code — and it is the one failure whose cause is entirely in this message.
    child.on("error", (err) => finish(false, `ffmpeg could not be started (${err.message}).`));
    child.on("close", (code, signal) => {
      if (code === 0) { finish(true, ""); return; }
      if (isCancelled()) { finish(false, ""); return; }
      // The full tail goes to the server log; the caller gets the one-line version.
      console.error(
        `slideshow render: ffmpeg exited ${signal ? `on ${signal}` : `with code ${code}`}\n`
        + `command: ${FFMPEG_BIN} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}\n`
        + (errText.trim() || "(ffmpeg wrote nothing to stderr)")
      );
      finish(false, describeFfmpegFailure(errText, code, signal));
    });
  });
}

// Render one slideshow to an MP4 in the store. Returns the storage key + byte size,
// or throws with a user-facing message. `libIds` is the CREATOR's accessible set (the
// render belongs to whoever asked for it).
export async function renderSlideshow(
  slideshow: SlideshowRow,
  libIds: string[],
  onProgress: (elapsedSec: number, totalSec: number) => void,
  isCancelled: () => boolean = () => false
): Promise<{ storageKey: string; bytes: number }> {
  const items = getSlideshowRenderItems(libIds, slideshow);
  if (items.length === 0) throw new Error("This slideshow has no photos or videos to render.");

  // Every source file must exist and stay inside its library root (path-safety).
  const present = presentRenderItems(items);
  if (present.length === 0) throw new Error("None of this slideshow's photo files are available on disk.");

  const segs = segmentsFor(present, slideshow.slide_seconds, slideshow.transition_seconds);
  const musicPath = musicPathFor(slideshow.music_track_id);

  const storageKey = thumbnailStorageKey("slideshows", slideshow.id, `${slideshow.id}.mp4`);
  const finalPath = thumbnailAbsolutePath(storageKey);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  // Sweep leftovers from renders interrupted by a server restart: the re-queued job
  // renders under a fresh temp name, so anything matching the prefix is stale.
  try {
    const dir = path.dirname(finalPath);
    for (const entry of fs.readdirSync(dir)) {
      if (["tmp-", "title-", "slide-", "batch-"].some((kind) => entry.startsWith(`${path.basename(finalPath)}.${kind}`))) {
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    }
  } catch { /* best-effort */ }
  const tmpPath = `${finalPath}.tmp-${nanoid(6)}.mp4`;

  // What this ffmpeg can do. It can only ever take something away from the movie,
  // never stop one being made.
  const capabilities = capabilitiesFrom(await ffmpegFilters());
  if (!capabilities.xfade) {
    console.warn("slideshow render: this ffmpeg build has no xfade filter — rendering with hard cuts between slides.");
  }

  // Opening title card, as the slideshow's own title_* settings describe it, drawn to
  // a PNG here (no ffmpeg filter involved) and fed in as the first still. A card that
  // can't be drawn costs the card, not the movie. The count it can carry counts the
  // slides that will actually be in the movie, not the whole slideshow.
  const titleFiles: string[] = [];
  let titleCard: Segment | null = null;
  if (slideshow.title_enabled) {
    const cardFile = `${finalPath}.title-${nanoid(6)}.png`;
    if (await renderSlideshowTitleCard(slideshow, present.slice(0, segs.length), cardFile)) {
      titleFiles.push(cardFile);
      titleCard = titleCardSegment(cardFile, slideshow.title_seconds);
    }
  }

  // Closing card: the same machinery, appended as the LAST node. Its dwell also
  // anchors the music's fade-out (see BuildOptions.closingDwell). Like the opening
  // card, one that can't be drawn costs the card, never the movie.
  let closingCard: Segment | null = null;
  if (slideshow.closing_enabled) {
    const cardFile = `${finalPath}.title-${nanoid(6)}.png`;
    if (await renderSlideshowClosingCard(slideshow, present.slice(0, segs.length), cardFile)) {
      titleFiles.push(cardFile);
      closingCard = titleCardSegment(cardFile, slideshow.closing_seconds);
    }
  }

  // Scale the photos to the movie's own size before ffmpeg opens any of them: a
  // render's memory is otherwise the SOURCE resolution times the number of slides,
  // which is how 63 camera photos reached 17 GB. One photo at a time, so this pass
  // costs one image's worth of memory however long the slideshow is.
  const scaleRun = nanoid(6);
  const { segments: renderSegs, written } = await prescaleSegments(
    segs,
    present.map((item) => item.rotation ?? 0),
    (index) => `${finalPath}.slide-${scaleRun}-${index}.jpg`,
    undefined,
    isCancelled
  );
  titleFiles.push(...written);
  if (isCancelled()) {
    for (const file of titleFiles) fs.rmSync(file, { force: true });
    throw new Error("Render cancelled.");
  }

  // Opening/closing clips: a gallery video each, resolved against the SAME access
  // set as the slides. One that is gone, inaccessible, or not on disk is skipped
  // with a warning — a missing clip costs the clip, never the movie. Each becomes
  // an ordinary video segment (segmentsFor: own length, capped at 20s, audio
  // dropped like every clip — the soundtrack stays the music bed).
  const clipSegmentFor = (itemId: string | null, label: string): Segment | null => {
    if (!itemId) return null;
    const clip = getClipRenderItem(libIds, itemId);
    const usable = clip ? presentRenderItems([clip]) : [];
    if (usable.length === 0) {
      console.warn(`slideshow render: the ${label} clip is missing or not accessible — rendering without it.`);
      return null;
    }
    return segmentsFor(usable, slideshow.slide_seconds)[0];
  };
  const introClip = clipSegmentFor(slideshow.intro_item_id, "opening");
  const outroClip = clipSegmentFor(slideshow.outro_item_id, "closing");

  const transition = capabilities.xfade ? slideshow.transition : "none";
  // The clips and cards are nodes like any other:
  // intro clip → title card → slides → outro clip → closing card.
  const nodes = [
    ...(introClip ? [introClip] : []),
    ...(titleCard ? [titleCard] : []),
    ...renderSegs,
    ...(outroClip ? [outroClip] : []),
    ...(closingCard ? [closingCard] : [])
  ];
  // The music fade anchors to the closing CARD — the outro clip before it carries
  // its own sound (or full music, if its sound is off).
  const closingDwell = closingCard?.dwell;

  // Sounded clips, as absolute windows on the movie's timeline: a node's on-screen
  // start is the sum of the dwells before it (the xfade overlap cancels — see
  // musicWindows). Only clips whose file actually HAS an audio stream join in; a
  // silent file keeps the music running instead.
  const clipSounds: ClipSound[] = [];
  const startOfNode = (node: Segment): number => {
    let sum = 0;
    for (const n of nodes) {
      if (n === node) return sum;
      sum += n.dwell;
    }
    return sum;
  };
  for (const [clip, wanted] of [
    [introClip, slideshow.intro_sound === 1],
    [outroClip, slideshow.outro_sound === 1]
  ] as const) {
    if (clip && wanted && await probeHasAudio(clip.file)) {
      clipSounds.push({ file: clip.file, start: startOfNode(clip), duration: clip.dwell });
    }
  }

  const encodeFailed = (detail: string): Error => new Error(
    // ffmpeg's own words, so the failure is readable without shell access to the
    // server. The full output is in the log either way.
    detail
      ? `The movie couldn't be encoded. ffmpeg said: ${detail}`
      : "The movie couldn't be encoded. Check the server logs for ffmpeg output."
  );

  try {
    if (nodes.length > BATCH_SIZE) {
      await renderInBatches({
        nodes, transition, transitionSec: slideshow.transition_seconds, musicPath, closingDwell, clipSounds,
        outPath: tmpPath, tempPathFor: (index) => `${finalPath}.batch-${scaleRun}-${index}.mp4`,
        onProgress, isCancelled, onTempFile: (file) => titleFiles.push(file), encodeFailed
      });
    } else {
      const { args, total } = buildFfmpegArgs(
        nodes, transition, musicPath, tmpPath, slideshow.transition_seconds,
        undefined, { closingDwell, clipSounds }
      );
      const { ok, detail } = await runRender(args, total, onProgress, isCancelled);
      if (!ok) {
        fs.rmSync(tmpPath, { force: true });
        if (isCancelled()) throw new Error("Render cancelled.");
        throw encodeFailed(detail);
      }
    }
    // Swap the finished temp file into place. If the rename fails — on Windows it throws
    // EPERM when the destination movie is still open (e.g. a <video> is streaming the
    // previous render) — clean up the temp so it can't pile up on the thumbnail drive.
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
    return { storageKey, bytes: fs.statSync(finalPath).size };
  } finally {
    for (const file of titleFiles) fs.rmSync(file, { force: true });
  }
}

function musicPathFor(musicTrackId: string | null): string | null {
  if (!musicTrackId) return null;
  const track = getMusicTrack(musicTrackId);
  if (!track) return null;
  try {
    const abs = musicFileAbsolutePath(track);
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

// ── Auto-save the rendered movie into a gallery library ──────────────────────
// When an admin has set a default "movie library" (slideshow-settings.ts), a finished
// render is ALSO filed into that library as a video item, so the movie becomes a durable,
// browsable gallery asset — not just the copy in the thumbnail store the editor streams.

// Rendered movies live under this fixed subfolder of the target library (they carry no
// capture date, so a dated folder like uploads use would just scatter them).
const MOVIE_SUBFOLDER = "Slideshow movies";

// The library-relative path a render is saved to. It FOLLOWS the slideshow's CURRENT
// name: an unchanged name lands on the stored path and overwrites in place (same
// catalog item, no duplicate); after a rename the movie saves under the new name and
// saveMovieToLibrary retires the old file/item. The slideshow's own stored file never
// counts as a collision — reaching it just means overwrite. Pure + injectable so the
// logic is testable without touching the disk or the encoder.
export function movieRelativePathFor(
  slideshow: Pick<SlideshowRow, "name" | "movie_library_id" | "movie_relative_path">,
  libraryId: string,
  exists: (relativePath: string) => boolean
): string {
  const own = slideshow.movie_library_id === libraryId ? slideshow.movie_relative_path : null;
  // A safe stem: strip separators/control chars and a leading dot (the scanner skips
  // dot-entries), then disambiguate with " (2)", " (3)", … Mirrors uniqueGalleryFileName.
  const stem = Array.from(slideshow.name)
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .replace(/[\s.]+$/g, "") || "slideshow";
  let relativePath = `${MOVIE_SUBFOLDER}/${stem}.mp4`;
  let counter = 2;
  while (relativePath !== own && exists(relativePath)) {
    relativePath = `${MOVIE_SUBFOLDER}/${stem} (${counter}).mp4`;
    counter += 1;
  }
  return relativePath;
}

// Copy a finished render (the thumbnail-store MP4 at `storageKey`) into the default movie
// library and catalog it as a video item. Best-effort by contract: the caller treats any
// throw as "not saved" and leaves the render 'ready' regardless. Re-renders reuse the
// slideshow's stored path so the same file is overwritten and the SAME catalog item is
// updated (ingestGalleryAsset keys on library_id + relative_path) — no duplicate items.
export async function saveMovieToLibrary(
  slideshow: SlideshowRow,
  storageKey: string
): Promise<{ saved: boolean; itemId: string | null }> {
  const libId = getRenderLibraryId();
  if (!libId) return { saved: false, itemId: null };

  const library = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libId) as { id: string; source_path: string } | undefined;
  if (!library) return { saved: false, itemId: null };

  const root = validateLibrarySource(library.source_path); // throws on an unusable mount

  const relativePath = movieRelativePathFor(slideshow, libId, (rel) => fs.existsSync(path.join(root, ...rel.split("/"))));
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(thumbnailAbsolutePath(storageKey), target);

  const itemId = await scanSingleGalleryFile(libId, normaliseRelativePath(relativePath));
  if (!itemId) return { saved: false, itemId: null };

  // A previous save under another name (slideshow renamed) or in another library is now
  // stale: best-effort remove the old file and soft-delete its catalog item right away
  // (same tombstone the scanner uses), so the Timeline doesn't show a broken tile until
  // the nightly scan reconciles it.
  const staleLibraryId = slideshow.movie_library_id;
  const stalePath = slideshow.movie_relative_path;
  if (staleLibraryId && stalePath && (staleLibraryId !== libId || stalePath !== relativePath)) {
    try {
      const old = db.prepare("SELECT source_path FROM libraries WHERE id = ? AND type = 'gallery'")
        .get(staleLibraryId) as { source_path: string } | undefined;
      if (old) {
        const oldRoot = staleLibraryId === libId ? root : validateLibrarySource(old.source_path);
        fs.rmSync(path.join(oldRoot, ...stalePath.split("/")), { force: true });
      }
      if (slideshow.movie_item_id && slideshow.movie_item_id !== itemId) {
        db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
          .run(slideshow.movie_item_id);
      }
    } catch { /* best-effort — a leftover file/tile is reaped by the nightly scan */ }
  }

  setSlideshowMovieAsset(slideshow.id, { libraryId: libId, relativePath, itemId });
  return { saved: true, itemId };
}

// Delete a slideshow's rendered movie: the MP4 in the thumbnail store plus any leftover
// temp files from interrupted renders, then reset the render state to 'draft' so the
// editor shows the 'Render movie' button again. Best-effort on the filesystem (an
// unconfigured store or already-missing files aren't errors). Does NOT touch a copy
// already saved into a gallery library — that's a separate, kept asset.
export function deleteSlideshowRender(slideshow: SlideshowRow): void {
  try {
    // The render always writes to a deterministic key, so temp files can be swept even
    // when output_storage_key was never set (only failed renders ran).
    const storageKey = slideshow.output_storage_key
      ?? thumbnailStorageKey("slideshows", slideshow.id, `${slideshow.id}.mp4`);
    const finalPath = thumbnailAbsolutePath(storageKey);
    const dir = path.dirname(finalPath);
    fs.rmSync(finalPath, { force: true });
    // Sweep sibling temp files from interrupted/failed renders: `<name>.mp4.tmp-*.mp4`
    // encodes, `<name>.mp4.title-*.png` title cards and `<name>.mp4.slide-*.jpg`
    // render-sized photos (normally removed in the render's finally; a crash can
    // strand them).
    const prefixes = ["tmp-", "title-", "slide-", "batch-"].map((kind) => `${path.basename(finalPath)}.${kind}`);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (prefixes.some((prefix) => entry.startsWith(prefix))) fs.rmSync(path.join(dir, entry), { force: true });
      }
    }
  } catch { /* best-effort file cleanup */ }
  setSlideshowRenderState(slideshow.id, {
    status: "draft", jobId: null, outputStorageKey: null, outputBytes: null, renderedAt: null, error: null
  });
}

// ── Enqueue + worker ─────────────────────────────────────────────────────────

// Live render progress for the editor/Tasks page, read from the job payload.
export function renderProgressPercent(jobId: string | null): number | null {
  if (!jobId) return null;
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const progress = (JSON.parse(row.payload) as { progress?: { processed: number; total: number } }).progress;
    if (!progress || progress.total <= 0) return null;
    return Math.min(100, Math.round((progress.processed / progress.total) * 100));
  } catch {
    return null;
  }
}

// Merge a final result into the job payload (preserving the last progress the writer
// left), so the Tasks page history can summarize the outcome.
function writeResult(jobId: string, result: Record<string, unknown>): void {
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string } | undefined;
  let payload: Record<string, unknown> = {};
  try { payload = row ? JSON.parse(row.payload) : {}; } catch { /* start fresh on a bad payload */ }
  db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(JSON.stringify({ ...payload, result }), jobId);
}

export function enqueueSlideshowRender(slideshow: SlideshowRow, userId: string): string {
  const jobId = nanoid(16);
  db.prepare(
    "INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 2)"
  ).run(jobId, RENDER_JOB_TYPE, JSON.stringify({ slideshowId: slideshow.id, userId } satisfies RenderPayload));
  setSlideshowRenderState(slideshow.id, { status: "queued", jobId, error: null });
  return jobId;
}

// A job counts as active (its render is still coming) while it's pending or running.
function jobIsRunning(jobId: string): boolean {
  return (db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined)?.status === "running";
}

// Release slideshows stuck in 'queued'/'rendering' whose job is no longer active —
// cancelled from the Tasks page, or lost to a crash — so the editor stops showing
// "Rendering movie…" forever. Restores the previous movie ('ready') when one exists on
// disk (output_storage_key set), otherwise drops back to the 'Render movie' CTA
// ('draft'). Active (pending/running) jobs are left untouched.
export function reconcileOrphanedRenders(): number {
  return db.prepare(`
    UPDATE gallery_slideshows
    SET render_status = CASE WHEN output_storage_key IS NOT NULL THEN 'ready' ELSE 'draft' END,
        render_error = NULL
    WHERE render_status IN ('queued', 'rendering')
      AND (render_job_id IS NULL OR render_job_id NOT IN (SELECT id FROM jobs WHERE status IN ('pending', 'running')))
  `).run().changes;
}

let queueRunning = false;

export async function processSlideshowRenderQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // A render interrupted by a restart: re-queue it (idempotent — it re-renders) —
    // but only while it has attempts left. A render heavy enough to exhaust the
    // container's memory kills the whole server, and an unbounded re-queue then
    // starts it again on every restart, forever. Whatever this gives up on is told
    // to its slideshow, so the editor shows why rather than sitting on "Rendering…".
    const recovery = requeueInterruptedJobs(RENDER_JOB_TYPE);
    for (const job of recovery.abandoned) {
      try {
        const { slideshowId } = JSON.parse(job.payload) as RenderPayload;
        setSlideshowRenderState(slideshowId, {
          status: "failed",
          error: "The render was interrupted every time it ran — the server may not have enough memory for a slideshow this long. Try fewer photos."
        });
      } catch { /* unreadable payload: reconcileOrphanedRenders below still unsticks it */ }
    }
    // Then unstick any slideshow whose render job is no longer active (post-cancel or
    // post-crash) — after the re-queue above, a resumable render's job is 'pending' and
    // so is excluded here.
    reconcileOrphanedRenders();

    for (;;) {
      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(run_at) ASC LIMIT 1
      `).get(RENDER_JOB_TYPE) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1,
          locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as RenderPayload;
      const slideshow = getSlideshow(payload.slideshowId);
      if (!slideshow) {
        // Slideshow deleted before the render ran — nothing to do.
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?").run(job.id);
        continue;
      }

      setSlideshowRenderState(slideshow.id, { status: "rendering", error: null });
      const writeProgress = jobProgressWriter(job.id, payload);
      try {
        // The render belongs to whoever asked; resolve their accessible libraries.
        const libIds = resolveRendererLibraries(payload.userId);
        const { storageKey, bytes } = await renderSlideshow(slideshow, libIds, writeProgress, () => !jobIsRunning(job.id));
        // Cancelled from the Tasks page while ffmpeg ran: the cancel handler already
        // released the slideshow, so don't resurrect it to 'ready' or complete the job.
        if (!jobIsRunning(job.id)) continue;
        setSlideshowRenderState(slideshow.id, {
          status: "ready", outputStorageKey: storageKey, outputBytes: bytes,
          renderedAt: new Date().toISOString(), error: null
        });

        // Auto-save the movie into the default library, if one is configured. Best-effort:
        // a failure here (unusable mount, etc.) must NOT fail the render — the movie is
        // still ready and playable/downloadable in the editor.
        let savedToLibrary = false;
        try {
          savedToLibrary = (await saveMovieToLibrary(getSlideshow(slideshow.id)!, storageKey)).saved;
        } catch (saveErr) {
          console.warn(`slideshow render: movie encoded but couldn't be saved to the library: ${saveErr instanceof Error ? saveErr.message : saveErr}`);
        }

        // Record a result on the job so the Tasks page history shows an outcome.
        writeResult(job.id, { bytes, savedToLibrary });
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?").run(job.id);
      } catch (err) {
        // Cancelled during the render: honour it — don't retry or overwrite the status
        // the cancel handler set.
        if (!jobIsRunning(job.id)) continue;
        const message = err instanceof Error ? err.message : "Render failed";
        const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number };
        if (attempts.attempts < attempts.max_attempts) {
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(new Date(Date.now() + 5000).toISOString(), message, job.id);
          setSlideshowRenderState(slideshow.id, { status: "queued", error: null });
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
          setSlideshowRenderState(slideshow.id, { status: "failed", error: message });
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

// The creator's accessible gallery libraries (the worker has no request context, so
// it rebuilds the user and reuses the normal scope resolver).
function resolveRendererLibraries(userId: string): string[] {
  const user = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as { id: string; role: string } | undefined;
  if (!user) return [];
  return resolveGalleryScopeLibraryIds(user);
}

export function startSlideshowRenderWorker(): () => void {
  const timer = setInterval(() => { void processSlideshowRenderQueue().catch(() => { /* logged per-job */ }); }, 2000);
  return () => clearInterval(timer);
}
