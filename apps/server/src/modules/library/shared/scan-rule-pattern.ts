// Declarative path-pattern engine for custom scan rules (docs/scan-layout-plan.md).
//
// A pattern is matched against a "book key" relative to the rule's anchor folder
// (POSIX-separated, extension already removed). It is `/`-separated segments;
// within a segment, text is a sequence of literals and {tokens}. A token is
// non-greedy and bounded by the literal that follows it (or the segment edge).
// Pure + validated — no regular expressions or code supplied by the user.
//
// A rule holds an ordered list of patterns ("layouts"); matchLayouts tries them in
// order and the first that fits wins. Inside one pattern, `<...>` marks an optional
// section: the pattern is expanded into the variant with the section and the variant
// without it, tried in that order. (Square brackets are NOT used for this — they are
// literals in the common "Author - Title [Narrator]" folder convention.)

export type PatternField = "author" | "title" | "series" | "narrator" | "position" | "year" | "publisher";

const FIELD_TOKENS: readonly string[] = ["author", "title", "series", "narrator", "position", "year", "publisher"];
const KNOWN_TOKENS: readonly string[] = [...FIELD_TOKENS, "ignore"];

// How many optional sections one pattern may carry (2^n expanded variants).
const MAX_OPTIONAL_SECTIONS = 4;
export const MAX_LAYOUTS = 10;

export interface PatternResult {
  matched: boolean;
  author?: string;
  title?: string;
  series?: string;
  narrator?: string;
  position?: number;
  year?: number;
  publisher?: string;
  // Present only when something captured was dropped (non-numeric position/year).
  warnings?: string[];
}

export interface LayoutMatch extends PatternResult {
  // Index into the layouts list that matched; null when nothing matched.
  layoutIndex: number | null;
}

type Part = { kind: "lit"; text: string } | { kind: "token"; name: string };

function tokenize(segment: string): Part[] {
  const parts: Part[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    if (m.index > last) parts.push({ kind: "lit", text: segment.slice(last, m.index) });
    parts.push({ kind: "token", name: m[1] });
    last = re.lastIndex;
  }
  if (last < segment.length) parts.push({ kind: "lit", text: segment.slice(last) });
  return parts;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A literal matches verbatim, with two conveniences. Any run of whitespace matches
// one-or-more whitespace (so "1.  Title" with a double space still matches
// "{position}. {title}"). And a literal's REQUIRED trailing space is also satisfied
// by a zero-width boundary right before a NON-digit — so "{position}. {title}" matches
// both "1. Начало" and the space-less "1.Начало" (FB2 libraries mix the two). The
// non-digit guard keeps real numbers intact: "2.5. Title" still parses position "2.5"
// because the inner dot is followed by a digit, so it isn't treated as the boundary.
// A purely whitespace literal still requires real whitespace, so "{author} {title}"
// never collapses onto "AuthorTitle".
function literalRegex(literal: string, anchored: boolean): RegExp {
  const core = literal.split(/\s+/).filter(Boolean);
  const body = core.length === 0
    ? (literal.length > 0 ? "\\s+" : "")
    : core.map(escapeRe).join("\\s+") + (/\s$/.test(literal) ? "(?:\\s+|(?=\\D)|$)" : "");
  return new RegExp((anchored ? "^" : "") + body);
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// "Doyle, Arthur Conan" → "Arthur Conan Doyle". Only the plain "Last, First" form with
// exactly one comma is rewritten; anything else (several authors, suffixes) is left
// to the name splitter downstream.
export function normaliseAuthorName(value: string): string {
  const parts = value.split(",");
  if (parts.length !== 2) return value;
  const last = parts[0].trim();
  const first = parts[1].trim();
  if (!last || !first || /\d/.test(last) || /\d/.test(first)) return value;
  return `${first} ${last}`;
}

function matchSegment(template: string, value: string, caps: Record<string, string>): boolean {
  const parts = tokenize(template);
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.kind === "lit") {
      const m = value.slice(pos).match(literalRegex(part.text, true));
      if (!m) return false;
      pos += m[0].length;
    } else {
      const next = parts[i + 1];
      if (!next) {
        caps[part.name] = value.slice(pos);
        pos = value.length;
      } else if (next.kind === "lit") {
        const rest = value.slice(pos);
        const m = rest.match(literalRegex(next.text, false));
        if (!m || m.index === undefined) return false;
        caps[part.name] = rest.slice(0, m.index);
        pos += m.index;
      } else {
        // Two adjacent tokens are ambiguous — rejected by validatePattern.
        return false;
      }
    }
  }
  return pos === value.length;
}

// Expand `<...>` optional sections into plain patterns, most-complete variant first.
// Returns an error string instead when the brackets are malformed.
export function expandOptionalSections(pattern: string): string[] | { error: string } {
  const open = pattern.indexOf("<");
  const close = pattern.indexOf(">");
  if (open < 0 && close < 0) return [pattern];
  if (open < 0 || close < 0 || close < open) return { error: "Optional sections need a matching < and >." };
  const inner = pattern.slice(open + 1, close);
  if (inner.includes("<")) return { error: "Optional sections cannot be nested." };
  if (!inner.trim()) return { error: "An optional section <…> cannot be empty." };
  if ((pattern.match(/</g) ?? []).length > MAX_OPTIONAL_SECTIONS) {
    return { error: `A pattern can hold at most ${MAX_OPTIONAL_SECTIONS} optional sections.` };
  }
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const withSection = expandOptionalSections(prefix + inner + suffix);
  if (!Array.isArray(withSection)) return withSection;
  const without = expandOptionalSections(prefix + suffix);
  if (!Array.isArray(without)) return without;
  const out: string[] = [];
  for (const v of [...withSection, ...without]) if (!out.includes(v)) out.push(v);
  return out;
}

