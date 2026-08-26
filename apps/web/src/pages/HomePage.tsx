import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ChevronRight, DownloadCloud, HardDrive, Image as ImageIcon, Library, Loader2, Play, Sparkles } from "lucide-react";
import { ActivityList } from "../features/social/ActivityList";
import { InboxRow, type InboxCard } from "../features/social/InboxRow";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute, navigate } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { authorLine, audioRecordToFeedItem, ebookRecordToFeedItem, fetchFeed, saveFeedItemOffline, type FeedItem } from "../features/library/feed";
import { batchDayLabel, fetchHomeFeed, localDate, toActivityItem, type ActivityCard, type AddedBatchCard, type HomeCard, type MemoryCard, type SentCard, type SeriesNextCard } from "../features/home/feed";
import { FeedListItem, FeedListItemSkeleton } from "../features/library/FeedListItem";
import { DEFAULT_COVERS } from "../features/audiobooks/covers";
import { useIsMobile } from "../shared/useIsMobile";
import { useOnlineStatus } from "../pwa/useOnlineStatus";
import { getDownloadedEpubBlob, getEbookDownload, listDownloads, listEbookDownloads, type DownloadRecord, type EbookDownloadRecord } from "../offline/downloads";
import { isFoliateFormat } from "../shared/utils";
import { EbookReader } from "../features/audiobooks/reader/EbookReader";
import type { AudiobookBookDetail, ReadingProgress } from "../features/audiobooks/types";
import type { GalleryAsset, GalleryMemories } from "../features/gallery/types";
import { GalleryLightbox } from "../features/gallery/GalleryLightbox";

const count = (value: number) => new Intl.NumberFormat().format(value);

// The resume hero — the single most-recent in-progress book, pinned above the
// feed on every screen size (it grew up on mobile; desktop adopted it in the
// feed revamp). Tapping the main area resumes; the side column carries the
// save-for-offline button (phones, where offline matters) and the play/read
// action.
function ResumeHero({ item, onRead, downloaded, onDownloaded, onDownload, onToast, showDownload, moreCount }: {
  item: FeedItem;
  onRead: (item: FeedItem) => Promise<void>;
  downloaded: boolean;
  onDownloaded: (id: string) => void;
  onDownload: (info: { title: string; progress: number } | null) => void;
  onToast: (message: string) => void;
  showDownload: boolean;
  moreCount: number;
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
          {showDownload && (downloaded ? (
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
          ))}
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
      {moreCount > 0 && (
        <a className="home-resume-more" href="/continue" onClick={(event) => followRoute(event, "/continue")}>
          <span>{moreCount === 1 ? "1 more in progress" : `${moreCount} more in progress`}</span>
          <ChevronRight size={15} aria-hidden="true" />
        </a>
      )}
    </section>
  );
}

// ── Feed cards ───────────────────────────────────────────────────────────────
// Every card renders on the shared .home-card chrome; each type brings its own
// body. The server owns the order — the client never re-sorts.

function MemoryFeedCard({ card, onOpen }: { card: MemoryCard; onOpen: (year: number) => void }) {
  const title = card.precision === "near" ? "Around this day" : "On this day";
  // One strip across the years, newest first — up to four photos, each jumping
  // straight into that year's viewer.
  const photos = card.groups.flatMap((group) => group.items.map((item) => ({ item, year: group.year }))).slice(0, 4);
  const years = card.groups.map((group) => group.year);
  const yearSpan = years.length === 1
    ? String(years[0])
    : `${years[years.length - 1]} – ${years[0]}`;
  return (
    <section className="home-card home-card-memory" aria-label={title}>
      <header className="home-card-head">
        <span className="home-card-who"><strong>{title}</strong> · {yearSpan}</span>
        <a className="home-card-link" href="/gallery/memories" onClick={(event) => followRoute(event, "/gallery/memories")}>
          <span>View all</span>
          <ChevronRight size={16} aria-hidden="true" />
        </a>
      </header>
      <div className="home-memory-strip">
        {photos.map(({ item, year }) => (
          <button
            key={item.id}
            type="button"
            className="home-memory-photo"
            onClick={() => onOpen(year)}
            aria-label={`Photos from ${year}`}
          >
            {item.coverUrl
              ? <img src={item.coverUrl} alt="" loading="lazy" />
              : <span className="home-memory-fallback"><ImageIcon size={24} aria-hidden="true" /></span>}
            <em>{year}</em>
          </button>
        ))}
      </div>
      <p className="home-card-sub">
        {card.totalCount === 1 ? "1 photo" : `${count(card.totalCount)} photos`} from this day over the years — tap to relive
      </p>
    </section>
  );
}

