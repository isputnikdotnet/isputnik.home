import { useCallback, useEffect, useRef, useState } from "react";
import {
  ALargeSmall, ArrowLeft, Bookmark, BookmarkPlus, BookOpen, ChevronLeft, ChevronRight, Columns2, Download,
  List, Minus, Pencil, Plus, RotateCcw, ScrollText, Search, Settings, Sun, Trash2
} from "lucide-react";
import { api } from "../../../api";
import { useIsMobile } from "../../../shared/useIsMobile";
import type { EbookBookmark, ReadingProgress } from "../types";
import {
  applyLayout, countToc, createFoliateView, themeColors, themeCSS,
  type FoliateRelocateDetail, type FoliateLoadDetail, type FoliateTocItem, type FoliateView,
  type ReaderFont, type ReaderLayout, type ReaderTheme
} from "./foliate";

interface EbookReaderProps {
  bookId: string;
  documentId: string;
  url: string;
  storageKey: string;
  initialProgress: ReadingProgress | null;
  onProgressChange?: (progress: ReadingProgress) => void;
  title?: string;
  author?: string;
  coverUrl?: string | null;
  downloadUrl?: string;
  onExit?: () => void;
  // Guest mode (public share link): no account, so every per-user server call
  // (progress sync, bookmarks) is skipped — reading position lives in localStorage
  // only, and bookmarks are hidden.
  guest?: boolean;
}

interface ProgressDraft {
  cfi: string;
  percentComplete: number | null;
  label: string | null;
}

interface SearchHit {
  cfi: string;
  pre: string;
  match: string;
  post: string;
  chapter: string;
}

type Panel = "toc" | "bookmarks" | "search" | "settings" | "text" | null;

const FONT_KEY = "isputnik-ebk-font";
const FAMILY_KEY = "isputnik-ebk-family";
const LAYOUT_KEY = "isputnik-ebk-layout";
const THEME_KEY = "isputnik-ebk-theme";
const SPACING_KEY = "isputnik-ebk-spacing";
const THEMES: ReaderTheme[] = ["light", "sepia", "dark"];

function clampPercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function clampFontScale(value: number): number {
  return Math.max(80, Math.min(200, value));
}

function readNumber(key: string, fallback: number): number {
  try {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch {
    return fallback;
  }
}

function readLayout(): ReaderLayout {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === "single" || v === "double" || v === "scrolled" ? v : "single";
  } catch {
    return "single";
  }
}

function readFamily(): ReaderFont {
  try {
    return localStorage.getItem(FAMILY_KEY) === "sans" ? "sans" : "serif";
  } catch {
    return "serif";
  }
}

function readTheme(): ReaderTheme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "sepia" || v === "dark" ? v : "light";
  } catch {
    return "light";
  }
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

function percentLabel(percent: number | null | undefined) {
  if (percent == null) return "0%";
  return `${Math.round(clampPercent(percent)! * 100)}%`;
}

function bookmarkPercent(percent: number | null) {
  return percent == null ? "•" : `${Math.round(clampPercent(percent)! * 100)}%`;
}