// Match a book key against ONE plain pattern (no optional sections). Depth must
// match exactly (the rule's folder selection controls the anchor depth), so an
// over-/under-deep path is no match.
function matchPlainPattern(pattern: string, bookKey: string): PatternResult {
  const patSegs = pattern.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
  const keySegs = bookKey.split("/").filter((s) => s.length > 0);
  if (patSegs.length === 0 || patSegs.length !== keySegs.length) return { matched: false };

  const caps: Record<string, string> = {};
  for (let i = 0; i < patSegs.length; i++) {
    if (!matchSegment(patSegs[i], keySegs[i], caps)) return { matched: false };
  }

  const result: PatternResult = { matched: true };
  const warnings: string[] = [];
  for (const field of ["author", "title", "series", "narrator", "publisher"] as const) {
    const v = caps[field] != null ? clean(caps[field]) : "";
    if (v) result[field] = field === "author" ? normaliseAuthorName(v) : v;
  }
  if (caps.position != null) {
    const raw = clean(caps.position);
    const n = Number(raw);
    if (raw && Number.isFinite(n)) result.position = n;
    else warnings.push(`"${raw}" is not a number, so the position was dropped.`);
  }
  if (caps.year != null) {
    const raw = clean(caps.year);
    if (/^\d{4}$/.test(raw)) result.year = Number(raw);
    else warnings.push(`"${raw}" is not a four-digit year, so it was dropped.`);
  }
  if (warnings.length) result.warnings = warnings;
  return result;
}

// Match a book key against a pattern that may carry optional sections. A malformed
// pattern (which validatePattern would have rejected) simply matches nothing.
export function matchPattern(pattern: string, bookKey: string): PatternResult {
  const variants = expandOptionalSections(pattern);
  if (!Array.isArray(variants)) return { matched: false };
  for (const variant of variants) {
    const r = matchPlainPattern(variant, bookKey);
    if (r.matched) return r;
  }
  return { matched: false };
}

// Match a book key against a rule's ordered layouts; the first that fits wins.
export function matchLayouts(layouts: readonly string[], bookKey: string): LayoutMatch {
  for (let i = 0; i < layouts.length; i++) {
    const r = matchPattern(layouts[i], bookKey);
    if (r.matched) return { ...r, layoutIndex: i };
  }
  return { matched: false, layoutIndex: null };
}

// Segment count of a pattern (the depth below the anchor it describes). With
// optional sections the depths of the variants may differ; this is the deepest.
export function patternDepth(pattern: string): number {
  const variants = expandOptionalSections(pattern);
  const list = Array.isArray(variants) ? variants : [pattern.replace(/[<>]/g, "")];
  return Math.max(...list.map((v) => v.split("/").map((s) => s.trim()).filter(Boolean).length));
}

function validatePlainPattern(pattern: string, mediaType: "audiobook" | "ebook"): string[] {
  const errors: string[] = [];
  const segs = pattern.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
  if (segs.length === 0) errors.push("Enter a pattern.");
  const seen = new Set<string>();
  for (const seg of segs) {
    const parts = tokenize(seg);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.kind !== "token") continue;
      if (!KNOWN_TOKENS.includes(part.name)) {
        errors.push(`Unknown token {${part.name}}.`);
      }
      if (part.name === "narrator" && mediaType === "ebook") {
        errors.push("{narrator} is only valid for audiobook rules.");
      }
      if (part.name !== "ignore") {
        if (seen.has(part.name)) errors.push(`Token {${part.name}} is used more than once.`);
        seen.add(part.name);
      }
      const next = parts[i + 1];
      if (next && next.kind === "token") {
        errors.push(`{${part.name}} and {${next.name}} need a separator between them.`);
      }
    }
  }
  return errors;
}

// Validate a pattern at save time. Returns human-readable errors ([] = valid).
export function validatePattern(pattern: string, mediaType: "audiobook" | "ebook"): string[] {
  if (!pattern.trim()) return ["Enter a pattern."];
  const errors: string[] = [];
  if (pattern.includes("..")) errors.push("Pattern must not contain '..'.");
  const variants = expandOptionalSections(pattern);
  if (!Array.isArray(variants)) return [...errors, variants.error];
  // variants[0] is the most complete expansion; errors that only appear once a
  // section is left out say so.
  for (const variant of variants) {
    for (const e of validatePlainPattern(variant, mediaType)) {
      const msg = variant === variants[0] ? e : `${e} (with an optional section left out)`;
      if (!errors.includes(msg) && !errors.includes(e)) errors.push(msg);
    }
  }
  return errors;
}

// Validate a rule's ordered layouts. Errors are prefixed with the layout number when
// the rule holds more than one.
export function validateLayouts(layouts: readonly string[], mediaType: "audiobook" | "ebook"): string[] {
  if (layouts.length === 0) return ["Enter a pattern."];
  if (layouts.length > MAX_LAYOUTS) return [`A rule can hold at most ${MAX_LAYOUTS} layouts.`];
  const errors: string[] = [];
  layouts.forEach((layout, index) => {
    for (const e of validatePattern(layout, mediaType)) {
      errors.push(layouts.length > 1 ? `Layout ${index + 1}: ${e}` : e);
    }
  });
  return errors;
}
