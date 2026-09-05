// The layout builder's model (docs/scan-layout-plan.md): a real example path is
// split into folder segments and, within each, into pieces separated by the
// punctuation people use in file names. The user labels each piece with a role;
// the pattern the scanner understands is generated from those labels. Pure and
// framework-free so it can be unit-tested and shared by every step.

export type LibraryKind = "audiobook" | "ebook";

export type Role = "author" | "series" | "position" | "title" | "narrator" | "year" | "publisher" | "skip";

export const ROLES: Role[] = ["author", "series", "position", "title", "narrator", "year", "publisher", "skip"];

export const ROLE_TOKEN: Record<Role, string> = {
  author: "{author}", series: "{series}", position: "{position}", title: "{title}",
  narrator: "{narrator}", year: "{year}", publisher: "{publisher}", skip: "{ignore}"
};

export function rolesFor(kind: LibraryKind): Role[] {
  return ROLES.filter((role) => role !== "narrator" || kind === "audiobook");
}

export interface Token { kind: "piece" | "sep"; text: string }

export interface SegmentDraft {
  tokens: Token[];
  // Indexes (into tokens) of separators glued into the group before them.
  joins: number[];
  // Role keyed by the index of the group's first piece.
  roles: Record<number, Role>;
}

export interface Group {
  start: number;      // index of the first piece; -1 for a leading literal
  text: string;
  leading?: string;   // a separator before any piece (rare: "(2003) Title")
  sepAfter: { index: number; text: string } | null;
}

export interface LayoutExample { anchor: string; path: string }

export interface LayoutDraft {
  id: string;
  mode: "builder" | "text";
  example: LayoutExample | null;
  segments: SegmentDraft[];
  // Audiobooks: how many leading segments are labelled; the rest are tracks. For
  // ebooks every segment is labelled (the file stem is the last).
  boundary: number;
  text: string;
}

export interface Preset { id: string; pattern: string }

export const PRESETS: Record<LibraryKind, Preset[]> = {
  ebook: [
    { id: "authorTitle", pattern: "{author}/{title}" },
    { id: "authorSeriesNumberTitle", pattern: "{author}/{series}/{position} - {title}" },
    { id: "seriesNumberTitle", pattern: "{series}/{position} - {title}" },
    { id: "numberTitle", pattern: "{position} - {title}" },
    { id: "authorDashTitle", pattern: "{author} - {title}" }
  ],
  audiobook: [
    { id: "authorTitle", pattern: "{author}/{title}" },
    { id: "authorSeriesNumberTitle", pattern: "{author}/{series}/{position} - {title}" },
    { id: "authorDashTitleNarrator", pattern: "{author} - {title} [{narrator}]" },
    { id: "authorTitleNarrator", pattern: "{author}/{title}/{narrator}" },
    { id: "seriesNumberTitle", pattern: "{series}/{position} - {title}" }
  ]
};

// Mirrors the scanner's PART_FOLDER_RE: a folder that is one part of a book.
const DISC_LIKE = /(?:^|[\s_\-([])(?:cd|disc|disk|part|pt|часть|ч|диск)[\s_.\-]*\d+[)\]]?$/i;
// Separators file names are split on. The ordinal dot ("01. Title") only counts
// right after leading digits, so "J.R.R. Tolkien" stays whole.
const SEP_RE = /( - |(?<=^\d+)\. |_| \(| \[|\)|\])/;

export function splitPieces(text: string): Token[] {
  const raw = text.split(SEP_RE);
  const out: Token[] = [];
  raw.forEach((s, i) => {
    if (s === "" || s === undefined) return;
    const isSep = i % 2 === 1;
    const last = out[out.length - 1];
    if (isSep && last && last.kind === "sep") last.text += s;
    else out.push({ kind: isSep ? "sep" : "piece", text: s });
  });
  return out;
}

export function groupsOf(seg: SegmentDraft): Group[] {
  type Building = Group & { pendingSep: string | null };
  const groups: Building[] = [];
  let cur: Building | null = null;
  seg.tokens.forEach((t, i) => {
    if (t.kind === "piece") {
      if (cur && cur.pendingSep !== null) { cur.text += cur.pendingSep + t.text; cur.pendingSep = null; }
      else { cur = { start: i, text: t.text, sepAfter: null, pendingSep: null }; groups.push(cur); }
    } else if (!cur) {
      groups.push({ start: -1, text: "", leading: t.text, sepAfter: null, pendingSep: null });
    } else if (seg.joins.includes(i)) {
      cur.pendingSep = t.text;
    } else {
      cur.sepAfter = { index: i, text: t.text };
      cur = null;
    }
  });
  return groups.map(({ pendingSep: _drop, ...g }) => g);
}

