import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronRight, Clapperboard, Film, Headphones, Image as ImageIcon, Loader2, Play, Tv } from "lucide-react";
import { api } from "../../api";
import { LibraryCards } from "../../app/OrbitLibraries";
import { useSections } from "../../app/sections";
import { useVideoAvailable } from "../../app/useVideoAvailable";
import { followRoute, galleryRecentHref, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { coverBackdrop } from "../../shared/coverBackdrop";
import { DEFAULT_COVERS } from "../audiobooks/covers";
import { authorLine, feedHref, fetchFeed, type FeedItem } from "../library/feed";
import {
  VIDEO_API,
  episodeCodeValues,
  videoHref,
  watchHref,
  type VideoContinueItem,
  type VideoMovieSummary,
  type VideoPage,
  type VideoShowSummary
} from "../video/types";
import type { HomeCard, MemoryCard, PhotosAddedCard } from "./feed";

// The top layout's Home (app/layoutChoice.ts): what you were doing and what this day holds
// on top, rows of what is new under it, and the family's feed last. It takes the
// same cards as the normal Home; only the arrangement differs.

// The engine's continue list has no pictures, so each costs a request of its own.
// A row shows about this many before it clips.
const POSTERS_ASKED = 8;

// SQLite writes ISO with Z on newer rows and the space form on older ones.
function timeOf(stamp: string | null | undefined): number {
  if (!stamp) return 0;
  const parsed = Date.parse(stamp.includes("T") ? stamp : `${stamp.replace(" ", "T")}Z`);
  return Number.isNaN(parsed) ? 0 : parsed;
}

interface Tile {
  key: string;
  href: string;
  title: string;
  sub: string;
  cover: string | null;
  shape: "square" | "tall";
  percent?: number;
  fallback: typeof Film;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

function openBook(item: FeedItem, onRead: (item: FeedItem) => Promise<void>): Promise<void> {
  if (item.kind === "ebook") return onRead(item);
  // The popup player, the desktop's way of playing a book everywhere else.
  window.open(`/player/${item.id}`, "isputnik-player", "width=500,height=700,resizable=yes,scrollbars=yes");
  return Promise.resolve();
}

function bookTile(item: FeedItem, onResume?: (item: FeedItem) => void): Tile {
  return {
    key: `${item.kind}-${item.id}`,
    href: feedHref(item),
    title: item.title,
    sub: authorLine(item),
    cover: item.coverUrl ?? DEFAULT_COVERS[item.kind] ?? null,
    shape: item.kind === "ebook" ? "tall" : "square",
    percent: onResume && item.percentComplete ? Math.round(item.percentComplete * 100) : undefined,
    fallback: item.kind === "ebook" ? BookOpen : Headphones,
    onClick: onResume
      ? (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onResume(item);
      }
      : undefined
  };
}

function TileRow({ title, viewAll, tiles }: { title: string; viewAll?: string; tiles: Tile[] }) {
  const { t } = useTranslation();
  if (tiles.length === 0) return null;
  return (
    <section className="orbit-section">
      <div className="orbit-section-head">
        <h2>{title}</h2>
        {viewAll && (
          <a href={viewAll} onClick={(event) => followRoute(event, viewAll)}>
            <span>{t("common.viewAll")}</span>
            <ChevronRight size={16} aria-hidden="true" />
          </a>
        )}
      </div>
      {/* One line of whole tiles: as many as fit, the rest wrap out of sight. */}
      <div className="orbit-row">
        {tiles.map((tile) => {
          const Fallback = tile.fallback;
          return (
            <a
              key={tile.key}
              className={`orbit-tile is-${tile.shape}`}
              href={tile.href}
              onClick={tile.onClick ?? ((event) => followRoute(event, tile.href))}
            >
              <span className={`orbit-tile-cover${tile.cover ? " cover-backdrop" : ""}`} style={coverBackdrop(tile.cover)}>
                {tile.cover
                  ? <img src={tile.cover} alt="" loading="lazy" />
                  : <span className="orbit-tile-empty"><Fallback size={30} aria-hidden="true" /></span>}
                {tile.percent !== undefined && (
                  <span className="orbit-tile-bar" aria-hidden="true"><span style={{ width: `${tile.percent}%` }} /></span>
                )}
              </span>
              <strong title={tile.title}>{tile.title}</strong>
              <small title={tile.sub}>{tile.sub}</small>
            </a>
          );
        })}
      </div>
    </section>
  );
}

// What was left halfway. A picture may be a small square cover or a poster, so the
// card's backdrop is that same picture blurred: it works for whatever is there.
function ContinueCard({ eyebrow, title, byline, cover, percent, busy, icon, onResume }: {
  eyebrow: string;
  title: string;
  byline: string;
  cover: string | null;
  percent: number;
  busy: boolean;
  icon: ReactNode;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="orbit-card orbit-continue" aria-label={eyebrow}>
      {cover && <span className="orbit-continue-backdrop" style={{ backgroundImage: `url("${cover}")` }} aria-hidden="true" />}
      <div className="orbit-card-eyebrow">{icon}<span>{eyebrow}</span></div>
      <div className="orbit-continue-body">
        <span className="orbit-continue-cover">
          {cover ? <img src={cover} alt="" /> : <Clapperboard size={40} aria-hidden="true" />}
        </span>
        <div className="orbit-continue-copy">
          <strong>{title}</strong>
          <small>{byline}</small>
          {percent > 0 && (
            <span className="orbit-progress">
              <span className="orbit-progress-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
              <span>{percent}%</span>
            </span>
          )}
          <Button variant="primary" className="orbit-resume" onClick={onResume} disabled={busy}>
            {busy ? <Loader2 size={17} className="home-feed-spin" aria-hidden="true" /> : <Play size={17} fill="currentColor" aria-hidden="true" />}
            <span>{t("orbit.resume")}</span>
          </Button>
        </div>
      </div>
    </section>
  );
}

function MemoryPanel({ card, onOpen }: { card: MemoryCard; onOpen: (year: number, itemId?: string) => void }) {
  const { t } = useTranslation();
  const label = card.precision === "near" ? t("home.aroundThisDay") : t("home.onThisDay");
  const photos = card.strip.slice(0, 3);
  return (
    <section className="orbit-card orbit-memory" aria-label={label}>
      <div className="orbit-memory-copy">
        <div className="orbit-card-eyebrow"><ImageIcon size={18} aria-hidden="true" /><span>{label}</span></div>
        <strong>{t("orbit.memories", { count: card.totalCount })}</strong>
        <small>{t("orbit.memoriesSub")}</small>
        <div className="orbit-years">
          {card.years.slice(0, 4).map((year) => (
            <Button variant="chip" key={year} onClick={() => onOpen(year)}>{year}</Button>
          ))}
        </div>
      </div>
      <div className={`orbit-memory-photos is-count-${photos.length}`}>
        {photos.map(({ item, year }) => (
          <Button
            variant="tile"
            key={item.id}
            className="orbit-print"
            onClick={() => onOpen(year, item.id)}
            aria-label={t("home.photosFromYear", { year })}
          >
            {item.coverUrl
              ? <img src={item.coverUrl} alt="" loading="lazy" />
              : <span className="orbit-tile-empty"><ImageIcon size={24} aria-hidden="true" /></span>}
          </Button>
        ))}
      </div>
    </section>
  );
}

function NewPhotos({ card, onOpen }: { card: PhotosAddedCard; onOpen: (itemId: string) => void }) {
  const { t } = useTranslation();
  const href = galleryRecentHref();
  return (
    <section className="orbit-section orbit-new-photos">
      <div className="orbit-section-head">
        <h2>{t("home.photosAdded")}</h2>
        <a href={href} onClick={(event) => followRoute(event, href)}>
          <span>{t("home.photosAddedSub", { count: card.count })}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </a>
      </div>
      <div className="orbit-photo-strip">
        {card.strip.map((item) => (
          <Button
            variant="tile"
            key={item.id}
            className="orbit-photo"
            onClick={() => onOpen(item.id)}
            aria-label={t("home.openPhoto", { title: item.title })}
          >
            {item.coverUrl
              ? <img src={item.coverUrl} alt="" loading="lazy" />
              : <span className="orbit-tile-empty"><ImageIcon size={24} aria-hidden="true" /></span>}
          </Button>
        ))}
      </div>
    </section>
  );
}

export function OrbitHome({
  displayName,
  cards,
  waiting,
  notice,
  renderCard,
  onRead,
  onOpenMemory,
  onOpenRecentPhoto
}: {
  displayName: string;
  cards: HomeCard[] | null;
  /** The rows waiting on this person, as the normal Home draws them. */
  waiting: ReactNode;
  /** Errors and the What's new note. */
  notice: ReactNode;
  renderCard: (card: HomeCard) => ReactNode;
  onRead: (item: FeedItem) => Promise<void>;
  onOpenMemory: (year: number, itemId?: string) => void;
  onOpenRecentPhoto: (itemId: string, days: number) => void;
}) {
  const { t } = useTranslation();
  const sections = useSections();
  const videoAvailable = useVideoAvailable();
  const videoOn = videoAvailable && sections.video;

  const [books, setBooks] = useState<FeedItem[]>([]);
  const [recent, setRecent] = useState<FeedItem[]>([]);
  const [watching, setWatching] = useState<VideoContinueItem[]>([]);
  const [posters, setPosters] = useState<Record<string, string | null>>({});
  const [newVideo, setNewVideo] = useState<Tile[]>([]);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let live = true;
    fetchFeed("continue", 12).then((payload) => { if (live) setBooks(payload.items); }).catch(() => undefined);
    fetchFeed("recent", 24).then((payload) => { if (live) setRecent(payload.items); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!videoOn) return;
    let live = true;
    api<{ items: VideoContinueItem[] }>(`${VIDEO_API}/continue`)
      .then(async ({ items }) => {
        if (!live) return;
        setWatching(items);
        // The engine's continue list carries no pictures; ask each title for its own.
        const pictures = await Promise.allSettled(items.slice(0, POSTERS_ASKED).map(async (item) => {
          const path = item.show ? `shows/${item.show.id}` : `movies/${item.id}`;
          const detail = await api<{ show?: { poster?: string | null }; movie?: { poster?: string | null }; poster?: string | null }>(`${VIDEO_API}/${path}`);
          return [item.id, detail.show?.poster ?? detail.movie?.poster ?? detail.poster ?? null] as const;
        }));
        if (!live) return;
        setPosters(Object.fromEntries(pictures.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []))));
      })
      .catch(() => undefined);

    const newest = <T,>(kind: "shows" | "movies") =>
      api<VideoPage<T>>(`${VIDEO_API}/${kind}?sort=added&pageSize=12`).then((page) => page.items).catch(() => [] as T[]);
    void Promise.all([newest<VideoMovieSummary>("movies"), newest<VideoShowSummary>("shows")]).then(([movies, shows]) => {
      if (!live) return;
      const tiles: Tile[] = [];
      for (let i = 0; i < Math.max(movies.length, shows.length); i += 1) {
        const movie = movies[i];
        const show = shows[i];
        if (movie) {
          const href = videoHref("movies", movie.id);
          tiles.push({ key: `m-${movie.id}`, href, title: movie.title, sub: movie.year ? String(movie.year) : t("video.movies"), cover: movie.poster ?? null, shape: "tall", fallback: Film });
        }
        if (show) {
          const href = videoHref("shows", show.id);
          tiles.push({ key: `s-${show.id}`, href, title: show.title, sub: show.year ? String(show.year) : t("video.shows"), cover: show.poster ?? null, shape: "tall", fallback: Tv });
        }
      }
      setNewVideo(tiles);
    });
    return () => { live = false; };
  }, [videoOn, t]);

  const resumeBook = (item: FeedItem) => {
    setOpening(true);
    void openBook(item, onRead).finally(() => setOpening(false));
  };

  const memory = cards?.find((card): card is MemoryCard => card.type === "memory") ?? null;
  const photos = cards?.find((card): card is PhotosAddedCard => card.type === "photos_added") ?? null;
  const quote = cards?.find((card) => card.type === "quote") ?? null;
  const feed = (cards ?? []).filter((card) => card.type !== "memory" && card.type !== "photos_added" && card.type !== "quote");

  const videoLine = (item: VideoContinueItem) => {
    const code = item.season !== null && item.episode !== null ? t("video.episodeCode", episodeCodeValues(item.season, item.episode)) : null;
    return item.show ? [code, item.title].filter(Boolean).join(" · ") : t("video.movies");
  };
  const videoTile = (item: VideoContinueItem): Tile => ({
    key: `w-${item.id}`,
    href: watchHref(item.id),
    title: item.show ? item.show.title : item.title,
    sub: videoLine(item),
    cover: posters[item.id] ?? null,
    shape: "tall",
    percent: item.resume && item.duration ? Math.round(Math.min(1, item.position / item.duration) * 100) : undefined,
    fallback: item.type === "episode" ? Tv : Film
  });

  // The most recent of everything leads, and the rest follow in the same order.
  const started = [
    ...books.map((item) => ({ at: timeOf(item.lastActivityAt), book: item, video: null })),
    ...watching.map((item) => ({ at: timeOf(item.updatedAt), book: null, video: item }))
  ].sort((a, b) => b.at - a.at);
  const heroBook = started[0]?.book ?? null;
  const heroVideo = started[0]?.video ?? null;
  const inProgress: Tile[] = started.slice(1).map((entry) => (entry.book ? bookTile(entry.book, resumeBook) : videoTile(entry.video!)));

  // Books and video, turn about: each list is newest first, but the engine's titles
  // carry no date to sort the two together by.
  const bookTiles = recent.map((item) => bookTile(item));
  const recentlyAdded: Tile[] = [];
  for (let i = 0; i < Math.max(bookTiles.length, newVideo.length); i += 1) {
    if (bookTiles[i]) recentlyAdded.push(bookTiles[i]);
    if (newVideo[i]) recentlyAdded.push(newVideo[i]);
  }

  const hasContinue = Boolean(heroBook || heroVideo);
  const topClass = hasContinue && memory ? "orbit-top" : "orbit-top is-single";

  return (
    <section className="orbit-home" aria-label={t("nav.home")}>
      <header className="orbit-hello">
        <h1>{t("home.welcome", { name: displayName })}</h1>
        <p>{t("home.subtitle")}</p>
      </header>

      {notice}

      {(hasContinue || memory) && (
        <div className={topClass}>
          {heroBook && (
            <ContinueCard
              eyebrow={heroBook.kind === "ebook" ? t("home.continueReading") : t("home.continueListening")}
              title={heroBook.title}
              byline={authorLine(heroBook)}
              cover={heroBook.coverUrl ?? DEFAULT_COVERS[heroBook.kind] ?? null}
              percent={Math.round((heroBook.percentComplete ?? 0) * 100)}
              busy={opening}
              icon={heroBook.kind === "ebook" ? <BookOpen size={18} aria-hidden="true" /> : <Headphones size={18} aria-hidden="true" />}
              onResume={() => resumeBook(heroBook)}
            />
          )}
          {heroVideo && (
            <ContinueCard
              eyebrow={t("video.continueWatching")}
              title={heroVideo.show ? heroVideo.show.title : heroVideo.title}
              byline={videoLine(heroVideo)}
              cover={posters[heroVideo.id] ?? null}
              percent={heroVideo.resume && heroVideo.duration ? Math.round(Math.min(1, heroVideo.position / heroVideo.duration) * 100) : 0}
              busy={false}
              icon={<Clapperboard size={18} aria-hidden="true" />}
              onResume={() => navigate(watchHref(heroVideo.id))}
            />
          )}
          {memory && <MemoryPanel card={memory} onOpen={onOpenMemory} />}
        </div>
      )}

      {waiting}

      {/* The big cards, only where the screen has room: smaller ones reach the same
          places through the Media button without pushing the rows down. */}
      <section className="orbit-section orbit-library-home">
        <div className="orbit-section-head"><h2>{t("orbit.yourLibrary")}</h2></div>
        <LibraryCards />
      </section>

      {(photos || quote) && (
        <div className={`orbit-split${photos && quote ? "" : " is-single"}`}>
          {photos && <NewPhotos card={photos} onOpen={(itemId) => onOpenRecentPhoto(itemId, photos.days)} />}
          {quote && renderCard(quote)}
        </div>
      )}

      <TileRow title={t("orbit.inProgress")} viewAll={books.length > 1 ? "/continue" : undefined} tiles={inProgress} />
      <TileRow title={t("orbit.recentlyAdded")} viewAll="/recent" tiles={recentlyAdded} />

      {feed.length > 0 && (
        <section className="orbit-section">
          <div className="orbit-section-head"><h2>{t("orbit.feedTitle")}</h2></div>
          <div className="orbit-feed">{feed.map(renderCard)}</div>
        </section>
      )}

      {cards !== null && (
        <div className="home-feed-end">
          <strong>{t("home.caughtUp")}</strong>
          <span>{t("home.tomorrow")}</span>
        </div>
      )}
    </section>
  );
}
