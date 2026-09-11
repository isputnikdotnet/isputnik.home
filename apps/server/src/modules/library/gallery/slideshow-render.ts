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
//
// The pieces, in the order a render uses them: slideshow-segments.ts (slides, cards,
// canvas), slideshow-prescale.ts (photos scaled to the movie first),
// slideshow-ffmpeg-args.ts (the command), slideshow-probe.ts (what the binary and a
// file can do), this file (running ffmpeg, batching, swapping the result in),
// slideshow-movie-files.ts (filing the movie into a library) and
// slideshow-render-queue.ts (the job and its worker).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { getSlideshowRenderItems, getClipRenderItem, type SlideshowRow } from "./slideshows.js";
import { getMusicTrack, musicFileAbsolutePath } from "./music.js";
import { log } from "../../../core/logger.js";
import {
  presentRenderItems,
  renderSlideshowClosingCard,
  renderSlideshowTitleCard,
  segmentsFor,
  titleCardSegment,
  type Segment
} from "./slideshow-segments.js";
import { buildFfmpegArgs, type ClipSound } from "./slideshow-ffmpeg-args.js";
import { prescaleSegments } from "./slideshow-prescale.js";
import { capabilitiesFrom, FFMPEG_BIN, ffmpegFilters, probeDurationSeconds, probeHasAudio } from "./slideshow-probe.js";

// Nice the child to the bottom of the run queue (best-effort: unsupported on some
// platforms, and lowering our own priority never needs privileges where it is).
// The render still gets every idle cycle; it just stops competing with the web
// server, the scanners, and whatever else the box is for.
function deprioritise(pid: number | undefined): void {
  if (pid === undefined) return;
  try { os.setPriority(pid, 19); } catch { /* not supported here — the thread caps still apply */ }
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

interface BatchRenderPlan {
  nodes: Segment[];
  transition: SlideshowRow["transition"];
  transitionSec: number;
  musicPath: string | null;
  /** See BuildOptions.closingDwell — applied at the JOIN, where the music is muxed. */
  closingDwell?: number;
  /** See BuildOptions.closingTail — likewise applied at the JOIN. */
  closingTail?: number;
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
    undefined, {
      prePadded: true, closingDwell: plan.closingDwell, closingTail: plan.closingTail, clipSounds: plan.clipSounds
    }
  );
  const { ok, detail } = await runRender(args, total, (done) => report(done), plan.isCancelled);
  if (!ok) {
    fs.rmSync(plan.outPath, { force: true });
    if (plan.isCancelled()) throw new Error("Render cancelled.");
    throw plan.encodeFailed(detail);
  }
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
      log.error(
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
    log.warn("slideshow render: this ffmpeg build has no xfade filter — rendering with hard cuts between slides.");
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

  // Closing card: the same machinery, appended after the slides. Its dwell also
  // anchors the music's fade-out (see BuildOptions.closingDwell). Like the opening
  // card, one that can't be drawn costs the card, never the movie. It is entirely
  // independent of the post-credit clip below — either can end the movie on its
  // own, and with both the card plays first.
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

  // The post-credit clip: a gallery video resolved against the SAME access set as
  // the slides. One that is gone, inaccessible, or not on disk is skipped with a
  // warning — a missing clip costs the clip, never the movie. It becomes an
  // ordinary video segment (segmentsFor: own length, capped at 20s, audio dropped
  // like every clip — the soundtrack stays the music bed unless outro_sound is on).
  const clipSegmentFor = (itemId: string | null, label: string): Segment | null => {
    if (!itemId) return null;
    const clip = getClipRenderItem(libIds, itemId);
    const usable = clip ? presentRenderItems([clip]) : [];
    if (usable.length === 0) {
      log.warn(`slideshow render: the ${label} clip is missing or not accessible — rendering without it.`);
      return null;
    }
    return segmentsFor(usable, slideshow.slide_seconds)[0];
  };
  const outroClip = clipSegmentFor(slideshow.outro_item_id, "post-credit");

  const transition = capabilities.xfade ? slideshow.transition : "none";
  // The clip and cards are nodes like any other:
  // title card → slides → closing card → post-credit clip. The clip plays LAST,
  // after the credits — a film's stinger, not a second ending.
  const nodes = [
    ...(titleCard ? [titleCard] : []),
    ...renderSegs,
    ...(closingCard ? [closingCard] : []),
    ...(outroClip ? [outroClip] : [])
  ];
  // The music still fades under the closing CARD, so the fade is anchored a clip's
  // length from the end rather than at it: the credits play the song out and the
  // stinger runs on its own sound (or in silence, if its sound is off).
  const closingDwell = closingCard?.dwell;
  const closingTail = outroClip?.dwell ?? 0;

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
  if (outroClip && slideshow.outro_sound === 1 && await probeHasAudio(outroClip.file)) {
    clipSounds.push({ file: outroClip.file, start: startOfNode(outroClip), duration: outroClip.dwell });
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
        nodes, transition, transitionSec: slideshow.transition_seconds, musicPath, closingDwell, closingTail, clipSounds,
        outPath: tmpPath, tempPathFor: (index) => `${finalPath}.batch-${scaleRun}-${index}.mp4`,
        onProgress, isCancelled, onTempFile: (file) => titleFiles.push(file), encodeFailed
      });
    } else {
      const { args, total } = buildFfmpegArgs(
        nodes, transition, musicPath, tmpPath, slideshow.transition_seconds,
        undefined, { closingDwell, closingTail, clipSounds }
      );
      const { ok, detail } = await runRender(args, total, onProgress, isCancelled);
      if (!ok) {
        fs.rmSync(tmpPath, { force: true });
        if (isCancelled()) throw new Error("Render cancelled.");
        throw encodeFailed(detail);
      }
    }
    // Swap the finished temp file into place, retrying while the destination is
    // held open (see swapRenderIntoPlace).
    await swapRenderIntoPlace(tmpPath, finalPath);
    return { storageKey, bytes: fs.statSync(finalPath).size };
  } finally {
    for (const file of titleFiles) fs.rmSync(file, { force: true });
  }
}

// Replacing the previous movie fails with EPERM on Windows whenever another
// process holds the destination open without FILE_SHARE_DELETE — an antivirus or
// Search-indexer pass over the freshly written file, a sync client, Explorer's
// preview handler. All of them let go within seconds. (Our own streaming route is
// NOT a cause: Node opens files with FILE_SHARE_DELETE, so a viewer streaming the
// old movie does not block the rename. Measured, after assuming otherwise.)
//
// By this point the encode is finished and correct, so surrendering minutes of work
// to a scanner that will release the file imminently is the wrong trade — wait it
// out. Only lock-shaped failures are retried; a missing temp file or a bad path
// will not fix itself and should fail at once rather than eight seconds later.
const LOCKED_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_MS = [100, 250, 500, 1000, 1500, 2000, 2500];

export async function swapRenderIntoPlace(
  tmpPath: string,
  finalPath: string,
  // Injectable so the tests don't sit through the real backoff.
  delaysMs: number[] = RENAME_RETRY_MS
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmpPath, finalPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (attempt >= delaysMs.length || !LOCKED_CODES.has(code)) {
        // Out of patience, or a failure waiting won't cure: drop the temp so it
        // can't pile up on the thumbnail drive, and report what actually happened.
        fs.rmSync(tmpPath, { force: true });
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
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
