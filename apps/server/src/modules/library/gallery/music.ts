// Gallery slideshow music: built-in ambient beds + user uploads (see
// docs/gallery-slideshows-proposal.md, Phase 2). Both flavours share one table
// (gallery_music_tracks) and one storage location — the configured thumbnail store's
// shared "music" bucket (like the "people"/"categories" buckets), resolved through
// thumbnailAbsolutePath so the same path-safety rules apply. Built-in beds are
// SYNTHESISED on demand with the bundled ffmpeg (no audio blobs committed to the
// repo); user uploads are streamed in via the shared upload primitive.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import ffmpegStatic from "ffmpeg-static";
import { parseFile } from "music-metadata";
import { db } from "../../../db.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";

export interface MusicTrackRow {
  id: string;
  title: string;
  artist: string | null;
  builtin: number;
  storage_key: string;
  duration_seconds: number | null;
  uploaded_by: string | null;
  created_at: string;
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
  ".flac": "audio/flac", ".weba": "audio/webm", ".webm": "audio/webm"
};
export const MUSIC_UPLOAD_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba", "webm"];
export const MUSIC_MAX_BYTES = 25 * 1024 * 1024; // a slideshow bed, not an album

export function musicMimeForKey(storageKey: string): string {
  return MIME_BY_EXT[path.extname(storageKey).toLowerCase()] ?? "application/octet-stream";
}

export function getMusicTrack(id: string): MusicTrackRow | undefined {
  return db.prepare("SELECT * FROM gallery_music_tracks WHERE id = ?").get(id) as MusicTrackRow | undefined;
}

export function musicFileAbsolutePath(track: MusicTrackRow): string {
  return thumbnailAbsolutePath(track.storage_key);
}

// Client shape. `url` is the streaming endpoint; the picker and the live-preview
// <audio> both use it. Kept in one place so every response agrees.
export function summarizeTrack(row: MusicTrackRow) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    builtin: row.builtin === 1,
    durationSeconds: row.duration_seconds,
    url: `/api/library/gallery/music/${row.id}/stream`,
    uploadedBy: row.uploaded_by
  };
}

export function listMusicTracks() {
  const rows = db.prepare(
    "SELECT * FROM gallery_music_tracks ORDER BY builtin DESC, datetime(created_at) DESC, title ASC"
  ).all() as MusicTrackRow[];
  return rows.map(summarizeTrack);
}

async function probeDurationSeconds(absPath: string): Promise<number | null> {
  try {
    const meta = await parseFile(absPath);
    const d = meta.format.duration;
    return typeof d === "number" && Number.isFinite(d) ? Math.round(d * 100) / 100 : null;
  } catch {
    return null;
  }
}

function titleFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename)).trim();
  return (base || "Untitled track").slice(0, 120);
}

// Move a received upload temp file into the music bucket and record it. The temp file
// is expected to already live under the thumbnail store (same filesystem) so the
// rename can't fail with EXDEV; a copy+unlink is the cross-device fallback anyway.
export async function createUserTrack(
  user: { id: string },
  tmpPath: string,
  filename: string,
  extension: string
): Promise<ReturnType<typeof summarizeTrack>> {
  const id = nanoid(16);
  const key = thumbnailStorageKey("music", id, `${id}.${extension.toLowerCase()}`);
  const abs = thumbnailAbsolutePath(key);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.renameSync(tmpPath, abs);
  } catch {
    fs.copyFileSync(tmpPath, abs);
    fs.rmSync(tmpPath, { force: true });
  }
  const duration = await probeDurationSeconds(abs);
  db.prepare(
    "INSERT INTO gallery_music_tracks (id, title, artist, builtin, storage_key, duration_seconds, uploaded_by) VALUES (?, ?, NULL, 0, ?, ?, ?)"
  ).run(id, titleFromFilename(filename), key, duration, user.id);
  return summarizeTrack(getMusicTrack(id)!);
}

export type DeleteMusicResult = "ok" | "notfound" | "builtin" | "forbidden";

