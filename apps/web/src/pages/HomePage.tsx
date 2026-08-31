import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { BookOpen, ChevronRight, DownloadCloud, HardDrive, Image as ImageIcon, Library, Loader2, Play, SlidersHorizontal, Sparkles } from "lucide-react";
import { ActivityList } from "../features/social/ActivityList";
import { InboxRow, type InboxCard } from "../features/social/InboxRow";
import { api, type PublicUser } from "../api";
import { DashboardShell } from "../app/DashboardShell";
import { followRoute, navigate } from "../router";
import { MessageBox } from "../shared/MessageBox";
import { Modal } from "../shared/Modal";
import { Button } from "../shared/Button";
import { authorLine, audioRecordToFeedItem, ebookRecordToFeedItem, fetchFeed, saveFeedItemOffline, type FeedItem } from "../features/library/feed";
import { batchDayLabel, fetchDailyQuote, fetchHomeFeed, fetchRecentlyAddedPhotos, localDate, storeQuoteCategory, storeQuotePrefs, storedQuotePrefs, tightMemoryGroups, toActivityItem, type ActivityCard, type AddedBatchCard, type HomeCard, type MemoryCard, type PhotosAddedCard, type QuoteCard, type QuotePrefs, type SentCard, type SeriesNextCard } from "../features/home/feed";
import { FeedListItem, FeedListItemSkeleton } from "../features/library/FeedListItem";
import { DEFAULT_COVERS } from "../features/audiobooks/covers";
import { useIsMobile } from "../shared/useIsMobile";
import { useOnlineStatus } from "../pwa/useOnlineStatus";
import { getDownloadedEpubBlob, getEbookDownload, listDownloads, listEbookDownloads, type DownloadRecord, type EbookDownloadRecord } from "../offline/downloads";
import { isFoliateFormat } from "../shared/utils";
import { EbookReader } from "../features/audiobooks/reader/EbookReader";
import type { AudiobookBookDetail, ReadingProgress } from "../features/audiobooks/types";
import type { GalleryAsset, GalleryLibrary, GalleryMemories } from "../features/gallery/types";
import { GalleryLightbox } from "../features/gallery/GalleryLightbox";

