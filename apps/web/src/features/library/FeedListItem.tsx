import { useEffect, useRef, useState } from "react";
import { BookOpen, DownloadCloud, HardDrive, Headphones, Heart, Info, Loader2, MoreVertical, Play } from "lucide-react";
import { api } from "../../api";
import { downloadBook, downloadEbook } from "../../offline/downloads";
import { navigate } from "../../router";
import { formatBytes, formatDuration } from "../../shared/utils";
import type { AudiobookBookDetail } from "../audiobooks/types";
import { authorLine, feedHref, type FeedItem } from "./feed";

// Mobile / PWA home-feed row: one book per line. Info column reads
// title → author → [offline button + progress bar] → run time / format. The
// action button plays (audiobook) or reads (ebook); a ⋮ menu carries the rest.
// Only mounts at the mobile breakpoint (see useIsMobile), so the desktop layout
// is untouched.
export function FeedListItem({ item, progress, downloaded, onDownloaded, onRead, onToast }: {
  item: FeedItem;
  progress?: boolean;
  downloaded?: boolean;
  onDownloaded?: (id: string) => void;
  onRead?: (item: FeedItem) => Promise<void>;
  onToast?: (message: string) => void;
}) {
  const href = feedHref(item);
  const isEbook = item.kind === "ebook";
  const percent = Math.round((item.percentComplete ?? 0) * 100);
  const inProgress = progress === true && percent > 0;

  const meta = isEbook
    ? [item.format?.toUpperCase(), item.totalSize != null ? formatBytes(item.totalSize) : null].filter(Boolean).join(" · ")
    : item.durationSeconds != null
      ? formatDuration(item.durationSeconds)
      : "";

  const [downloading, setDownloading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [fav, setFav] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const open = () => navigate(href);

  // Audiobooks open the player; ebooks open the inline reader (via onRead) and
  // fall back to the detail page when no reader handler is wired.
  const activatePrimary = () => {
    if (isEbook) {
      if (onRead) { setOpening(true); void onRead(item).finally(() => setOpening(false)); }
      else navigate(href);
    } else {
      navigate(`/player/${item.id}`);
    }
  };

  // Fetch the full detail (the feed item lacks file info) then hand off to the
  // audiobook or ebook offline-download helper.
  const startDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    onToast?.("Downloading…");
    try {
      const { book } = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${item.id}`);
      if (isEbook) {
        const doc = book.documents.find((d) => d.format === "epub") ?? book.documents[0] ?? null;
        if (doc) {
          await downloadEbook(item.id, doc.id, doc.url, {
            title: item.title,
            authors: item.authors,
            coverUrl: item.coverUrl,
            totalBytes: doc.size
          });
        }
      } else {
        await downloadBook(book);
      }
      onDownloaded?.(item.id);
      onToast?.("Saved for offline");
    } catch {
      onToast?.("Download failed");
    } finally {
      setDownloading(false);
    }
  };

  const toggleFav = async () => {
    if (favBusy) return;
    const next = !fav;
    setFav(next);
    setFavBusy(true);
    try {
      if (next) await api(`/api/library/books/${item.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${item.id}/save`, { method: "DELETE" });
    } catch {
      setFav(!next);
    } finally {
      setFavBusy(false);
    }
  };

  return (
    <article className="home-feed-row">
      <div
        className="home-feed-row-main"
        role="button"
        tabIndex={0}
        aria-label={`Open ${item.title}`}
        onClick={open}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}
      >
        <span className="home-feed-row-cover">
          {item.coverUrl ? (
            <img src={item.coverUrl} alt="" loading="lazy" />
          ) : isEbook ? (
            <BookOpen size={20} aria-hidden="true" />
          ) : (
            <Headphones size={20} aria-hidden="true" />
          )}
        </span>
        <span className="home-feed-row-info">
          <strong>{item.title}</strong>
          <small>{authorLine(item)}</small>
          {inProgress && (
            <span className="home-feed-row-bar" aria-label={`${percent}% complete`}>
              <span style={{ width: `${percent}%` }} />
            </span>
          )}
          <span className="home-feed-row-meta-row">
            {downloaded ? (
              <button
                type="button"
                className="home-feed-row-dl is-saved"
                onClick={(event) => { event.stopPropagation(); navigate(isEbook ? href : "/audiobooks/downloads"); }}
                title="Saved for offline"
                aria-label="Available offline"
              >
                <HardDrive size={11} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="home-feed-row-dl"
                onClick={(event) => { event.stopPropagation(); void startDownload(); }}
                disabled={downloading}
                title={downloading ? "Downloading…" : "Save for offline"}
                aria-label={downloading ? "Downloading…" : "Save for offline"}
              >
                {downloading
                  ? <Loader2 size={11} className="home-feed-spin" aria-hidden="true" />
                  : <DownloadCloud size={11} aria-hidden="true" />}
              </button>
            )}
            {meta && <span className="home-feed-row-meta">{meta}</span>}
          </span>
        </span>
      </div>

      <button
        type="button"
        className="home-feed-row-action"
        onClick={activatePrimary}
        disabled={opening}
        aria-label={isEbook ? (opening ? "Opening…" : `Read ${item.title}`) : `Play ${item.title}`}
        title={isEbook ? "Read" : "Play"}
      >
        {isEbook && opening ? (
          <Loader2 size={16} className="home-feed-spin" aria-hidden="true" />
        ) : isEbook ? (
          <BookOpen size={17} aria-hidden="true" />
        ) : (
          <Play size={16} fill="currentColor" aria-hidden="true" />
        )}
      </button>

      <div className="home-feed-row-menu" ref={menuRef}>
        <button
          type="button"
          className="home-feed-row-kebab"
          onClick={() => setMenuOpen((isOpen) => !isOpen)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`More options for ${item.title}`}
          title="More options"
        >
          <MoreVertical size={18} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="home-feed-row-dropdown" role="menu" aria-label={`Options for ${item.title}`}>
            <button
              type="button"
              role="menuitem"
              className={fav ? "is-fav" : ""}
              onClick={() => { setMenuOpen(false); void toggleFav(); }}
              disabled={favBusy}
            >
              <Heart size={16} fill={fav ? "currentColor" : "none"} aria-hidden="true" />
              <span>{fav ? "Favorited" : "Add to favorites"}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setMenuOpen(false); navigate(href); }}
            >
              <Info size={16} aria-hidden="true" />
              <span>View details</span>
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

export function FeedListItemSkeleton() {
  return (
    <div className="home-feed-row is-skeleton" aria-hidden="true">
      <span className="home-feed-row-cover" />
      <span style={{ flex: 1, display: "grid", gap: 6 }}>
        <span className="home-skeleton-line" style={{ width: "60%" }} />
        <span className="home-skeleton-line" style={{ width: "38%" }} />
      </span>
    </div>
  );
}
