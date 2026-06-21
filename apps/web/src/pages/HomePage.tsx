import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ChevronRight, Headphones, Heart, Loader2, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute, navigate } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { fetchFeed, type FeedItem, type FeedMode } from "../features/library/feed";
import { FeedTile, FeedTileSkeleton } from "../features/library/FeedTile";
import { FeedListItem, FeedListItemSkeleton } from "../features/library/FeedListItem";
import { useIsMobile } from "../shared/useIsMobile";
import { useOnlineStatus } from "../pwa/useOnlineStatus";
import { getDownloadedEpubBlob, getEbookDownload, listDownloads, listEbookDownloads } from "../offline/downloads";
import { isFoliateFormat } from "../shared/utils";
import { EbookReader } from "../features/audiobooks/reader/EbookReader";
import type { AudiobookBookDetail, ReadingProgress } from "../features/audiobooks/types";

// Upper bound fetched per row. Each row renders one line of fixed-size tiles and
// clips whatever doesn't fit (no horizontal scroll, no wrap) — so we fetch enough
// to fill a wide screen and let CSS decide how many actually show.
const FETCH = 16;

type Tone = "violet" | "green" | "blue" | "rose";

interface LibraryCountRow {
  bookCount: number;
}

interface StatCard {
  label: string;
  value: number;
  tone: Tone;
  icon: LucideIcon;
  href: string;
}

const count = (value: number) => new Intl.NumberFormat().format(value);

function RowHeader({ id, title, href }: { id: string; title: string; href: string }) {
  return (
    <div className="home-section-title">
      <h2 id={id}>{title}</h2>
      <a href={href} onClick={(event) => followRoute(event, href)}>
        <span>View all</span>
        <ChevronRight size={18} aria-hidden="true" />
      </a>
    </div>
  );
}

function FeedRow({ id, title, mobileTitle, href, mode, items, emptyText, mobile, downloadedIds, onDownloaded, onRead, onToast, onDownload }: {
  id: string;
  title: string;
  mobileTitle?: string;
  href: string;
  mode: FeedMode;
  items: FeedItem[] | null;
  emptyText: string;
  mobile: boolean;
  downloadedIds?: Set<string>;
  onDownloaded?: (id: string) => void;
  onRead?: (item: FeedItem) => Promise<void>;
  onToast?: (message: string) => void;
  onDownload?: (info: { title: string; progress: number } | null) => void;
}) {
  const heading = mobile && mobileTitle ? mobileTitle : title;
  return (
    <section className="home-section" aria-labelledby={id}>
      <RowHeader id={id} title={heading} href={href} />
      {items !== null && items.length === 0 ? (
        <p className="home-row-empty">{emptyText}</p>
      ) : mobile ? (
        <div className="home-feed-list">
          {items === null
            ? Array.from({ length: 5 }).map((_, index) => <FeedListItemSkeleton key={index} />)
            : items.map((item) => (
              <FeedListItem
                key={`${item.kind}-${item.id}`}
                item={item}
                progress={mode === "continue"}
                downloaded={downloadedIds?.has(item.id) ?? false}
                onDownloaded={onDownloaded}
                onRead={onRead}
                onToast={onToast}
                onDownload={onDownload}
              />
            ))}
        </div>
      ) : (
        <div className="home-tile-grid">
          {items === null
            ? Array.from({ length: 10 }).map((_, index) => <FeedTileSkeleton key={index} />)
            : items.map((item) => (
              <FeedTile key={`${item.kind}-${item.id}`} item={item} progress={mode === "continue"} added={mode === "recent"} />
            ))}
        </div>
      )}
    </section>
  );
}

function StatTile({ card }: { card: StatCard }) {
  const Icon = card.icon;
  return (
    <a className="home-overview-card" href={card.href} onClick={(event) => followRoute(event, card.href)}>
      <span className={`home-overview-icon ${card.tone}`} aria-hidden="true">
        <Icon size={22} />
      </span>
      <span>
        <strong>{count(card.value)}</strong>
        <small>{card.label}</small>
      </span>
    </a>
  );
}

interface ViewerState {
  bookId: string;
  docId: string;
  format: string;
  url: string;
  title: string;
  author: string;
  coverUrl: string | null;
  blobUrl?: string;
  initialProgress: ReadingProgress | null;
}