// The resume hero — the single most-recent in-progress book, pinned above the
// feed on every screen size (it grew up on mobile; desktop adopted it in the
// feed revamp). Tapping the main area resumes; the side column carries the
// save-for-offline button (phones, where offline matters) and the play/read
// action.
function ResumeHero({ item, onRead, downloaded, onDownloaded, onDownload, onToast, mobile, moreCount }: {
  item: FeedItem;
  onRead: (item: FeedItem) => Promise<void>;
  downloaded: boolean;
  onDownloaded: (id: string) => void;
  onDownload: (info: { title: string; progress: number } | null) => void;
  onToast: (message: string) => void;
  mobile: boolean;
  moreCount: number;
}) {
  const { t } = useTranslation();
  const isEbook = item.kind === "ebook";
  const percent = Math.round((item.percentComplete ?? 0) * 100);
  const [opening, setOpening] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const resume = () => {
    if (isEbook) {
      setOpening(true);
      void onRead(item).finally(() => setOpening(false));
    } else if (mobile) {
      // Phones / the installed app: the player takes over the screen.
      navigate(`/player/${item.id}`);
    } else {
      // Desktop opens the player in its own small window, the same way the
      // catalog, bookmarks and collections do — the page you're on stays put.
      window.open(`/player/${item.id}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes");
    }
  };

  const saveOffline = async () => {
    if (downloading) return;
    setDownloading(true);
    onDownload({ title: item.title, progress: 0 });
    try {
      await saveFeedItemOffline(item, (fraction) => onDownload({ title: item.title, progress: fraction }));
      onDownloaded(item.id);
      onToast(t("home.savedOffline"));
    } catch {
      onToast(t("home.downloadFailed"));
    } finally {
      onDownload(null);
      setDownloading(false);
    }
  };

  return (
    <section className="home-resume" aria-label={t("home.resumeAria")}>
      <div className="home-resume-card">
        <button type="button" className="home-resume-main" onClick={resume} disabled={opening} aria-label={t("home.resume", { title: item.title })}>
          <span className="home-resume-cover">
            <img src={item.coverUrl ?? DEFAULT_COVERS[item.kind]} alt="" />
          </span>
          <span className="home-resume-body">
            <span className="home-resume-eyebrow">{isEbook ? t("home.continueReading") : t("home.continueListening")}</span>
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
          {mobile && (downloaded ? (
            <button
              type="button"
              className="home-resume-dl is-saved"
              onClick={() => navigate("/downloads")}
              title={t("home.savedOffline")}
              aria-label={t("home.availableOffline")}
            >
              <HardDrive size={16} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="home-resume-dl"
              onClick={saveOffline}
              disabled={downloading}
              title={downloading ? t("home.downloading") : t("home.saveForOffline")}
              aria-label={downloading ? t("home.downloading") : t("home.saveForOffline")}
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
            aria-label={isEbook ? t("home.readTitle", { title: item.title }) : t("home.playTitle", { title: item.title })}
            title={isEbook ? t("home.read") : t("home.play")}
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
          <span>{t("home.moreInProgress", { count: moreCount })}</span>
          <ChevronRight size={15} aria-hidden="true" />
        </a>
      )}
    </section>
  );
}

// Which set the home's photo viewer is paging: the day the memory card stands
// for, or the arrivals the "New photos" card counted (with the window it used,
// so a re-fetch after an edit asks for exactly the same set).
type PhotoSource = { kind: "memory" } | { kind: "added"; days: number };

// ── Feed cards ───────────────────────────────────────────────────────────────
// Every card renders on the shared .home-card chrome; each type brings its own
// body. The server owns the order — the client never re-sorts.

function MemoryFeedCard({ card, onOpen }: { card: MemoryCard; onOpen: (year: number, itemId: string) => void }) {
  const { t } = useTranslation();
  const title = card.precision === "near" ? t("home.aroundThisDay") : t("home.onThisDay");
  // The server picked the strip for variety — one photo per year, people
  // preferred. Each photo jumps straight to itself in the viewer.
  const photos = card.strip.map(({ item, year }) => ({ item, year }));
  const yearSpan = card.years.length === 1
    ? String(card.years[0])
    : `${card.years[card.years.length - 1]} – ${card.years[0]}`;
  return (
    <section className="home-card home-card-memory" aria-label={title}>
      <header className="home-card-head">
        <span className="home-card-who"><strong>{title}</strong> · {yearSpan}</span>
        <a className="home-card-link" href="/gallery/memories" onClick={(event) => followRoute(event, "/gallery/memories")}>
          <span>{t("common.viewAll")}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </a>
      </header>
      <div className="home-memory-strip">
        {photos.map(({ item, year }) => (
          <button
            key={item.id}
            type="button"
            className="home-memory-photo"
            onClick={() => onOpen(year, item.id)}
            aria-label={t("home.photosFromYear", { year })}
          >
            {item.coverUrl
              ? <img src={item.coverUrl} alt="" loading="lazy" />
              : <span className="home-memory-fallback"><ImageIcon size={24} aria-hidden="true" /></span>}
            <em>{year}</em>
          </button>
        ))}
      </div>
      <p className="home-card-sub">
        {t("home.memorySub", { count: card.totalCount })}
      </p>
    </section>
  );
}

// "New photos": everything the gallery took in over the past week, as one card
// with a strip — the server leaves it out entirely when nothing arrived, so the
// front page never carries an empty shortcut to the gallery.
function PhotosAddedFeedCard({ card, onOpen }: { card: PhotosAddedCard; onOpen: (itemId: string) => void }) {
  const { t } = useTranslation();
  const timelineHref = "/gallery?sort=added";
  return (
    <section className="home-card home-card-photos" aria-label={t("home.photosAdded")}>
      <header className="home-card-head">
        <span className="home-card-who">
          <strong>{t("home.photosAdded")}</strong> · {t("home.photosAddedWindow", { count: card.days })}
        </span>
        <a className="home-card-link" href={timelineHref} onClick={(event) => followRoute(event, timelineHref)}>
          <span>{t("common.viewAll")}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </a>
      </header>
      <div className="home-memory-strip">
        {card.strip.map((item) => (
          <button
            key={item.id}
            type="button"
            className="home-memory-photo"
            onClick={() => onOpen(item.id)}
            aria-label={t("home.openPhoto", { title: item.title })}
          >
            {item.coverUrl
              ? <img src={item.coverUrl} alt="" loading="lazy" />
              : <span className="home-memory-fallback"><ImageIcon size={24} aria-hidden="true" /></span>}
          </button>
        ))}
      </div>
      <p className="home-card-sub">{t("home.photosAddedSub", { count: card.count })}</p>
    </section>
  );
}

function BatchFeedCard({ card }: { card: AddedBatchCard }) {
  const { t } = useTranslation();
  const more = card.count - card.coverUrls.length;
  return (
    <a className="home-card home-card-batch" href="/recent" onClick={(event) => followRoute(event, "/recent")}>
      <header className="home-card-head">
        <span className="home-card-who">
          {t("home.batchJoined", { count: card.count, day: batchDayLabel(card.day) })}
        </span>
      </header>
      <div className="home-batch-fan">
        {card.coverUrls.map((url) => (
          <span key={url} className="home-batch-cover"><img src={url} alt="" loading="lazy" /></span>
        ))}
        {card.coverUrls.length === 0 && (
          <span className="home-batch-cover home-batch-cover-empty"><Library size={22} aria-hidden="true" /></span>
        )}
        <span className="home-batch-more">{more > 0 ? t("home.plusMore", { count: more }) : t("common.browse")} <ChevronRight size={15} aria-hidden="true" /></span>
      </div>
    </a>
  );
}

function SeriesNextFeedCard({ card }: { card: SeriesNextCard }) {
  const { t } = useTranslation();
  return (
    <a className="home-card home-card-suggest" href={card.item.href} onClick={(event) => followRoute(event, card.item.href)}>
      <span className="home-suggest-cover">
        {card.item.coverUrl
          ? <img src={card.item.coverUrl} alt="" loading="lazy" />
          : <span className="home-memory-fallback"><Sparkles size={22} aria-hidden="true" /></span>}
      </span>
      <span className="home-suggest-copy">
        <small className="home-suggest-why">
          <Trans i18nKey="home.youFinished" values={{ title: card.finishedTitle }} components={{ bold: <strong /> }} />
        </small>
        <strong className="home-suggest-title">{t("home.onShelf", { title: card.item.title })}</strong>
        <small className="home-suggest-series">{t("home.nextInSeries", { series: card.seriesName })}</small>
      </span>
    </a>
  );
}

// Quote of the day. The server already picked one honouring the stored category,
// so this only has to redraw when the viewer switches — one small request that
// swaps the quote, rather than reloading the whole front page.
function QuoteFeedCard({ card }: { card: QuoteCard }) {
  const { t } = useTranslation();
  const [quote, setQuote] = useState<QuoteCard>(card);
  const [busy, setBusy] = useState(false);
  const [tuning, setTuning] = useState(false);
  const active = quote.category ?? "";

  const reload = async (category: string, prefs?: QuotePrefs) => {
    setBusy(true);
    try {
      const { quote: next } = await fetchDailyQuote(category, prefs);
      if (next) setQuote(next);
    } catch {
      // Keep showing the quote already on screen.
    } finally {
      setBusy(false);
    }
  };

  const choose = (category: string) => {
    if (category === active) return;
    storeQuoteCategory(category);
    void reload(category);
  };

  // Changing what you like starts the card over on "All": the chip you were
  // standing on may not be among your categories any more.
  const savePrefs = (prefs: QuotePrefs) => {
    storeQuotePrefs(prefs);
    storeQuoteCategory("");
    setTuning(false);
    void reload("", prefs);
  };

  const byline = [quote.attribution, quote.source].filter(Boolean).join(" · ");

  return (
    <div className={`home-card home-card-quote${busy ? " is-busy" : ""}`}>
      <div className="home-quote-head">
        <small className="home-quote-eyebrow">
          {quote.yearsAgo === null
            ? t("home.quoteOfTheDay")
            : t("home.quoteYearsAgoToday", { count: quote.yearsAgo })}
        </small>
        {/* Only worth offering once there is something to choose between. */}
        {quote.allCategories.length > 0 && (
          <button
            type="button"
            className="icon-button home-quote-tune"
            onClick={() => setTuning(true)}
            aria-label={t("home.quotePrefsTitle")}
            title={t("home.quotePrefsTitle")}
          >
            <SlidersHorizontal size={15} />
          </button>
        )}
      </div>
      <blockquote className="home-quote-text">{quote.text}</blockquote>
      {byline && <p className="home-quote-byline">{byline}</p>}
      {quote.categories.length > 0 && (
        <div className="home-quote-categories" role="group" aria-label={t("home.quoteCategoryLabel")}>
          <button
            type="button"
            className={`home-quote-category${active === "" ? " is-active" : ""}`}
            aria-pressed={active === ""}
            onClick={() => void choose("")}
          >
            {t("home.quoteAllCategories")}
          </button>
          {quote.categories.map((category) => (
            <button
              key={category}
              type="button"
              className={`home-quote-category${active === category ? " is-active" : ""}`}
              aria-pressed={active === category}
              onClick={() => void choose(category)}
            >
              {category}
            </button>
          ))}
        </div>
      )}

      {tuning && (
        <QuotePrefsModal
          allCategories={quote.allCategories}
          onSave={savePrefs}
          onClose={() => setTuning(false)}
        />
      )}
    </div>
  );
}

// What this viewer wants from the daily card: which language, and which
// categories. Kept in the browser rather than the database — it is a per-viewer
// convenience like the chip choice, and losing it just means the card goes back
// to the whole library in whatever language the app is being read in.
function QuotePrefsModal({
  allCategories,
  onSave,
  onClose
}: {
  allCategories: string[];
  onSave: (prefs: QuotePrefs) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [prefs, setPrefs] = useState<QuotePrefs>(storedQuotePrefs);

  const toggle = (category: string) => {
    setPrefs((current) => ({
      ...current,
      categories: current.categories.includes(category)
        ? current.categories.filter((name) => name !== category)
        : [...current.categories, category]
    }));
  };

  return (
    <Modal
      variant="card"
      title={t("home.quotePrefsTitle")}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); onSave(prefs); }}
    >
      <div className="quote-prefs">
        <label className="field">
          <span>{t("home.quotePrefsLanguage")}</span>
          <select
            value={prefs.language}
            onChange={(event) => setPrefs((current) => ({ ...current, language: event.target.value }))}
          >
            {/* "" follows the app's own language, which is what most people want
                and what the card did before this dialog existed. */}
            <option value="">{t("home.quotePrefsLanguageAuto")}</option>
            <option value="en">English</option>
            <option value="ru">Русский</option>
          </select>
        </label>

        {/* Not a .field: that class styles its inputs as full-width 46px text
            boxes, which turns a checkbox into a giant square and squeezes its
            label into a one-character column. */}
        <div className="quote-prefs-group">
          <span className="quote-prefs-label">{t("home.quotePrefsCategories")}</span>
          <p className="muted quote-prefs-hint">{t("home.quotePrefsCategoriesHint")}</p>
          <div className="quote-prefs-categories">
            {allCategories.map((category) => (
              <label className="quote-prefs-category" key={category} title={category}>
                <input
                  type="checkbox"
                  checked={prefs.categories.includes(category)}
                  onChange={() => toggle(category)}
                />
                <span>{category}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit">{t("home.quotePrefsSave")}</Button>
        </div>
      </div>
    </Modal>
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
  const { t } = useTranslation();
  return (
    <section className="home-section" aria-labelledby={id}>
      <div className="home-section-title">
        <h2 id={id}>{title}</h2>
        <a href="/downloads" onClick={(event) => followRoute(event, "/downloads")}>
          <span>{t("common.viewAll")}</span>
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
  const { t } = useTranslation();
  const [cards, setCards] = useState<HomeCard[] | null>(null);
  const [heroItem, setHeroItem] = useState<FeedItem | null>(null);
  const [inProgressTotal, setInProgressTotal] = useState(0);
  // The photo viewer opened from a gallery card: the FULL set that card stands
  // for — every photo of the day for "On this day", the whole week's arrivals
  // for "New photos" — plus the item currently shown. Either card carries only
  // a few covers, so opening the viewer re-fetches the complete set, and the
  // source remembers which one to re-fetch after an edit.
  const [photoLightbox, setPhotoLightbox] = useState<
    { items: GalleryAsset[]; index: number; source: PhotoSource } | null
  >(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  // Gallery libraries with their permission flags, so the memory lightbox can
  // offer exactly what the Timeline offers (edit/rotate/delete/guest link).
  // Fetched once, the first time the viewer opens.
  const [galleryLibraries, setGalleryLibraries] = useState<GalleryLibrary[] | null>(null);
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

  // Open the "On this day" viewer on the clicked photo. The card carries a few
  // covers, so load the full set (all photos, every year) and flatten it the
  // same way the gallery does — newest year first, chronological within a
  // year — so Next flows across the whole day. We land on the exact photo that
  // was tapped (several strip photos can share a year, so the year alone isn't
  // enough), falling back to the first photo of that year, then to the
  // Memories page on failure.
  const openMemory = useCallback(async (year: number, itemId?: string) => {
    if (memoryLoading) return;
    setMemoryLoading(true);
    try {
      const full = await api<GalleryMemories>(`/api/library/gallery/memories?date=${localDate()}&perYear=200`);
      // Same tightness the card applied, so the viewer pages through exactly
      // the day the card advertises — not near-days it deliberately left out.
      const groups = full.precision === "month" ? [] : tightMemoryGroups(full.groups);
      const items = groups.flatMap((group) => group.items);
      if (items.length === 0) { navigate("/gallery/memories"); return; }
      let start = itemId ? items.findIndex((item) => item.id === itemId) : -1;
      if (start < 0) {
        start = 0;
        for (const group of groups) {
          if (group.year === year) break;
          start += group.items.length;
        }
      }
      setPhotoLightbox({ items, index: Math.min(start, items.length - 1), source: { kind: "memory" } });
    } catch {
      navigate("/gallery/memories");
    } finally {
      setMemoryLoading(false);
    }
  }, [memoryLoading]);

  // Open the "New photos" viewer on the clicked photo. Same shape as the memory
  // opener: the card carries four covers, the viewer pages the whole week the
  // card counted, and a failure just lands in the gallery sorted by arrival.
  const openRecentPhoto = useCallback(async (itemId: string, days: number) => {
    if (memoryLoading) return;
    setMemoryLoading(true);
    try {
      const items = await fetchRecentlyAddedPhotos(days);
      if (items.length === 0) { navigate("/gallery?sort=added"); return; }
      const start = Math.max(0, items.findIndex((item) => item.id === itemId));
      setPhotoLightbox({ items, index: start, source: { kind: "added", days } });
    } catch {
      navigate("/gallery?sort=added");
    } finally {
      setMemoryLoading(false);
    }
  }, [memoryLoading]);

  // Load the permission flags alongside the first viewer open. Until they
  // land the viewer is read-only, which is also the safe answer on failure.
  useEffect(() => {
    if (!photoLightbox || galleryLibraries !== null) return;
    api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries")
      .then((payload) => setGalleryLibraries(payload.libraries))
      .catch(() => setGalleryLibraries([]));
  }, [photoLightbox, galleryLibraries]);

  // After the viewer changes something (a rotate, an edit, a delete), re-fetch
  // the day and find the photo we were on again — or the one that took its
  // place when it was the one deleted. The same job refreshView does on the
  // gallery pages.
  const refreshPhotoLightbox = useCallback(async (source: PhotoSource) => {
    try {
      let items: GalleryAsset[];
      if (source.kind === "added") {
        items = await fetchRecentlyAddedPhotos(source.days);
      } else {
        const full = await api<GalleryMemories>(`/api/library/gallery/memories?date=${localDate()}&perYear=200`);
        const groups = full.precision === "month" ? [] : tightMemoryGroups(full.groups);
        items = groups.flatMap((group) => group.items);
      }
      setPhotoLightbox((current) => {
        if (!current) return current;
        if (items.length === 0) return null;
        const currentId = current.items[current.index]?.id;
        const found = items.findIndex((item) => item.id === currentId);
        const index = found >= 0 ? found : Math.min(current.index, items.length - 1);
        return { items, index, source: current.source };
      });
    } catch {
      // Keep showing what we have; the next open refetches anyway.
    }
  }, []);

  // The Details panel's folder line: close the viewer and land in the gallery's
  // Folders view on that folder, the way the Timeline's viewer does. Segments
  // are encoded one by one so names with #/% survive while slashes stay slashes.
  const openMemoryFolder = useCallback((folder: string) => {
    const asset = photoLightbox ? photoLightbox.items[photoLightbox.index] : null;
    const path = folder.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    setPhotoLightbox(null);
    navigate(`/gallery/folders/${path}${asset ? `?library=${encodeURIComponent(asset.libraryId)}` : ""}`);
  }, [photoLightbox]);

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
    if (!offlineBlob && !networkUrl) { showToast(t("home.notAvailableOffline")); return; }

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
  }, [showToast, t]);

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
        setError(reason instanceof Error ? reason.message : t("home.loadFailed"));
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
      if (action === "save") showToast(t("home.addedToLikes"));
    } catch {
      showToast(action === "save" ? t("home.likeFailed") : t("home.dismissFailed"));
    } finally {
      setBusySent(null);
    }
  }, [showToast, t]);

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
        return <MemoryFeedCard key="memory" card={card} onOpen={(year, itemId) => void openMemory(year, itemId)} />;
      case "photos_added":
        return <PhotosAddedFeedCard key="photos" card={card} onOpen={(itemId) => void openRecentPhoto(itemId, card.days)} />;
      case "added_batch":
        return <BatchFeedCard key={`batch-${card.day}`} card={card} />;
      case "series_next":
        return <SeriesNextFeedCard key={`series-${card.item.id}`} card={card} />;
      case "quote":
        return <QuoteFeedCard key="quote" card={card} />;
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
              {online ? t("common.online") : t("common.offline")}
            </span>
          </header>
        ) : (
          <header className="home-header">
            <div className="home-heading">
              <h1>{t("home.welcome", { name: user.displayName })}</h1>
              <p>{t("home.subtitle")}</p>
            </div>
          </header>
        )}

        {error && !offlineMode && <MessageBox tone="error" title={t("home.loadTitle")}>{error}</MessageBox>}

        {offlineMode ? (
          <div className="home-content">
            {!offlineLoaded ? (
              <OfflineRow id="home-offline-title" title={t("home.downloadedTitle")} items={null} downloadedIds={downloadedIds} />
            ) : offlineEmpty ? (
              <div className="empty-state home-offline-empty">
                <DownloadCloud size={52} aria-hidden="true" />
                <h2>{t("home.nothingSaved")}</h2>
                <p className="muted">{t("home.offlineEmptyBody")}</p>
              </div>
            ) : (
              <>
                {offlineAudioItems && offlineAudioItems.length > 0 && (
                  <OfflineRow
                    id="home-offline-audio"
                    title={t("nav.audiobooks")}
                    items={offlineAudioItems}
                    downloadedIds={downloadedIds}
                    onToast={showToast}
                  />
                )}
                {offlineEbookItems && offlineEbookItems.length > 0 && (
                  <OfflineRow
                    id="home-offline-ebooks"
                    title={t("nav.ebooks")}
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
                mobile={isMobile}
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
                      {t("home.quietDay")}
                    </p>
                  ) : (
                    <div className="home-feed-end">
                      <strong>{t("home.caughtUp")}</strong>
                      <span>{t("home.tomorrow")}</span>
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
          <span className="home-dl-banner-label">{t("home.downloadingTitle", { title: activeDownload.title })}</span>
          <span className="home-dl-banner-track">
            <span style={{ width: `${Math.round(activeDownload.progress * 100)}%` }} />
          </span>
        </div>
        <span className="home-dl-banner-pct">{Math.round(activeDownload.progress * 100)}%</span>
      </div>,
      document.body
    )}

    {photoLightbox && photoLightbox.items[photoLightbox.index] && (() => {
      // Per-photo permissions, exactly as the gallery pages compute them.
      const library = galleryLibraries?.find(
        (candidate) => candidate.id === photoLightbox.items[photoLightbox.index].libraryId
      );
      return (
        <GalleryLightbox
          assets={photoLightbox.items}
          index={photoLightbox.index}
          canDelete={library?.canDelete ?? false}
          canEdit={library?.canWrite ?? false}
          canShare={library?.canCurate ?? false}
          onClose={() => setPhotoLightbox(null)}
          onIndexChange={(next) => setPhotoLightbox((current) => (current ? { ...current, index: next } : current))}
          onChanged={() => void refreshPhotoLightbox(photoLightbox.source)}
          onOpenFolder={openMemoryFolder}
        />
      );
    })()}

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
