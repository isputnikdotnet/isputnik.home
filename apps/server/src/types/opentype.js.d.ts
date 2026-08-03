// opentype.js 2.x ships no type definitions. Only the corner the title card uses is
// declared: parse a font, then walk characters to glyphs and glyphs to outlines.
// Its higher-level text API (getPath/getAdvanceWidth over a whole string) is
// deliberately absent — that path runs the shaper, which throws on DejaVu Sans.
declare module "opentype.js" {
  export interface Path {
    toPathData(decimalPlaces?: number): string;
  }

  export interface Glyph {
    /** Advance in font units; multiply by size / unitsPerEm for pixels. */
    advanceWidth: number;
    getPath(x: number, y: number, fontSize: number): Path;
  }

  export interface Font {
    unitsPerEm: number;
    /** Font units above the baseline (positive) and below it (negative). */
    ascender: number;
    descender: number;
    charToGlyph(character: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
  }

  export function parse(buffer: ArrayBuffer, options?: Record<string, unknown>): Font;

  const opentype: { parse: typeof parse };
  export default opentype;
}
