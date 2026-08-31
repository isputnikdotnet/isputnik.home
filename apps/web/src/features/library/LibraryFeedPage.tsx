import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Clock, Headphones, Loader2, type LucideIcon } from "lucide-react";
import type { PublicUser } from "../../api";
import { DashboardShell } from "../../app/DashboardShell";
import { MessageBox } from "../../shared/MessageBox";
import { useIsMobile } from "../../shared/useIsMobile";
import { listDownloads, listEbookDownloads } from "../../offline/downloads";
import { fetchFeed, type FeedItem, type FeedMode } from "./feed";
import { FeedTile, FeedTileSkeleton } from "./FeedTile";
import { FeedListItem, FeedListItemSkeleton } from "./FeedListItem";

// The page shows the most recent N — no pagination, just the latest slice.
const LIMIT = 50;

const MODE_ICONS: Record<FeedMode, LucideIcon> = {
  recent: Clock,
  continue: Headphones
};

// Unified, cross-type feed page behind the home rows' "View all" links. `recent`
// lists newest additions across audiobooks + ebooks; `continue` lists in-progress.
// Capped at the latest LIMIT items. Renders the same way the home rows do:
// list rows on phones, the catalog tile grid on desktop.
export function LibraryFeedPage({ mode, user, logout }: { mode: FeedMode; user: PublicUser; logout: () => Promise<void> }) {
  const isMobile = useIsMobile();
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState("");
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeDownload, setActiveDownload] = useState<{ title: string; progress: number } | null>(null);
  const { t } = useTranslation(["common", "user"]);
  // Literal key-suffix lookup (not a plain string) so t()'s overload resolves —
  // see the namespace-key typing pitfalls in docs/i18n-plan.md.
  const MODE_KEYS: Record<FeedMode, { title: "recentTitle" | "continueTitle"; emptyHeading: "recentEmptyHeading" | "continueEmptyHeading"; empty: "recentEmpty" | "continueEmpty" }> = {
    recent: { title: "recentTitle", emptyHeading: "recentEmptyHeading", empty: "recentEmpty" },
    continue: { title: "continueTitle", emptyHeading: "continueEmptyHeading", empty: "continueEmpty" }
  };
  const modeKeys = MODE_KEYS[mode];
  const meta = {
    title: t(`user:feed.${modeKeys.title}`),
    emptyHeading: t(`user:feed.${modeKeys.emptyHeading}`),
    empty: t(`user:feed.${modeKeys.empty}`),
    icon: MODE_ICONS[mode]
  };

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const handleDownloaded = useCallback((id: string) => {
    setDownloadedIds((prev) => new Set([...prev, id]));
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    let alive = true;
    Promise.allSettled([listDownloads(), listEbookDownloads()]).then(([audio, ebooks]) => {
      if (!alive) return;
      const ids = new Set<string>();
      if (audio.status === "fulfilled") audio.value.forEach((d) => ids.add(d.bookId));
      if (ebooks.status === "fulfilled") ebooks.value.forEach((d) => ids.add(d.bookId));
      setDownloadedIds(ids);
    });
    return () => { alive = false; };
  }, [isMobile]);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError("");
    fetchFeed(mode, LIMIT, 0)
      .then((res) => { if (alive) setItems(res.items); })
      .catch((err) => {
        if (!alive) return;
        setItems([]);
        setError(err instanceof Error ? err.message : t("user:feed.loadFailed"));
      });
    return () => { alive = false; };
  }, [mode]);

  const EmptyIcon = meta.icon;

  return (
    <>
    <DashboardShell active="home" user={user} logout={logout}>
      {/* Same full-width wrapper the Audiobooks page uses, so the catalog grid
          fits the same number of columns (work-area caps width at 1040px). */}
      <section className="audiobook-main-page">
        <div className="section-head audiobook-head">
          <div>
            <p className="eyebrow">{t("user:feed.eyebrow")}</p>
            <h1>{meta.title}</h1>
          </div>
          {items != null && items.length > 0 && (
            <span>{t("user:count.items", { count: items.length })}</span>
          )}
        </div>

        {error && <MessageBox tone="error" title={t("user:common.unableToLoad")}>{error}</MessageBox>}

        {items != null && items.length === 0 && !error ? (
          <div className="empty-state library-empty">
            <EmptyIcon size={58} aria-hidden="true" />
            <h2>{meta.emptyHeading}</h2>
            <p className="muted">{meta.empty}</p>
          </div>
        ) : isMobile ? (
          <div className="home-feed-list">
            {items === null
              ? Array.from({ length: 8 }).map((_, index) => <FeedListItemSkeleton key={index} />)
              : items.map((item) => (
                <FeedListItem
                  key={`${item.kind}-${item.id}`}
                  item={item}
                  progress={mode === "continue"}
                  downloaded={downloadedIds.has(item.id)}
                  onDownloaded={handleDownloaded}
                  onToast={showToast}
                  onDownload={setActiveDownload}
                />
              ))}
          </div>
        ) : (
          <div className="library-feed-grid">
            {items === null
              ? Array.from({ length: 12 }).map((_, index) => <FeedTileSkeleton key={index} />)
              : items.map((item) => (
                <FeedTile key={`${item.kind}-${item.id}`} item={item} progress={mode === "continue"} added={mode === "recent"} kindLabel />
              ))}
          </div>
        )}
      </section>
    </DashboardShell>

    {toast && createPortal(
      <div className="home-toast" role="status" aria-live="polite">{toast}</div>,
      document.body
    )}

    {activeDownload && createPortal(
      <div className="home-dl-banner" role="status" aria-live="polite">
        <Loader2 size={16} className="home-feed-spin" aria-hidden="true" />
        <div className="home-dl-banner-body">
          <span className="home-dl-banner-label">{t("common:home.downloadingTitle", { title: activeDownload.title })}</span>
          <span className="home-dl-banner-track">
            <span style={{ width: `${Math.round(activeDownload.progress * 100)}%` }} />
          </span>
        </div>
        <span className="home-dl-banner-pct">{Math.round(activeDownload.progress * 100)}%</span>
      </div>,
      document.body
    )}
    </>
  );
}
