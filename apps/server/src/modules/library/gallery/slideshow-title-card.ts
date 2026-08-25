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
import sharp, { type OverlayOptions } from "sharp";
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

// ── Lettering: which face the card is set in, and how large ─────────────────
//
// Users pick a named STYLE, not a font file; each maps to a face bundled under
// src/assets/fonts. A face earns its place by passing two checks: full Cyrillic
// coverage, and looking right under the unshaped character-by-character layout
// below (a script face that needs contextual alternates renders as disconnected
// glyphs). 'classic' is the DejaVu Sans every movie used before styles existed.
export type CardFont = "classic" | "serif" | "bold" | "script" | "typewriter";
export type CardSize = "small" | "medium" | "large";

export const CARD_FONTS: readonly CardFont[] = ["classic", "serif", "bold", "script", "typewriter"];
export const CARD_SIZES: readonly CardSize[] = ["small", "medium", "large"];

const CARD_FONT_FILES: Record<CardFont, string> = {
  classic: "DejaVuSans.ttf",
  serif: "DejaVuSerif.ttf",
  bold: "DejaVuSans-Bold.ttf",
  script: "MarckScript-Regular.ttf",
  typewriter: "PTMono-Regular.ttf"
};

// Faces don't look the same size at the same point size: Marck Script's small
// x-height reads far smaller than DejaVu at 88px, PT Mono's fixed-width caps a
// touch larger. Each face carries a nudge so every style LOOKS the same size.
const CARD_FONT_OPTICAL: Record<CardFont, number> = {
  classic: 1,
  serif: 1,
  bold: 1,
  script: 1.2,
  typewriter: 0.92
};

// 'medium' is exactly the card every earlier movie rendered. The multiplier
// applies to the title and the subtitle together, and shrink-to-fit still wins:
// a long title never runs off the frame at any size.
const CARD_SIZE_FACTOR: Record<CardSize, number> = { small: 0.72, medium: 1, large: 1.35 };

export interface CardLettering { font?: CardFont; size?: CardSize }

/** The combined type-scale multiplier for a lettering choice (size × optical). */
export function letteringScale(lettering: CardLettering = {}): number {
  return CARD_SIZE_FACTOR[lettering.size ?? "medium"] * CARD_FONT_OPTICAL[lettering.font ?? "classic"];
}

// A bundled face, resolved relative to this module so it works from src/ under
// tsx (dev) and dist/ in production (copy-assets.mjs ships src/assets). Every
// bundled face covers Latin and Cyrillic, so a Russian slideshow name renders.
// A style whose file is missing falls back to classic — a wrong face is a far
// smaller loss than no card.
export function bundledFontPath(style: CardFont = "classic"): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fontPath = path.resolve(here, `../../../assets/fonts/${CARD_FONT_FILES[style]}`);
  if (fs.existsSync(fontPath)) return fontPath;
  if (style !== "classic") {
    console.warn(`slideshow render: bundled font for style '${style}' missing — falling back to classic.`);
    return bundledFontPath("classic");
  }
  return null;
}

const fontCache = new Map<string, Font>();