// Delete a user track (its file + row). Built-in beds can't be deleted; a user track
// is deletable by its uploader or an admin. Slideshows referencing it degrade to
// silent via the FK's ON DELETE SET NULL.
export function deleteMusicTrack(id: string, user: { id: string; role: string }): DeleteMusicResult {
  const row = getMusicTrack(id);
  if (!row) return "notfound";
  if (row.builtin === 1) return "builtin";
  if (user.role !== "admin" && row.uploaded_by !== user.id) return "forbidden";
  try { fs.rmSync(thumbnailAbsolutePath(row.storage_key), { force: true }); } catch { /* best-effort */ }
  db.prepare("DELETE FROM gallery_music_tracks WHERE id = ?").run(id);
  return "ok";
}

// ── Built-in ambient beds ───────────────────────────────────────────────────

// Built-in beds come in two flavours, both synthesised from pure sine tones and
// encoded to FLAC (see the encoder note in bedArgs). Stable ids so a re-seed updates
// in place (never DELETE+INSERT, which would null out slideshows referencing the bed).
//
// - `pad`: one soft, sustained chord — a calm ambient backdrop.
// - `progression`: a looping chord progression (each chord's triad gated to its time
//   slot with short fades, then mixed) — a more musical, melodic bed.
interface PadBed { id: string; title: string; kind: "pad"; freqs: number[]; vibrato: number; tremolo: number }
interface ProgressionBed { id: string; title: string; kind: "progression"; chords: number[][]; chordSeconds: number; vibrato: number }
type BedSpec = PadBed | ProgressionBed;

const PAD_DURATION = 24;

// Triads (mid-octave) used by the progression beds.
const C = [261.63, 329.63, 392.0];    // C major
const G = [196.0, 246.94, 293.66];    // G major
const Am = [220.0, 261.63, 329.63];   // A minor
const F = [174.61, 220.0, 261.63];    // F major
const Em = [164.81, 196.0, 246.94];   // E minor

const BUILTIN_BEDS: BedSpec[] = [
  // Ambient pads.
  { id: "builtinbedwarm001", title: "Warm Daylight", kind: "pad", freqs: [261.63, 329.63, 392.0, 523.25], vibrato: 4.5, tremolo: 0.12 },
  { id: "builtinbedcalm001", title: "Quiet Evening", kind: "pad", freqs: [220.0, 261.63, 329.63, 440.0], vibrato: 3.5, tremolo: 0.1 },
  { id: "builtinbedairy001", title: "Open Sky", kind: "pad", freqs: [293.66, 349.23, 440.0, 587.33], vibrato: 5.0, tremolo: 0.14 },
  // Melodic chord-progression beds (loop seamlessly; the player/render loop them).
  { id: "builtinbedsun00001", title: "Sunlit Days", kind: "progression", chords: [C, G, Am, F], chordSeconds: 3.0, vibrato: 4.0 },     // I-V-vi-IV, uplifting
  { id: "builtinbedhome0001", title: "Homeward", kind: "progression", chords: [F, C, G, Am], chordSeconds: 3.5, vibrato: 3.2 },        // IV-I-V-vi, warm/nostalgic
  { id: "builtinbedsnow0001", title: "Quiet Snowfall", kind: "progression", chords: [Am, F, C, Em], chordSeconds: 4.0, vibrato: 5.0 }  // vi-IV-I-iii, reflective
];

function bedDurationSeconds(spec: BedSpec): number {
  return spec.kind === "pad" ? PAD_DURATION : spec.chords.length * spec.chordSeconds;
}

