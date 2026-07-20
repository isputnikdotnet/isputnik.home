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
import { nanoid } from "nanoid";
import ffmpegStatic from "ffmpeg-static";
import { db } from "../../../db.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { jobProgressWriter } from "../shared/job-progress.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import {
  getSlideshow,
  getSlideshowRenderItems,
  setSlideshowRenderState,
  type SlideshowRow,
  type SlideshowRenderItem
} from "./slideshows.js";
import { getMusicTrack, musicFileAbsolutePath } from "./music.js";
import { resolveGalleryScopeLibraryIds } from "./catalog.js";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";

export const RENDER_JOB_TYPE = "gallery-slideshow-render";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const TRANSITION_SEC = 1; // xfade duration between slides
const MIN_DWELL = TRANSITION_SEC + 0.5; // a slide must outlast its transition
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

export function segmentsFor(items: SlideshowRenderItem[], slideSeconds: number): Segment[] {
  return items.slice(0, MAX_ITEMS).map((item) => {
    const isVideo = item.kind === "video";
    let dwell: number;
    if (isVideo) {
      // A clip plays for its own length (capped) so it isn't cut mid-action; if the
      // scanner never probed a duration, fall back to the slide default.
      const len = item.duration_seconds ?? slideSeconds;
      dwell = Math.min(Math.max(Number.isFinite(len) && len > 0 ? len : slideSeconds, MIN_DWELL), VIDEO_CAP);
    } else {
      const raw = item.dwell_seconds ?? slideSeconds;
      dwell = Math.min(Math.max(Number.isFinite(raw) ? raw : slideSeconds, MIN_DWELL), 30);
    }
    return { file: path.join(item.source_path, ...item.relative_path.split("/")), dwell, isVideo };
  });
}

// Total video length: with transitions, adjacent slides overlap by TRANSITION_SEC.
function totalDuration(segs: Segment[], useXfade: boolean): number {
  const sum = segs.reduce((n, s) => n + s.dwell, 0);
  return useXfade && segs.length > 1 ? sum - (segs.length - 1) * TRANSITION_SEC : sum;
}

export function buildFfmpegArgs(segs: Segment[], transition: SlideshowRow["transition"], musicPath: string | null, outPath: string): { args: string[]; total: number } {
  // Ken Burns is too expensive to render; fall back to a crossfade (see file header).
  const useXfade = transition !== "none";
  const xfadeName = transition === "slide" ? "slideleft" : "fade";

  const args: string[] = [];
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
    `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${WIDTH}:${HEIGHT}:-1:-1:color=black,setsar=1,fps=${FPS},format=yuv420p[v${i}]`
  );

  let filter: string;
  let mapV: string;
  if (segs.length === 1) {
    filter = per.join(";");
    mapV = "[v0]";
  } else if (!useXfade) {
    const concatIn = segs.map((_, i) => `[v${i}]`).join("");
    filter = `${per.join(";")};${concatIn}concat=n=${segs.length}:v=1:a=0[vout]`;
    mapV = "[vout]";
  } else {
    const chain: string[] = [];
    let last = "v0";
    let cumulative = segs[0].dwell;
    for (let i = 1; i < segs.length; i += 1) {
      const outLabel = i === segs.length - 1 ? "vout" : `x${i}`;
      const offset = (cumulative - TRANSITION_SEC).toFixed(3);
      chain.push(`[${last}][v${i}]xfade=transition=${xfadeName}:duration=${TRANSITION_SEC}:offset=${offset}[${outLabel}]`);
      last = outLabel;
      cumulative += segs[i].dwell - TRANSITION_SEC;
    }
    filter = `${per.join(";")};${chain.join(";")}`;
    mapV = "[vout]";
  }

  const total = totalDuration(segs, useXfade);

  args.push("-filter_complex", filter, "-map", mapV);
  if (musicPath) {
    const fadeStart = Math.max(0, total - 2).toFixed(2);
    args.push(
      "-map", `${segs.length}:a`,
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
// live percentage. Resolves false on any non-zero exit / spawn failure.
function runRender(args: string[], totalSeconds: number, onProgress: (elapsedSec: number, totalSec: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(FFMPEG_BIN, args, { windowsHide: true }); } catch { resolve(false); return; }
    const totalRounded = Math.max(1, Math.round(totalSeconds));
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
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// Render one slideshow to an MP4 in the store. Returns the storage key + byte size,
// or throws with a user-facing message. `libIds` is the CREATOR's accessible set (the
// render belongs to whoever asked for it).
export async function renderSlideshow(
  slideshow: SlideshowRow,
  libIds: string[],
  onProgress: (elapsedSec: number, totalSec: number) => void
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

  const segs = segmentsFor(present, slideshow.slide_seconds);
  const musicPath = musicPathFor(slideshow.music_track_id);

  const storageKey = thumbnailStorageKey("slideshows", slideshow.id, `${slideshow.id}.mp4`);
  const finalPath = thumbnailAbsolutePath(storageKey);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp-${nanoid(6)}.mp4`;

  const { args, total } = buildFfmpegArgs(segs, slideshow.transition, musicPath, tmpPath);
  const ok = await runRender(args, total, onProgress);
  if (!ok) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error("The movie couldn't be encoded. Check the server logs for ffmpeg output.");
  }
  fs.renameSync(tmpPath, finalPath);
  return { storageKey, bytes: fs.statSync(finalPath).size };
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

export function enqueueSlideshowRender(slideshow: SlideshowRow, userId: string): string {
  const jobId = nanoid(16);
  db.prepare(
    "INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 2)"
  ).run(jobId, RENDER_JOB_TYPE, JSON.stringify({ slideshowId: slideshow.id, userId } satisfies RenderPayload));
  setSlideshowRenderState(slideshow.id, { status: "queued", jobId, error: null });
  return jobId;
}

let queueRunning = false;

export async function processSlideshowRenderQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // A render interrupted by a restart: re-queue it (idempotent — it re-renders).
    db.prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE type = ? AND status = 'running'").run(RENDER_JOB_TYPE);

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
        const { storageKey, bytes } = await renderSlideshow(slideshow, libIds, writeProgress);
        setSlideshowRenderState(slideshow.id, {
          status: "ready", outputStorageKey: storageKey, outputBytes: bytes,
          renderedAt: new Date().toISOString(), error: null
        });
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?").run(job.id);
      } catch (err) {
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
