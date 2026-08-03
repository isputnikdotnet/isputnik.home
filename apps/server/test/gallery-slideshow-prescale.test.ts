import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { prescaleSegments, type Segment } from "../src/modules/library/gallery/slideshow-render.js";

// Why this pass exists: every photo in a slideshow is its own ffmpeg input, and each
// input holds decoded frames at the SOURCE's resolution for the whole render. The
// movie is 1920x1080 whatever goes in, so 63 camera photos cost ~17 GB to produce a
// 1080p film. Measured on 63 twelve-megapixel photos: 3910 MB and 313s before this,
// 1659 MB and 58s after — and the "after" no longer depends on how big the originals
// are, which is the whole point.

let dir = "";

async function photo(name: string, width: number, height: number): Promise<string> {
  const file = path.join(dir, name);
  await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .jpeg().toFile(file);
  return file;
}

describe("scaling photos to the movie's size first", () => {
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "prescale-")); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const dest = (index: number) => path.join(dir, `scaled-${index}.jpg`);

  it("hands ffmpeg a 1080p copy instead of the original", async () => {
    const original = await photo("big.jpg", 4032, 3024);
    const segments: Segment[] = [{ file: original, dwell: 5, isVideo: false }];

    const { segments: out, written } = await prescaleSegments(segments, [0], dest);
    expect(out[0].file).not.toBe(original);
    expect(written).toEqual([out[0].file]);

    // Fitted INSIDE the 1920x1080 frame, aspect kept: a 4:3 photo is bounded by the
    // frame's height, and ffmpeg's pad puts the black bars either side as before.
    const meta = await sharp(out[0].file).metadata();
    expect(meta.width).toBe(1440);
    expect(meta.height).toBe(1080);
    // Dwell and kind ride along untouched — only the file changes.
    expect(out[0]).toMatchObject({ dwell: 5, isVideo: false });
  });

  // A video decodes frame by frame, so its cost doesn't grow with the slideshow's
  // length the way a still's does — and re-encoding one here would be pure loss.
  it("leaves video clips alone", async () => {
    const clip: Segment = { file: path.join(dir, "clip.mp4"), dwell: 8, isVideo: true };
    const { segments: out, written } = await prescaleSegments([clip], [0], dest);
    expect(out).toEqual([clip]);
    expect(written).toEqual([]);
  });

  it("doesn't blow a small photo up to fill the frame", async () => {
    const small = await photo("small.jpg", 800, 600);
    const { segments: out } = await prescaleSegments([{ file: small, dwell: 4, isVideo: false }], [0], dest);
    const meta = await sharp(out[0].file).metadata();
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });

  // The gallery shows a rotated photo upright; the movie never did, because ffmpeg
  // reads the pixels and ignores what the gallery knows about them.
  it("applies the user's rotation, as the gallery does", async () => {
    const landscape = await photo("portrait.jpg", 1200, 900);
    const { segments: out } = await prescaleSegments([{ file: landscape, dwell: 4, isVideo: false }], [90], dest);
    // Turned on its side (900x1200), then fitted to the frame's height.
    const meta = await sharp(out[0].file).metadata();
    expect(meta.height).toBe(1080);
    expect(meta.width).toBe(810);
  });

  // One heavy input is survivable; a failed render is not.
  it("falls back to the original when a photo can't be scaled", async () => {
    const broken = path.join(dir, "not-an-image.jpg");
    fs.writeFileSync(broken, "this is not a photo");
    const { segments: out, written } = await prescaleSegments([{ file: broken, dwell: 4, isVideo: false }], [0], dest);
    expect(out[0].file).toBe(broken);
    expect(written).toEqual([]);
  });

  it("stops early when the render is cancelled, and still reports what it wrote", async () => {
    const files = await Promise.all([photo("a.jpg", 2000, 1500), photo("b.jpg", 2000, 1500), photo("c.jpg", 2000, 1500)]);
    const segments: Segment[] = files.map((file) => ({ file, dwell: 4, isVideo: false }));
    let scaled = 0;
    const { segments: out, written } = await prescaleSegments(
      segments, [0, 0, 0], (i) => path.join(dir, `cancel-${i}.jpg`), () => { scaled += 1; }, () => scaled >= 1
    );
    expect(written).toHaveLength(1);
    // Every segment still comes back, so nothing is silently dropped from the movie.
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual(segments[1]);
  });
});
