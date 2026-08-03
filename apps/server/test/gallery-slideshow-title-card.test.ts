import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  bundledFontPath,
  loadTitleFont,
  titleCardSvg,
  renderTitleCardPng,
  CARD_WIDTH,
  CARD_HEIGHT
} from "../src/modules/library/gallery/slideshow-title-card.js";

// The card is drawn here rather than by ffmpeg's drawtext, which the Linux build
// ffmpeg-static installs does not have — with drawtext the whole movie failed to
// render on a Linux host. These run against the REAL bundled font: the point of the
// change is that the card needs nothing from the platform, so stubbing the font
// would test the wrong thing.

// Every coordinate in a path's data, as (x, y) pairs: toPathData emits M/L/Q/C/Z
// with two numbers per point, so the numbers alternate.
function pointsOf(svg: string): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (const match of svg.matchAll(/ d="([^"]+)"/g)) {
    const numbers = (match[1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: numbers[i], y: numbers[i + 1] });
  }
  return points;
}

describe("slideshow title card", () => {
  const fontPath = bundledFontPath();
  const font = fontPath ? loadTitleFont(fontPath) : null;

  it("ships a font it can actually parse", () => {
    // Not an incidental assertion: a card that can't be drawn silently disappears
    // from every movie, and the font is the one thing that has to be in the image.
    expect(fontPath).toBeTruthy();
    expect(font).toBeTruthy();
    expect(font!.unitsPerEm).toBeGreaterThan(0);
  });

  it("draws the title and subtitle as outlines on a black frame", () => {
    const svg = titleCardSvg(font!, "Summer holiday", "42 photos");
    expect(svg).toContain(`width="${CARD_WIDTH}" height="${CARD_HEIGHT}"`);
    expect(svg).toContain(`<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#000000"/>`);
    // Two lines, and the subtitle dimmer than the title.
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('fill-opacity="0.72"');
    // No <text>: nothing downstream has to find a font, so nothing can substitute one.
    expect(svg).not.toContain("<text");
  });

  // Cyrillic is why DejaVu is bundled at all — a family library's slideshow names
  // are not all in English.
  it("renders Cyrillic, accents and dashes as real glyphs", () => {
    for (const title of ["Летний отпуск", "Ünïcödé — dash", "Åland 2019"]) {
      const points = pointsOf(titleCardSvg(font!, title, null));
      expect(points.length, title).toBeGreaterThan(50); // .notdef boxes would be far fewer
    }
  });

  it("keeps every line inside the frame, centred", () => {
    const svg = titleCardSvg(font!, "Summer holiday", "42 photos");
    const xs = pointsOf(svg).map((p) => p.x);
    const ys = pointsOf(svg).map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(CARD_WIDTH);
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(CARD_HEIGHT);
    // Centred: the margins either side match to within a pixel.
    expect(Math.min(...xs) - 0).toBeCloseTo(CARD_WIDTH - Math.max(...xs), -1);
  });

  // drawtext just drew off the edges; a card drawn here can be made to fit.
  it("shrinks a title too long for the frame instead of running off it", () => {
    const long = "A slideshow with an unreasonably long name that would once have run straight off both edges";
    const xs = pointsOf(titleCardSvg(font!, long, "7 photos")).map((p) => p.x);
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(CARD_WIDTH);
  });

  it("survives a title with nothing renderable in it", () => {
    // An empty title must not produce a broken SVG — the frame still draws.
    const svg = titleCardSvg(font!, "   ", null);
    expect(svg).toContain("<rect");
    expect(svg).not.toContain("<path");
  });

  describe("writing the picture", () => {
    let dir = "";
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "title-card-")); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("writes a 1920x1080 PNG ffmpeg can take as a still", async () => {
      const out = path.join(dir, "card.png");
      expect(await renderTitleCardPng("Летний отпуск", "128 photos", out)).toBe(true);
      const meta = await sharp(out).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(CARD_WIDTH);
      expect(meta.height).toBe(CARD_HEIGHT);
    });

    it("reports failure rather than throwing when it can't be written", async () => {
      // A directory that doesn't exist: the movie should still be rendered, without
      // a card, so this returns false instead of taking the render down with it.
      const out = path.join(dir, "no-such-dir", "card.png");
      expect(await renderTitleCardPng("Anything", null, out)).toBe(false);
    });
  });
});
