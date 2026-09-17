// Searching the user guides, entirely in the browser.
//
// The guides ship inside the build (see vite.config.ts), so there is no server
// index to ask and search keeps working with no internet. Each guide is split into
// its sections — a heading and the prose under it — and a result points at the
// section, not just the guide, so a hit deep inside control-panel.md opens there.

/** The id a guide heading gets when rendered. The same slug GitHub makes, so
 *  `guide.md#some-section` links written in the docs land where authors expect.
 *  GuidePage's renderer uses this too — the two must never disagree. */
export function headingAnchor(text: string): string {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
}

export interface GuideSection {
  slug: string;
  guideTitle: string;
  /** Null for the guide's opening — the prose above its first section. */
  heading: string | null;
  anchor: string | null;
  text: string;
}

// Stand-ins for a code span's angle brackets while tags are stripped: characters
// from the Private Use Area, which no guide contains.
const OPEN_BRACKET = String.fromCharCode(0xe000);
const CLOSE_BRACKET = String.fromCharCode(0xe001);

// Markdown down to the words a reader sees: no image tags, link targets, emphasis
// marks, table pipes or comments to match on (or to show in a snippet).
export function plainText(markdown: string): string {
  // Code spans keep their angle brackets (`isputnik-<date>.zip`) — shelter them
  // from the tag stripping below, then put them back.
  const sheltered = markdown.replace(/`([^`\n]*)`/g, (_span, code: string) =>
    code.split("<").join(OPEN_BRACKET).split(">").join(CLOSE_BRACKET)
  );
  return sheltered
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}(?:>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, " ")
    .replace(/[*_`|~]/g, "")
    .replace(/\s+/g, " ")
    .split(OPEN_BRACKET)
    .join("<")
    .split(CLOSE_BRACKET)
    .join(">")
    .trim();
}

// Sections break at #, ## and ###; anything deeper stays with its parent, which
// keeps a result's destination a heading worth landing on.
export function splitSections(slug: string, markdown: string): GuideSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: GuideSection[] = [];
  let guideTitle = slug;
  let current: { heading: string | null; body: string[] } = { heading: null, body: [] };
  let inFence = false;

  const flush = () => {
    const text = plainText(current.body.join("\n"));
    if (current.heading !== null || text) {
      sections.push({
        slug,
        guideTitle,
        heading: current.heading,
        anchor: current.heading === null ? null : headingAnchor(current.heading),
        text
      });
    }
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      current.body.push(line);
    } else if (match[1].length === 1) {
      // The title names the guide; the prose under it is the guide's opening.
      guideTitle = plainText(match[2]);
    } else {
      flush();
      current = { heading: match[2], body: [] };
    }
  }
  flush();
  // The title arrives before any section is pushed, but the opening was flushed
  // with whatever title was known then — make every section agree.
  return sections.map((section) => ({ ...section, guideTitle }));
}

export interface SnippetPart {
  text: string;
  hit: boolean;
}

export interface SearchResult {
  section: GuideSection;
  href: string;
  /** The heading shown for the result: the section's, or the guide's own title. */
  title: string;
  snippet: SnippetPart[];
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter((term) => term.length > 0))];
}

// Split text into plain and matching runs, so the page can <mark> the hits without
// ever building HTML from guide text.
export function highlight(text: string, queryTerms: string[]): SnippetPart[] {
  if (!queryTerms.length) return [{ text, hit: false }];
  const pattern = new RegExp(`(${queryTerms.map(escapeRegExp).join("|")})`, "gi");
  return text
    .split(pattern)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, hit: queryTerms.includes(part.toLowerCase()) }));
}

const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 170;

// When the heading already carries the match, the section's opening lines say
// what it's about better than a fragment from somewhere in the middle (often a
// table). Otherwise show the words around the first hit.
function snippetFor(section: GuideSection, queryTerms: string[]): string {
  const { text } = section;
  const heading = (section.heading ?? "").toLowerCase();
  const lower = text.toLowerCase();
  const at = queryTerms.some((term) => heading.includes(term))
    ? 0
    : Math.min(...queryTerms.map((term) => lower.indexOf(term)).filter((index) => index >= 0), Infinity);
  if (!Number.isFinite(at) || at <= SNIPPET_BEFORE) {
    return text.length > SNIPPET_LENGTH ? `${text.slice(0, text.lastIndexOf(" ", SNIPPET_LENGTH))}…` : text;
  }
  const start = text.indexOf(" ", at - SNIPPET_BEFORE) + 1;
  const end = start + SNIPPET_LENGTH;
  const cut = end >= text.length ? text.length : text.lastIndexOf(" ", end);
  return `…${text.slice(start, cut)}${cut < text.length ? "…" : ""}`;
}

export function searchGuides(sections: GuideSection[], query: string, limit = 8): SearchResult[] {
  const queryTerms = terms(query);
  if (!queryTerms.length) return [];
  const phrase = query.trim().toLowerCase();

  const scored = sections.flatMap((section) => {
    const heading = (section.heading ?? "").toLowerCase();
    const title = section.guideTitle.toLowerCase();
    const body = section.text.toLowerCase();
    // Every word has to appear somewhere in the section — the guide's title counts,
    // so "gallery albums" finds the albums section of the Gallery guide.
    if (!queryTerms.every((term) => heading.includes(term) || body.includes(term) || title.includes(term))) return [];

    let score = 0;
    if (heading.includes(phrase)) score += 12;
    if (body.includes(phrase)) score += 4;
    for (const term of queryTerms) {
      if (heading.includes(term)) score += 5;
      if (title.includes(term)) score += 2;
      score += Math.min(body.split(term).length - 1, 3);
    }
    // A section that only matched on the guide's title is a weak answer.
    if (!queryTerms.some((term) => heading.includes(term) || body.includes(term))) score -= 6;
    return [{ section, score }];
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ section }) => ({
      section,
      href: `/help/${section.slug}${section.anchor ? `#${section.anchor}` : ""}`,
      title: section.heading ? plainText(section.heading) : section.guideTitle,
      snippet: highlight(snippetFor(section, queryTerms), queryTerms)
    }));
}
