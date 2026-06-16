// Typed thin wrapper around the vendored foliate-js <foliate-view> element.
// Importing view.js (side effect) registers the custom element. We only ever
// feed it EPUB blobs; everything navigation/CFI-related goes through foliate's
// own book model (goTo / relocate), which is what makes it reliable.
import "../../../vendor/foliate-js/view.js";

export interface FoliateTocItem {
  label: string;
  href: string;
  subitems?: FoliateTocItem[];
}

export interface FoliateRelocateDetail {
  cfi?: string;
  fraction?: number;
  tocItem?: { label?: string; href?: string } | null;
  pageItem?: { label?: string } | null;
  section?: { current: number; total: number };
  location?: { current: number; next: number; total: number };
  time?: { section: number; total: number };
}

export interface FoliateLoadDetail {
  doc: Document;
  index: number;
}

export interface FoliateSearchMatch {
  cfi: string;
  excerpt?: { pre?: string; match?: string; post?: string };
}

// search() yields progress ticks, flat matches, and per-section grouped matches.
// Kept as one permissive shape rather than a union so callers can read whichever
// fields a given yield carries.
export interface FoliateSearchYield {
  progress?: number;
  cfi?: string;
  excerpt?: { pre?: string; match?: string; post?: string };
  label?: string;
  subitems?: FoliateSearchMatch[];
}

interface FoliateRenderer {
  setStyles(css: string): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface FoliateView extends HTMLElement {
  open(book: Blob | File | string): Promise<void>;
  init(options: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
  goTo(target: string | number | { fraction: number }): Promise<unknown>;
  goToFraction(fraction: number): Promise<void>;
  goLeft(): Promise<void> | void;
  goRight(): Promise<void> | void;
  prev(distance?: number): Promise<void>;
  next(distance?: number): Promise<void>;
  search(options: { query: string; index?: number }): AsyncGenerator<FoliateSearchYield, void, unknown>;
  clearSearch?(): void;
  close?(): void;
  renderer?: FoliateRenderer;
  book: { toc?: FoliateTocItem[] };
}

export function createFoliateView(): FoliateView {
  return document.createElement("foliate-view") as FoliateView;
}

// ── reading theme + typography ───────────────────────────────────────────────

export type ReaderTheme = "light" | "sepia" | "dark";
export type ReaderLayout = "single" | "double" | "scrolled";
export type ReaderFont = "serif" | "sans";

const FONT_STACKS: Record<ReaderFont, string> = {
  serif: `Georgia, "Palatino Linotype", "Book Antiqua", "Times New Roman", serif`,
  sans: `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
};

const THEMES: Record<ReaderTheme, { bg: string; fg: string; link: string }> = {
  light: { bg: "#fbfbf6", fg: "#1a1a1a", link: "#116b5f" },
  sepia: { bg: "#f4ecd8", fg: "#5b4636", link: "#9a5b2b" },
  dark: { bg: "#191817", fg: "#cdc8bf", link: "#7fc3b3" }
};

export function themeColors(theme: ReaderTheme) {
  return THEMES[theme];
}

// CSS injected into every rendered section via renderer.setStyles(). !important
// on colour/background/family keeps the theme winning over the book's own stylesheet.
export function themeCSS(theme: ReaderTheme, fontPercent: number, lineHeight: number, font: ReaderFont = "serif"): string {
  const t = THEMES[theme];
  return `
    html { color-scheme: ${theme === "dark" ? "dark" : "light"}; font-size: ${fontPercent}%; }
    html, body {
      background: ${t.bg} !important;
      color: ${t.fg} !important;
      font-family: ${FONT_STACKS[font]} !important;
    }
    p, li, blockquote, dd { line-height: ${lineHeight}; }
    p { text-align: justify; -webkit-hyphens: auto; hyphens: auto; }
    a, a:any-link { color: ${t.link} !important; }
    img, svg, video { max-width: 100% !important; height: auto !important; }
    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.3); border-radius: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
  `;
}

// Apply the layout to the foliate renderer: paginated 1-up / 2-up, or scrolled.
// A wider max-inline-size than foliate's 720px default makes better use of a
// desktop window while still keeping a comfortable measure.
export function applyLayout(renderer: FoliateRenderer, layout: ReaderLayout): void {
  renderer.setAttribute("max-inline-size", "800px");
  renderer.setAttribute("gap", "6%");
  if (layout === "scrolled") {
    renderer.setAttribute("flow", "scrolled");
    renderer.setAttribute("max-column-count", "1");
  } else {
    renderer.setAttribute("flow", "paginated");
    renderer.setAttribute("max-column-count", layout === "double" ? "2" : "1");
  }
}

// ── table of contents helpers ────────────────────────────────────────────────

export interface FlatTocEntry {
  label: string;
  href: string;
}

export function flattenToc(items: FoliateTocItem[] = [], out: FlatTocEntry[] = []): FlatTocEntry[] {
  for (const item of items) {
    if (item.href) out.push({ label: item.label, href: item.href });
    if (item.subitems?.length) flattenToc(item.subitems, out);
  }
  return out;
}

export function countToc(items: FoliateTocItem[] = []): number {
  return items.reduce((sum, item) => sum + 1 + countToc(item.subitems ?? []), 0);
}
