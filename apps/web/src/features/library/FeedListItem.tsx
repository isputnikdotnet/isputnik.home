import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, DownloadCloud, HardDrive, Heart, Info, Loader2, MoreVertical, Play, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { formatBytes, formatDuration } from "../../shared/utils";
import { DEFAULT_COVERS } from "../audiobooks/covers";
import { authorLine, feedHref, saveFeedItemOffline, type FeedItem } from "./feed";
import { Button } from "../../shared/Button";

// A single ⋮-menu entry. When `menuItems` is supplied the row renders these
// instead of the default likes/details menu — this lets the library pages
// inject their full action set while keeping the identical row look.
export interface FeedRowMenuItem {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
}

// Mobile / PWA library row: one book per line. The text column reads
// title → author · run time → progress bar with its percentage; the cover wears
// a tick when the book is saved offline. The action button plays (audiobook) or
// reads (ebook), and a ⋮ menu — a bottom sheet on a phone, headed by the book
// it belongs to — carries everything else, saving for offline included.
// Only mounts at the mobile breakpoint (see useIsMobile), so the desktop layout
// is untouched.
export function FeedListItem({
  item,
  progress,
  downloaded,
  onDownloaded,
  onRead,
  onToast,
  onDownload,
  menuItems,
  hideDownload,
  onDelete,
  deleting,
  selectionMode,
  selected,
  onToggleSelect
}: {
  item: FeedItem;
  progress?: boolean;
  downloaded?: boolean;
  onDownloaded?: (id: string) => void;
  onRead?: (item: FeedItem) => Promise<void>;
  onToast?: (message: string) => void;
  onDownload?: (info: { title: string; progress: number } | null) => void;
  menuItems?: FeedRowMenuItem[];
  // Offline/Downloads use: no save-for-offline entry, no ⋮ menu, and a single
  // delete (trash) action in its place.
  hideDownload?: boolean;
  onDelete?: () => void;
  deleting?: boolean;
  /** Picking several books: the row ticks instead of opening. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const { t } = useTranslation(["common", "user"]);
  const href = feedHref(item);
  const isEbook = item.kind === "ebook";
  const percent = Math.round((item.percentComplete ?? 0) * 100);
  const inProgress = progress === true && percent > 0;

  const meta = isEbook
    ? [item.format?.toUpperCase(), item.totalSize != null ? formatBytes(item.totalSize) : null].filter(Boolean).join(" · ")
    : item.durationSeconds != null
      ? formatDuration(item.durationSeconds)
      : "";
  // One line under the title: who it is by, then how long it runs. They were two
  // lines and a button, which is what made every row 92px tall on a phone.
  const byline = [authorLine(item), meta].filter(Boolean).join(" · ");

  const [downloading, setDownloading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [liked, setLiked] = useState(false);
  const [likeBusy, setLikeBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (sheetRef.current?.contains(target)) return;
      setMenuOpen(false);
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

  const open = () => {
    if (selectionMode) onToggleSelect?.(item.id);
    else navigate(href);
  };

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
  // shared offline-save helper.
  const startDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    onDownload?.({ title: item.title, progress: 0 });
    try {
      await saveFeedItemOffline(item, (fraction) => onDownload?.({ title: item.title, progress: fraction }));
      onDownloaded?.(item.id);
      onToast?.(t("common:home.savedOffline"));
    } catch {
      onToast?.(t("common:home.downloadFailed"));
    } finally {
      onDownload?.(null);
      setDownloading(false);
    }
  };

  const toggleLike = async () => {
    if (likeBusy) return;
    const next = !liked;
    setLiked(next);
    setLikeBusy(true);
    try {
      if (next) await api(`/api/library/books/${item.id}/save`, { method: "PUT", body: JSON.stringify({ note: null }) });
      else await api(`/api/library/books/${item.id}/save`, { method: "DELETE" });
    } catch {
      setLiked(!next);
    } finally {
      setLikeBusy(false);
    }
  };

  // Saving for offline is a menu entry now, not a button on every row: it is a
  // once-per-book decision, and it was taking a line of the row from the words.
  const offlineEntry: FeedRowMenuItem[] = hideDownload
    ? []
    : downloaded
      ? [{ icon: HardDrive, label: t("common:home.availableOffline"), onClick: () => navigate(isEbook ? href : "/downloads") }]
      : [{
        icon: downloading ? Loader2 : DownloadCloud,
        label: downloading ? t("common:home.downloading") : t("common:home.saveForOffline"),
        onClick: () => void startDownload(),
        disabled: downloading
      }];

  const entries: FeedRowMenuItem[] = menuItems
    ? [...offlineEntry, ...menuItems]
    : [
      ...offlineEntry,
      {
        icon: Heart,
        label: liked ? t("user:likes.liked") : t("user:likes.like"),
        onClick: () => void toggleLike(),
        active: liked,
        disabled: likeBusy
      },
      { icon: Info, label: t("user:feed.viewDetails"), onClick: () => navigate(href) }
    ];

  return (
    <article className={`home-feed-row${selectionMode ? " is-selectable" : ""}${selected ? " is-selected" : ""}`}>
      <div
        className="home-feed-row-main"
        role="button"
        tabIndex={0}
        aria-label={t("user:feed.openItem", { title: item.title })}
        aria-pressed={selectionMode ? Boolean(selected) : undefined}
        onClick={open}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}
      >
        <span className="home-feed-row-cover">
          <img src={item.coverUrl ?? DEFAULT_COVERS[item.kind]} alt="" loading="lazy" />
          {/* Saved offline: a tick on the cover, where it says something about
              the book rather than asking for a tap. */}
          {downloaded && !hideDownload && !selectionMode && (
            <span className="home-feed-row-saved" title={t("common:home.savedOffline")} aria-label={t("common:home.availableOffline")}>
              <HardDrive size={11} aria-hidden="true" />
            </span>
          )}
          {selectionMode && (
            <span className="home-feed-row-tick" aria-hidden="true">
              {selected && <Check size={14} />}
            </span>
          )}
        </span>
        <span className="home-feed-row-info">
          <strong>{item.title}</strong>
          {byline && <small>{byline}</small>}
          {inProgress && (
            <span className="home-feed-row-progress">
              <span className="home-feed-row-bar" aria-label={t("user:feed.percentComplete", { percent })}>
                <span style={{ width: `${percent}%` }} />
              </span>
              <span className="home-feed-row-pct">{percent}%</span>
            </span>
          )}
        </span>
      </div>

      {!selectionMode && (
        <Button
          variant="bare"
          className="home-feed-row-action"
          onClick={activatePrimary}
          disabled={opening}
          aria-label={isEbook ? (opening ? t("user:feed.opening") : t("common:home.readTitle", { title: item.title })) : t("common:home.playTitle", { title: item.title })}
          title={isEbook ? t("common:home.read") : t("common:home.play")}
        >
          {isEbook && opening ? (
            <Loader2 size={15} className="home-feed-spin" aria-hidden="true" />
          ) : isEbook ? (
            <BookOpen size={16} aria-hidden="true" />
          ) : (
            <Play size={15} fill="currentColor" aria-hidden="true" />
          )}
        </Button>
      )}

      {onDelete ? (
        <Button
          variant="bare"
          className="home-feed-row-kebab home-feed-row-delete"
          onClick={onDelete}
          disabled={deleting}
          aria-label={t("user:downloads.removeFromDownloadsAria", { title: item.title })}
          title={t("user:downloads.removeDownload")}
        >
          {deleting
            ? <Loader2 size={16} className="home-feed-spin" aria-hidden="true" />
            : <Trash2 size={17} aria-hidden="true" />}
        </Button>
      ) : !selectionMode && (
        <div className="home-feed-row-menu" ref={triggerRef}>
          <Button
            variant="bare"
            className="home-feed-row-kebab"
            onClick={() => setMenuOpen((isOpen) => !isOpen)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("user:feed.moreOptionsFor", { title: item.title })}
            title={t("user:feed.moreOptions")}
          >
            <MoreVertical size={18} aria-hidden="true" />
          </Button>
          {/* Portalled: as a bottom sheet it must escape the row's box, and a
              row inside a scrolling list cannot position a fixed layer itself. */}
          {menuOpen && createPortal(
            <>
              <div className="home-feed-row-scrim" onMouseDown={() => setMenuOpen(false)} aria-hidden="true" />
              <div
                className="home-feed-row-dropdown"
                role="menu"
                ref={sheetRef}
                aria-label={t("user:feed.optionsFor", { title: item.title })}
              >
                <span className="mobile-sheet-handle" aria-hidden="true" />
                {/* Which book these actions belong to — a sheet covers the row
                    it was opened from, so the row can no longer say. */}
                <div className="home-feed-row-sheet-head">
                  <img src={item.coverUrl ?? DEFAULT_COVERS[item.kind]} alt="" />
                  <span>
                    <strong>{item.title}</strong>
                    {byline && <small>{byline}</small>}
                  </span>
                </div>
                {entries.map((entry, index) => {
                  const MenuIcon = entry.icon;
                  const inner = (
                    <>
                      <MenuIcon size={16} className={entry.icon === Loader2 ? "home-feed-spin" : undefined} aria-hidden="true" />
                      <span>{entry.label}</span>
                    </>
                  );
                  return entry.href ? (
                    <a
                      key={index}
                      role="menuitem"
                      href={entry.href}
                      download
                      className={entry.active ? "is-liked" : ""}
                      onClick={() => setMenuOpen(false)}
                    >
                      {inner}
                    </a>
                  ) : (
                    <Button
                      variant="bare"
                      key={index}
                      role="menuitem"
                      className={`${entry.danger ? "danger" : ""}${entry.active ? " is-liked" : ""}`.trim()}
                      onClick={() => { setMenuOpen(false); entry.onClick?.(); }}
                      disabled={entry.disabled}
                    >
                      {inner}
                    </Button>
                  );
                })}
              </div>
            </>,
            document.body
          )}
        </div>
      )}
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
