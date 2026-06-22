// Declarative path-pattern engine for custom scan rules (docs/custom-scan-rules-proposal.md).
//
// A pattern is matched against a "book key" relative to the rule's anchor folder
// (POSIX-separated, extension already removed). It is `/`-separated segments;
// within a segment, text is a sequence of literals and {tokens}. A token is
// non-greedy and bounded by the literal that follows it (or the segment edge).
// Pure + validated — no regular expressions or code supplied by the user.

export type PatternField = "author" | "title" | "series" | "narrator" | "position";

const FIELD_TOKENS: readonly string[] = ["author", "title", "series", "narrator", "position"];
const KNOWN_TOKENS: readonly string[] = [...FIELD_TOKENS, "ignore"];

export interface PatternResult {
  matched: boolean;
  author?: string;
  title?: string;
  series?: string;
  narrator?: string;
  position?: number;
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

// Match a book key against a pattern. Depth must match exactly (the rule's folder
// selection controls the anchor depth), so an over-/under-deep path is no match.
export function matchPattern(pattern: string, bookKey: string): PatternResult {
  const patSegs = pattern.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
  const keySegs = bookKey.split("/").filter((s) => s.length > 0);
  if (patSegs.length === 0 || patSegs.length !== keySegs.length) return { matched: false };

  const caps: Record<string, string> = {};
  for (let i = 0; i < patSegs.length; i++) {
    if (!matchSegment(patSegs[i], keySegs[i], caps)) return { matched: false };
  }

  const result: PatternResult = { matched: true };
  for (const field of ["author", "title", "series", "narrator"] as const) {
    const v = caps[field] != null ? clean(caps[field]) : "";
    if (v) result[field] = v;
  }
  if (caps.position != null) {
    const n = Number(clean(caps.position));
    if (Number.isFinite(n)) result.position = n;
  }
  return result;
}

// Validate a pattern at save time. Returns human-readable errors ([] = valid).
export function validatePattern(pattern: string, mediaType: "audiobook" | "ebook"): string[] {
  const errors: string[] = [];
  if (!pattern.trim()) return ["Enter a pattern."];
  if (pattern.includes("..")) errors.push("Pattern must not contain '..'.");

  const segs = pattern.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
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
