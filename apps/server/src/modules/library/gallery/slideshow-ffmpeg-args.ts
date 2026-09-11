import os from "node:os";
import type { SlideshowRow } from "./slideshows.js";
import { clampTransitionSec, DEFAULT_TRANSITION_SEC, FPS, HEIGHT, WIDTH, type Segment } from "./slideshow-segments.js";

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

// ── Build the ffmpeg invocation ──────────────────────────────────────────────

// Total video length: with transitions, adjacent nodes overlap by transitionSec.
// `dwells` covers every node in the chain, title card included.
function totalDuration(dwells: number[], useXfade: boolean, transitionSec: number): number {
  const sum = dwells.reduce((n, d) => n + d, 0);
  return useXfade && dwells.length > 1 ? sum - (dwells.length - 1) * transitionSec : sum;
}

// The xfade styles a "random" slideshow draws from at each cut — a tasteful subset of
// ffmpeg's catalogue (every entry verified against the bundled ffmpeg-static build).
export const RANDOM_XFADES = ["fade", "dissolve", "slideleft", "slideright", "wipeleft", "wiperight", "circleopen", "smoothup"] as const;

// ── A clip's own sound ───────────────────────────────────────────────────────
//
// The post-credit clip is often chosen FOR its sound — a recorded greeting, a
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
  // Seconds of movie AFTER the closing card — the post-credit clip. The music
  // still fades out under the CARD, so the fade is anchored this far from the end
  // rather than at it; the stinger then plays past a soundtrack already at zero.
  // 0/undefined = the movie ends on the card (or the last slide).
  closingTail?: number;
  // Sounded clips (see ClipSound). Like closingDwell, only meaningful
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
  // Ken Burns is too expensive to render; fall back to a crossfade (see the header of slideshow-render.ts).
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
    // A photo is a still looped for its input length — frames forever, so it can
    // carry the transition overlap. A video is read for its DWELL of footage only;
    // the overlap it cannot supply is cloned in the filtergraph (tpad below). Asking
    // -t for dwell+pad instead used to truncate the whole movie: the file EOFs at
    // its own length, and an xfade whose offset lies past an input's end doesn't
    // shorten one transition — it ends the chain, and everything after it was lost.
    if (seg.isVideo) args.push("-t", seg.dwell.toFixed(3), "-i", seg.file);
    else args.push("-loop", "1", "-t", inputDur(seg).toFixed(3), "-i", seg.file);
  }
  if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);
  // Sounded clips ride as EXTRA audio-only inputs after the music — their video
  // is one of the segment inputs (single pass) or baked into a batch video (join).
  const clipSounds = (options.clipSounds ?? []).filter((clip) => clip.duration > 0.2);
  for (const clip of clipSounds) args.push("-i", clip.file);

  // Normalize every input to the same canvas (letterboxed), fixed fps + pixel format —
  // photos, video frames and the title card alike, so they transition cleanly. A video
  // additionally clones its last frame across the transition overlap (tpad; a second
  // beyond it as a cushion for probe-vs-delivery rounding) — the padding a looped
  // photo gets for free, and without which its EOF truncates the movie (see above).
  // The output -t below trims whatever the cushion adds past the arithmetic total.
  const per = segs.map((seg, i) =>
    `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
    `pad=${WIDTH}:${HEIGHT}:-1:-1:color=black,setsar=1,fps=${FPS},` +
    (seg.isVideo && pad > 0 ? `tpad=stop_mode=clone:stop_duration=${(pad + 1).toFixed(2)},` : "") +
    `format=yuv420p[v${i}]`
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
  // 2-second tail every movie has always had, byte for byte. A post-credit clip
  // (closingTail) sits after all of that, so the fade is measured from where the
  // card ends rather than from the end of the movie.
  const closing = options.closingDwell;
  const tail = Math.max(0, options.closingTail ?? 0);
  const fadeDur = closing && closing > 0 ? Math.min(closing, 8) : 2;
  const fadeStart = Math.max(0, total - tail - (closing && closing > 0 ? closing : 2));

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
    // The closing fade belongs to the MUSIC, not to the finished mix: a post-credit
    // clip plays once the credits have taken the song to zero, and fading the mix
    // would take the clip's own sound down with it. Applied after adelay, whose
    // silence makes the window's timestamps absolute — so one `st` fits every
    // window, and a window that ends before the fade simply never reaches it.
    const fadeOut = `afade=t=out:st=${fadeStart.toFixed(2)}:d=${fadeDur}`;
    if (musicPath) {
      musicWindows(clipSounds, total).forEach((window, j) => {
        const delay = Math.round(window.at * 1000);
        chains.push(
          `[${segs.length}:a]atrim=${window.from.toFixed(3)}:${(window.from + window.len).toFixed(3)},asetpts=PTS-STARTPTS` +
          // A resumed window eases back in; the movie-opening window starts clean.
          (window.at > 0 ? `,afade=t=in:st=0:d=0.3` : "") +
          (delay > 0 ? `,adelay=${delay}:all=1` : "") +
          `,${fadeOut}` +
          `[music${j}]`
        );
        mixIn.push(`[music${j}]`);
      });
    }
    const soundtrack = mixIn.length === 1
      ? `${mixIn[0]}anull[aout]`
      : `${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0[aout]`;
    args.push("-filter_complex", `${filter};${chains.join(";")};${soundtrack}`, "-map", mapV);
    // No -shortest: every audio piece is trimmed to the timeline by construction,
    // and the video stream is what bounds the movie.
    args.push("-map", "[aout]", ...audioCodec);
  }
  args.push(
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(options.crf ?? 22), "-preset", "veryfast",
    "-threads", String(ENCODER_THREADS),
    "-r", String(FPS), "-movflags", "+faststart",
    // The arithmetic total is the movie: the tpad cushion on a trailing video (and
    // an infinite music loop) must never stretch past it.
    "-t", total.toFixed(3),
    "-progress", "pipe:1", "-nostats", "-y", outPath
  );
  return { args, total };
}
