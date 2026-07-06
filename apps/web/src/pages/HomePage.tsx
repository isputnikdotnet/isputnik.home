import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ChevronRight, DownloadCloud, HardDrive, Headphones, Heart, Image as ImageIcon, Loader2, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute, navigate } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { authorLine, audioRecordToFeedItem, ebookRecordToFeedItem, fetchFeed, saveFeedItemOffline, type FeedItem, type FeedMode } from "../features/library/feed";
import { FeedTile, FeedTileSkeleton } from "../features/library/FeedTile";
import { FeedListItem, FeedListItemSkeleton } from "../features/library/FeedListItem";
import { DEFAULT_COVERS } from "../features/audiobooks/covers";
import { useIsMobile } from "../shared/useIsMobile";
import { useOnlineStatus } from "../pwa/useOnlineStatus";
import { getDownloadedEpubBlob, getEbookDownload, listDownloads, listEbookDownloads, type DownloadRecord, type EbookDownloadRecord } from "../offline/downloads";
import { isFoliateFormat } from "../shared/utils";
import { EbookReader } from "../features/audiobooks/reader/EbookReader";
import type { AudiobookBookDetail, ReadingProgress } from "../features/audiobooks/types";
import type { GalleryMemories } from "../features/gallery/types";

// How many books each home row shows. Continue is capped at 5 (one of which
// becomes the mobile resume hero), Recently added at 10. Desktop clips its row
// to a single line within these counts; mobile lists them all.
const CONTINUE_LIMIT = 5;
const RECENT_LIMIT = 10;

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

