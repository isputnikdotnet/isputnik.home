// Asking the bundled ffmpeg/ffprobe about files and about themselves.
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

export const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";
const FFPROBE_BIN: string = ffprobeStatic?.path || "ffprobe";

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
