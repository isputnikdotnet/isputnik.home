import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, BookOpenText, ChevronLeft, ChevronRight, Columns2, ListTree, Minus, Pencil, Plus, Trash2 } from "lucide-react";
import ePub, { type Book, type Location, type NavItem, type Rendition } from "epubjs";
import { api } from "../../api";
import type { EbookBookmark, ReadingProgress } from "./types";

interface EpubReaderProps {
  bookId: string;
  documentId: string;
  url: string;
  storageKey: string;
  initialProgress: ReadingProgress | null;
  onProgressChange?: (progress: ReadingProgress) => void;
}

interface ProgressDraft {
  cfi: string;
  percentComplete: number | null;
  label: string | null;
}

type EpubPageMode = "single" | "double";

interface SpineSectionLike {
  href: string;
  index: number;
  document?: Document;
  contents?: Element;
  cfiFromElement?: (el: Element) => string;
  load?: (request?: Function) => Promise<Element>;
}

interface TocTarget {
  target: string;
  section: SpineSectionLike;
  fragment: string;
}

const FONT_KEY = "isputnik-epub-font-scale";
const PAGE_MODE_KEY = "isputnik-epub-page-mode";
const LOCATION_CHUNK_SIZE = 1600;

function clampPercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function clampFontScale(value: number): number {
  return Math.max(82, Math.min(132, value));
}

function readFontScale() {
  try {
    const stored = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(stored) ? clampFontScale(stored) : 100;
  } catch {
    return 100;
  }
}

function readPageMode(): EpubPageMode {
  try {
    return localStorage.getItem(PAGE_MODE_KEY) === "single" ? "single" : "double";
  } catch {
    return "double";
  }
}

function spreadForPageMode(mode: EpubPageMode) {
  return mode === "single"
    ? { spread: "none", minSpreadWidth: 0 }
    : { spread: "both", minSpreadWidth: 0 };
}

function readStoredProgress(key: string, documentId: string): ReadingProgress | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReadingProgress>;
    if (typeof parsed.cfi !== "string" || parsed.cfi.trim() === "") return null;
    return {
      documentId,
      cfi: parsed.cfi,
      percentComplete: clampPercent(parsed.percentComplete),
      label: typeof parsed.label === "string" ? parsed.label : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null
    };
  } catch {
    return null;
  }
}

function writeStoredProgress(key: string, progress: ReadingProgress) {
  try {
    localStorage.setItem(key, JSON.stringify(progress));
  } catch {
    // Private browsing / quota should not block reading.
  }
}

function newerProgress(a: ReadingProgress | null, b: ReadingProgress | null) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a;
}

function displayPercent(percent: number | null | undefined) {
  if (percent == null) return "Position not calculated";
  return `${Math.round(clampPercent(percent)! * 100)}%`;
}

// Compact "42%" for a bookmark chip; a bullet when the position isn't known yet
// (book locations still generating when the mark was saved).
function bookmarkPercent(percent: number | null) {
  return percent == null ? "•" : `${Math.round(clampPercent(percent)! * 100)}%`;
}

// Bookmarks listed in reading order — earliest position first.
function sortBookmarks(list: EbookBookmark[]) {
  return [...list].sort((a, b) => (a.percentComplete ?? 0) - (b.percentComplete ?? 0));
}

