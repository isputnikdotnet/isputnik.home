import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { thumbnailPathSettingKey, thumbnailAbsolutePath } from "../src/modules/library/shared/thumbnail.js";
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

  it("returns null for a missing file without invoking ffmpeg", async () => {
    const missing = path.join(root, "nope.jpg");
    const started = Date.now();
    expect(await generateGalleryThumbnails("LIB", "ITEM", "photo", missing)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000); // fails fast, no spawn
  });
});
