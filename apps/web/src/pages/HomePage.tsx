import { useEffect, useState } from "react";
import { BookOpen, DownloadCloud, HardDrive, Headphones, Play } from "lucide-react";
import type { PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute, navigate } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { useOnlineStatus } from "../pwa/useOnlineStatus";
import { listDownloads, listEbookDownloads } from "../offline/downloads";
import { authorLine, feedHref, fetchFeed, type FeedItem } from "../features/library/feed";

function HomeHeader() {
  const online = useOnlineStatus();
  return (
    <div className="home-brand-header">
      <img
        src="/Assets/brand/isputnik-brand-icon.svg"
        alt=""
        className="home-brand-icon"
        aria-hidden="true"
      />
      <div className="home-brand-text">
        <strong className="home-brand-name">iSputnik</strong>
        <span className="home-brand-url">{window.location.origin}</span>
      </div>
      <span
        className={`home-brand-status${online ? " is-online" : " is-offline"}`}
        role="status"
        aria-label={online ? "Online" : "Offline"}
      >
        <span className="home-brand-status-dot" aria-hidden="true" />
        {online ? "Online" : "Offline"}
      </span>
    </div>
  );
}

function InProgressRow({ item, downloaded }: { item: FeedItem; downloaded: boolean }) {
  const href = feedHref(item);
  const percent = Math.round((item.percentComplete ?? 0) * 100);
  const isAudiobook = item.kind === "audiobook";

  return (
    <div className="inprogress-row" role="listitem">
      <a className="inprogress-main" href={href} onClick={(e) => followRoute(e, href)}>
        <div className="inprogress-cover">
          {item.coverUrl
            ? <img src={item.coverUrl} alt="" loading="lazy" />
            : isAudiobook
              ? <Headphones size={18} aria-hidden="true" />
              : <BookOpen size={18} aria-hidden="true" />
          }
        </div>
        <div className="inprogress-info">
          <strong>{item.title}</strong>
          <small>{authorLine(item)}</small>
          {percent > 0 && (
            <span className="inprogress-bar" aria-label={`${percent}% complete`}>
              <span style={{ width: `${percent}%` }} />
            </span>
          )}
        </div>
      </a>
      <div className="inprogress-actions">
        {downloaded
          ? (
            <button
              type="button"
              className="inprogress-offline-btn"
              onClick={() => navigate(isAudiobook ? "/audiobooks/downloads" : href)}
              title="Saved for offline"
              aria-label="Available offline"
            >
              <HardDrive size={14} aria-hidden="true" />
            </button>
          )
          : (
            <button
              type="button"
              className="inprogress-download-btn"
              onClick={() => navigate(href)}
              title="Save for offline"
              aria-label={`Save "${item.title}" for offline`}
            >
              <DownloadCloud size={14} aria-hidden="true" />
            </button>
          )
        }
        <button
          type="button"
          className="inprogress-play"
          onClick={() => navigate(isAudiobook ? `/player/${item.id}` : href)}
          aria-label={isAudiobook ? `Play ${item.title}` : `Read ${item.title}`}
        >
          {isAudiobook
            ? <Play size={13} fill="currentColor" aria-hidden="true" />
            : <BookOpen size={14} aria-hidden="true" />
          }
        </button>
      </div>
    </div>
  );
}

function InProgressRowSkeleton() {
  return (
    <div className="inprogress-row is-skeleton" aria-hidden="true">
      <div className="inprogress-main">
        <div className="inprogress-cover" />
        <div className="inprogress-info">
          <div className="home-skeleton-line" style={{ width: "65%" }} />
          <div className="home-skeleton-line" style={{ width: "42%", marginTop: "5px" }} />
          <div className="inprogress-bar" style={{ marginTop: "8px" }}>
            <span style={{ width: "30%" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function HomePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [downloadedIds, setDownloadedIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.allSettled([fetchFeed("continue", 10), listDownloads(), listEbookDownloads()]).then(([feed, downloads, ebookDownloads]) => {
      if (!alive) return;
      if (feed.status === "fulfilled") setItems(feed.value.items);
      else { setItems([]); setError("Unable to load your library"); }
      const ids = new Set<string>();
      if (downloads.status === "fulfilled") downloads.value.forEach((d) => ids.add(d.bookId));
      if (ebookDownloads.status === "fulfilled") ebookDownloads.value.forEach((d) => ids.add(d.bookId));
      setDownloadedIds(ids);
    });
    return () => { alive = false; };
  }, []);

  return (
    <DashboardShell active="home" user={user} logout={logout}>
      <section className="home-page" aria-label="In progress">
        <HomeHeader />
        {error && <MessageBox tone="error" title="Unable to load">{error}</MessageBox>}

        {items === null || items.length > 0 ? (
          <>
            <h2 className="inprogress-heading">Continue listening</h2>
            <div className="inprogress-list" role={items !== null ? "list" : undefined}>
              {items === null
                ? Array.from({ length: 6 }).map((_, i) => <InProgressRowSkeleton key={i} />)
                : items.map((item) => (
                    <InProgressRow
                      key={`${item.kind}-${item.id}`}
                      item={item}
                      downloaded={downloadedIds.has(item.id)}
                    />
                  ))
              }
            </div>
          </>
        ) : (
          <div className="inprogress-empty">
            <Headphones size={48} aria-hidden="true" />
            <p>Nothing in progress yet — open a book to start.</p>
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
