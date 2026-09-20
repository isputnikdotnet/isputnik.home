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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { readFaststart, remuxInPlace } from "../src/modules/library/gallery/faststart.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

const FFMPEG = (ffmpegStatic as unknown as string | null) || "ffmpeg";

let dir: string;
/** A 1-second clip with its index at the BACK, which is what ffmpeg writes by
 *  default — copied per test so each one gets a pristine original. */
let source: string | null = null;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "faststart-remux-"));
  const made = path.join(dir, "source.mp4");
  const result = spawnSync(FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=10",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", made
  ], { windowsHide: true });
  if (result.status === 0 && fs.existsSync(made)) source = made;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
});

/** A catalog row for a copy of the clip, and the copy's path. */
function stageVideo(name: string): { itemId: string; filePath: string } {
  const filePath = path.join(dir, name);
  fs.copyFileSync(source!, filePath);
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
