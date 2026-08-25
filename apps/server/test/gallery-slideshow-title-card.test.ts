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
  collageGrid,
  spreadPhotos,
  letteringScale,
  splitCardLines,
  COLLAGE_MAX,
  CARD_FONTS,
  CARD_SIZES,
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

  // ── Backgrounds ───────────────────────────────────────────────────────────
  //
  // A card can sit on one of the slideshow's own photos (sharp or blurred) or on a
  // collage of several. These read the finished pixels, because everything that can
  // go wrong here is invisible in the SVG: a photo that never composited, a collage
  // laid out on top of itself, a scrim so heavy the picture is gone.

  describe("over a picture", () => {
    let dir = "";
    const solid = async (name: string, colour: { r: number; g: number; b: number }) => {
      const file = path.join(dir, name);
      await sharp({ create: { width: 800, height: 600, channels: 3, background: colour } }).jpeg().toFile(file);
      return file;
    };
    // The colour at a fraction across the frame, as the finished PNG has it.
    const pixelAt = async (file: string, xFraction: number, yFraction: number) => {
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      const x = Math.floor(info.width * xFraction);
      const y = Math.floor(info.height * yFraction);
      const offset = (y * info.width + x) * info.channels;
      return { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
    };

    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "title-bg-")); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("puts a photo behind the words, darkened but still a photo", async () => {
      const photo = await solid("red.jpg", { r: 255, g: 0, b: 0 });
      const out = path.join(dir, "photo-card.png");
      expect(await renderTitleCardPng("Summer", "42 photos", out, { kind: "photo", photo: { file: photo } })).toBe(true);

      // A corner is background, never text: red survives the scrim, and it is darker
      // than the photo went in — that darkening is what keeps white text readable.
      const corner = await pixelAt(out, 0.04, 0.06);
      expect(corner.r).toBeGreaterThan(80);
      expect(corner.r).toBeLessThan(220);
      expect(corner.g).toBeLessThan(40);
    });

    it("draws the words with a dark outline over a picture, and without one on black", async () => {
      const overPhoto = titleCardSvg(font!, "Summer", "42 photos", "scrim");
      // Two lines, each an outline pass under a fill pass.
      expect(overPhoto.match(/<path /g)).toHaveLength(4);
      expect(overPhoto).toContain('stroke="#000000"');
      expect(overPhoto).toContain('fill-opacity="0.45"'); // the scrim itself
      expect(titleCardSvg(font!, "Summer", "42 photos")).not.toContain("stroke");
    });

    it("blurs the photo when asked, leaving the colour", async () => {
      const photo = await solid("blue.jpg", { r: 0, g: 0, b: 255 });
      const out = path.join(dir, "blur-card.png");
      expect(await renderTitleCardPng("Summer", null, out, { kind: "blur", photo: { file: photo } })).toBe(true);
      const corner = await pixelAt(out, 0.5, 0.05);
      expect(corner.b).toBeGreaterThan(80);
      expect(corner.r).toBeLessThan(40);
    });

    it("tiles a collage so every photo gets its own cell", async () => {
      const photos = [
        { file: await solid("c1.jpg", { r: 255, g: 0, b: 0 }) },
        { file: await solid("c2.jpg", { r: 0, g: 255, b: 0 }) },
        { file: await solid("c3.jpg", { r: 0, g: 0, b: 255 }) },
        { file: await solid("c4.jpg", { r: 255, g: 255, b: 0 }) }
      ];
      const out = path.join(dir, "collage-card.png");
      expect(await renderTitleCardPng("Summer", null, out, { kind: "collage", photos })).toBe(true);

      // Four photos lay out 2x2, so each quadrant carries a different one — read near
      // the outer corners, well clear of the centred text.
      const topLeft = await pixelAt(out, 0.08, 0.1);
      const topRight = await pixelAt(out, 0.92, 0.1);
      const bottomLeft = await pixelAt(out, 0.08, 0.9);
      const bottomRight = await pixelAt(out, 0.92, 0.9);
      expect(topLeft.r).toBeGreaterThan(topLeft.g);
      expect(topRight.g).toBeGreaterThan(topRight.r);
      expect(bottomLeft.b).toBeGreaterThan(bottomLeft.r);
      expect(bottomRight.r).toBeGreaterThan(50);
      expect(bottomRight.g).toBeGreaterThan(50);
      expect(bottomRight.b).toBeLessThan(bottomRight.r);
    });

    it("falls back to the black card when the picture can't be read", async () => {
      // An unreadable background costs the background, never the card: the movie
      // still opens on its title.
      const out = path.join(dir, "missing-bg.png");
      expect(await renderTitleCardPng("Summer", null, out, {
        kind: "photo", photo: { file: path.join(dir, "not-here.jpg") }
      })).toBe(true);
      expect(await pixelAt(out, 0.04, 0.06)).toEqual({ r: 0, g: 0, b: 0 });
    });
  });

  // ── Multi-line text ───────────────────────────────────────────────────────
  //
  // Up to six lines below the title (credits, dedications). One line keeps the
  // original drawtext geometry bit-for-bit; two or more switch to a centred block
  // where every line shares one fitted size.

  describe("multi-line text", () => {
    it("draws each credit line as its own path, dimmed like a subtitle", () => {
      const svg = titleCardSvg(font!, "The End", "Filmed by Dad\nMusic: our song\nSummer 2026");
      expect(svg.match(/<path /g)).toHaveLength(4); // title + 3 lines
      expect(svg.match(/fill-opacity="0.72"/g)).toHaveLength(3);
    });

    it("splits, trims, drops empties and caps at six lines", () => {
      expect(splitCardLines(null)).toEqual([]);
      expect(splitCardLines(" a \r\n\n  \nb ")).toEqual(["a", "b"]);
      expect(splitCardLines("1\n2\n3\n4\n5\n6\n7\n8")).toHaveLength(6);
    });

    it("keeps every line inside the frame and stacked downward in order", () => {
      const svg = titleCardSvg(font!, "Наши каникулы", "Filmed by Dad\nMusic: our song\nFor grandma — with love");
      const xs = pointsOf(svg).map((p) => p.x);
      const ys = pointsOf(svg).map((p) => p.y);
      expect(Math.min(...xs)).toBeGreaterThan(0);
      expect(Math.max(...xs)).toBeLessThan(CARD_WIDTH);
      expect(Math.min(...ys)).toBeGreaterThan(0);
      expect(Math.max(...ys)).toBeLessThan(CARD_HEIGHT);
    });

    it("gives every line one shared size — a long credit shrinks them together", () => {
      const long = "A credit line so unreasonably long that it must shrink well below the subtitle size to fit the frame";
      const widthOf = (svg: string, pathIndex: number) => {
        const matches = [...svg.matchAll(/ d="([^"]+)"/g)];
        const numbers = (matches[pathIndex][1].match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
        const xs = numbers.filter((_, i) => i % 2 === 0);
        return Math.max(...xs) - Math.min(...xs);
      };
      // The same short line is drawn narrower when a long sibling drags the shared
      // size down than it is beside another short line.
      const alone = titleCardSvg(font!, "T", "Short line\nAnother short");
      const dragged = titleCardSvg(font!, "T", `Short line\n${long}`);
      expect(widthOf(dragged, 1)).toBeLessThan(widthOf(alone, 1));
    });

    it("still draws the block when there is no title", () => {
      const svg = titleCardSvg(font!, "  ", "Filmed by Dad\nSummer 2026");
      expect(svg.match(/<path /g)).toHaveLength(2);
      const ys = pointsOf(svg).map((p) => p.y);
      expect(Math.min(...ys)).toBeGreaterThan(0);
      expect(Math.max(...ys)).toBeLessThan(CARD_HEIGHT);
    });
  });

  // ── Lettering ─────────────────────────────────────────────────────────────
  //
  // Users pick a named style and a size; each style maps to a bundled face. These
  // run against the real files, because the faces are the thing being shipped.

  describe("lettering", () => {
    it("ships a parseable file for every style", () => {
      for (const style of CARD_FONTS) {
        const p = bundledFontPath(style);
        expect(p, style).toBeTruthy();
        const f = loadTitleFont(p!);
        expect(f, style).toBeTruthy();
        expect(f!.unitsPerEm, style).toBeGreaterThan(0);
      }
    });

    // Every face must draw every kind of character the card meets as a REAL
    // outline. This is the check that caught PT Serif: its '6' parsed to a broken
    // fragment through opentype.js (a handful of points where a real glyph has
    // dozens), which is why the serif style is DejaVu Serif. Per-character, so a
    // single bad glyph can't hide behind a long healthy title.
    it("draws Cyrillic, Latin and digits as full glyphs in every face", () => {
      for (const style of CARD_FONTS) {
        const f = loadTitleFont(bundledFontPath(style)!)!;
        for (const char of ["6", "2", "я", "ж", "д", "S", "y", "é"]) {
          const points = pointsOf(titleCardSvg(f, char, null));
          expect(points.length, `${style} '${char}'`).toBeGreaterThan(15);
        }
      }
    });

    it("scales the text with the size choice, medium being exactly today's card", () => {
      expect(letteringScale()).toBe(1);
      expect(letteringScale({ font: "classic", size: "medium" })).toBe(1);
      const spread = (scale: number) => {
        const xs = pointsOf(titleCardSvg(font!, "Summer", "42 photos", "black", scale)).map((p) => p.x);
        return Math.max(...xs) - Math.min(...xs);
      };
      expect(spread(letteringScale({ size: "large" }))).toBeGreaterThan(spread(1));
      expect(spread(letteringScale({ size: "small" }))).toBeLessThan(spread(1));
      // scale 1 IS the pre-lettering card: the default draws identical output.
      expect(titleCardSvg(font!, "Summer", "42 photos", "black", 1))
        .toBe(titleCardSvg(font!, "Summer", "42 photos"));
    });

    it("keeps a long title inside the frame at every size", () => {
      const long = "A slideshow with an unreasonably long name that would once have run straight off both edges";
      for (const size of CARD_SIZES) {
        const xs = pointsOf(titleCardSvg(font!, long, "7 photos", "black", letteringScale({ size }))).map((p) => p.x);
        expect(Math.min(...xs), size).toBeGreaterThan(0);
        expect(Math.max(...xs), size).toBeLessThan(CARD_WIDTH);
      }
    });

    it("draws the card in the chosen face", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "title-font-"));
      try {
        const out = path.join(dir, "script.png");
        expect(await renderTitleCardPng("Лето на даче", "48 photos", out, { kind: "black" }, { font: "script" })).toBe(true);
        const meta = await sharp(out).metadata();
        expect(meta.width).toBe(CARD_WIDTH);
        // Different faces produce different pixels; identical output would mean the
        // lettering never reached the drawer.
        const classic = path.join(dir, "classic.png");
        expect(await renderTitleCardPng("Лето на даче", "48 photos", classic, { kind: "black" })).toBe(true);
        expect(fs.readFileSync(out).equals(fs.readFileSync(classic))).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("collage layout", () => {
    it("leans landscape, because the frame is", () => {
      for (const count of [2, 3, 4, 5, 6, 7, 9, 10, 12]) {
        const { cols, rows } = collageGrid(count);
        expect(cols, `${count}`).toBeGreaterThanOrEqual(rows);
        // Enough cells for every photo, so none is silently dropped.
        expect(cols * rows, `${count}`).toBeGreaterThanOrEqual(Math.min(count, COLLAGE_MAX));
      }
    });

    it("samples the whole slideshow rather than its first few slides", () => {
      const photos = Array.from({ length: 100 }, (_, i) => i);
      const picked = spreadPhotos(photos, 12);
      expect(picked).toHaveLength(12);
      expect(picked[0]).toBe(0);
      expect(picked[11]).toBeGreaterThan(80);
      // Fewer than asked for is everything, in order.
      expect(spreadPhotos([1, 2, 3], 12)).toEqual([1, 2, 3]);
    });
  });
});