export function segmentPattern(seg: SegmentDraft): string {
  let out = "";
  for (const g of groupsOf(seg)) {
    if (g.start < 0) { out += g.leading ?? ""; continue; }
    out += ROLE_TOKEN[seg.roles[g.start] ?? "skip"];
    if (g.sepAfter) out += g.sepAfter.text;
  }
  return out;
}

export function labelledSegments(draft: LayoutDraft): SegmentDraft[] {
  return draft.segments.slice(0, draft.boundary);
}

export function patternOf(draft: LayoutDraft): string {
  if (draft.mode === "text") return draft.text.trim();
  return labelledSegments(draft).map(segmentPattern).join("/");
}

// Folder names (all segments but the pattern's leaf) start as one piece each
// with a role guessed from position; the leaf gets "number - title" when it
// looks like that. Everything past the boundary is unlabelled.
export function guessRoles(draft: LayoutDraft): void {
  const segs = labelledSegments(draft);
  const depth = segs.length;
  const leafPieces = depth > 0 ? groupsOf({ ...segs[depth - 1], joins: [] }).filter((g) => g.start >= 0) : [];
  const leafStartsWithNumber = leafPieces.length > 1 && /^\d+$/.test(leafPieces[0].text);
  segs.forEach((seg, i) => {
    seg.joins = [];
    seg.roles = {};
    const isLeaf = i === depth - 1;
    if (!isLeaf) {
      seg.tokens.forEach((t, ti) => { if (t.kind === "sep") seg.joins.push(ti); });
      const g = groupsOf(seg).find((x) => x.start >= 0);
      // The folder right above a numbered leaf ("01 - Title") is almost always the
      // series; otherwise the first folder is the author and a middle one the series.
      if (g) {
        const aboveNumberedLeaf = i === depth - 2 && leafStartsWithNumber;
        seg.roles[g.start] = aboveNumberedLeaf ? "series" : i === 0 ? "author" : depth === 3 && i === 1 ? "series" : "skip";
      }
      return;
    }
    // The leaf: "01 - Title" reads as position + title; "X - Y" with no author
    // folder above reads as author + title; anything further is skipped.
    const groups = groupsOf(seg).filter((g) => g.start >= 0);
    const authorAbove = segs.slice(0, i).some((other) => Object.values(other.roles).includes("author"));
    groups.forEach((g, gi) => {
      const taken = Object.values(seg.roles);
      if (gi === 0 && /^\d+$/.test(g.text) && groups.length > 1) seg.roles[g.start] = "position";
      else if (gi === 0 && groups.length > 1 && !authorAbove) seg.roles[g.start] = "author";
      else if (!taken.includes("title")) seg.roles[g.start] = "title";
      else seg.roles[g.start] = "skip";
    });
  });
}

let draftCounter = 0;
export const nextDraftId = () => `layout-${Date.now().toString(36)}-${(draftCounter += 1)}`;

// Split an example into segments. For ebooks the leaf is the file stem; for
// audiobooks the file itself is never labelled and the boundary starts above
// any disc-like folders.
export function draftFromExample(example: LayoutExample, kind: LibraryKind): LayoutDraft {
  const rawSegs = example.path.split("/").filter(Boolean);
  const file = rawSegs[rawSegs.length - 1] ?? "";
  const dirs = rawSegs.slice(0, -1);
  const segs = kind === "ebook" ? [...dirs, file.replace(/\.[^./]+$/, "")] : [...dirs, file];
  let boundary = segs.length;
  if (kind === "audiobook") {
    boundary = dirs.length;
    while (boundary > 1 && DISC_LIKE.test(dirs[boundary - 1])) boundary -= 1;
  }
  const draft: LayoutDraft = {
    id: nextDraftId(), mode: "builder", example, boundary, text: "",
    segments: segs.map((s) => ({ tokens: splitPieces(s), joins: [], roles: {} }))
  };
  guessRoles(draft);
  return draft;
}

export function textDraft(text: string): LayoutDraft {
  return { id: nextDraftId(), mode: "text", example: null, segments: [], boundary: 0, text };
}

export function extensionOf(example: LayoutExample | null): string {
  const m = example?.path.match(/\.[^./]+$/);
  return m ? m[0] : "";
}

// Parse a pattern into the roles per segment: [[author], [series], [position, title]].
function presetRoles(pattern: string): Role[][] {
  return pattern.split("/").map((seg) =>
    [...seg.matchAll(/\{(\w+)\}/g)].map((m) => (m[1] === "ignore" ? "skip" : m[1]) as Role)
  );
}

