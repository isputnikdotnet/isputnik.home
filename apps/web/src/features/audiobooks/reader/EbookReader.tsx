import { useCallback, useEffect, useRef, useState } from "react";
import {
  ALargeSmall, ArrowLeft, Bookmark, BookmarkPlus, BookOpen, ChevronLeft, ChevronRight, Columns2, Copy, Download,
  Highlighter, List, Minus, Pencil, Plus, RotateCcw, ScrollText, Search, Settings, Sun, Trash2
} from "lucide-react";
import { api } from "../../../api";
import { saveQuote, getLocalQuotes, deleteLocalQuote, updateLocalQuoteColor, isLocalQuoteId } from "../../../offline/quotes";
import { saveBookmark, getLocalBookmarks, deleteLocalBookmark, updateLocalBookmarkNote, isLocalBookmarkId } from "../../../offline/bookmarks";
import { useIsMobile } from "../../../shared/useIsMobile";
import { foliateFileInfo } from "../../../shared/utils";
import type { EbookBookmark, Quote, ReadingProgress } from "../types";
import {
  applyLayout, countToc, createFoliateView, drawHighlight, highlightFill, themeColors, themeCSS,
  HIGHLIGHT_COLORS,
  type FoliateRelocateDetail, type FoliateLoadDetail, type FoliateDrawAnnotationDetail,
  type FoliateShowAnnotationDetail, type FoliateTocItem, type FoliateView,
  type ReaderFont, type ReaderLayout, type ReaderTheme
} from "./foliate";

interface EbookReaderProps {
  bookId: string;
  documentId: string;
  // The document's format ("epub" | "fb2"). foliate detects the book type from the
  // File name, so this decides how the fetched blob is named before view.open().
  format: string;
  // Network URL for the document. Optional because a downloaded book is read
  // straight from its offline `blob` and may have no reachable URL.
  url?: string;
  // When set, the document is loaded directly from this Blob (offline download)
  // instead of being fetched. This keeps the blob's lifecycle inside the reader
  // so a parent revoking an object URL can't pull the data out mid-load — the
  // bug that broke opening downloaded books under React StrictMode.
  blob?: Blob | null;
  storageKey: string;
  initialProgress: ReadingProgress | null;
  // When opened from a quote/bookmark deep link, start at this exact CFI regardless
  // of stored progress (so "open in reader" lands on the quoted passage).
  initialCfi?: string | null;
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
  format,
  url,
  blob,
  storageKey,
  initialProgress,
  initialCfi,
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
  // Download href for an offline book is derived from its Blob here so the
  // object URL is created and revoked inside this component (StrictMode-safe),
  // never handed in from a parent that might revoke it early.
  const [blobDownloadHref, setBlobDownloadHref] = useState<string | null>(null);
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