function BatchFeedCard({ card }: { card: AddedBatchCard }) {
  const more = card.count - card.coverUrls.length;
  return (
    <a className="home-card home-card-batch" href="/recent" onClick={(event) => followRoute(event, "/recent")}>
      <header className="home-card-head">
        <span className="home-card-who">
          <strong>{card.count === 1 ? "1 book" : `${count(card.count)} books`}</strong>
          {` joined the library ${batchDayLabel(card.day)}`}
        </span>
      </header>
      <div className="home-batch-fan">
        {card.coverUrls.map((url) => (
          <span key={url} className="home-batch-cover"><img src={url} alt="" loading="lazy" /></span>
        ))}
        {card.coverUrls.length === 0 && (
          <span className="home-batch-cover home-batch-cover-empty"><Library size={22} aria-hidden="true" /></span>
        )}
        <span className="home-batch-more">{more > 0 ? `+${count(more)} more` : "Browse"} <ChevronRight size={15} aria-hidden="true" /></span>
      </div>
    </a>
  );
}

function SeriesNextFeedCard({ card }: { card: SeriesNextCard }) {
  return (
    <a className="home-card home-card-suggest" href={card.item.href} onClick={(event) => followRoute(event, card.item.href)}>
      <span className="home-suggest-cover">
        {card.item.coverUrl
          ? <img src={card.item.coverUrl} alt="" loading="lazy" />
          : <span className="home-memory-fallback"><Sparkles size={22} aria-hidden="true" /></span>}
      </span>
      <span className="home-suggest-copy">
        <small className="home-suggest-why">You finished <strong>{card.finishedTitle}</strong> —</small>
        <strong className="home-suggest-title">{card.item.title} is on the shelf</strong>
        <small className="home-suggest-series">{card.seriesName} · next in the series</small>
      </span>
    </a>
  );
}

function FeedCardSkeleton() {
  return (
    <div className="home-card is-skeleton" aria-hidden="true">
      <div className="home-skeleton-line" style={{ width: "40%" }} />
      <div className="home-skeleton-line" style={{ width: "88%", height: 56, marginTop: 12 }} />
    </div>
  );
}

