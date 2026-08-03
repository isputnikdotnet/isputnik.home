// The opening title card of a rendered slideshow, drawn here and handed to ffmpeg
// as an ordinary picture.
//
// It used to be ffmpeg's drawtext filter. That filter is OPTIONAL, and the Linux
// build ffmpeg-static installs doesn't have it — so every movie export inside the
// Docker image failed at "Filter not found" while development on Windows, whose
// build does have it, never saw a problem. Rather than ship a second ffmpeg to get
// one filter back, the card is drawn before ffmpeg runs: the text becomes glyph
// OUTLINES from the bundled DejaVu Sans (opentype.js), those become an SVG, and
// sharp — already here for thumbnails — rasterises it to a PNG.
//
// Nothing about that depends on the ffmpeg build, on system fonts, or on fontconfig
// finding anything: by the time the picture exists it is only pixels, and every
// platform draws the same card.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import opentype, { type Font, type Glyph } from "opentype.js";

export const CARD_WIDTH = 1920;
export const CARD_HEIGHT = 1080;

const TITLE_SIZE = 88;
const SUBTITLE_SIZE = 40;
const SUBTITLE_OPACITY = 0.72;
// A long name used to run off both edges of the frame, because drawtext draws
// wherever you tell it. Drawing the card ourselves means it can be made to fit.
const MAX_LINE_WIDTH = CARD_WIDTH * 0.86;
const MIN_TITLE_SIZE = 34;

// The bundled title-card font, resolved relative to this module so it works from
// src/ under tsx (dev) and dist/ in production (copy-assets.mjs ships src/assets).
// DejaVu Sans covers Latin and Cyrillic, so a Russian slideshow name renders.
export function bundledFontPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fontPath = path.resolve(here, "../../../assets/fonts/DejaVuSans.ttf");
  return fs.existsSync(fontPath) ? fontPath : null;
}

let cachedFont: { path: string; font: Font } | null = null;

// Parsing the TTF costs milliseconds and the file can't change under a running
// server, so it is read once.
export function loadTitleFont(fontPath: string): Font | null {
  if (cachedFont?.path === fontPath) return cachedFont.font;
  try {
    const bytes = fs.readFileSync(fontPath);
    const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    cachedFont = { path: fontPath, font };
    return font;
  } catch {
    return null;
  }
}

interface Placed { glyph: Glyph; x: number }

// Glyph-by-glyph layout with kerning, deliberately NOT opentype's own text shaping:
// its shaper throws outright on DejaVu Sans ("substitutionType : 62 lookupType: 6 …
// is not yet supported") the moment it meets the font's ccmp table. A title card
// needs no ligature substitution, so laying out characters directly avoids an entire
// class of font-dependent failure — and gets Cyrillic, accents and dashes right.
function layout(font: Font, text: string, size: number): { width: number; placed: Placed[] } {
  const scale = size / font.unitsPerEm;
  const placed: Placed[] = [];
  let x = 0;
  let previous: Glyph | null = null;
  for (const character of text) {
    const glyph = font.charToGlyph(character);
    if (previous) x += font.getKerningValue(previous, glyph) * scale;
    placed.push({ glyph, x });
    x += glyph.advanceWidth * scale;
    previous = glyph;
  }
  return { width: x, placed };
}

// Shrink a line until it fits the frame rather than letting it run off the edges.
function fittedSize(font: Font, text: string, size: number): number {
  const { width } = layout(font, text, size);
  if (width <= MAX_LINE_WIDTH || width <= 0) return size;
  return Math.max(MIN_TITLE_SIZE, Math.floor(size * (MAX_LINE_WIDTH / width)));
}

// Where a line's baseline sits. These are the positions drawtext produced, kept
// deliberately: the card should look the same as the one people already have at the
// front of their movies. drawtext placed the top of the text box, so each is that
// position plus the font's ascender.
function baselineFor(font: Font, size: number, line: "title" | "subtitle", hasSubtitle: boolean): number {
  const scale = size / font.unitsPerEm;
  const ascender = font.ascender * scale;
  if (line === "subtitle") return CARD_HEIGHT / 2 + 48 + ascender;
  const textHeight = (font.ascender - font.descender) * scale;
  const top = (CARD_HEIGHT - textHeight) / 2 - (hasSubtitle ? 36 : 0);
  return top + ascender;
}

// The card as an SVG whose text is paths, not <text>: nothing downstream has to find
// a font, so the rasteriser cannot substitute or silently drop one. Exported because
// it is pure — the PNG around it is not.
export function titleCardSvg(font: Font, title: string, subtitle: string | null): string {
  const shapes: string[] = [];
  const draw = (text: string, requested: number, kind: "title" | "subtitle", opacity: number) => {
    if (!text.trim()) return;
    const size = fittedSize(font, text, requested);
    const { width, placed } = layout(font, text, size);
    const left = (CARD_WIDTH - width) / 2;
    const baseline = baselineFor(font, size, kind, subtitle !== null);
    // toPathData rounds to 2 decimals — invisible at this size, and it keeps the
    // SVG small enough to hand to sharp as a single buffer.
    const data = placed
      .map((item) => item.glyph.getPath(left + item.x, baseline, size).toPathData(2))
      .filter(Boolean)
      .join(" ");
    if (!data) return;
    shapes.push(`<path d="${data}" fill="#ffffff"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""}/>`);
  };

  draw(title, TITLE_SIZE, "title", 1);
  if (subtitle) draw(subtitle, SUBTITLE_SIZE, "subtitle", SUBTITLE_OPACITY);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#000000"/>`,
    ...shapes,
    "</svg>"
  ].join("");
}

// Write the card to `outPath`. Returns false when it can't be drawn — a missing or
// unreadable font, a rasteriser error — and the caller then renders the movie
// without a card, which is a far smaller loss than no movie.
export async function renderTitleCardPng(
  title: string,
  subtitle: string | null,
  outPath: string
): Promise<boolean> {
  const fontPath = bundledFontPath();
  if (!fontPath) {
    console.warn("slideshow render: bundled title-card font missing — rendering without a title card.");
    return false;
  }
  const font = loadTitleFont(fontPath);
  if (!font) {
    console.warn(`slideshow render: title-card font at ${fontPath} could not be read — rendering without a title card.`);
    return false;
  }
  try {
    await sharp(Buffer.from(titleCardSvg(font, title, subtitle))).png().toFile(outPath);
    return true;
  } catch (err) {
    console.warn(
      `slideshow render: title card could not be drawn (${err instanceof Error ? err.message : "unknown error"}) — rendering without one.`
    );
    return false;
  }
}