  // Quotes / highlights. `quotesRef` mirrors the document's saved quotes so the
  // load handler can redraw their overlays without re-rendering React; `selection`
  // anchors the capture toolbar over a fresh text selection; `activeQuote` anchors
  // the popover shown when an existing highlight is tapped.
  const quotesRef = useRef<Quote[]>([]);
  const sectionIndexRef = useRef(0);
  const [selection, setSelection] = useState<{ x: number; top: number; bottom: number; text: string; cfi: string } | null>(null);
  const [activeQuote, setActiveQuote] = useState<{ quote: Quote; x: number; y: number } | null>(null);

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
    // A page turn invalidates the on-screen anchors for the capture toolbar and the
    // highlight popover, so dismiss them.
    setSelection(null);
    setActiveQuote(null);
    persistProgress({ cfi: detail.cfi, percentComplete: fraction, label });
  }, [persistProgress]);

  const onLoad = useCallback((event: Event) => {
    const detail = (event as CustomEvent<FoliateLoadDetail>).detail;
    const doc = detail?.doc;
    if (!doc) return;
    const index = detail.index ?? 0;
    sectionIndexRef.current = index;

    doc.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); void viewRef.current?.goLeft(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); void viewRef.current?.goRight(); }
    });

    // Repaint this freshly-loaded section's highlights. addAnnotation only draws on
    // the section whose overlayer currently exists, so this must run on every load.
    const view = viewRef.current;
    if (view) {
      for (const quote of quotesRef.current) {
        if (quote.cfi) void view.addAnnotation({ value: quote.cfi, color: quote.color ?? undefined }).catch(() => undefined);
      }
    }

    // Text selection → quote toolbar. `selectionchange` is the signal that works in
    // every mode: on touch (PWA / tablet) a long-press selection is finalised through
    // the native drag handles *after* touchend, and the foliate paginator owns the
    // touchstart/touchend gestures, so our own touch/mouse listeners on the doc never
    // see the finished selection. selectionchange fires on the document regardless.
    // Debounced so it settles before we read it; mouseup keeps desktop instant.
    const captureSelection = () => {
      const v = viewRef.current;
      if (!v) return;
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setSelection(null); return; }
      const text = sel.toString().trim();
      if (!text) { setSelection(null); return; }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { setSelection(null); return; }
      const frameRect = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
      const offsetX = frameRect?.left ?? 0;
      const offsetY = frameRect?.top ?? 0;
      let cfi = "";
      try { cfi = v.getCFI(index, range); } catch { /* range not addressable */ }
      setSelection({
        x: offsetX + rect.left + rect.width / 2,
        top: offsetY + rect.top,
        bottom: offsetY + rect.bottom,
        text,
        cfi
      });
    };
    let selectionTimer = 0;
    doc.addEventListener("mouseup", captureSelection);
    doc.addEventListener("selectionchange", () => {
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setSelection(null); return; }
      window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(captureSelection, 220);
    });
  }, []);

  // Paint a highlight when foliate asks, and open the highlight popover when an
  // existing one is tapped. Both stable so the engine effect never rebuilds.
  const onDrawAnnotation = useCallback((event: Event) => {
    drawHighlight((event as CustomEvent<FoliateDrawAnnotationDetail>).detail);
  }, []);

  const onShowAnnotation = useCallback((event: Event) => {
    const detail = (event as CustomEvent<FoliateShowAnnotationDetail>).detail;
    const quote = quotesRef.current.find((q) => q.cfi === detail.value);
    if (!quote) return;
    const rect = detail.range.getBoundingClientRect();
    const doc = detail.range.startContainer.ownerDocument;
    const frameRect = (doc?.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
    setSelection(null);
    setActiveQuote({
      quote,
      x: (frameRect?.left ?? 0) + rect.left + rect.width / 2,
      y: (frameRect?.top ?? 0) + rect.bottom
    });
  }, []);

  useEffect(() => {
    onProgressChangeRef.current = onProgressChange;
  }, [onProgressChange]);

  // Own the object URL for the offline-download button: create on mount, revoke
  // on cleanup, so it can never be revoked out from under us.
  useEffect(() => {
    if (!blob) { setBlobDownloadHref(null); return undefined; }
    const href = URL.createObjectURL(blob);
    setBlobDownloadHref(href);
    return () => URL.revokeObjectURL(href);
  }, [blob]);
  const downloadHref = blob ? blobDownloadHref : downloadUrl;

  // Engine lifecycle — runs once per opened document.
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;

    (async () => {
      try {
        // Downloaded books are read from their stored Blob directly; only fall
        // back to the network when no offline copy was handed in.
        let data: Blob;
        if (blob) {
          data = blob;
        } else {
          if (!url) throw new Error("Could not load this ebook.");
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) throw new Error("Could not load this ebook.");
          data = await res.blob();
        }
        if (cancelled) return;
        // foliate's makeBook does format detection on the file *name* (e.g.
        // name.endsWith('.fb2')), so it needs a File, not a bare Blob. Name it to
        // match this document's format so foliate picks the right parser.
        const { name, mime } = foliateFileInfo(format);
        const file = new File([data], name, { type: data.type || mime });
        if (cancelled) return;

        let startCfi = initialCfi ?? startingProgress?.cfi ?? null;
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
        view.addEventListener("draw-annotation", onDrawAnnotation);
        view.addEventListener("show-annotation", onShowAnnotation);
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

        // Load this document's saved quotes — server quotes plus any captured
        // offline and not yet synced — and paint the ones on screen. onLoad repaints
        // the rest as their sections come into view (via quotesRef). Works offline:
        // the server fetch just yields nothing and the local ones still draw.
        if (!guest) {
          void (async () => {
            const display = { sourceTitle: title ?? null, sourceAuthors: author ? [author] : [] };
            let merged: Quote[] = [];
            try {
              const { quotes } = await api<{ quotes: Quote[] }>(`/api/library/quotes?documentId=${encodeURIComponent(documentId)}`);
              merged = quotes;
            } catch { /* offline or older server — fall back to local only */ }
            try {
              const seen = new Set(merged.map((q) => q.cfi).filter(Boolean));
              for (const local of await getLocalQuotes(documentId, display)) {
                if (!local.cfi || !seen.has(local.cfi)) merged.push(local);
              }
            } catch { /* ignore */ }
            if (cancelled) return;
            quotesRef.current = merged;
            for (const quote of merged) {
              if (quote.cfi) void view.addAnnotation({ value: quote.cfi, color: quote.color ?? undefined }).catch(() => undefined);
            }
          })();
        }
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
  }, [bookId, documentId, format, url, blob, storageKey, startingProgress, initialCfi, title, author, sendProgress, onRelocate, onLoad, onDrawAnnotation, onShowAnnotation, guest]);

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
        if (activeQuote) setActiveQuote(null);
        else if (selection) setSelection(null);
        else if (panel) setPanel(null);
        else onExit?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goLeft, goRight, panel, selection, activeQuote, onExit]);

  // Transient quote/copy notices clear themselves so the toast never lingers.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Load this document's bookmarks — server bookmarks plus any captured offline and
  // not yet synced. Best-effort and offline-safe: the server fetch just yields
  // nothing offline and the local ones still show. Guests have no account, so the
  // bookmarks UI is hidden and there is nothing to load.
  useEffect(() => {
    let cancelled = false;
    setBookmarks([]);
    setEditingBookmarkId(null);
    if (guest) return () => { cancelled = true; };
    void (async () => {
      let merged: EbookBookmark[] = [];
      try {
        const payload = await api<{ bookmarks: EbookBookmark[] }>(
          `/api/library/books/${bookId}/ebook-bookmarks?documentId=${encodeURIComponent(documentId)}`
        );
        merged = payload.bookmarks;
      } catch { /* offline — fall back to local only */ }
      try {
        const seen = new Set(merged.map((b) => b.cfi));
        for (const local of await getLocalBookmarks(documentId)) {
          if (!seen.has(local.cfi)) merged.push(local);
        }
      } catch { /* ignore */ }
      if (!cancelled) setBookmarks(sortBookmarks(merged));
    })();
    return () => { cancelled = true; };
  }, [bookId, documentId, guest]);

  const addBookmark = useCallback(async () => {
    const draft = latestProgressRef.current;
    if (!draft?.cfi) return;
    setBookmarkBusy(true);
    try {
      // saveBookmark POSTs when online and otherwise queues offline, returning a
      // bookmark (real or local) so the panel updates immediately either way.
      const bookmark = await saveBookmark({
        bookId,
        documentId,
        cfi: draft.cfi,
        percentComplete: draft.percentComplete,
        label: draft.label ?? sectionLabel ?? null,
        note: null
      });
      setBookmarks((prev) => sortBookmarks([...prev, bookmark]));
      setNotice(isLocalBookmarkId(bookmark.id) ? "Bookmark saved — will sync when online." : "");
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
      // A not-yet-synced bookmark has no server row — edit it in the offline queue.
      if (isLocalBookmarkId(id)) {
        await updateLocalBookmarkNote(id, note);
        setBookmarks((prev) => prev.map((entry) => (entry.id === id ? { ...entry, note: note || null } : entry)));
        setEditingBookmarkId(null);
        return;
      }
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
      if (isLocalBookmarkId(id)) await deleteLocalBookmark(id);
      else await api(`/api/library/books/${bookId}/ebook-bookmarks/${id}`, { method: "DELETE" });
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

  // ── quotes / highlights ──────────────────────────────────────────────────────
  // These read the live `selection`/`activeQuote` state, so they stay plain closures
  // recreated each render rather than memoised callbacks.
  const saveSelectionQuote = async (color: string) => {
    if (!selection || guest) return;
    const { text, cfi } = selection;
    setSelection(null);
    try {
      // saveQuote POSTs when online and otherwise queues offline, returning a quote
      // (real or local) either way so the highlight shows immediately.
      const quote = await saveQuote(
        {
          itemId: bookId,
          documentId,
          cfi: cfi || null,
          text,
          color,
          percentComplete: latestProgressRef.current?.percentComplete ?? null
        },
        { sourceTitle: title ?? null, sourceAuthors: author ? [author] : [] }
      );
      quotesRef.current = [...quotesRef.current, quote];
      if (quote.cfi) void viewRef.current?.addAnnotation({ value: quote.cfi, color: quote.color ?? undefined });
      setNotice(isLocalQuoteId(quote.id) ? "Quote saved — will sync when online." : "Quote saved.");
    } catch {
      setNotice("Unable to save this quote.");
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to clipboard.");
    } catch {
      setNotice("Couldn't copy — clipboard access was blocked.");
    }
  };

  const copySelection = async () => {
    if (!selection) return;
    const text = selection.text;
    setSelection(null);
    await copyText(text);
  };

  const recolorActiveQuote = async (color: string) => {
    if (!activeQuote) return;
    const target = activeQuote.quote;
    setActiveQuote(null);
    try {
      // A not-yet-synced quote has no server row — update it in the offline queue.
      if (isLocalQuoteId(target.id)) {
        await updateLocalQuoteColor(target.id, color);
        const updated = { ...target, color };
        quotesRef.current = quotesRef.current.map((q) => (q.id === target.id ? updated : q));
        if (updated.cfi) void viewRef.current?.addAnnotation({ value: updated.cfi, color });
        return;
      }
      const { quote } = await api<{ quote: Quote }>(`/api/library/quotes/${target.id}`, {
        method: "PATCH",
        body: JSON.stringify({ color })
      });
      quotesRef.current = quotesRef.current.map((q) => (q.id === quote.id ? quote : q));
      if (quote.cfi) void viewRef.current?.addAnnotation({ value: quote.cfi, color: quote.color ?? undefined });
    } catch {
      setNotice("Unable to update this highlight.");
    }
  };

  const deleteActiveQuote = async () => {
    if (!activeQuote) return;
    const target = activeQuote.quote;
    setActiveQuote(null);
    try {
      if (isLocalQuoteId(target.id)) await deleteLocalQuote(target.id);
      else await api(`/api/library/quotes/${target.id}`, { method: "DELETE" });
      quotesRef.current = quotesRef.current.filter((q) => q.id !== target.id);
      if (target.cfi) void viewRef.current?.deleteAnnotation({ value: target.cfi });
      setNotice("Highlight removed.");
    } catch {
      setNotice("Unable to remove this highlight.");
    }
  };

  const colors = themeColors(theme);
  const pct = percentComplete ?? 0;
  const pageLabel = pageInfo ? `${pageInfo.current} / ${pageInfo.total}` : percentLabel(percentComplete);
  const drawerSide = panel === "settings" || panel === "text" ? "right" : "left";

  if (error) {
    return (
      <div className="ebk-reader" data-theme={theme} style={{ background: colors.bg, color: colors.fg }}>
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
                    {downloadHref && (
                      <a className="ebk-menu-item" href={downloadHref} download onClick={closePanels}>
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

      {/* Floating capture toolbar over a fresh text selection. On touch we sit it
          below the selection so it clears the native selection callout above, and
          clamp its centre so it can't overflow a narrow screen's edges. */}
      {selection && (
        <div
          className={`ebk-sel-toolbar${isMobile ? " below" : ""}`}
          style={{
            left: `${Math.min(Math.max(selection.x, 120), window.innerWidth - 120)}px`,
            top: `${isMobile ? selection.bottom : selection.top}px`
          }}
          role="toolbar"
          aria-label="Selection actions"
        >
          {!guest && (
            <>
              <span className="ebk-sel-lead" aria-hidden="true"><Highlighter size={15} /></span>
              {Object.keys(HIGHLIGHT_COLORS).map((color) => (
                <button
                  key={color}
                  type="button"
                  className="ebk-sel-color"
                  style={{ background: highlightFill(color) }}
                  onClick={() => void saveSelectionQuote(color)}
                  aria-label={`Highlight ${color}`}
                  title={`Highlight ${color}`}
                />
              ))}
              <span className="ebk-sel-divider" aria-hidden="true" />
            </>
          )}
          <button type="button" className="ebk-sel-btn" onClick={() => void copySelection()} aria-label="Copy" title="Copy">
            <Copy size={15} />
          </button>
        </div>
      )}

      {/* Popover shown when an existing highlight is tapped. */}
      {activeQuote && (
        <>
          <button type="button" className="ebk-quote-scrim" aria-label="Close" onClick={() => setActiveQuote(null)} />
          <div
            className="ebk-quote-pop"
            style={{ left: `${Math.min(Math.max(activeQuote.x, 120), window.innerWidth - 120)}px`, top: `${activeQuote.y}px` }}
            role="dialog"
            aria-label="Highlight actions"
          >
            {!guest && Object.keys(HIGHLIGHT_COLORS).map((color) => (
              <button
                key={color}
                type="button"
                className={`ebk-sel-color${activeQuote.quote.color === color ? " active" : ""}`}
                style={{ background: highlightFill(color) }}
                onClick={() => void recolorActiveQuote(color)}
                aria-label={`Recolor ${color}`}
                title={`Recolor ${color}`}
              />
            ))}
            <span className="ebk-sel-divider" aria-hidden="true" />
            <button
              type="button"
              className="ebk-sel-btn"
              onClick={() => { const t = activeQuote.quote.text; setActiveQuote(null); void copyText(t); }}
              aria-label="Copy"
              title="Copy"
            >
              <Copy size={15} />
            </button>
            {!guest && (
              <button type="button" className="ebk-sel-btn danger" onClick={() => void deleteActiveQuote()} aria-label="Delete highlight" title="Delete highlight">
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </>
      )}

      {notice && <div className="ebk-toast" role="status">{notice}</div>}
    </div>
  );
}
