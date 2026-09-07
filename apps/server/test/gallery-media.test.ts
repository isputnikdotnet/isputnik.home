import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { renderInTurn, thumbnailPathSettingKey, thumbnailAbsolutePath } from "../src/modules/library/shared/thumbnail.js";
import { decodePhotoToJpeg, generateGalleryThumbnails, readAssetMetadata } from "../src/modules/library/gallery/media.js";
import { resetDb } from "./helpers/seed.js";

// A real 24-bit uncompressed BMP — the format sharp's prebuilt libvips cannot read,
// so these tests exercise the ffmpeg fallback end to end (they spawn the bundled
// ffmpeg/ffprobe binaries).
function writeBmp(filePath: string, width = 8, height = 8): void {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(54 + rowSize * height);
  data.write("BM", 0);
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = 54 + y * rowSize + x * 3;
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 255; // solid red (BGR)
    }
  }
  fs.writeFileSync(filePath, data);
}

let root: string;

beforeEach(() => {
  resetDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-media-"));
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, path.join(root, "thumbs"));
});

afterEach(() => {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(thumbnailPathSettingKey);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("BMP photos (no sharp loader)", () => {
  it("decodePhotoToJpeg converts a BMP to a JPEG buffer via ffmpeg", async () => {
    const bmp = path.join(root, "photo.bmp");
    writeBmp(bmp);
    const jpeg = await decodePhotoToJpeg(bmp);
    expect(jpeg).not.toBeNull();
    expect(jpeg![0]).toBe(0xff); // JPEG SOI marker
    expect(jpeg![1]).toBe(0xd8);
  });

  it("generateGalleryThumbnails falls back to ffmpeg and writes both thumbnails", async () => {
    const bmp = path.join(root, "photo.bmp");
    writeBmp(bmp, 16, 12);
    const keys = await generateGalleryThumbnails("LIB", "ITEM", "photo", bmp);
    expect(keys).not.toBeNull();
    expect(fs.existsSync(thumbnailAbsolutePath(keys!.coverKey))).toBe(true);
    expect(fs.existsSync(thumbnailAbsolutePath(keys!.previewKey))).toBe(true);
  });

  it("readAssetMetadata reports BMP dimensions via the ffprobe fallback", async () => {
    const bmp = path.join(root, "photo.bmp");
    writeBmp(bmp, 16, 12);
    const meta = await readAssetMetadata("photo", bmp);
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(12);
  });
});

describe("undecodable photos", () => {
  it("returns null for an empty file", async () => {
    const empty = path.join(root, "empty.jpg");
    fs.writeFileSync(empty, "");
    expect(await generateGalleryThumbnails("LIB", "ITEM", "photo", empty)).toBeNull();
  });

  it("returns null for a missing file without decoding or spawning anything", async () => {
    const missing = path.join(root, "nope.jpg");
    const started = Date.now();
    expect(await generateGalleryThumbnails("LIB", "ITEM", "photo", missing)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000); // fails fast: no libvips, no spawn
  });

  // Same answer for a video, which used to reach ffmpeg twice before giving it.
  // The spawns are cheap; what they are not is free of libvips and ffmpeg error
  // paths, which is what the guard in generateGalleryThumbnails is about.
  it("returns null for a missing video", async () => {
    expect(await generateGalleryThumbnails("LIB", "ITEM", "video", path.join(root, "nope.mp4"))).toBeNull();
  });
});

// The rule that keeps a scan alive: two sharp pipelines over the same unreadable
// source, at the same time, kill the process outright on Windows (0xC0000409, no
// exception, no stderr). One at a time is safe, and costs nothing — see
// renderInTurn. This pins the property, since the shape it replaced (Promise.all)
// is the one anybody would reach for.
describe("renderInTurn", () => {
  it("never lets two renders overlap, and keeps their order", async () => {
    const order: number[] = [];
    let running = 0;
    let peak = 0;
    const render = (n: number) => () => new Promise<void>((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => { order.push(n); running -= 1; resolve(); }, 5);
    });

    await renderInTurn([render(1), render(2), render(3)]);

    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });

  it("holds the line between callers too, not just within one call", async () => {
    let running = 0;
    let peak = 0;
    const render = () => new Promise<void>((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => { running -= 1; resolve(); }, 5);
    });

    // Two callers at once — the audiobook scanner works through four books in
    // parallel, and each of them renders a cover.
    await Promise.all([renderInTurn([render, render]), renderInTurn([render, render])]);

    expect(peak).toBe(1);
  });

  it("keeps going for the next caller after a render fails", async () => {
    await expect(renderInTurn([() => Promise.reject(new Error("unreadable"))])).rejects.toThrow("unreadable");
    let ran = false;
    await renderInTurn([() => { ran = true; return Promise.resolve(); }]);
    expect(ran).toBe(true);
  });

  it("stops at the first failure rather than starting the next", async () => {
    const started: string[] = [];
    const boom = () => { started.push("boom"); return Promise.reject(new Error("unreadable")); };
    const after = () => { started.push("after"); return Promise.resolve(); };

    await expect(renderInTurn([boom, after])).rejects.toThrow("unreadable");
    expect(started).toEqual(["boom"]);
  });
});

// libvips keeps what it reads, and on Windows a cached file stays open: a preview
// the app had read by path could not be written again, so a scan would quietly
// keep a stale thumbnail (generateGalleryThumbnails swallows the EBUSY). The
// shared image layer turns that cache off; this is the invariant it buys.
describe("a file sharp has read stays writable", () => {
  it("lets a preview be regenerated after it has been decoded", async () => {
    const photo = path.join(root, "sample.jpg");
    await sharp({ create: { width: 120, height: 90, channels: 3, background: "#4488cc" } })
      .jpeg().toFile(photo);

    // What computeDhash and the Inbox copy check do: read it by PATH.
    await sharp(photo).grayscale().resize(16, 16, { fit: "fill" }).raw().toBuffer();

    // What the next scan does: write over it. This is the step that used to fail.
    await expect(
      sharp({ create: { width: 60, height: 45, channels: 3, background: "#cc4444" } }).jpeg().toFile(photo)
    ).resolves.toBeDefined();
    expect((await sharp(photo).metadata()).width).toBe(60);

    // And it can be removed, which is what the thumbnail sweeps need.
    expect(() => fs.unlinkSync(photo)).not.toThrow();
  });
});