export function HomePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [continueItems, setContinueItems] = useState<FeedItem[] | null>(null);
  const [recentItems, setRecentItems] = useState<FeedItem[] | null>(null);
  const [stats, setStats] = useState({ audiobooks: 0, ebooks: 0, inProgress: 0, favorites: 0 });
  const [error, setError] = useState("");
  const isMobile = useIsMobile();
  const online = useOnlineStatus();
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeDownload, setActiveDownload] = useState<{ title: string; progress: number } | null>(null);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const handleDownloaded = useCallback((id: string) => {
    setDownloadedIds((prev) => new Set([...prev, id]));
  }, []);

  // Open an ebook in the inline reader. Works offline: the epub document id comes
  // from the live detail when the server is reachable, else from the saved
  // download record, and the file loads from the offline blob when present.
  const handleRead = useCallback(async (item: FeedItem) => {
    const offlineRecord = await getEbookDownload(item.id).catch(() => null);
    let docId: string | null = offlineRecord?.documentId ?? null;
    let format: string = offlineRecord?.format ?? "epub";
    let networkUrl: string | null = null;
    try {
      const { book } = await api<{ book: AudiobookBookDetail }>(`/api/library/books/${item.id}`);
      const doc = book.documents.find((d) => isFoliateFormat(d.format)) ?? book.documents[0] ?? null;
      if (doc) { docId = doc.id; networkUrl = doc.url; format = doc.format; }
    } catch {
      // Server unreachable — fall back to the offline record's document id below.
    }
    if (!docId) { navigate(`/ebooks/books/${item.id}`); return; }

    const offlineBlob = await getDownloadedEpubBlob(item.id, docId).catch(() => null);
    const blobUrl = offlineBlob ? URL.createObjectURL(offlineBlob) : undefined;
    const url = blobUrl ?? networkUrl;
    if (!url) { showToast("Not available offline"); return; }

    const progressData = await api<{ progress: ReadingProgress | null }>(
      `/api/library/books/${item.id}/reading-progress?documentId=${encodeURIComponent(docId)}`
    ).catch(() => ({ progress: null }));

    setViewer({
      bookId: item.id,
      docId,
      format,
      url,
      title: item.title,
      author: item.authors.join(", "),
      coverUrl: item.coverUrl,
      blobUrl,
      initialProgress: progressData.progress
    });
  }, [showToast]);

  useEffect(() => {
    const current = viewer;
    return () => { if (current?.blobUrl) URL.revokeObjectURL(current.blobUrl); };
  }, [viewer]);

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

    Promise.allSettled([
      fetchFeed("continue", FETCH),
      fetchFeed("recent", FETCH),
      api<{ libraries: LibraryCountRow[] }>("/api/library/audiobook-libraries"),
      api<{ libraries: LibraryCountRow[] }>("/api/library/ebook-libraries"),
      api<{ books: unknown[] }>("/api/library/saved")
    ]).then(([cont, recent, audioLibs, ebookLibs, saved]) => {
      if (!alive) return;

      if (cont.status === "fulfilled") {
        setContinueItems(cont.value.items);
        setStats((prev) => ({ ...prev, inProgress: cont.value.total }));
      } else {
        setContinueItems([]);
      }

      if (recent.status === "fulfilled") {
        setRecentItems(recent.value.items);
      } else {
        setRecentItems([]);
        setError(recent.reason instanceof Error ? recent.reason.message : "Unable to load your library");
      }

      const sumBooks = (libs: LibraryCountRow[]) => libs.reduce((total, library) => total + (library.bookCount ?? 0), 0);
      if (audioLibs.status === "fulfilled") setStats((prev) => ({ ...prev, audiobooks: sumBooks(audioLibs.value.libraries) }));
      if (ebookLibs.status === "fulfilled") setStats((prev) => ({ ...prev, ebooks: sumBooks(ebookLibs.value.libraries) }));
      if (saved.status === "fulfilled") setStats((prev) => ({ ...prev, favorites: saved.value.books.length }));
    });

    return () => { alive = false; };
  }, []);

  const statCards: StatCard[] = [
    { label: "Audiobooks", value: stats.audiobooks, tone: "violet", icon: Headphones, href: "/audiobooks" },
    { label: "Ebooks", value: stats.ebooks, tone: "green", icon: BookOpen, href: "/ebooks" },
    { label: "In progress", value: stats.inProgress, tone: "blue", icon: Play, href: "/continue" },
    { label: "Favorites", value: stats.favorites, tone: "rose", icon: Heart, href: "/favorites" }
  ];

  return (
    <>
    <DashboardShell active="home" user={user} logout={logout}>
      <section className="home-page" aria-label="Home">
        {isMobile ? (
          <header className="home-header home-header-mobile">
            <div className="home-brand">
              <img
                className="home-brand-mark"
                src="/Assets/brand/isputnik-logo-sputnik-earth-mark.svg"
                alt=""
                width={36}
                height={36}
              />
              <span className="home-brand-copy">
                <strong>iSputnik</strong>
                <small>isputnik.home</small>
              </span>
            </div>
            <span className={`home-net ${online ? "is-online" : "is-offline"}`} role="status" aria-live="polite">
              <span className="home-net-dot" aria-hidden="true" />
              {online ? "Online" : "Offline"}
            </span>
          </header>
        ) : (
          <header className="home-header">
            <div className="home-heading">
              <h1>Welcome back, {user.displayName}</h1>
              <p>Here's what's happening in your library</p>
            </div>
          </header>
        )}

        {error && <MessageBox tone="error" title="Unable to load home">{error}</MessageBox>}

        <div className="home-stats" aria-label="Library overview">
          {statCards.map((card) => <StatTile card={card} key={card.label} />)}
        </div>

        <div className="home-content">
          <FeedRow
            id="home-continue-title"
            title="Continue listening & reading"
            mobileTitle="Continue"
            href="/continue"
            mode="continue"
            items={continueItems}
            emptyText="Nothing in progress yet — open a book to start."
            mobile={isMobile}
            downloadedIds={downloadedIds}
            onDownloaded={handleDownloaded}
            onRead={handleRead}
            onToast={showToast}
            onDownload={setActiveDownload}
          />
          <FeedRow
            id="home-recent-title"
            title="Recently added"
            href="/recent"
            mode="recent"
            items={recentItems}
            emptyText="No books yet. Newly added audiobooks and ebooks show up here."
            mobile={isMobile}
            downloadedIds={downloadedIds}
            onDownloaded={handleDownloaded}
            onRead={handleRead}
            onToast={showToast}
            onDownload={setActiveDownload}
          />
        </div>
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
          <span className="home-dl-banner-label">Downloading {activeDownload.title}</span>
          <span className="home-dl-banner-track">
            <span style={{ width: `${Math.round(activeDownload.progress * 100)}%` }} />
          </span>
        </div>
        <span className="home-dl-banner-pct">{Math.round(activeDownload.progress * 100)}%</span>
      </div>,
      document.body
    )}

    {viewer && createPortal(
      <EbookReader
        bookId={viewer.bookId}
        documentId={viewer.docId}
        format={viewer.format}
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
