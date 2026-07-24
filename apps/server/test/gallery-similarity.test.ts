// Perceptual-hash near-duplicate detection: the pure bit math (similarity.ts) and the
// sharp-backed dHash itself (media.ts computeDhash).
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { computeDhash } from "../src/modules/library/gallery/media.js";
import { hammingDistanceHex, pickVisuallyDistinct, NEAR_DUPLICATE_DISTANCE } from "../src/modules/library/gallery/similarity.js";

// Deterministic grayscale test image: per-pixel brightness from (x, y).
async function testImage(width: number, height: number, fn: (x: number, y: number) => number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw[y * width + x] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
  }
  return sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

describe("hammingDistanceHex", () => {
  it("counts differing bits", () => {
    expect(hammingDistanceHex("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistanceHex("0000000000000000", "000000000000000f")).toBe(4);
    expect(hammingDistanceHex("ffffffffffffffff", "0000000000000000")).toBe(64);
  });

  it("returns null for unparseable hashes", () => {
    expect(hammingDistanceHex("not-hex", "0000000000000000")).toBeNull();
    expect(hammingDistanceHex("", "0000000000000000")).toBeNull();
  });
});

describe("pickVisuallyDistinct", () => {
  it("drops near-duplicates of an already-kept photo, preserving order", () => {
    const items = [
      { id: "a", phash: "0000000000000000" },
      { id: "a2", phash: "0000000000000003" }, // 2 bits from a → duplicate
      { id: "b", phash: "ffffffffffffffff" }, // far from everything
      { id: "a3", phash: "0000000000000001" } // 1 bit from a → duplicate
    ];
    expect(pickVisuallyDistinct(items).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("always keeps items it cannot judge (null or invalid hash)", () => {
    const items = [
      { id: "a", phash: "0000000000000000" },
      { id: "video", phash: null },
      { id: "junk", phash: "zz" },
      { id: "dup", phash: "0000000000000000" }
    ];
    expect(pickVisuallyDistinct(items).map((i) => i.id)).toEqual(["a", "video", "junk"]);
  });
});

describe("computeDhash", () => {
  it("hashes the same scene at different sizes to within the duplicate window", async () => {
    const gradient = (w: number) => (x: number) => (x * 255) / (w - 1);
    const small = await computeDhash(await testImage(64, 64, gradient(64)));
    const large = await computeDhash(await testImage(200, 150, gradient(200)));
    expect(small).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistanceHex(small!, large!)!).toBeLessThanOrEqual(NEAR_DUPLICATE_DISTANCE);
  });

  it("hashes a different scene well outside the duplicate window", async () => {
    const ltr = await computeDhash(await testImage(64, 64, (x) => (x * 255) / 63));
    const rtl = await computeDhash(await testImage(64, 64, (x) => 255 - (x * 255) / 63));
    expect(hammingDistanceHex(ltr!, rtl!)!).toBeGreaterThan(NEAR_DUPLICATE_DISTANCE);
  });

  it("returns null for undecodable input", async () => {
    expect(await computeDhash(Buffer.from("not an image"))).toBeNull();
  });
});
