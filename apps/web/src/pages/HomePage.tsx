import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, DownloadCloud, HardDrive, Headphones, Loader2, Play } from "lucide-react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute, navigate } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { formatBytes, formatDuration } from "../shared/utils";
import { useOnlineStatus } from "../pwa/useOnlineStatus";
import { downloadBook, downloadEbook, getDownloadedEpubBlob, listDownloads, listEbookDownloads } from "../offline/downloads";
import type { AudiobookBookDetail, ReadingProgress } from "../features/audiobooks/types";
import { EbookReader } from "../features/audiobooks/reader/EbookReader";
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

function InProgressRow({ item, downloaded, onDownloaded, onRead }: { item: FeedItem; downloaded: boolean; onDownloaded: (id: string) => void; onRead: (item: FeedItem) => Promise<void> }) {
  const [downloading, setDownloading] = useState(false);
  const [opening, setOpening] = useState(false);
  const href = feedHref(item);
  const percent = Math.round((item.percentComplete ?? 0) * 100);
  const isAudiobook = item.kind === "audiobook";

  const startDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const { book } = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${item.id}`);
      if (isAudiobook) {
        await downloadBook(book);
      } else {
        const doc = book.documents.find((d) => d.format === "epub") ?? book.documents[0] ?? null;
        if (doc) {
          await downloadEbook(item.id, doc.id, doc.url, {
            title: item.title,
            authors: item.authors,
            coverUrl: item.coverUrl,
            totalBytes: doc.size
          });
        }
      }
      onDownloaded(item.id);
    } catch {
      // silently — user can retry or use the book detail page
    } finally {
      setDownloading(false);
    }
  };

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
          <div className="inprogress-progress-row">
            {downloaded ? (
              <button
                type="button"
                className="inprogress-bar-icon"
                onClick={(e) => { e.preventDefault(); navigate(isAudiobook ? "/audiobooks/downloads" : href); }}
                title="Saved for offline"
                aria-label="Available offline"
              >
                <HardDrive size={10} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="inprogress-bar-icon"
                onClick={(e) => { e.preventDefault(); void startDownload(); }}
                disabled={downloading}
                title={downloading ? "Downloading…" : "Save for offline"}
                aria-label={downloading ? "Downloading…" : "Save for offline"}
              >
                {downloading
                  ? <Loader2 size={10} aria-hidden="true" className="inprogress-spinning" />
                  : <DownloadCloud size={10} aria-hidden="true" />
                }
              </button>
            )}
            {percent > 0 && (
              <span className="inprogress-bar" aria-label={`${percent}% complete`}>
                <span style={{ width: `${percent}%` }} />
              </span>
            )}
          </div>
          {(isAudiobook ? item.durationSeconds : item.format) && (
            <span className="inprogress-meta">
              {isAudiobook
                ? formatDuration(item.durationSeconds!)
                : [item.format!.toUpperCase(), item.totalSize ? formatBytes(item.totalSize) : null].filter(Boolean).join(" · ")
              }
            </span>
          )}
        </div>
      </a>
      <div className="inprogress-actions">
        <button
          type="button"
          className="inprogress-play"
          disabled={opening}
          onClick={() => {
            if (isAudiobook) {
              navigate(`/player/${item.id}`);
            } else {
              setOpening(true);
              void onRead(item).finally(() => setOpening(false));
            }
          }}
          aria-label={isAudiobook ? `Play ${item.title}` : (opening ? "Opening…" : `Read ${item.title}`)}
        >
          {!isAudiobook && opening
            ? <Loader2 size={14} aria-hidden="true" className="inprogress-spinning" />
            : isAudiobook
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

interface ViewerState {
  bookId: string;
  docId: string;
  url: string;
  title: string;
  author: string;
  coverUrl: string | null;
  blobUrl?: string;
  initialProgress: ReadingProgress | null;
}

export function HomePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [viewer, setViewer] = useState<ViewerState | null>(null);

  const handleDownloaded = useCallback((id: string) => {
    setDownloadedIds((prev) => new Set([...prev, id]));
  }, []);

  const handleRead = useCallback(async (item: FeedItem) => {
    const { book } = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${item.id}`);
    const doc = book.documents.find((d) => d.format === "epub") ?? book.documents[0] ?? null;
    if (!doc) { navigate(`/ebooks/books/${item.id}`); return; }
    const [progressData, offlineBlob] = await Promise.all([
      api<{ progress: ReadingProgress | null }>(`/api/library/books/${item.id}/reading-progress?documentId=${encodeURIComponent(doc.id)}`).catch(() => ({ progress: null })),
      getDownloadedEpubBlob(item.id, doc.id).catch(() => null)
    ]);
    const blobUrl = offlineBlob ? URL.createObjectURL(offlineBlob) : undefined;
    setViewer({
      bookId: item.id,
      docId: doc.id,
      url: blobUrl ?? doc.url,
      title: item.title,
      author: item.authors.join(", "),
      coverUrl: item.coverUrl,
      blobUrl,
      initialProgress: progressData.progress
    });
  }, []);

  useEffect(() => {
    const v = viewer;
    return () => { if (v?.blobUrl) URL.revokeObjectURL(v.blobUrl); };
  }, [viewer]);

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
    <>
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
                      onDownloaded={handleDownloaded}
                      onRead={handleRead}
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

    {viewer && createPortal(
      <EbookReader
        bookId={viewer.bookId}
        documentId={viewer.docId}
        url={viewer.url}
        storageKey={`isputnik:epub-progress:${user.id}:${viewer.bookId}:${viewer.docId}`}
        initialProgress={viewer.initialProgress}
        title={viewer.title}
        author={viewer.author}
        coverUrl={viewer.coverUrl}
        downloadUrl={viewer.url}
        onExit={() => setViewer(null)}
      />,
      document.body
    )}
    </>
  );
}