// Encode to FLAC, not a perceptual codec. Both libmp3lame and the native AAC encoder
// assert / drop frames non-deterministically on pure-sine chords (their psychoacoustic
// models choke on the pathologically tonal input these beds are). FLAC is lossless — no
// psychoacoustic model to trip — and these tonal beds still compress small. Browsers
// play audio/flac via <audio>. gain leaves ~2 dB of headroom so nothing clips.
function bedArgs(spec: BedSpec, outPath: string): string[] {
  if (spec.kind === "pad") {
    const inputs = spec.freqs.flatMap((f) => ["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${PAD_DURATION}`]);
    const labels = spec.freqs.map((_, i) => `[${i}]`).join("");
    const gain = (0.85 / spec.freqs.length).toFixed(3);
    const filter = [
      `${labels}amix=inputs=${spec.freqs.length}:normalize=0`,
      `volume=${gain}`,
      `vibrato=f=${spec.vibrato}:d=0.22`,
      `tremolo=f=${spec.tremolo}:d=0.6`,
      `afade=t=in:d=3`,
      `afade=t=out:st=${PAD_DURATION - 3}:d=3`,
      "aformat=sample_fmts=s16:channel_layouts=stereo"
    ].join(",");
    return ["-y", ...inputs, "-filter_complex", filter, "-c:a", "flac", "-ar", "44100", outPath];
  }

  // Progression: one sine per note; each note lasts `chordSeconds`, fades at its edges,
  // and is delayed to its chord's time slot — so only the current chord's triad sounds.
  const D = spec.chordSeconds;
  const fade = 0.45;
  const notes: { f: number; k: number }[] = [];
  spec.chords.forEach((triad, k) => triad.forEach((f) => notes.push({ f, k })));
  const inputs = notes.flatMap((n) => ["-f", "lavfi", "-i", `sine=frequency=${n.f}:duration=${D}`]);
  const per = notes.map((n, i) => {
    const delayMs = Math.round(n.k * D * 1000);
    const delay = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";
    return `[${i}]afade=t=in:d=${fade},afade=t=out:st=${(D - fade).toFixed(2)}:d=${fade}${delay}[a${i}]`;
  });
  const mixIn = notes.map((_, i) => `[a${i}]`).join("");
  const filter = `${per.join(";")};${mixIn}amix=inputs=${notes.length}:normalize=0,volume=0.2,` +
    `vibrato=f=${spec.vibrato}:d=0.12,aformat=sample_fmts=s16:channel_layouts=stereo`;
  return ["-y", ...inputs, "-filter_complex", filter, "-c:a", "flac", "-ar", "44100", outPath];
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(FFMPEG_BIN, args, { windowsHide: true }); } catch { resolve(false); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } resolve(false); }, 60000);
    timer.unref?.();
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

// Ensure every built-in bed exists (row + file). Idempotent: skips a bed whose row
// and file are both present, so it's cheap to call on every startup. Silently a
// no-op if the thumbnail store isn't configured yet or ffmpeg can't run — music is
// only relevant once galleries/slideshows exist, and uploads still work regardless.
export async function seedBuiltinMusic(): Promise<void> {
  for (const spec of BUILTIN_BEDS) {
    const key = thumbnailStorageKey("music", spec.id, `${spec.id}.flac`);
    let abs: string;
    try { abs = thumbnailAbsolutePath(key); } catch { return; } // store not configured
    if (getMusicTrack(spec.id) && fs.existsSync(abs)) continue;

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${nanoid(6)}.flac`;
    const ok = await runFfmpeg(bedArgs(spec, tmp));
    if (!ok) { fs.rmSync(tmp, { force: true }); continue; }
    try { fs.renameSync(tmp, abs); } catch { fs.rmSync(tmp, { force: true }); continue; }

    db.prepare(`
      INSERT INTO gallery_music_tracks (id, title, artist, builtin, storage_key, duration_seconds)
      VALUES (?, ?, 'Built-in', 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, storage_key = excluded.storage_key,
        duration_seconds = excluded.duration_seconds, builtin = 1
    `).run(spec.id, spec.title, key, bedDurationSeconds(spec));
  }
}

// The music-bucket directory (created lazily) — used as the upload temp dir so the
// received file lands on the same filesystem as its final home (no cross-device
// rename). Safe because thumbnailAbsolutePath validates the key stays under the root.
export function musicTempDir(): string {
  const dir = thumbnailAbsolutePath("music");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
