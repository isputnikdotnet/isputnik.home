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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import ffmpegStatic from "ffmpeg-static";
import { db } from "../../../db.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { jobProgressWriter } from "../shared/job-progress.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import {
  getSlideshow,
  getSlideshowRenderItems,
  setSlideshowRenderState,
  setSlideshowMovieAsset,
  type SlideshowRow,
  type SlideshowRenderItem
} from "./slideshows.js";
import { getMusicTrack, musicFileAbsolutePath } from "./music.js";
import { resolveGalleryScopeLibraryIds } from "./catalog.js";
import { getRenderLibraryId } from "./slideshow-settings.js";
import { scanSingleGalleryFile } from "./scanner.js";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";

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

export interface Segment { file: string; dwell: number; isVideo: boolean }

export function segmentsFor(items: SlideshowRenderItem[], slideSeconds: number, transitionSec = DEFAULT_TRANSITION_SEC): Segment[] {
  const minDwell = clampTransitionSec(transitionSec) + 0.5; // a slide must outlast its transition
  return items.slice(0, MAX_ITEMS).map((item) => {
    const isVideo = item.kind === "video";
    let dwell: number;
    if (isVideo) {
      // A clip plays for its own length (capped) so it isn't cut mid-action; if the
      // scanner never probed a duration, fall back to the slide default.
      const len = item.duration_seconds ?? slideSeconds;
      dwell = Math.min(Math.max(Number.isFinite(len) && len > 0 ? len : slideSeconds, minDwell), VIDEO_CAP);
    } else {
      const raw = item.dwell_seconds ?? slideSeconds;
      dwell = Math.min(Math.max(Number.isFinite(raw) ? raw : slideSeconds, minDwell), 30);
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
// Every render opens on a ~3s black card carrying the slideshow's name (drawtext on a
// lavfi color source), cross-fading into the first photo with the slideshow's own
// transition. Text comes from temp FILES (textfile=) — that sidesteps drawtext's text
// escaping entirely; only the two paths we control need escaping below.

export interface TitleCard {
  textFile: string;           // UTF-8 file holding the title line (the slideshow name)
  subTextFile: string | null; // optional smaller second line ("42 photos")
  fontFile: string;           // bundled TTF (static ffmpeg has no system font lookup)
}

// The card must outlast its own transition, like any slide.
export function titleCardDwell(transitionSec: number): number {
  return Math.max(3, clampTransitionSec(transitionSec) + 0.5);
}

// A path inside a filtergraph value: forward slashes, escaped drive colon, quotes
// stripped (our own store/asset paths never legitimately contain one).
export function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/'/g, "").replace(/:/g, "\\:");
}

// The bundled title-card font, resolved relative to this module so it works from
// src/ under tsx (dev) and dist/ in production (copy-assets.mjs ships src/assets).
export function bundledFontPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fontPath = path.resolve(here, "../../../assets/fonts/DejaVuSans.ttf");
  return fs.existsSync(fontPath) ? fontPath : null;
}

export function buildFfmpegArgs(
  segs: Segment[],
  transition: SlideshowRow["transition"],
  musicPath: string | null,
  outPath: string,
  transitionSec = DEFAULT_TRANSITION_SEC,
  // Injectable for tests; the default picks uniformly per slide boundary.
  pickTransition: (boundaryIndex: number) => string = () => RANDOM_XFADES[Math.floor(Math.random() * RANDOM_XFADES.length)],
  titleCard: TitleCard | null = null
): { args: string[]; total: number } {
  const TRANSITION_SEC = clampTransitionSec(transitionSec);
  // Ken Burns is too expensive to render; fall back to a crossfade (see file header).
  const useXfade = transition !== "none";
  const xfadeName = transition === "slide" ? "slideleft" : transition === "dipblack" ? "fadeblack" : "fade";
  // With a title card, node 0 is the card and every photo/video input shifts by one.
  const base = titleCard ? 1 : 0;
  const titleDwell = titleCardDwell(TRANSITION_SEC);

  const args: string[] = [];
  if (titleCard) {
    args.push("-f", "lavfi", "-t", titleDwell.toFixed(3), "-i", `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}`);
  }
  for (const seg of segs) {
    // A photo is a still looped for its dwell; a video is read for `dwell` seconds of
    // its own footage (its audio is ignored — only [i:v] is referenced below).
    if (seg.isVideo) args.push("-t", seg.dwell.toFixed(3), "-i", seg.file);
    else args.push("-loop", "1", "-t", seg.dwell.toFixed(3), "-i", seg.file);
  }
  if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);

  // Normalize every input to the same canvas (letterboxed), fixed fps + pixel format —
  // photos and video frames alike, so they transition cleanly.
  const per = segs.map((_, i) =>
    `[${i + base}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${WIDTH}:${HEIGHT}:-1:-1:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i + base}]`
  );
  if (titleCard) {
    const font = escapeFilterPath(titleCard.fontFile);
    let card = `[0:v]drawtext=fontfile='${font}':textfile='${escapeFilterPath(titleCard.textFile)}':` +
      `fontcolor=white:fontsize=88:x=(w-text_w)/2:y=${titleCard.subTextFile ? "(h-text_h)/2-36" : "(h-text_h)/2"}`;
    if (titleCard.subTextFile) {
      card += `,drawtext=fontfile='${font}':textfile='${escapeFilterPath(titleCard.subTextFile)}':` +
        `fontcolor=white@0.72:fontsize=40:x=(w-text_w)/2:y=(h)/2+48`;
    }
    per.unshift(`${card},setsar=1,fps=${FPS},format=yuv420p[v0]`);
  }

  // Every node in presentation order: the card (when present), then the slides.
  const dwells = titleCard ? [titleDwell, ...segs.map((s) => s.dwell)] : segs.map((s) => s.dwell);
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

  args.push("-filter_complex", filter, "-map", mapV);
  if (musicPath) {
    const fadeStart = Math.max(0, total - 2).toFixed(2);
    args.push(
      "-map", `${segs.length + base}:a`,
      "-af", `afade=t=out:st=${fadeStart}:d=2`,
      "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "44100",
      "-shortest"
    );
  }
  args.push(
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-preset", "veryfast",
    "-r", String(FPS), "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", "-y", outPath
  );
  return { args, total };
}

// Run ffmpeg, parsing -progress output for elapsed seconds so the caller can report a
// live percentage. Resolves false on any non-zero exit / spawn failure. `isCancelled`
// is polled once a second; when it flips true (the job was cancelled from the Tasks
// page) the ffmpeg child is killed so a cancelled render doesn't burn CPU for minutes.
function runRender(
  args: string[],
  totalSeconds: number,
  onProgress: (elapsedSec: number, totalSec: number) => void,
  isCancelled: () => boolean = () => false
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(FFMPEG_BIN, args, { windowsHide: true }); } catch { resolve(false); return; }
    const totalRounded = Math.max(1, Math.round(totalSeconds));
    let settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearInterval(poll); resolve(ok); };
    const poll = setInterval(() => {
      if (isCancelled()) { try { child.kill(); } catch { /* already gone */ } finish(false); }
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
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
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
  const present: SlideshowRenderItem[] = [];
  for (const item of items) {
    let root: string;
    try { root = validateLibrarySource(item.source_path); } catch { continue; }
    const abs = path.join(root, ...item.relative_path.split("/"));
    if (abs.startsWith(root) && fs.existsSync(abs)) present.push(item);
  }
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
      if (entry.startsWith(`${path.basename(finalPath)}.tmp-`) || entry.startsWith(`${path.basename(finalPath)}.title-`)) {
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    }
  } catch { /* best-effort */ }
  const tmpPath = `${finalPath}.tmp-${nanoid(6)}.mp4`;

  // Opening title card: the slideshow's name + a photo-count subline, fed to drawtext
  // as temp text FILES (no filter escaping). Missing font (should not happen — it ships
  // with the server) degrades to a card-less render rather than failing the movie.
  const titleTextFiles: string[] = [];
  let titleCard: TitleCard | null = null;
  const fontFile = bundledFontPath();
  if (fontFile) {
    try {
      const textFile = `${finalPath}.title-${nanoid(6)}.txt`;
      const subTextFile = `${finalPath}.title-${nanoid(6)}.txt`;
      fs.writeFileSync(textFile, slideshow.name, "utf8");
      fs.writeFileSync(subTextFile, `${segs.length} photo${segs.length === 1 ? "" : "s"}`, "utf8");
      titleTextFiles.push(textFile, subTextFile);
      titleCard = { textFile, subTextFile, fontFile };
    } catch { titleCard = null; }
  } else {
    console.warn("slideshow render: bundled title-card font missing — rendering without a title card.");
  }

  try {
    const { args, total } = buildFfmpegArgs(
      segs, slideshow.transition, musicPath, tmpPath, slideshow.transition_seconds, undefined, titleCard
    );
    const ok = await runRender(args, total, onProgress, isCancelled);
    if (!ok) {
      fs.rmSync(tmpPath, { force: true });
      if (isCancelled()) throw new Error("Render cancelled.");
      throw new Error("The movie couldn't be encoded. Check the server logs for ffmpeg output.");
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
    for (const file of titleTextFiles) fs.rmSync(file, { force: true });
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
    // encodes and `<name>.mp4.title-*.txt` title-card text (normally removed in the
    // render's finally; a crash can strand them).
    const prefixes = [`${path.basename(finalPath)}.tmp-`, `${path.basename(finalPath)}.title-`];
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
    // A render interrupted by a restart: re-queue it (idempotent — it re-renders).
    db.prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE type = ? AND status = 'running'").run(RENDER_JOB_TYPE);
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
  return resolveGalleryScopeLibraryIds(user, "all");
}

export function startSlideshowRenderWorker(): () => void {
  const timer = setInterval(() => { void processSlideshowRenderQueue().catch(() => { /* logged per-job */ }); }, 2000);
  return () => clearInterval(timer);
}
