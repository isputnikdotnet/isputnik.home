// A guest link hands its recipient the file itself, and for a photo the camera
// original carries EXIF — including the GPS of wherever it was taken, usually
// the family home. stripImageMetadata is what the guest download/file/zip routes
// now run every photo through. These prove an input carrying GPS EXIF comes back
// with no EXIF at all, while still being a valid, correctly sized image.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { stripImageMetadata } from "../src/modules/library/shared/shares.js";

let dir: string;

async function writeImageWithGps(name: string, format: "jpeg" | "png"): Promise<string> {
  const base = sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } } });
  // Attach real EXIF including a GPS block — the exact thing that must not survive.
  const withExif = base.withExif({
    IFD0: { Copyright: "Test" },
    GPS: { GPSLatitudeRef: "N", GPSLatitude: "53/1 55/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "27/1 34/1 0/1" }
  });
  const buffer = await (format === "jpeg" ? withExif.jpeg() : withExif.png()).toBuffer();
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-exif-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("stripImageMetadata", () => {
  it("removes the EXIF/GPS block from a JPEG while keeping a valid image", async () => {
    const src = await writeImageWithGps("home.jpg", "jpeg");
    // Sanity: the fixture really does carry EXIF before stripping.
    expect((await sharp(src).metadata()).exif).toBeDefined();

    const result = await stripImageMetadata(src);
    expect(result).not.toBeNull();
    const meta = await sharp(result!.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(result!.contentType).toBe("image/jpeg");
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(24);
  });

  it("keeps a PNG a PNG and drops its metadata", async () => {
    const src = await writeImageWithGps("home.png", "png");
    const result = await stripImageMetadata(src);
    expect(result).not.toBeNull();
    const meta = await sharp(result!.buffer).metadata();
    expect(meta.format).toBe("png");
    expect(result!.contentType).toBe("image/png");
    expect(meta.exif).toBeUndefined();
  });

  it("returns null (refuse) for a file that can't be decoded — never the original", async () => {
    // The security-critical contract: an undecodable photo must not fall back to
    // the original bytes (which would carry EXIF/GPS). sharp fails, the ffmpeg
    // rescue fails, so the helper returns null and the route refuses the download.
    const junk = path.join(dir, "not-an-image.jpg");
    fs.writeFileSync(junk, Buffer.from("this is definitely not an image"));
    expect(await stripImageMetadata(junk)).toBeNull();
  });
});