// Offline home rows (phones with no connection): downloaded books as a list.
function OfflineRow({ id, title, items, downloadedIds, onRead, onToast }: {
  id: string;
  title: string;
  items: FeedItem[] | null;
  downloadedIds: Set<string>;
  onRead?: (item: FeedItem) => Promise<void>;
  onToast?: (message: string) => void;
}) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <div className="home-section-title">
        <h2 id={id}>{title}</h2>
        <a href="/downloads" onClick={(event) => followRoute(event, "/downloads")}>
          <span>View all</span>
          <ChevronRight size={18} aria-hidden="true" />
        </a>
      </div>
      <div className="home-feed-list">
        {items === null
          ? Array.from({ length: 5 }).map((_, index) => <FeedListItemSkeleton key={index} />)
          : items.map((item) => (
            <FeedListItem
              key={`${item.kind}-${item.id}`}
              item={item}
              progress={false}
              downloaded={downloadedIds.has(item.id)}
              onRead={onRead}
              onToast={onToast}
            />
          ))}
      </div>
    </section>
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
  const [cards, setCards] = useState<HomeCard[] | null>(null);
  const [heroItem, setHeroItem] = useState<FeedItem | null>(null);
  const [inProgressTotal, setInProgressTotal] = useState(0);
  // The "On this day" lightbox opened from the memory card: the FULL day (every
  // photo, every year, flattened newest-year-first) plus the item currently
  // shown. The card itself only carries a few covers, so opening the viewer
  // re-fetches the complete set.
  const [memoryLightbox, setMemoryLightbox] = useState<{ items: GalleryAsset[]; index: number } | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [busySent, setBusySent] = useState<string | null>(null);
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

  // Open the "On this day" viewer at the clicked year. The card carries a few
  // covers, so load the full set (all photos, every year) and flatten it the
  // same way the gallery does — newest year first, chronological within a
  // year — so Next flows across the whole day. We land on the first photo of
  // the year that was clicked. Falls back to the Memories page on failure.
  const openMemory = useCallback(async (year: number) => {
    if (memoryLoading) return;
    setMemoryLoading(true);
    try {
      const full = await api<GalleryMemories>(`/api/library/gallery/memories?date=${localDate()}&perYear=200`);
      const groups = full.precision === "month" ? [] : full.groups;
      const items = groups.flatMap((group) => group.items);
      if (items.length === 0) { navigate("/gallery/memories"); return; }
      let start = 0;
      for (const group of groups) {
        if (group.year === year) break;
        start += group.items.length;
      }
      setMemoryLightbox({ items, index: Math.min(start, items.length - 1) });
    } catch {
      navigate("/gallery/memories");
    } finally {
      setMemoryLoading(false);
    }
  }, [memoryLoading]);

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

  // The feed lives on the server. Skip it while offline (the offline home
  // renders downloaded books instead) and refetch when the connection returns.
  useEffect(() => {
    if (!online) return;
    let alive = true;

    fetchHomeFeed()
      .then((payload) => { if (alive) setCards(payload.cards); })
      .catch((reason) => {
        if (!alive) return;
        setCards([]);
        setError(reason instanceof Error ? reason.message : "Unable to load your home feed");
      });

    // The hero is the top of the Continue feed; the total feeds the "more in
    // progress" link under it.
    fetchFeed("continue", 1)
      .then((payload) => {
        if (!alive) return;
        setHeroItem(payload.items[0] ?? null);
        setInProgressTotal(payload.total);
      })
      .catch(() => undefined);

    return () => { alive = false; };
  }, [online]);

  // Deciding a sticky card right on the front page: Like writes to Likes (the
  // same list as everywhere else), Not now sets it aside. Either way the card
  // leaves the feed; a failure leaves it standing with a toast.
  const actOnSent = useCallback(async (card: InboxCard, action: "save" | "dismiss") => {
    setBusySent(card.id);
    try {
      await api(`/api/social/recommendations/${card.id}/${action}`, { method: "POST" });
      setCards((prev) => (prev ? prev.filter((c) => !(c.type === "sent" && c.id === card.id)) : prev));
      if (action === "save") showToast("Added to Likes");
    } catch {
      showToast(action === "save" ? "Unable to like this" : "Unable to set this aside");
    } finally {
      setBusySent(null);
    }
  }, [showToast]);

  // When offline on a phone, the home becomes a browser for downloaded books
  // (the server feed is unreachable).
  const offlineMode = isMobile && !online;

  const sentCards = (cards ?? []).filter((card): card is SentCard => card.type === "sent");
  const rankedCards = (cards ?? []).filter((card) => card.type !== "sent");

  const offlineLoaded = downloads !== null && ebookDownloads !== null;
  const offlineAudioItems = downloads ? downloads.map(audioRecordToFeedItem) : null;
  const offlineEbookItems = ebookDownloads ? ebookDownloads.map(ebookRecordToFeedItem) : null;
  const offlineEmpty = offlineLoaded && (offlineAudioItems?.length ?? 0) === 0 && (offlineEbookItems?.length ?? 0) === 0;

  const renderCard = (card: Exclude<HomeCard, SentCard>) => {
    switch (card.type) {
      case "memory":
        return <MemoryFeedCard key="memory" card={card} onOpen={(year) => void openMemory(year)} />;
      case "added_batch":
        return <BatchFeedCard key={`batch-${card.day}`} card={card} />;
      case "series_next":
        return <SeriesNextFeedCard key={`series-${card.item.id}`} card={card} />;
      default:
        return (
          <div key={card.id} className="home-card home-card-activity">
            <ActivityList items={[toActivityItem(card as ActivityCard)]} />
          </div>
        );
    }
  };

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

        {offlineMode ? (
          <div className="home-content">
            {!offlineLoaded ? (
              <OfflineRow id="home-offline-title" title="Downloaded" items={null} downloadedIds={downloadedIds} />
            ) : offlineEmpty ? (
              <div className="empty-state home-offline-empty">
                <DownloadCloud size={52} aria-hidden="true" />
                <h2>Nothing saved offline</h2>
                <p className="muted">You're offline. Books you save while connected show up here, ready to play or read without a connection.</p>
              </div>
            ) : (
              <>
                {offlineAudioItems && offlineAudioItems.length > 0 && (
                  <OfflineRow
                    id="home-offline-audio"
                    title="Audiobooks"
                    items={offlineAudioItems}
                    downloadedIds={downloadedIds}
                    onToast={showToast}
                  />
                )}
                {offlineEbookItems && offlineEbookItems.length > 0 && (
                  <OfflineRow
                    id="home-offline-ebooks"
                    title="Ebooks"
                    items={offlineEbookItems}
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
                showDownload={isMobile}
                moreCount={Math.max(0, inProgressTotal - 1)}
              />
            )}

            <div className="home-feed">
              {/* Something a family member picked out for you outranks everything
                  time-ranked — sticky until decided, decided right here. */}
              {sentCards.length > 0 && (
                <ul className="inbox-list home-feed-sent">
                  {sentCards.map((card) => (
                    <InboxRow key={card.id} card={card} busy={busySent === card.id} onAct={actOnSent} />
                  ))}
                </ul>
              )}

              {cards === null ? (
                <>
                  <FeedCardSkeleton />
                  <FeedCardSkeleton />
                  <FeedCardSkeleton />
                </>
              ) : (
                <>
                  {rankedCards.map(renderCard)}
                  {rankedCards.length === 0 && sentCards.length === 0 ? (
                    <p className="home-row-empty">
                      A quiet day. New books, today's photo memories and family activity will appear here.
                    </p>
                  ) : (
                    <div className="home-feed-end">
                      <strong>You're all caught up</strong>
                      <span>Tomorrow brings a different day's memories.</span>
                    </div>
                  )}
                </>
              )}
            </div>
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

    {memoryLightbox && memoryLightbox.items[memoryLightbox.index] && (
      <GalleryLightbox
        assets={memoryLightbox.items}
        index={memoryLightbox.index}
        canDelete={false}
        canEdit={false}
        canShare={false}
        onClose={() => setMemoryLightbox(null)}
        onIndexChange={(next) => setMemoryLightbox((current) => (current ? { ...current, index: next } : current))}
        onChanged={() => { /* home is a read-only glance; likes refresh on next load */ }}
      />
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
