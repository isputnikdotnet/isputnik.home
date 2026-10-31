// The rewrite itself, against a real (tiny) video and the real ffmpeg — the one
// place in the app that replaces somebody's original file, so the checks that guard
// that moment are worth exercising for real rather than against a stub.
//
// Video only, no audio track: ffmpeg-static's mp3/aac encoders crash on synthesized
// tones (see docs and the slideshow music notes), and nothing here needs sound.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { readFaststart, remuxInPlace } from "../src/modules/library/gallery/faststart.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

const FFMPEG = (ffmpegStatic as unknown as string | null) || "ffmpeg";
const FFPROBE = ffprobeStatic?.path || "ffprobe";

let dir: string;
/** A 1-second clip with its index at the BACK, which is what ffmpeg writes by
 *  default — copied per test so each one gets a pristine original. */
let source: string | null = null;
/** The same clip as a camera writes it: with a timecode track (tmcd) beside the
 *  picture — what GoPro and Sony clips carry, and what a plain copy trips over. */
let cameraClip: string | null = null;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "faststart-remux-"));
  const made = path.join(dir, "source.mp4");
  const result = spawnSync(FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=10",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", made
  ], { windowsHide: true });
  if (result.status === 0 && fs.existsSync(made)) source = made;
  const camera = path.join(dir, "camera-source.mp4");
  const withTimecode = spawnSync(FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=10",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-timecode", "01:00:00:00", "-y", camera
  ], { windowsHide: true });
  if (withTimecode.status === 0 && fs.existsSync(camera)) cameraClip = camera;
});

/** Each track of a file as ffprobe names it: "video:h264", "data:tmcd". */
function tracksOf(filePath: string): string[] {
  const result = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,codec_tag_string", "-of", "json", filePath], { encoding: "utf8", windowsHide: true });
  const streams = (JSON.parse(result.stdout) as { streams: { codec_type: string; codec_name?: string; codec_tag_string: string }[] }).streams;
  return streams.map((stream) => `${stream.codec_type}:${stream.codec_type === "data" ? stream.codec_tag_string : stream.codec_name}`);
}

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
});

/** A catalog row for a copy of the clip, and the copy's path. */
function stageVideo(name: string, from: string | null = source): { itemId: string; filePath: string } {
  const filePath = path.join(dir, name);
  fs.copyFileSync(from!, filePath);
  const lib = makeLibrary("gal", { createdBy: "admin", type: "gallery" });
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('clip', ?, 'gallery', ?, 'ready')")
    .run(lib, name);
  db.prepare(
    "INSERT INTO gallery_details (item_id, kind, relative_path, size, faststart, content_hash, content_hash_at) VALUES ('clip', 'video', ?, ?, 0, 'stale-hash', '2026-01-01T00:00:00Z')"
  ).run(name, fs.statSync(filePath).size);
  return { itemId: "clip", filePath };
}

describe("rewriting a video with its index in front", () => {
  it("is what ffmpeg writes without asking: the index goes at the back", async () => {
    if (!source) return; // no usable ffmpeg on this platform — covered below
    expect(await readFaststart(source, ".mp4")).toBe(false);
  });

  it("moves the index, keeps the picture, and records the new file", async () => {
    if (!source) return;
    const { itemId, filePath } = stageVideo("holiday.mp4");
    const before = fs.readFileSync(filePath);

    expect(await remuxInPlace({ itemId, srcPath: filePath })).toBeNull();

    expect(await readFaststart(filePath, ".mp4")).toBe(true);
    const after = fs.readFileSync(filePath);
    // Same bytes, rearranged: nothing was re-encoded, so the size barely moves.
    expect(Math.abs(after.length - before.length)).toBeLessThan(2048);

    const row = db.prepare("SELECT faststart, size, content_hash, content_hash_at FROM gallery_details WHERE item_id = 'clip'")
      .get() as { faststart: number; size: number; content_hash: string | null; content_hash_at: string | null };
    expect(row.faststart).toBe(1);
    expect(row.size).toBe(after.length);
    // The bytes moved, so the duplicate scan's hash of them is no longer true.
    expect(row.content_hash).toBeNull();
    expect(row.content_hash_at).toBeNull();
  }, 30_000);

  it("keeps the original, and leaves no temp file, when the source cannot be read", async () => {
    if (!source) return;
    const { itemId } = stageVideo("broken.mp4");
    const notAVideo = path.join(dir, "notes.mp4");
    fs.writeFileSync(notAVideo, "this is not a video");

    expect(await remuxInPlace({ itemId, srcPath: notAVideo })).toMatch(/could not be read/i);
    expect(fs.readFileSync(notAVideo, "utf8")).toBe("this is not a video");
    expect(fs.readdirSync(dir).filter((f) => f.includes("faststart-"))).toEqual([]);
    // Nothing was claimed to be fixed.
    expect((db.prepare("SELECT faststart FROM gallery_details WHERE item_id = 'clip'").get() as { faststart: number }).faststart).toBe(0);
  }, 30_000);

  it("running it twice is harmless — the second pass finds it already in front", async () => {
    if (!source) return;
    const { itemId, filePath } = stageVideo("twice.mp4");
    expect(await remuxInPlace({ itemId, srcPath: filePath })).toBeNull();
    expect(await remuxInPlace({ itemId, srcPath: filePath })).toBeNull();
    expect(await readFaststart(filePath, ".mp4")).toBe(true);
  }, 45_000);
});

// GoPro and Sony clips (docs: a batch of 26 failed with "could not be rewritten"):
// the camera's own tracks cannot be copied into an MP4 as ffmpeg reads them.
describe("rewriting a camera's video", () => {
  it("rebuilds the timecode track instead of failing on it", async () => {
    if (!cameraClip) return;
    expect(tracksOf(cameraClip)).toEqual(["video:h264", "data:tmcd"]);
    const { itemId, filePath } = stageVideo("GOPR0001.MP4", cameraClip);

    expect(await remuxInPlace({ itemId, srcPath: filePath })).toBeNull();

    expect(await readFaststart(filePath, ".mp4")).toBe(true);
    expect(tracksOf(filePath)).toEqual(["video:h264", "data:tmcd"]);
  }, 30_000);

  it("leaves the original as it is, and says which track, when a camera track cannot be kept", async () => {
    if (!cameraClip) return;
    // Sony writes per-frame camera data as an "rtmd" track; ffmpeg cannot put it
    // into an MP4 at all. The timecode track renamed is the same thing to ffmpeg.
    const bytes = fs.readFileSync(cameraClip);
    for (let at = bytes.indexOf("tmcd", 0, "latin1"); at !== -1; at = bytes.indexOf("tmcd", at + 4, "latin1")) bytes.write("rtmd", at, "latin1");
    const sony = path.join(dir, "sony-source.mp4");
    fs.writeFileSync(sony, bytes);
    const { itemId, filePath } = stageVideo("C0001.MP4", sony);
    const original = fs.readFileSync(filePath);

    expect(await remuxInPlace({ itemId, srcPath: filePath })).toMatch(/Left as it is: the camera wrote a track \(rtmd\)/);

    expect(fs.readFileSync(filePath).equals(original)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.includes("faststart-"))).toEqual([]);
    expect((db.prepare("SELECT faststart FROM gallery_details WHERE item_id = 'clip'").get() as { faststart: number }).faststart).toBe(0);
  }, 30_000);
});