// Mobile "pick up where you left off" hero — the single most-recent in-progress
// book, blown up above the Continue row. Tapping the main area resumes (plays an
// audiobook / opens the inline reader for an ebook); a side column carries the
// save-for-offline button and the play/read action.
function ResumeHero({ item, onRead, downloaded, onDownloaded, onDownload, onToast }: {
  item: FeedItem;
  onRead: (item: FeedItem) => Promise<void>;
  downloaded: boolean;
  onDownloaded: (id: string) => void;
  onDownload: (info: { title: string; progress: number } | null) => void;
  onToast: (message: string) => void;
}) {
  const isEbook = item.kind === "ebook";
  const percent = Math.round((item.percentComplete ?? 0) * 100);
  const [opening, setOpening] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const resume = () => {
    if (isEbook) {
      setOpening(true);
      void onRead(item).finally(() => setOpening(false));
    } else {
      navigate(`/player/${item.id}`);
    }
  };

  const saveOffline = async () => {
    if (downloading) return;
    setDownloading(true);
    onDownload({ title: item.title, progress: 0 });
    try {
      await saveFeedItemOffline(item, (fraction) => onDownload({ title: item.title, progress: fraction }));
      onDownloaded(item.id);
      onToast("Saved for offline");
    } catch {
      onToast("Download failed");
    } finally {
      onDownload(null);
      setDownloading(false);
    }
  };

  return (
    <section className="home-resume" aria-label="Pick up where you left off">
      <div className="home-resume-card">
        <button type="button" className="home-resume-main" onClick={resume} disabled={opening} aria-label={`Resume ${item.title}`}>
          <span className="home-resume-cover">
            <img src={item.coverUrl ?? DEFAULT_COVERS[item.kind]} alt="" />
          </span>
          <span className="home-resume-body">
            <span className="home-resume-eyebrow">{isEbook ? "Continue reading" : "Continue listening"}</span>
            <strong className="home-resume-title">{item.title}</strong>
            <small className="home-resume-author">{authorLine(item)}</small>
            {percent > 0 && (
              <span className="home-resume-progress">
                <span className="home-resume-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
                <span className="home-resume-pct">{percent}%</span>
              </span>
            )}
          </span>
        </button>
        <div className="home-resume-side">
          {downloaded ? (
            <button
              type="button"
              className="home-resume-dl is-saved"
              onClick={() => navigate("/downloads")}
              title="Saved for offline"
              aria-label="Available offline"
            >
              <HardDrive size={16} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="home-resume-dl"
              onClick={saveOffline}
              disabled={downloading}
              title={downloading ? "Downloading…" : "Save for offline"}
              aria-label={downloading ? "Downloading…" : "Save for offline"}
            >
              {downloading
                ? <Loader2 size={16} className="home-feed-spin" aria-hidden="true" />
                : <DownloadCloud size={16} aria-hidden="true" />}
            </button>
          )}
          <button
            type="button"
            className="home-resume-action"
            onClick={resume}
            disabled={opening}
            aria-label={isEbook ? `Read ${item.title}` : `Play ${item.title}`}
            title={isEbook ? "Read" : "Play"}
          >
            {isEbook && opening
              ? <Loader2 size={22} className="home-feed-spin" />
              : isEbook
                ? <BookOpen size={22} />
                : <Play size={22} fill="currentColor" />}
          </button>
        </div>
      </div>
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
  url?: string;
  title: string;
  author: string;
  coverUrl: string | null;
  blob?: Blob | null;
  initialProgress: ReadingProgress | null;
}

export function HomePage({ user, logout }: { user: PublicUser; logout: () => Promise<void> }) {
  const [continueItems, setContinueItems] = useState<FeedItem[] | null>(null);
  const [recentItems, setRecentItems] = useState<FeedItem[] | null>(null);
  const [memories, setMemories] = useState<GalleryMemories | null>(null);
  const [stats, setStats] = useState({ audiobooks: 0, ebooks: 0, inProgress: 0, favorites: 0 });
  const [error, setError] = useState("");
  const isMobile = useIsMobile();
  const online = useOnlineStatus();
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set());
  const [downloads, setDownloads] = useState<DownloadRecord[] | null>(null);
  const [ebookDownloads, setEbookDownloads] = useState<EbookDownloadRecord[] | null>(null);
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
    if (!offlineBlob && !networkUrl) { showToast("Not available offline"); return; }

    const progressData = await api<{ progress: ReadingProgress | null }>(
      `/api/library/books/${item.id}/reading-progress?documentId=${encodeURIComponent(docId)}`
    ).catch(() => ({ progress: null }));

    setViewer({
      bookId: item.id,
      docId,
      format,
      url: networkUrl ?? undefined,
      title: item.title,
      author: item.authors.join(", "),
      coverUrl: item.coverUrl,
      blob: offlineBlob,
      initialProgress: progressData.progress
    });
  }, [showToast]);

  // Local (IndexedDB) download records — both the id set used to flag rows as
  // saved, and the full records that drive the offline home when disconnected.
  useEffect(() => {
    if (!isMobile) return;
    let alive = true;
    Promise.allSettled([listDownloads(), listEbookDownloads()]).then(([audio, ebooks]) => {
      if (!alive) return;
      const audioList = audio.status === "fulfilled" ? audio.value : [];
      const ebookList = ebooks.status === "fulfilled" ? ebooks.value : [];
      setDownloads(audioList);
      setEbookDownloads(ebookList);
      setDownloadedIds(new Set([...audioList, ...ebookList].map((d) => d.bookId)));
    });
    return () => { alive = false; };
  }, [isMobile]);

  // The home feed lives on the server. Skip it while offline (the offline home
  // renders downloaded books instead) and refetch when the connection returns.
  useEffect(() => {
    if (!online) return;
    let alive = true;

    // Gallery memories ("On this day") want the viewer's local calendar date —
    // the server may sit in a different timezone. One cover per year is enough
    // for the home tiles; the counts come along regardless.
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    Promise.allSettled([
      fetchFeed("continue", CONTINUE_LIMIT),
      fetchFeed("recent", RECENT_LIMIT),
      api<{ libraries: LibraryCountRow[] }>("/api/library/audiobook-libraries"),
      api<{ libraries: LibraryCountRow[] }>("/api/library/ebook-libraries"),
      api<{ books: unknown[] }>("/api/library/saved"),
      api<GalleryMemories>(`/api/library/gallery/memories?date=${localDate}&perYear=1`)
    ]).then(([cont, recent, audioLibs, ebookLibs, saved, mems]) => {
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
      if (mems.status === "fulfilled") setMemories(mems.value);
    });

    return () => { alive = false; };
  }, [online]);

  const statCards: StatCard[] = [
    { label: "Audiobooks", value: stats.audiobooks, tone: "violet", icon: Headphones, href: "/audiobooks" },
    { label: "Ebooks", value: stats.ebooks, tone: "green", icon: BookOpen, href: "/ebooks" },
    { label: "In progress", value: stats.inProgress, tone: "blue", icon: Play, href: "/continue" },
    { label: "Favorites", value: stats.favorites, tone: "rose", icon: Heart, href: "/favorites" }
  ];

  // When offline on a phone, the home becomes a browser for downloaded books
  // (the server feed is unreachable). Online, the top in-progress book is lifted
  // out of the Continue row into the resume hero.
  const offlineMode = isMobile && !online;
  const heroItem = isMobile && online && continueItems && continueItems.length > 0 ? continueItems[0] : null;
  const continueRest = heroItem ? continueItems!.slice(1) : continueItems;
  const showContinueRow = !heroItem || (continueRest != null && continueRest.length > 0);

  // "On this day" (gallery memories): only shown for a day-precision match — a
  // whole-month fallback would put filler on the dashboard. Hidden entirely when
  // there is nothing to show (no gallery, or no dated past-year photos today).
  const memoryGroups = memories && memories.precision !== "month" ? memories.groups : [];
  const memoriesTitle = memories?.precision === "near" ? "Around this day" : "On this day";

  const offlineLoaded = downloads !== null && ebookDownloads !== null;
  const offlineAudioItems = downloads ? downloads.map(audioRecordToFeedItem) : null;
  const offlineEbookItems = ebookDownloads ? ebookDownloads.map(ebookRecordToFeedItem) : null;
  const offlineEmpty = offlineLoaded && (offlineAudioItems?.length ?? 0) === 0 && (offlineEbookItems?.length ?? 0) === 0;

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

        {error && !offlineMode && <MessageBox tone="error" title="Unable to load home">{error}</MessageBox>}

        <div className="home-stats" aria-label="Library overview">
          {statCards.map((card) => <StatTile card={card} key={card.label} />)}
        </div>

        {offlineMode ? (
          <div className="home-content">
            {!offlineLoaded ? (
              <FeedRow
                id="home-offline-title"
                title="Downloaded"
                href="/downloads"
                mode="recent"
                items={null}
                emptyText=""
                mobile
                downloadedIds={downloadedIds}
              />
            ) : offlineEmpty ? (
              <div className="empty-state home-offline-empty">
                <DownloadCloud size={52} aria-hidden="true" />
                <h2>Nothing saved offline</h2>
                <p className="muted">You're offline. Books you save while connected show up here, ready to play or read without a connection.</p>
              </div>
            ) : (
              <>
                {offlineAudioItems && offlineAudioItems.length > 0 && (
                  <FeedRow
                    id="home-offline-audio"
                    title="Downloaded audiobooks"
                    mobileTitle="Audiobooks"
                    href="/downloads"
                    mode="recent"
                    items={offlineAudioItems}
                    emptyText=""
                    mobile
                    downloadedIds={downloadedIds}
                    onToast={showToast}
                  />
                )}
                {offlineEbookItems && offlineEbookItems.length > 0 && (
                  <FeedRow
                    id="home-offline-ebooks"
                    title="Downloaded ebooks"
                    mobileTitle="Ebooks"
                    href="/downloads"
                    mode="recent"
                    items={offlineEbookItems}
                    emptyText=""
                    mobile
                    downloadedIds={downloadedIds}
                    onRead={handleRead}
                    onToast={showToast}
                  />
                )}
              </>
            )}
          </div>
        ) : (
          <div className="home-content">
            {heroItem && (
              <ResumeHero
                item={heroItem}
                onRead={handleRead}
                downloaded={downloadedIds.has(heroItem.id)}
                onDownloaded={handleDownloaded}
                onDownload={setActiveDownload}
                onToast={showToast}
              />
            )}
            {showContinueRow && (
              <FeedRow
                id="home-continue-title"
                title="Continue listening & reading"
                mobileTitle="Continue"
                href="/continue"
                mode="continue"
                items={continueRest}
                emptyText="Nothing in progress yet — open a book to start."
                mobile={isMobile}
                downloadedIds={downloadedIds}
                onDownloaded={handleDownloaded}
                onRead={handleRead}
                onToast={showToast}
                onDownload={setActiveDownload}
              />
            )}
            {!isMobile && memoryGroups.length > 0 && (
              <section className="home-section" aria-labelledby="home-memories-title">
                <RowHeader id="home-memories-title" title={memoriesTitle} href="/gallery/memories" />
                <div className="home-tile-grid">
                  {memoryGroups.map((group) => (
                    <a
                      key={group.year}
                      className="audiobook-catalog-card grid home-feed-tile"
                      href="/gallery/memories"
                      onClick={(event) => followRoute(event, "/gallery/memories")}
                    >
                      <div className="audiobook-catalog-cover">
                        {group.items[0]?.coverUrl ? (
                          <img src={group.items[0].coverUrl} alt="" loading="lazy" />
                        ) : (
                          <span className="home-memory-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
                        )}
                      </div>
                      <div className="audiobook-catalog-copy">
                        <strong>{group.year}</strong>
                        <small>{group.count === 1 ? "1 photo" : `${count(group.count)} photos`}</small>
                      </div>
                    </a>
                  ))}
                </div>
              </section>
            )}
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
        blob={viewer.blob}
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