// Parsing a TTF costs milliseconds and the files can't change under a running
// server, so each face is read once.
export function loadTitleFont(fontPath: string): Font | null {
  const cached = fontCache.get(fontPath);
  if (cached) return cached;
  try {
    const bytes = fs.readFileSync(fontPath);
    const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    fontCache.set(fontPath, font);
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

// What the words sit on.
//   black  — the original card: white text on an opaque black frame.
//   scrim  — the text layer alone, over a translucent black wash, to be composited
//            onto a picture. The wash is what makes white text readable over a photo
//            nobody chose for its contrast.
//   none   — the text layer with nothing behind it (unused today; kept because the
//            two cases above are one parameter apart and hiding that costs nothing).
export type TitleBackdrop = "black" | "scrim" | "none";

// How far the picture behind the words is darkened. Measured against real family
// photos: less and a bright sky swallows the title, more and the photo stops reading
// as a photo.
const SCRIM_OPACITY = 0.45;
// Over a picture the glyphs also carry a dark outline, so a title survives landing on
// a light patch of an already-darkened photo. Never drawn on the black card, where it
// would only soften edges that are already perfect.
const HALO_OPACITY = 0.5;
const HALO_WIDTH = 6;

// The most lines a card's text block carries below the title — enough for
// "Filmed by · Music · For grandma's 80th", not enough to need a scrolling roll
// (which the pipeline deliberately doesn't do; see the proposal). The route caps
// what is SAVED; this caps what is DRAWN, so an over-long value from anywhere
// degrades to its first six lines rather than to an unreadable card.
export const CARD_MAX_LINES = 6;

/** A subtitle's renderable lines: split on newlines, trimmed, empties dropped, capped. */
export function splitCardLines(subtitle: string | null): string[] {
  if (!subtitle) return [];
  return subtitle
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, CARD_MAX_LINES);
}

// Space between the title's bottom and the first credit line, and the leading
// between credit lines, as fractions of the (scaled) sizes in play. Multi-line
// only — the single-line card keeps drawtext's original positions.
const BLOCK_GAP = 44;
const LINE_LEADING = 1.5;

// The card as an SVG whose text is paths, not <text>: nothing downstream has to find
// a font, so the rasteriser cannot substitute or silently drop one. Exported because
// it is pure — the PNG around it is not.
//
// One line under the title keeps the exact geometry drawtext produced (baselineFor),
// so every pre-credits card renders bit-for-bit as it always did. Two lines or more
// switch to a block layout: the whole block (title + lines) vertically centred, the
// lines sharing ONE fitted size so a long credit doesn't ripple the block through
// several sizes.
export function titleCardSvg(
  font: Font,
  title: string,
  subtitle: string | null,
  backdrop: TitleBackdrop = "black",
  // The lettering's type-scale multiplier (letteringScale). 1 = the classic
  // medium card. Applied to the requested sizes only — shrink-to-fit and its
  // floor are absolute, so a long title behaves the same at every size.
  scale = 1
): string {
  const overPicture = backdrop !== "black";
  const shapes: string[] = [];
  const emit = (text: string, size: number, baseline: number, kind: "title" | "subtitle", opacity: number) => {
    const { width, placed } = layout(font, text, size);
    const left = (CARD_WIDTH - width) / 2;
    // toPathData rounds to 2 decimals — invisible at this size, and it keeps the
    // SVG small enough to hand to sharp as a single buffer.
    const data = placed
      .map((item) => item.glyph.getPath(left + item.x, baseline, size).toPathData(2))
      .filter(Boolean)
      .join(" ");
    if (!data) return;
    if (overPicture) {
      const stroke = kind === "title" ? HALO_WIDTH : HALO_WIDTH * 0.6;
      shapes.push(
        `<path d="${data}" fill="none" stroke="#000000" stroke-opacity="${HALO_OPACITY}" ` +
        `stroke-width="${stroke}" stroke-linejoin="round"/>`
      );
    }
    shapes.push(`<path d="${data}" fill="#ffffff"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""}/>`);
  };

  const lines = splitCardLines(subtitle);
  if (lines.length <= 1) {
    // The original two-line card, positioned exactly as drawtext positioned it.
    const draw = (text: string, requested: number, kind: "title" | "subtitle", opacity: number) => {
      if (!text.trim()) return;
      const size = fittedSize(font, text, requested * scale);
      emit(text, size, baselineFor(font, size, kind, subtitle !== null), kind, opacity);
    };
    draw(title, TITLE_SIZE, "title", 1);
    if (lines.length === 1) draw(lines[0], SUBTITLE_SIZE, "subtitle", SUBTITLE_OPACITY);
  } else {
    const hasTitle = title.trim().length > 0;
    const titleSize = hasTitle ? fittedSize(font, title, TITLE_SIZE * scale) : 0;
    // One size for every line: the smallest any of them needs to fit the frame.
    const lineSize = Math.min(...lines.map((line) => fittedSize(font, line, SUBTITLE_SIZE * scale)));
    const em = (size: number) => size / font.unitsPerEm;
    const titleHeight = hasTitle ? (font.ascender - font.descender) * em(titleSize) : 0;
    const lineHeight = (font.ascender - font.descender) * em(lineSize);
    const lineAdvance = lineSize * LINE_LEADING;
    const gap = hasTitle ? BLOCK_GAP * scale : 0;
    const blockHeight = titleHeight + gap + (lines.length - 1) * lineAdvance + lineHeight;
    // Centred, but never pushed off the frame by a tall block: the top margin holds
    // at least a line's worth of air (the caps above keep this from ever clipping).
    const top = Math.max(lineHeight, (CARD_HEIGHT - blockHeight) / 2);
    if (hasTitle) emit(title, titleSize, top + font.ascender * em(titleSize), "title", 1);
    const firstLineTop = top + titleHeight + gap;
    lines.forEach((line, index) => {
      const baseline = firstLineTop + index * lineAdvance + font.ascender * em(lineSize);
      emit(line, lineSize, baseline, "subtitle", SUBTITLE_OPACITY);
    });
  }

  const frame =
    backdrop === "black" ? `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#000000"/>`
    : backdrop === "scrim" ? `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#000000" fill-opacity="${SCRIM_OPACITY}"/>`
    : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`,
    frame,
    ...shapes,
    "</svg>"
  ].join("");
}

// ── The picture behind the words ─────────────────────────────────────────────
//
// A slideshow's own photos are the only pictures the card can be sure of, so the
// background is always built from them: one slide (sharp or blurred), or a tiling of
// several. Everything here is best-effort — an unreadable file costs the background,
// and a background that can't be built costs nothing but the black frame.

/** A source photo for the card: the file, plus the user's own rotation (as thumbnails apply it). */
export interface TitlePhoto { file: string; rotation?: number }

export type TitleBackground =
  | { kind: "black" }
  | { kind: "photo"; photo: TitlePhoto }
  | { kind: "blur"; photo: TitlePhoto }
  | { kind: "collage"; photos: TitlePhoto[] };

// Blur radius for the 'blur' background. Enough that the photo reads as colour and
// shape rather than subject — the point is a backdrop, not a picture competing with
// the title.
const BLUR_SIGMA = 24;

// Gutter between collage tiles, so a wall of photos reads as separate pictures.
const COLLAGE_GAP = 8;

// The grid a collage of `count` photos is laid out on. Landscape-leaning because the
// frame is 16:9: more columns than rows, always.
export function collageGrid(count: number): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count === 3) return { cols: 3, rows: 1 };
  if (count === 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: 3 };
}

// Up to `limit` photos spread evenly across the slideshow, so a collage samples the
// whole thing rather than its first few slides. Pure, and exported for the tests.
export function spreadPhotos<T>(photos: T[], limit: number): T[] {
  if (photos.length <= limit) return [...photos];
  const step = photos.length / limit;
  return Array.from({ length: limit }, (_, i) => photos[Math.floor(i * step)]);
}

/** The most photos a collage tiles. Beyond a 4x3 grid each face is too small to know. */
export const COLLAGE_MAX = 12;

// One photo, cover-cropped to fill exactly width x height. EXIF orientation first,
// then the user's own rotation — the same order media.ts uses for thumbnails, so the
// card shows a photo the way the gallery does.
async function coverBuffer(photo: TitlePhoto, width: number, height: number, blur = false): Promise<Buffer> {
  const image = sharp(photo.file, { failOn: "none" }).rotate();
  const rotated = photo.rotation ? image.rotate(photo.rotation) : image;
  const fitted = rotated.resize(width, height, { fit: "cover", position: "attention" });
  return (blur ? fitted.blur(BLUR_SIGMA) : fitted).toFormat("png").toBuffer();
}

// The 1920x1080 picture the text is drawn over, or null for a plain black card (and
// whenever the pictures asked for can't be read).
export async function titleBackgroundBuffer(background: TitleBackground): Promise<Buffer | null> {
  try {
    if (background.kind === "black") return null;
    if (background.kind === "photo" || background.kind === "blur") {
      return await coverBuffer(background.photo, CARD_WIDTH, CARD_HEIGHT, background.kind === "blur");
    }
    const photos = spreadPhotos(background.photos, COLLAGE_MAX);
    if (photos.length === 0) return null;
    if (photos.length === 1) return await coverBuffer(photos[0], CARD_WIDTH, CARD_HEIGHT);

    const { cols, rows } = collageGrid(photos.length);
    const cellWidth = Math.floor(CARD_WIDTH / cols);
    const cellHeight = Math.floor(CARD_HEIGHT / rows);
    const tileWidth = cellWidth - COLLAGE_GAP;
    const tileHeight = cellHeight - COLLAGE_GAP;

    const tiles: OverlayOptions[] = [];
    for (let index = 0; index < cols * rows; index += 1) {
      // Fewer photos than cells (5 into a 3x2, say): cycle rather than leave a hole.
      const photo = photos[index % photos.length];
      try {
        tiles.push({
          input: await coverBuffer(photo, tileWidth, tileHeight),
          left: (index % cols) * cellWidth + Math.floor(COLLAGE_GAP / 2),
          top: Math.floor(index / cols) * cellHeight + Math.floor(COLLAGE_GAP / 2)
        });
      } catch { /* one unreadable photo leaves one black cell, not a failed card */ }
    }
    if (tiles.length === 0) return null;

    return await sharp({
      create: { width: CARD_WIDTH, height: CARD_HEIGHT, channels: 3, background: "#000000" }
    }).composite(tiles).png().toBuffer();
  } catch {
    return null; // any unreadable source: fall back to the black card
  }
}

// The finished card as a PNG, or null when it can't be drawn — a missing or
// unreadable font, a rasteriser error. A background that can't be BUILT is not such a
// failure: the card falls back to black and is still made. `width` renders the card
// smaller (the editor's preview asks for a fraction of the frame).
export async function titleCardPngBuffer(
  title: string,
  subtitle: string | null,
  background: TitleBackground = { kind: "black" },
  width = CARD_WIDTH,
  lettering: CardLettering = {}
): Promise<Buffer | null> {
  const fontPath = bundledFontPath(lettering.font ?? "classic");
  if (!fontPath) {
    console.warn("slideshow render: bundled title-card font missing — rendering without a title card.");
    return null;
  }
  const font = loadTitleFont(fontPath);
  if (!font) {
    console.warn(`slideshow render: title-card font at ${fontPath} could not be read — rendering without a title card.`);
    return null;
  }
  try {
    const picture = await titleBackgroundBuffer(background);
    const svg = Buffer.from(titleCardSvg(font, title, subtitle, picture ? "scrim" : "black", letteringScale(lettering)));
    const card = picture ? sharp(picture).composite([{ input: svg }]) : sharp(svg);
    const full = await card.png().toBuffer();
    // Scaled in a SECOND pass, deliberately: sharp resizes before it composites, so
    // asking the pipeline above to do both would shrink the picture out from under a
    // full-size text layer. Rasterising the real frame first also means a preview
    // differs from the movie only in pixels.
    if (width >= CARD_WIDTH) return full;
    return await sharp(full).resize(Math.round(width)).png().toBuffer();
  } catch (err) {
    console.warn(
      `slideshow render: title card could not be drawn (${err instanceof Error ? err.message : "unknown error"}) — rendering without one.`
    );
    return null;
  }
}

// Write the card to `outPath`. Returns false when it can't be drawn, and the caller
// then renders the movie without a card, which is a far smaller loss than no movie.
export async function renderTitleCardPng(
  title: string,
  subtitle: string | null,
  outPath: string,
  background: TitleBackground = { kind: "black" },
  lettering: CardLettering = {}
): Promise<boolean> {
  const png = await titleCardPngBuffer(title, subtitle, background, CARD_WIDTH, lettering);
  if (!png) return false;
  try {
    fs.writeFileSync(outPath, png);
    return true;
  } catch (err) {
    console.warn(
      `slideshow render: title card could not be written (${err instanceof Error ? err.message : "unknown error"}) — rendering without one.`
    );
    return false;
  }
}