// A pattern with its `<...>` optional sections removed (the shallowest variant).
export function withoutOptionalSections(pattern: string): string {
  let out = "";
  let depth = 0;
  for (const ch of pattern) {
    if (ch === "<") depth += 1;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

export const patternDepth = (pattern: string) => withoutOptionalSections(pattern).split("/").filter((s) => s.trim()).length;

// Lay a preset's roles over the draft's segments: one role per segment joins
// all its pieces; k roles take the first k pieces in order and the rest join
// into the last. Segments the preset does not mention are skipped.
export function applyPreset(draft: LayoutDraft, pattern: string, kind: LibraryKind): void {
  const wantedBySeg = presetRoles(pattern);
  if (kind === "audiobook") draft.boundary = Math.max(1, Math.min(wantedBySeg.length, Math.max(0, draft.segments.length - 1)));
  draft.mode = "builder";
  labelledSegments(draft).forEach((seg, i) => {
    seg.joins = [];
    seg.roles = {};
    const wanted = wantedBySeg[i] ?? ["skip"];
    const pieces = seg.tokens.map((t, idx) => ({ ...t, idx })).filter((t) => t.kind === "piece");
    if (wanted.length <= 1) {
      seg.tokens.forEach((t, ti) => { if (t.kind === "sep") seg.joins.push(ti); });
      if (pieces[0]) seg.roles[pieces[0].idx] = wanted[0] ?? "skip";
      return;
    }
    pieces.forEach((p, pi) => {
      if (pi < wanted.length) seg.roles[p.idx] = wanted[pi];
      else {
        for (let ti = pieces[wanted.length - 1].idx + 1; ti < p.idx; ti++) {
          if (seg.tokens[ti].kind === "sep" && !seg.joins.includes(ti)) seg.joins.push(ti);
        }
      }
    });
  });
}

// Join the separator at `sepIndex` into the group before it. Roles that belonged
// to pieces now swallowed into that group are dropped.
export function joinAt(seg: SegmentDraft, sepIndex: number): void {
  if (!seg.joins.includes(sepIndex)) seg.joins.push(sepIndex);
  const starts = groupsOf(seg).map((g) => g.start);
  for (const key of Object.keys(seg.roles)) if (!starts.includes(Number(key))) delete seg.roles[Number(key)];
}

// Split a group back into its pieces.
export function splitGroup(seg: SegmentDraft, groupStart: number): void {
  for (let i = groupStart + 1; i < seg.tokens.length; i++) {
    if (seg.tokens[i].kind !== "sep") continue;
    const at = seg.joins.indexOf(i);
    if (at >= 0) seg.joins.splice(at, 1); else break;
  }
}

export interface DraftProblem { kind: "error" | "warning"; code: "duplicate" | "positionWithoutSeries" | "empty"; role?: Role; count?: number }

export function problemsOf(draft: LayoutDraft, kind: LibraryKind): DraftProblem[] {
  const out: DraftProblem[] = [];
  const pattern = patternOf(draft);
  if (!pattern) { out.push({ kind: "error", code: "empty" }); return out; }
  const counts = new Map<Role, number>();
  for (const m of withoutOptionalSections(pattern).matchAll(/\{(\w+)\}/g)) {
    const role = (m[1] === "ignore" ? "skip" : m[1]) as Role;
    if (role === "skip" || !ROLES.includes(role)) continue;
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  for (const [role, count] of counts) if (count > 1) out.push({ kind: "error", code: "duplicate", role, count });
  if (counts.has("position") && !counts.has("series")) out.push({ kind: "warning", code: "positionWithoutSeries" });
  if (kind === "ebook" && counts.has("narrator")) out.push({ kind: "error", code: "duplicate", role: "narrator", count: 0 });
  return out;
}

const HUMAN: Record<string, string> = {
  "{author}": "Author", "{series}": "Series", "{position}": "01", "{title}": "Title",
  "{narrator}": "Narrator", "{year}": "Year", "{publisher}": "Publisher", "{ignore}": "…"
};

// "{author}/{series}/{position} - {title}" → "Author / Series / 01 - Title".
export function humanize(pattern: string, labels: Partial<Record<string, string>> = {}): string {
  return pattern.replace(/\{\w+\}/g, (t) => labels[t] ?? HUMAN[t] ?? t).replace(/\//g, " / ");
}

// Which example fits a preset: the same depth below the anchor.
export function exampleDepth(example: LayoutExample, kind: LibraryKind): number {
  const segs = example.path.split("/").filter(Boolean);
  if (kind === "ebook") return segs.length;
  const dirs = segs.slice(0, -1);
  let b = dirs.length;
  while (b > 1 && DISC_LIKE.test(dirs[b - 1])) b -= 1;
  return b;
}
