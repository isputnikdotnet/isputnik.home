import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, DownloadCloud, HardDrive, Heart, Info, Loader2, MoreVertical, Play, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../api";
import { navigate } from "../../router";
import { formatBytes, formatDuration } from "../../shared/utils";
import { DEFAULT_COVERS } from "../audiobooks/covers";
import { authorLine, feedHref, saveFeedItemOffline, type FeedItem } from "./feed";

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

// Mobile / PWA home-feed row: one book per line. Info column reads
// title → author → [offline button + progress bar] → run time / format. The
// action button plays (audiobook) or reads (ebook); a ⋮ menu carries the rest.
// Only mounts at the mobile breakpoint (see useIsMobile), so the desktop layout
// is untouched.
export function FeedListItem({ item, progress, downloaded, onDownloaded, onRead, onToast, onDownload, menuItems, hideDownload, onDelete, deleting }: {
  item: FeedItem;
  progress?: boolean;
  downloaded?: boolean;
  onDownloaded?: (id: string) => void;
  onRead?: (item: FeedItem) => Promise<void>;
  onToast?: (message: string) => void;
  onDownload?: (info: { title: string; progress: number } | null) => void;
  menuItems?: FeedRowMenuItem[];
  // Offline/Downloads use: hide the save-for-offline button, drop the ⋮ menu,
  // and show a single delete (trash) action in its place.
  hideDownload?: boolean;
  onDelete?: () => void;
  deleting?: boolean;
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

  const [downloading, setDownloading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [liked, setLiked] = useState(false);
  const [likeBusy, setLikeBusy] = useState(false);
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

  return (
    <article className="home-feed-row">
      <div
        className="home-feed-row-main"
        role="button"
        tabIndex={0}
        aria-label={t("user:feed.openItem", { title: item.title })}
        onClick={open}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}
      >
        <span className="home-feed-row-cover">
          <img src={item.coverUrl ?? DEFAULT_COVERS[item.kind]} alt="" loading="lazy" />
        </span>
        <span className="home-feed-row-info">
          <strong>{item.title}</strong>
          <small>{authorLine(item)}</small>
          {inProgress && (
            <span className="home-feed-row-bar" aria-label={t("user:feed.percentComplete", { percent })}>
              <span style={{ width: `${percent}%` }} />
            </span>
          )}
          {(!hideDownload || meta !== "") && (
            <span className="home-feed-row-meta-row">
              {!hideDownload && (downloaded ? (
                <button
                  type="button"
                  className="home-feed-row-dl is-saved"
                  onClick={(event) => { event.stopPropagation(); navigate(isEbook ? href : "/downloads"); }}
                  title={t("common:home.savedOffline")}
                  aria-label={t("common:home.availableOffline")}
                >
                  <HardDrive size={11} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="home-feed-row-dl"
                  onClick={(event) => { event.stopPropagation(); void startDownload(); }}
                  disabled={downloading}
                  title={downloading ? t("common:home.downloading") : t("common:home.saveForOffline")}
                  aria-label={downloading ? t("common:home.downloading") : t("common:home.saveForOffline")}
                >
                  {downloading
                    ? <Loader2 size={11} className="home-feed-spin" aria-hidden="true" />
                    : <DownloadCloud size={11} aria-hidden="true" />}
                </button>
              ))}
              {meta && <span className="home-feed-row-meta">{meta}</span>}
            </span>
          )}
        </span>
      </div>

      <button
        type="button"
        className="home-feed-row-action"
        onClick={activatePrimary}
        disabled={opening}
        aria-label={isEbook ? (opening ? t("user:feed.opening") : t("common:home.readTitle", { title: item.title })) : t("common:home.playTitle", { title: item.title })}
        title={isEbook ? t("common:home.read") : t("common:home.play")}
      >
        {isEbook && opening ? (
          <Loader2 size={16} className="home-feed-spin" aria-hidden="true" />
        ) : isEbook ? (
          <BookOpen size={17} aria-hidden="true" />
        ) : (
          <Play size={16} fill="currentColor" aria-hidden="true" />
        )}
      </button>

      {onDelete ? (
        <button
          type="button"
          className="home-feed-row-kebab home-feed-row-delete"
          onClick={onDelete}
          disabled={deleting}
          aria-label={t("user:downloads.removeFromDownloadsAria", { title: item.title })}
          title={t("user:downloads.removeDownload")}
        >
          {deleting
            ? <Loader2 size={16} className="home-feed-spin" aria-hidden="true" />
            : <Trash2 size={17} aria-hidden="true" />}
        </button>
      ) : (
      <div className="home-feed-row-menu" ref={menuRef}>
        <button
          type="button"
          className="home-feed-row-kebab"
          onClick={() => setMenuOpen((isOpen) => !isOpen)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("user:feed.moreOptionsFor", { title: item.title })}
          title={t("user:feed.moreOptions")}
        >
          <MoreVertical size={18} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="home-feed-row-dropdown" role="menu" aria-label={t("user:feed.optionsFor", { title: item.title })}>
            {menuItems ? (
              menuItems.map((entry, index) => {
                const MenuIcon = entry.icon;
                const inner = (
                  <>
                    <MenuIcon size={16} aria-hidden="true" />
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
                  <button
                    key={index}
                    type="button"
                    role="menuitem"
                    className={`${entry.danger ? "danger" : ""}${entry.active ? " is-liked" : ""}`.trim()}
                    onClick={() => { setMenuOpen(false); entry.onClick?.(); }}
                    disabled={entry.disabled}
                  >
                    {inner}
                  </button>
                );
              })
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className={liked ? "is-liked" : ""}
                  onClick={() => { setMenuOpen(false); void toggleLike(); }}
                  disabled={likeBusy}
                >
                  <Heart size={16} fill={liked ? "currentColor" : "none"} aria-hidden="true" />
                  <span>{liked ? t("user:likes.liked") : t("user:likes.like")}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setMenuOpen(false); navigate(href); }}
                >
                  <Info size={16} aria-hidden="true" />
                  <span>{t("user:feed.viewDetails")}</span>
                </button>
              </>
            )}
          </div>
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