function sortBookmarks(list: EbookBookmark[]) {
  return [...list].sort((a, b) => (a.percentComplete ?? 0) - (b.percentComplete ?? 0));
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

function TocList({
  items,
  currentHref,
  level = 0,
  onSelect
}: {
  items: FoliateTocItem[];
  currentHref: string;
  level?: number;
  onSelect: (href: string) => void;
}) {
  return (
    <>
      {items.map((item, i) => {
        const active = item.href !== "" && item.href === currentHref;
        return (
          <div className="ebk-toc-node" key={`${item.href}-${i}`}>
            <button
              className={`ebk-toc-item${active ? " active" : ""}`}
              style={{ paddingLeft: `${14 + level * 14}px` }}
              type="button"
              onClick={() => item.href && onSelect(item.href)}
            >
              {item.label}
            </button>
            {item.subitems && item.subitems.length > 0 && (
              <TocList items={item.subitems} currentHref={currentHref} level={level + 1} onSelect={onSelect} />
            )}
          </div>
        );
      })}
    </>
  );
}

export function EbookReader({
  bookId,
  documentId,
  url,
  storageKey,
  initialProgress,
  onProgressChange,
  title,
  author,
  coverUrl,
  downloadUrl,
  onExit,
  guest = false
}: EbookReaderProps) {
  const isMobile = useIsMobile();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const latestProgressRef = useRef<ProgressDraft | null>(null);
  const persistTimerRef = useRef<number | null>(null);
  const onProgressChangeRef = useRef(onProgressChange);
  const appearanceRef = useRef<{ theme: ReaderTheme; fontScale: number; lineSpacing: number; layout: ReaderLayout; fontFamily: ReaderFont }>(
    { theme: readTheme(), fontScale: clampFontScale(readNumber(FONT_KEY, 130)), lineSpacing: readNumber(SPACING_KEY, 1.7), layout: readLayout(), fontFamily: readFamily() }
  );
  const startingProgressRef = useRef<ReadingProgress | null | undefined>(undefined);
  if (startingProgressRef.current === undefined) {
    startingProgressRef.current = newerProgress(initialProgress, readStoredProgress(storageKey, documentId));
  }
  const startingProgress = startingProgressRef.current;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [toc, setToc] = useState<FoliateTocItem[]>([]);
  const [panel, setPanel] = useState<Panel>(null);
  const [percentComplete, setPercentComplete] = useState<number | null>(startingProgress?.percentComplete ?? null);
  const [sectionLabel, setSectionLabel] = useState(startingProgress?.label ?? "");
  const [currentHref, setCurrentHref] = useState("");
  const [pageInfo, setPageInfo] = useState<{ current: number; total: number } | null>(null);

  const [fontScale, setFontScale] = useState(appearanceRef.current.fontScale);
  const [lineSpacing, setLineSpacing] = useState(appearanceRef.current.lineSpacing);
  const [theme, setTheme] = useState<ReaderTheme>(appearanceRef.current.theme);
  const [layout, setLayout] = useState<ReaderLayout>(appearanceRef.current.layout);
  const [fontFamily, setFontFamily] = useState<ReaderFont>(appearanceRef.current.fontFamily);

  const [bookmarks, setBookmarks] = useState<EbookBookmark[]>([]);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const sendProgress = useCallback((progress: ProgressDraft) => {
    // Guests have no account to sync to — localStorage (in persistProgress) is the
    // only store, so skip the server PATCH entirely.
    if (guest) return Promise.resolve(undefined);
    return patchReadingProgress(bookId, documentId, progress).catch(() => undefined);
  }, [bookId, documentId, guest]);

  const persistProgress = useCallback((progress: ProgressDraft) => {
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
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void sendProgress(progress);
    }, 700);
  }, [documentId, sendProgress, storageKey]);

  const goLeft = useCallback(() => { void viewRef.current?.goLeft(); }, []);
  const goRight = useCallback(() => { void viewRef.current?.goRight(); }, []);

  const closePanels = useCallback(() => { setPanel(null); }, []);

  const goToHref = useCallback((href: string) => {
    void viewRef.current?.goTo(href).catch(() => setNotice("Could not open that location."));
    closePanels();
  }, [closePanels]);

  // Stable relocate handler — must not depend on changing state or the engine
  // effect would tear down and rebuild the view on every render.
  const onRelocate = useCallback((event: Event) => {
    const detail = (event as CustomEvent<FoliateRelocateDetail>).detail;
    if (!detail?.cfi) return;
    const fraction = clampPercent(detail.fraction);
    setPercentComplete(fraction);
    setCurrentHref(detail.tocItem?.href ?? "");
    const loc = detail.location;
    // foliate's location.current is 0-based; show a 1-based page clamped to total.
    setPageInfo(loc && Number.isFinite(loc.total) && loc.total > 0
      ? { current: Math.min(loc.current + 1, loc.total), total: loc.total }
      : null);
    const label = detail.tocItem?.label ?? null;
    if (label) setSectionLabel(label);
    persistProgress({ cfi: detail.cfi, percentComplete: fraction, label });
  }, [persistProgress]);

  const onLoad = useCallback((event: Event) => {
    const doc = (event as CustomEvent<FoliateLoadDetail>).detail?.doc;
    if (!doc) return;
    doc.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); void viewRef.current?.goLeft(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); void viewRef.current?.goRight(); }
    });
  }, []);

  useEffect(() => {
    onProgressChangeRef.current = onProgressChange;
  }, [onProgressChange]);

  // Engine lifecycle — runs once per opened document.
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;

    (async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error("Could not load this ebook.");
        // foliate's makeBook does format detection on the file *name* (e.g.
        // name.endsWith('.cbz')), so it needs a File, not a bare Blob. Give it an
        // .epub name so it takes the EPUB path.
        const data = await res.blob();
        const file = new File([data], "book.epub", { type: data.type || "application/epub+zip" });
        if (cancelled) return;

        let startCfi = startingProgress?.cfi ?? null;
        if (!startCfi && !guest) {
          try {
            const payload = await api<{ progress: ReadingProgress | null }>(
              `/api/library/books/${bookId}/reading-progress?documentId=${encodeURIComponent(documentId)}`
            );
            if (!cancelled && payload.progress?.cfi) {
              startCfi = payload.progress.cfi;
              writeStoredProgress(storageKey, payload.progress);
              setPercentComplete(payload.progress.percentComplete);
              if (payload.progress.label) setSectionLabel(payload.progress.label);
              onProgressChangeRef.current?.(payload.progress);
            }
          } catch {
            // No server progress / offline / older server — open from the start.
          }
        }
        if (cancelled) return;

        const view = createFoliateView();
        viewRef.current = view;
        view.addEventListener("relocate", onRelocate);
        view.addEventListener("load", onLoad);
        host.append(view);

        await view.open(file);
        if (cancelled) { try { view.close?.(); } catch { /* ignore */ } view.remove(); return; }

        setToc(view.book.toc ?? []);
        const a = appearanceRef.current;
        if (view.renderer) {
          view.renderer.setStyles(themeCSS(a.theme, a.fontScale, a.lineSpacing, a.fontFamily));
          applyLayout(view.renderer, a.layout);
        }
        await view.init({ lastLocation: startCfi, showTextStart: true });
        if (!cancelled) setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load this ebook.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (persistTimerRef.current != null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (latestProgressRef.current) void sendProgress(latestProgressRef.current);
      const view = viewRef.current;
      viewRef.current = null;
      if (view) {
        try { view.close?.(); } catch { /* ignore */ }
        try { view.remove(); } catch { /* ignore */ }
      }
    };
  }, [bookId, documentId, url, storageKey, startingProgress, sendProgress, onRelocate, onLoad, guest]);

  // Typography / theme changes — applied live, no view rebuild.
  useEffect(() => {
    appearanceRef.current.theme = theme;
    appearanceRef.current.fontScale = fontScale;
    appearanceRef.current.lineSpacing = lineSpacing;
    appearanceRef.current.fontFamily = fontFamily;
    try {
      localStorage.setItem(THEME_KEY, theme);
      localStorage.setItem(FONT_KEY, String(fontScale));
      localStorage.setItem(SPACING_KEY, String(lineSpacing));
      localStorage.setItem(FAMILY_KEY, fontFamily);
    } catch { /* ignore */ }
    viewRef.current?.renderer?.setStyles(themeCSS(theme, fontScale, lineSpacing, fontFamily));
  }, [theme, fontScale, lineSpacing, fontFamily]);

  // Page layout changes — applied live.
  useEffect(() => {
    appearanceRef.current.layout = layout;
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* ignore */ }
    const renderer = viewRef.current?.renderer;
    if (renderer) applyLayout(renderer, layout);
  }, [layout]);

  // Window-level keyboard: arrows turn pages, Escape closes panels / exits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); goLeft(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goRight(); }
      else if (e.key === "Escape") {
        if (panel) setPanel(null);
        else onExit?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goLeft, goRight, panel, onExit]);

  // Load this document's bookmarks. Best-effort. Guests have no account, so the
  // bookmarks UI is hidden and there is nothing to load.
  useEffect(() => {
    let cancelled = false;
    setBookmarks([]);
    setEditingBookmarkId(null);
    if (guest) return () => { cancelled = true; };
    api<{ bookmarks: EbookBookmark[] }>(
      `/api/library/books/${bookId}/ebook-bookmarks?documentId=${encodeURIComponent(documentId)}`
    )
      .then((payload) => { if (!cancelled) setBookmarks(sortBookmarks(payload.bookmarks)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [bookId, documentId, guest]);

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
          label: draft.label ?? sectionLabel ?? null
        })
      });
      setBookmarks((prev) => sortBookmarks([...prev, bookmark]));
      setNotice("");
    } catch {
      setNotice("Unable to save this bookmark.");
    } finally {
      setBookmarkBusy(false);
    }
  }, [bookId, documentId, sectionLabel]);

  const jumpToBookmark = useCallback((bookmark: EbookBookmark) => {
    void viewRef.current?.goTo(bookmark.cfi)
      .then(() => { setNotice(""); closePanels(); })
      .catch(() => setNotice("This bookmark could not be opened."));
  }, [closePanels]);

  const saveBookmarkNote = useCallback(async (id: string, note: string) => {
    try {
      const { bookmark } = await api<{ bookmark: EbookBookmark }>(`/api/library/books/${bookId}/ebook-bookmarks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ note })
      });
      setBookmarks((prev) => prev.map((entry) => (entry.id === id ? bookmark : entry)));
      setEditingBookmarkId(null);
    } catch {
      setNotice("Unable to save this note.");
    }
  }, [bookId]);

  const deleteBookmark = useCallback(async (id: string) => {
    try {
      await api(`/api/library/books/${bookId}/ebook-bookmarks/${id}`, { method: "DELETE" });
      setBookmarks((prev) => prev.filter((entry) => entry.id !== id));
      setEditingBookmarkId((current) => (current === id ? null : current));
    } catch {
      setNotice("Unable to delete this bookmark.");
    }
  }, [bookId]);

  const runSearch = useCallback(async () => {
    const view = viewRef.current;
    const query = searchQuery.trim();
    if (!view || !query) { setSearchHits([]); return; }
    setSearching(true);
    setSearchHits([]);
    const hits: SearchHit[] = [];
    try {
      for await (const item of view.search({ query })) {
        if (Array.isArray(item.subitems)) {
          for (const sub of item.subitems) {
            hits.push({
              cfi: sub.cfi,
              pre: sub.excerpt?.pre ?? "",
              match: sub.excerpt?.match ?? query,
              post: sub.excerpt?.post ?? "",
              chapter: item.label ?? ""
            });
          }
        } else if (item.cfi) {
          hits.push({
            cfi: item.cfi,
            pre: item.excerpt?.pre ?? "",
            match: item.excerpt?.match ?? query,
            post: item.excerpt?.post ?? "",
            chapter: item.label ?? ""
          });
        }
        if (hits.length >= 200) break;
      }
    } catch {
      // best-effort
    } finally {
      setSearchHits([...hits]);
      setSearching(false);
    }
  }, [searchQuery]);

  const resetPosition = useCallback(async () => {
    setPanel(null);
    if (!guest) {
      try { await api(`/api/library/books/${bookId}/reading-progress?documentId=${encodeURIComponent(documentId)}`, { method: "DELETE" }); } catch { /* ignore */ }
    }
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    void viewRef.current?.goTo(0);
  }, [bookId, documentId, storageKey, guest]);

  const togglePanel = useCallback((next: Panel) => {
    setPanel((current) => (current === next ? null : next));
  }, []);

  const cycleTheme = useCallback(() => {
    setTheme((current) => THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  }, []);

  const colors = themeColors(theme);
  const pct = percentComplete ?? 0;
  const pageLabel = pageInfo ? `${pageInfo.current} / ${pageInfo.total}` : percentLabel(percentComplete);
  const drawerSide = panel === "settings" || panel === "text" ? "right" : "left";

  if (error) {
    return (
      <div className="ebk-reader" data-theme={theme}>
        <div className="ebk-status">
          <p>{error}</p>
          <button type="button" className="ebk-text-button" onClick={onExit}>Close</button>
        </div>
      </div>
    );
  }

  // Text-appearance rows are shared between the "Aa" text panel and the full
  // Settings panel, so they stay in sync from one definition.
  const fontRow = (
    <div className="ebk-setting">
      <label>Font</label>
      <div className="ebk-seg">
        <button type="button" className={`ebk-seg-btn${fontFamily === "serif" ? " active" : ""}`} onClick={() => setFontFamily("serif")}>Serif</button>
        <button type="button" className={`ebk-seg-btn${fontFamily === "sans" ? " active" : ""}`} onClick={() => setFontFamily("sans")}>Sans</button>
      </div>
    </div>
  );
  const fontSizeRow = (
    <div className="ebk-setting">
      <label>Font size</label>
      <div className="ebk-stepper">
        <button type="button" onClick={() => setFontScale((s) => clampFontScale(s - 6))} aria-label="Smaller"><Minus size={16} /></button>
        <span>{fontScale}%</span>
        <button type="button" onClick={() => setFontScale((s) => clampFontScale(s + 6))} aria-label="Larger"><Plus size={16} /></button>
      </div>
    </div>
  );
  const lineSpacingRow = (
    <div className="ebk-setting">
      <label>Line spacing</label>
      <div className="ebk-stepper">
        <button type="button" onClick={() => setLineSpacing((s) => Math.max(1.2, Math.round((s - 0.1) * 10) / 10))} aria-label="Tighter"><Minus size={16} /></button>
        <span>{lineSpacing.toFixed(1)}</span>
        <button type="button" onClick={() => setLineSpacing((s) => Math.min(2.2, Math.round((s + 0.1) * 10) / 10))} aria-label="Looser"><Plus size={16} /></button>
      </div>
    </div>
  );

  return (
    <div className="ebk-reader" data-theme={theme} style={{ background: colors.bg, color: colors.fg }}>
      <header className={`ebk-topbar${isMobile ? " ebk-topbar-mobile" : ""}`}>
        <button type="button" className="ebk-icon-btn ebk-back-btn" onClick={onExit} aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        {!isMobile && (
          <div className="ebk-book">
            {coverUrl ? <img className="ebk-cover" src={coverUrl} alt="" /> : <span className="ebk-cover ebk-cover-fallback"><BookOpen size={18} /></span>}
            <div className="ebk-book-meta">
              <strong title={title}>{title ?? "Reading"}</strong>
              {author && <span>{author}</span>}
            </div>
          </div>
        )}
        <div className="ebk-topbar-actions">
          <button type="button" className={`ebk-icon-btn${panel === "search" ? " active" : ""}`} onClick={() => togglePanel("search")} aria-label="Search"><Search size={19} /></button>
          <button type="button" className={`ebk-icon-btn${panel === "text" ? " active" : ""}`} onClick={() => togglePanel("text")} aria-label="Text options"><ALargeSmall size={20} /></button>
          <button type="button" className="ebk-icon-btn" onClick={cycleTheme} aria-label="Change theme"><Sun size={19} /></button>
          {!guest && (
            <button type="button" className={`ebk-icon-btn${panel === "bookmarks" ? " active" : ""}`} onClick={() => togglePanel("bookmarks")} aria-label="Bookmarks"><Bookmark size={19} /></button>
          )}
          <button type="button" className={`ebk-icon-btn${panel === "settings" ? " active" : ""}`} onClick={() => togglePanel("settings")} aria-label="Settings"><Settings size={19} /></button>
        </div>
      </header>

      <div className="ebk-main">
        <div className="ebk-stage" ref={hostRef}>
          {loading && <div className="ebk-status"><p>Loading…</p></div>}
        </div>

        <button type="button" className="ebk-page-nav ebk-page-prev" onClick={goLeft} aria-label="Previous page" disabled={loading}>
          <span className="ebk-page-circle"><ChevronLeft size={22} /></span>
        </button>
        <button type="button" className="ebk-page-nav ebk-page-next" onClick={goRight} aria-label="Next page" disabled={loading}>
          <span className="ebk-page-circle"><ChevronRight size={22} /></span>
        </button>

        {panel && <button type="button" className="ebk-scrim" aria-label="Close" onClick={closePanels} />}

        {panel && (
          <aside className={`ebk-drawer ebk-drawer-${drawerSide}`} aria-label={panel}>
            {panel === "toc" && (
              <>
                <div className="ebk-drawer-head"><strong>Contents</strong><span>{countToc(toc)}</span></div>
                <div className="ebk-drawer-body">
                  {toc.length === 0
                    ? <p className="ebk-empty">No table of contents.</p>
                    : <TocList items={toc} currentHref={currentHref} onSelect={goToHref} />}
                </div>
              </>
            )}

            {panel === "bookmarks" && (
              <>
                <div className="ebk-drawer-head"><strong>Bookmarks</strong><span>{bookmarks.length}</span></div>
                <div className="ebk-drawer-body">
                  <button type="button" className="ebk-add-bookmark" onClick={addBookmark} disabled={loading || bookmarkBusy}>
                    <BookmarkPlus size={15} /> {bookmarkBusy ? "Saving…" : "Bookmark this page"}
                  </button>
                  {bookmarks.length === 0 ? (
                    <p className="ebk-empty">No bookmarks yet. Save your spot to find it again later.</p>
                  ) : bookmarks.map((bm) => {
                    const editing = editingBookmarkId === bm.id;
                    return (
                      <div className={`ebk-bookmark${editing ? " editing" : ""}`} key={bm.id}>
                        <div className="ebk-bookmark-row">
                          <button type="button" className="ebk-bookmark-jump" onClick={() => jumpToBookmark(bm)}>
                            <span className="ebk-bookmark-pct">{bookmarkPercent(bm.percentComplete)}</span>
                            <span className="ebk-bookmark-label">{bm.label || "Bookmark"}</span>
                          </button>
                          <div className="ebk-bookmark-actions">
                            <button type="button" onClick={() => { setEditingBookmarkId(bm.id); setNoteDraft(bm.note ?? ""); }} aria-label="Edit note"><Pencil size={14} /></button>
                            <button type="button" onClick={() => deleteBookmark(bm.id)} aria-label="Delete bookmark"><Trash2 size={14} /></button>
                          </div>
                        </div>
                        {editing ? (
                          <div className="ebk-bookmark-edit">
                            <textarea value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Add a note…" rows={2} autoFocus />
                            <div className="ebk-bookmark-edit-actions">
                              <button type="button" onClick={() => saveBookmarkNote(bm.id, noteDraft)}>Save</button>
                              <button type="button" onClick={() => setEditingBookmarkId(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : (bm.note && <p className="ebk-bookmark-note">{bm.note}</p>)}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {panel === "search" && (
              <>
                <div className="ebk-drawer-head"><strong>Search</strong>{searchHits.length > 0 && <span>{searchHits.length}</span>}</div>
                <form className="ebk-search-form" onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search this book…"
                    autoFocus
                  />
                  <button type="submit" disabled={searching || !searchQuery.trim()}>{searching ? "…" : "Go"}</button>
                </form>
                <div className="ebk-drawer-body">
                  {searching && <p className="ebk-empty">Searching…</p>}
                  {!searching && searchHits.length === 0 && searchQuery && <p className="ebk-empty">No matches.</p>}
                  {searchHits.map((hit, i) => (
                    <button type="button" className="ebk-search-hit" key={`${hit.cfi}-${i}`} onClick={() => goToHref(hit.cfi)}>
                      {hit.chapter && <span className="ebk-search-chapter">{hit.chapter}</span>}
                      <span className="ebk-search-excerpt">{hit.pre}<mark>{hit.match}</mark>{hit.post}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {panel === "settings" && (
              <>
                <div className="ebk-drawer-head"><strong>Settings</strong></div>
                <div className="ebk-drawer-body ebk-settings">
                  <div className="ebk-setting">
                    <label>Theme</label>
                    <div className="ebk-seg">
                      {THEMES.map((t) => (
                        <button key={t} type="button" className={`ebk-seg-btn${theme === t ? " active" : ""}`} onClick={() => setTheme(t)}>{t}</button>
                      ))}
                    </div>
                  </div>
                  {fontRow}
                  {fontSizeRow}
                  {lineSpacingRow}
                  <div className="ebk-setting">
                    <label>Layout</label>
                    <div className="ebk-seg">
                      <button type="button" className={`ebk-seg-btn${layout === "single" ? " active" : ""}`} onClick={() => setLayout("single")}><BookOpen size={15} /> 1</button>
                      <button type="button" className={`ebk-seg-btn${layout === "double" ? " active" : ""}`} onClick={() => setLayout("double")}><Columns2 size={15} /> 2</button>
                      <button type="button" className={`ebk-seg-btn${layout === "scrolled" ? " active" : ""}`} onClick={() => setLayout("scrolled")}><ScrollText size={15} /></button>
                    </div>
                  </div>
                  <div className="ebk-setting-actions">
                    {downloadUrl && (
                      <a className="ebk-menu-item" href={downloadUrl} download onClick={closePanels}>
                        <Download size={16} /> Download
                      </a>
                    )}
                    <button type="button" className="ebk-menu-item" onClick={resetPosition}>
                      <RotateCcw size={16} /> Reset position
                    </button>
                  </div>
                </div>
              </>
            )}

            {panel === "text" && (
              <>
                <div className="ebk-drawer-head"><strong>Text</strong></div>
                <div className="ebk-drawer-body ebk-settings">
                  {fontRow}
                  {fontSizeRow}
                  {lineSpacingRow}
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      <footer className={`ebk-bottombar${isMobile ? " ebk-bottombar-mobile" : ""}`}>
        <button type="button" className={`ebk-contents${panel === "toc" ? " active" : ""}`} onClick={() => togglePanel("toc")} aria-label="Chapters">
          <List size={20} />
        </button>
        <div className="ebk-seek">
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(pct * 1000)}
            aria-label="Reading progress"
            onChange={(e) => { void viewRef.current?.goToFraction(Number(e.target.value) / 1000); }}
          />
        </div>
        <span className="ebk-pageno">{pageLabel}</span>
      </footer>

      {notice && <div className="ebk-toast" role="status">{notice}</div>}
    </div>
  );
}