function normalizeHref(value: string | undefined) {
  return (value ?? "").split("#")[0].replace(/^\.?\//, "");
}

function safeDecodeHref(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitHref(value: string) {
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = beforeHash.indexOf("?");
  return {
    path: queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash,
    fragment: hashIndex >= 0 ? value.slice(hashIndex) : ""
  };
}

function normalizePathPart(value: string) {
  const parts = safeDecodeHref(value)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

function pathDirname(value: string) {
  const normalized = normalizePathPart(splitHref(value).path);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
}

function joinBookPath(baseDir: string, targetPath: string) {
  if (!baseDir || targetPath.startsWith("/")) return normalizePathPart(targetPath);
  return normalizePathPart(`${baseDir}/${targetPath}`);
}

function makeHref(path: string, fragment: string) {
  return `${path}${fragment}`;
}

function addCandidate(candidates: string[], value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed || candidates.includes(trimmed)) return;
  candidates.push(trimmed);
}

function navigationBaseDir(book: Book) {
  const packaging = book.packaging as { navPath?: string | false; ncxPath?: string | false } | undefined;
  const navPath = typeof packaging?.navPath === "string" && packaging.navPath
    ? packaging.navPath
    : typeof packaging?.ncxPath === "string" && packaging.ncxPath
      ? packaging.ncxPath
      : "";
  return navPath ? pathDirname(navPath) : "";
}

function spineSections(book: Book): SpineSectionLike[] {
  const sections: SpineSectionLike[] = [];
  const spine = book.spine as unknown as {
    each?: (fn: (section: SpineSectionLike) => void) => void;
    spineItems?: SpineSectionLike[];
  };
  try {
    spine.each?.((section) => sections.push(section));
  } catch {
    return spine.spineItems ?? sections;
  }
  return sections.length > 0 ? sections : spine.spineItems ?? [];
}

function hrefBasename(value: string) {
  return normalizePathPart(splitHref(value).path).split("/").filter(Boolean).at(-1) ?? "";
}

function getSpineSection(book: Book, target: string) {
  return book.spine.get(target) as unknown as SpineSectionLike | null;
}

function resolveTocTarget(book: Book, href: string): TocTarget | null {
  const raw = href.trim();
  if (!raw) return null;
  if (raw.startsWith("epubcfi(")) {
    const section = getSpineSection(book, raw);
    return section ? { target: raw, section, fragment: "" } : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;

  const { path, fragment } = splitHref(raw);
  const decodedPath = safeDecodeHref(path);
  const normalizedPath = normalizePathPart(path);
  const navDir = navigationBaseDir(book);
  const candidates: string[] = [];

  addCandidate(candidates, raw);
  addCandidate(candidates, safeDecodeHref(raw));
  if (normalizedPath) addCandidate(candidates, makeHref(normalizedPath, fragment));
  if (decodedPath && decodedPath !== path) addCandidate(candidates, makeHref(normalizePathPart(decodedPath), fragment));
  if (navDir && path) addCandidate(candidates, makeHref(joinBookPath(navDir, path), fragment));
  if (fragment && !path) addCandidate(candidates, fragment);

  for (const candidate of candidates) {
    const section = getSpineSection(book, candidate);
    if (section) return { target: candidate, section, fragment };
  }

  const basename = hrefBasename(raw);
  if (!basename) return null;
  const section = spineSections(book).find((candidate) => hrefBasename(candidate.href) === basename);
  return section ? { target: makeHref(section.href, fragment), section, fragment } : null;
}

function fragmentIds(fragment: string) {
  if (!fragment.startsWith("#")) return [];
  const raw = fragment.slice(1).trim();
  const decoded = safeDecodeHref(raw).trim();
  return [raw, decoded].filter((value, index, values) => value && values.indexOf(value) === index);
}

function findFragmentElement(document: Document, fragment: string) {
  const ids = fragmentIds(fragment);
  if (ids.length === 0) return null;

  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) return element;
  }

  const elements = Array.from(document.getElementsByTagName("*"));
  return elements.find((element) => ids.some((id) => (
    element.getAttribute("id") === id
    || element.getAttribute("name") === id
    || element.getAttribute("xml:id") === id
    || element.getAttributeNS("http://www.w3.org/XML/1998/namespace", "id") === id
  ))) ?? null;
}

async function cfiFromTocTarget(book: Book, target: TocTarget) {
  if (!target.fragment || !target.section.load || !target.section.cfiFromElement) return null;
  await target.section.load(book.load.bind(book));
  const document = target.section.document ?? target.section.contents?.ownerDocument;
  if (!document) return null;
  const element = findFragmentElement(document, target.fragment);
  return element ? target.section.cfiFromElement(element) : null;
}

async function displayTocTarget(book: Book, rendition: Rendition, href: string) {
  const target = resolveTocTarget(book, href);
  if (!target) return false;

  const cfi = await cfiFromTocTarget(book, target).catch(() => null);
  if (target.fragment && !cfi) return false;

  await rendition.display(cfi ?? target.target);
  return true;
}

function hrefWithTocBase(href: string, baseHref: string) {
  const trimmed = href.trim();
  if (!trimmed.startsWith("#")) return trimmed;
  const basePath = splitHref(baseHref).path;
  return basePath ? makeHref(basePath, trimmed) : trimmed;
}

function findTocLabel(items: NavItem[], href: string | undefined): string | null {
  const normalizedHref = normalizeHref(href);
  if (!normalizedHref) return null;

  for (const item of items) {
    const itemHref = normalizeHref(item.href);
    if (itemHref === normalizedHref || normalizedHref.endsWith(itemHref) || itemHref.endsWith(normalizedHref)) {
      return item.label;
    }
    const child = item.subitems ? findTocLabel(item.subitems, href) : null;
    if (child) return child;
  }
  return null;
}

function tocItemCount(items: NavItem[]): number {
  return items.reduce((sum, item) => sum + 1 + tocItemCount(item.subitems ?? []), 0);
}

function patchReadingProgress(bookId: string, documentId: string, progress: ProgressDraft) {
  return api(`/api/library/books/${bookId}/reading-progress`, {
    method: "PATCH",
    body: JSON.stringify({
      documentId,
      cfi: progress.cfi,
      percentComplete: progress.percentComplete,
      label: progress.label
    })
  });
}

function TocItems({
  items,
  currentHref,
  baseHref = "",
  level = 0,
  onSelect
}: {
  items: NavItem[];
  currentHref: string;
  baseHref?: string;
  level?: number;
  onSelect: (href: string) => void;
}) {
  const current = normalizeHref(currentHref);
  return (
    <>
      {items.map((item) => {
        const resolvedHref = hrefWithTocBase(item.href, baseHref);
        const itemHref = normalizeHref(resolvedHref);
        const childBaseHref = splitHref(resolvedHref).path ? resolvedHref : baseHref;
        const active = itemHref !== "" && (itemHref === current || current.endsWith(itemHref));
        return (
          <div className="epub-toc-node" key={`${item.id}-${item.href}`}>
            <button
              className={`epub-toc-item${active ? " active" : ""}`}
              style={{ paddingLeft: `${12 + level * 14}px` }}
              type="button"
              onClick={() => onSelect(resolvedHref)}
            >
              {item.label}
            </button>
            {item.subitems && item.subitems.length > 0 && (
              <TocItems
                items={item.subitems}
                currentHref={currentHref}
                baseHref={childBaseHref}
                level={level + 1}
                onSelect={onSelect}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function EpubReader({
  bookId,
  documentId,
  url,
  storageKey,
  initialProgress,
  onProgressChange
}: EpubReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<Book | null>(null);
  const tocRef = useRef<NavItem[]>([]);
  const latestProgressRef = useRef<ProgressDraft | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const onProgressChangeRef = useRef(onProgressChange);
  const startingProgressRef = useRef<ReadingProgress | null | undefined>(undefined);
  if (startingProgressRef.current === undefined) {
    startingProgressRef.current = newerProgress(initialProgress, readStoredProgress(storageKey, documentId));
  }
  const startingProgress = startingProgressRef.current;

  const [loading, setLoading] = useState(true);
  const [generatingLocations, setGeneratingLocations] = useState(false);
  const [error, setError] = useState("");
  const [toc, setToc] = useState<NavItem[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const [chapterError, setChapterError] = useState("");
  const [fontScale, setFontScale] = useState(readFontScale);
  const [pageMode, setPageMode] = useState<EpubPageMode>(readPageMode);
  const [percentComplete, setPercentComplete] = useState<number | null>(startingProgress?.percentComplete ?? null);
  const [sectionLabel, setSectionLabel] = useState(startingProgress?.label ?? "EPUB");
  const [currentHref, setCurrentHref] = useState("");
  const [atStart, setAtStart] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [bookmarks, setBookmarks] = useState<EbookBookmark[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarkSaved, setBookmarkSaved] = useState(false);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const sendProgress = useCallback((progress: ProgressDraft) => {
    return patchReadingProgress(bookId, documentId, progress).catch(() => undefined);
  }, [bookId, documentId]);

  const persistProgress = useCallback((progress: ProgressDraft, immediate = false) => {
    latestProgressRef.current = progress;
    const updatedAt = new Date().toISOString();
    const record: ReadingProgress = {
      documentId,
      cfi: progress.cfi,
      percentComplete: progress.percentComplete,
      label: progress.label,
      updatedAt,
      completedAt: progress.percentComplete != null && progress.percentComplete >= 0.98 ? updatedAt : null
    };

    writeStoredProgress(storageKey, record);
    onProgressChangeRef.current?.(record);

    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }

    if (immediate) {
      void sendProgress(progress);
      return;
    }

    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void sendProgress(progress);
    }, 700);
  }, [documentId, sendProgress, storageKey]);

  const progressFromLocation = useCallback((book: Book, location: Location): number | null => {
    const cfi = location.start?.cfi;
    if (!cfi) return null;
    if (book.locations.length() > 0) {
      return clampPercent(book.locations.percentageFromCfi(cfi));
    }
    return clampPercent(location.start.percentage);
  }, []);

  const updateLocation = useCallback((location: Location) => {
    const cfi = location.start?.cfi;
    if (!cfi) return;

    const book = bookRef.current;
    const nextPercent = book ? progressFromLocation(book, location) : clampPercent(location.start.percentage);
    const label = findTocLabel(tocRef.current, location.start.href)
      ?? location.start.href?.split(/[/#]/).filter(Boolean).at(-1)
      ?? "EPUB";

    setPercentComplete(nextPercent);
    setSectionLabel(label);
    setCurrentHref(location.start.href ?? "");
    setAtStart(Boolean(location.atStart));
    setAtEnd(Boolean(location.atEnd));
    persistProgress({ cfi, percentComplete: nextPercent, label });
  }, [persistProgress, progressFromLocation]);

  const goPrev = useCallback(() => {
    void renditionRef.current?.prev();
  }, []);

  const goNext = useCallback(() => {
    void renditionRef.current?.next();
  }, []);

  const selectTocItem = useCallback((href: string) => {
    const book = bookRef.current;
    const rendition = renditionRef.current;
    if (!book || !rendition) return;

    void displayTocTarget(book, rendition, href)
      .then((opened) => {
        if (!opened) {
          setChapterError("This chapter link could not be opened.");
          return;
        }
        setChapterError("");
        setTocOpen(false);
      })
      .catch(() => {
        setChapterError("This chapter link could not be opened.");
      });
  }, []);

  // Save a mark at the current location. The reader already tracks the live cfi +
  // percent + section label in latestProgressRef (updated on every relocate), so a
  // bookmark is just that snapshot persisted under its own row.
  const addBookmark = useCallback(async () => {
    const draft = latestProgressRef.current;
    if (!draft?.cfi) return;

    setBookmarkBusy(true);
    try {
      const { bookmark } = await api<{ bookmark: EbookBookmark }>(`/api/library/books/${bookId}/ebook-bookmarks`, {
        method: "POST",
        body: JSON.stringify({
          documentId,
          cfi: draft.cfi,
          percentComplete: draft.percentComplete,
          label: draft.label ?? sectionLabel ?? "EPUB"
        })
      });
      setBookmarks((prev) => sortBookmarks([...prev, bookmark]));
      setChapterError("");
      setBookmarkSaved(true);
      window.setTimeout(() => setBookmarkSaved(false), 2000);
    } catch {
      setChapterError("Unable to save this bookmark.");
    } finally {
      setBookmarkBusy(false);
    }
  }, [bookId, documentId, sectionLabel]);

  const jumpToBookmark = useCallback((bookmark: EbookBookmark) => {
    const rendition = renditionRef.current;
    if (!rendition) return;
    void rendition.display(bookmark.cfi)
      .then(() => {
        setChapterError("");
        setBookmarksOpen(false);
      })
      .catch(() => setChapterError("This bookmark could not be opened."));
  }, []);

  const saveBookmarkNote = useCallback(async (id: string, note: string) => {
    try {
      const { bookmark } = await api<{ bookmark: EbookBookmark }>(`/api/library/books/${bookId}/ebook-bookmarks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ note })
      });
      setBookmarks((prev) => prev.map((entry) => (entry.id === id ? bookmark : entry)));
      setEditingBookmarkId(null);
    } catch {
      setChapterError("Unable to save this note.");
    }
  }, [bookId]);

  const deleteBookmark = useCallback(async (id: string) => {
    try {
      await api(`/api/library/books/${bookId}/ebook-bookmarks/${id}`, { method: "DELETE" });
      setBookmarks((prev) => prev.filter((entry) => entry.id !== id));
      setEditingBookmarkId((current) => (current === id ? null : current));
    } catch {
      setChapterError("Unable to delete this bookmark.");
    }
  }, [bookId]);

  useEffect(() => {
    onProgressChangeRef.current = onProgressChange;
  }, [onProgressChange]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error("Could not load this ebook.");
        const buffer = await res.arrayBuffer();
        if (cancelled || !containerRef.current) return;

        const book = ePub(buffer);
        bookRef.current = book;

        const pageLayout = spreadForPageMode(pageMode);
        const rendition = book.renderTo(containerRef.current, {
          width: "100%",
          height: "100%",
          flow: "paginated",
          spread: pageLayout.spread,
          minSpreadWidth: pageLayout.minSpreadWidth
        });
        rendition.themes.default({
          body: {
            background: "#fbfbf6",
            color: "#1a1a1a",
            "font-family": "Georgia, 'Times New Roman', serif",
            "line-height": "1.58"
          },
          a: { color: "#116b5f" },
          img: { "max-width": "100%" }
        });
        rendition.themes.fontSize(`${fontScale}%`);
        rendition.on("relocated", updateLocation);
        renditionRef.current = rendition;

        book.loaded.navigation.then((navigation) => {
          if (cancelled) return;
          tocRef.current = navigation.toc;
          setToc(navigation.toc);
        }).catch(() => undefined);

        let target = startingProgress?.cfi;
        if (!target) {
          try {
            const payload = await api<{ progress: ReadingProgress | null }>(
              `/api/library/books/${bookId}/reading-progress?documentId=${encodeURIComponent(documentId)}`
            );
            if (!cancelled && payload.progress?.cfi) {
              target = payload.progress.cfi;
              writeStoredProgress(storageKey, payload.progress);
              setPercentComplete(payload.progress.percentComplete);
              setSectionLabel(payload.progress.label ?? "EPUB");
              onProgressChangeRef.current?.(payload.progress);
            }
          } catch {
            // No server progress, offline, or old server; open from the beginning.
          }
        }
        await rendition.display(target ?? undefined);
        if (!cancelled) setLoading(false);

        void (async () => {
          try {
            const locationsKey = `${storageKey}:locations`;
            const stored = localStorage.getItem(locationsKey);
            if (stored) {
              book.locations.load(stored);
            } else {
              if (!cancelled) setGeneratingLocations(true);
              await book.locations.generate(LOCATION_CHUNK_SIZE);
              try { localStorage.setItem(locationsKey, book.locations.save()); } catch { /* ignore */ }
            }
            if (!cancelled) {
              setGeneratingLocations(false);
              await rendition.reportLocation();
            }
          } catch {
            if (!cancelled) setGeneratingLocations(false);
          }
        })();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load this ebook.");
          setLoading(false);
          setGeneratingLocations(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (latestProgressRef.current) {
        void sendProgress(latestProgressRef.current);
      }
      try { renditionRef.current?.destroy(); } catch { /* ignore */ }
      try { bookRef.current?.destroy(); } catch { /* ignore */ }
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [bookId, documentId, sendProgress, storageKey, updateLocation, url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNext, goPrev]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || !renditionRef.current) return;
      renditionRef.current.resize(Math.floor(box.width), Math.floor(box.height));
      void renditionRef.current.reportLocation();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try { localStorage.setItem(FONT_KEY, String(fontScale)); } catch { /* ignore */ }
    renditionRef.current?.themes.fontSize(`${fontScale}%`);
    window.setTimeout(() => { void renditionRef.current?.reportLocation(); }, 0);
  }, [fontScale]);

  useEffect(() => {
    try { localStorage.setItem(PAGE_MODE_KEY, pageMode); } catch { /* ignore */ }
    const rendition = renditionRef.current;
    if (!rendition) return;
    const pageLayout = spreadForPageMode(pageMode);
    rendition.spread(pageLayout.spread, pageLayout.minSpreadWidth);
    if (containerRef.current) {
      const box = containerRef.current.getBoundingClientRect();
      rendition.resize(Math.floor(box.width), Math.floor(box.height));
    }
    window.setTimeout(() => { void rendition.reportLocation(); }, 0);
  }, [pageMode]);

  // Load this document's saved bookmarks for the panel + jump targets. Best-effort:
  // offline or an older server just yields an empty list and reading still works.
  useEffect(() => {
    let cancelled = false;
    setBookmarks([]);
    setBookmarksOpen(false);
    setEditingBookmarkId(null);
    api<{ bookmarks: EbookBookmark[] }>(
      `/api/library/books/${bookId}/ebook-bookmarks?documentId=${encodeURIComponent(documentId)}`
    )
      .then((payload) => { if (!cancelled) setBookmarks(sortBookmarks(payload.bookmarks)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [bookId, documentId]);

  if (error) {
    return <div className="epub-reader-status">{error}</div>;
  }

  const percentLabel = displayPercent(percentComplete);
  const progressWidth = `${Math.round((percentComplete ?? 0) * 100)}%`;
  const tocCount = tocItemCount(toc);

  return (
    <div className={`epub-reader${tocOpen ? " toc-open" : ""}`}>
      <div className="epub-reader-toolbar">
        <button
          className={`epub-tool-button${tocOpen ? " active" : ""}`}
          type="button"
          onClick={() => { setTocOpen((open) => !open); setBookmarksOpen(false); }}
          disabled={toc.length === 0}
          aria-expanded={tocOpen}
          aria-label="Table of contents"
          title="Table of contents"
        >
          <ListTree size={17} />
        </button>
        <button
          className={`epub-tool-button${bookmarksOpen ? " active" : ""}`}
          type="button"
          onClick={() => { setBookmarksOpen((open) => !open); setTocOpen(false); }}
          aria-expanded={bookmarksOpen}
          aria-label="Bookmarks"
          title="Bookmarks"
        >
          <Bookmark size={17} />
        </button>
        <div className="epub-reader-title">
          <strong>{sectionLabel}</strong>
          <span className={chapterError ? "epub-reader-warning" : ""}>
            {chapterError || (generatingLocations ? "Calculating position..." : percentLabel)}
          </span>
        </div>
        <div className="epub-page-mode" role="group" aria-label="Page layout">
          <button
            className={`epub-mode-button${pageMode === "single" ? " active" : ""}`}
            type="button"
            onClick={() => setPageMode("single")}
            aria-pressed={pageMode === "single"}
            aria-label="One page"
            title="One page"
          >
            <BookOpenText size={15} />
            <span>1</span>
          </button>
          <button
            className={`epub-mode-button${pageMode === "double" ? " active" : ""}`}
            type="button"
            onClick={() => setPageMode("double")}
            aria-pressed={pageMode === "double"}
            aria-label="Two pages"
            title="Two pages"
          >
            <Columns2 size={15} />
            <span>2</span>
          </button>
        </div>
        <div className="epub-font-controls" aria-label="Font size">
          <button
            className="epub-tool-button"
            type="button"
            onClick={() => setFontScale((size) => clampFontScale(size - 6))}
            aria-label="Decrease font size"
            title="Decrease font size"
          >
            <Minus size={16} />
          </button>
          <span>{fontScale}%</span>
          <button
            className="epub-tool-button"
            type="button"
            onClick={() => setFontScale((size) => clampFontScale(size + 6))}
            aria-label="Increase font size"
            title="Increase font size"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="epub-reader-main">
        {tocOpen && (
          <aside className="epub-toc-panel" aria-label="Table of contents">
            <div className="epub-toc-head">
              <strong>Contents</strong>
              <span>{tocCount} {tocCount === 1 ? "section" : "sections"}</span>
            </div>
            <div className="epub-toc-list">
              <TocItems items={toc} currentHref={currentHref} onSelect={selectTocItem} />
            </div>
          </aside>
        )}
        {bookmarksOpen && (
          <aside className="epub-toc-panel epub-bookmark-panel" aria-label="Bookmarks">
            <div className="epub-toc-head">
              <strong>Bookmarks</strong>
              <span>{bookmarks.length} {bookmarks.length === 1 ? "mark" : "marks"}</span>
            </div>
            <div className="epub-bookmark-list">
              <button
                className="epub-bookmark-add"
                type="button"
                onClick={addBookmark}
                disabled={loading || bookmarkBusy}
              >
                <BookmarkPlus size={15} aria-hidden="true" />
                <span>{bookmarkSaved ? "Bookmark added" : bookmarkBusy ? "Saving…" : "Bookmark this page"}</span>
              </button>
              {bookmarks.length === 0 ? (
                <p className="epub-bookmark-empty">No bookmarks yet. Save your spot to find it again later.</p>
              ) : (
                bookmarks.map((bm) => {
                  const editing = editingBookmarkId === bm.id;
                  return (
                    <div className={`epub-bookmark-item${editing ? " editing" : ""}`} key={bm.id}>
                      <div className="epub-bookmark-row">
                        <button className="epub-bookmark-jump" type="button" onClick={() => jumpToBookmark(bm)}>
                          <Bookmark size={13} aria-hidden="true" />
                          <span className="epub-bookmark-percent">{bookmarkPercent(bm.percentComplete)}</span>
                          <span className="epub-bookmark-label">{bm.label || "Bookmark"}</span>
                        </button>
                        <div className="epub-bookmark-actions">
                          <button
                            type="button"
                            onClick={() => { setEditingBookmarkId(bm.id); setNoteDraft(bm.note ?? ""); }}
                            aria-label="Edit note"
                            title="Edit note"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteBookmark(bm.id)}
                            aria-label="Delete bookmark"
                            title="Delete bookmark"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      {editing ? (
                        <div className="epub-bookmark-edit">
                          <textarea
                            className="epub-bookmark-note-input"
                            value={noteDraft}
                            onChange={(event) => setNoteDraft(event.target.value)}
                            placeholder="Add a note…"
                            rows={2}
                            autoFocus
                          />
                          <div className="epub-bookmark-edit-actions">
                            <button type="button" className="epub-bookmark-save" onClick={() => saveBookmarkNote(bm.id, noteDraft)}>Save</button>
                            <button type="button" className="epub-bookmark-cancel" onClick={() => setEditingBookmarkId(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        bm.note && <p className="epub-bookmark-note">{bm.note}</p>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        )}
        <button className="epub-nav" onClick={goPrev} disabled={loading || atStart} aria-label="Previous page">
          <ChevronLeft size={28} />
        </button>
        <div className="epub-reader-area" ref={containerRef}>
          {loading && <div className="epub-reader-status">Loading...</div>}
        </div>
        <button className="epub-nav" onClick={goNext} disabled={loading || atEnd} aria-label="Next page">
          <ChevronRight size={28} />
        </button>
      </div>

      <div className="epub-reader-footer">
        <span className="epub-progress-track" aria-hidden="true">
          <span style={{ width: progressWidth }} />
        </span>
        <span>{percentLabel}</span>
      </div>
    </div>
  );
}
