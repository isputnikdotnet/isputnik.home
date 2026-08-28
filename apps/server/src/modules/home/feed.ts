// The home feed: one ranked list of typed cards, replacing the fixed dashboard
// sections (agreed in the Aug 2026 home revamp review).
//
// DERIVED, never stored — the same philosophy as the activity feed. Every card
// is composed at request time from tables that already record what happened, so
// the feed can never disagree with reality.
//
// Every card type declares one LIFETIME CLASS, and the class is the whole
// ranking story:
//   • pinned      — the quote of the day: the one card that is the same for the
//                   whole house and changes every morning, so it opens the page
//                   instead of competing for a place in it
//   • sticky      — "Sent to you": no time decay, leaves when the recipient
//                   decides, always above the ranked cards
//   • today-only  — the gallery memory ("On this day"): gone at midnight,
//                   replaced by tomorrow's — the daily heartbeat of the page
//   • decaying    — added-batches (one card per scan DAY with a cover fan,
//                   never N loose tiles) and activity events (notes, albums,
//                   slideshows, tree people)
//   • filler      — next-in-series: at most one, rotating daily — a treat,
//                   not a nag
//
// rank = class weight × exp(−age / half-life). Boring on purpose.
//
// Dedup rule: one underlying thing gets one card. Book arrivals appear ONLY as
// a batch (the activity feed deliberately carries no "book added" events), and
// the sticky inbox cards are the recommendations themselves, which activity
// deliberately leaves out — so the rule holds by construction; keep it that way
// when adding card types.
import { db } from "../../db.js";
import { loadActivity } from "../social/activity.js";
import { loadInboxCards, type InboxCardView } from "../social/routes.js";
import { bookLibraryIds } from "../library/feed.js";
import { resolveGalleryScopeLibraryIds } from "../library/gallery/catalog.js";
import { queryGalleryMemories, type GalleryMemoriesPrecision, type GalleryMemoryGroup } from "../library/gallery/catalog.js";
import { dailyQuote, type DailyQuote } from "../library/quotes-daily.js";

interface RequestUser {
  id: string;
  role: string;
}

export interface SentCard extends InboxCardView {
  type: "sent";
}

export interface MemoryCard {
  type: "memory";
  precision: Exclude<GalleryMemoriesPrecision, "month">;
  /** Every year with photos on this day, newest first — for the card's label. */
  years: number[];
  totalCount: number;
  /** The four photos shown, chosen for variety: one per year first (newest
   *  years first), photos with a person in them preferred within each year. */
  strip: { year: number; item: GalleryMemoryGroup["items"][number] }[];
}

export interface AddedBatchCard {
  type: "added_batch";
  /** Local-to-the-server calendar day the batch arrived, YYYY-MM-DD. */
  day: string;
  count: number;
  /** Up to five cover URLs for the fan, covered items first. */
  coverUrls: string[];
  newestAt: string;
}

export interface ActivityCard {
  type: "note" | "album" | "slideshow" | "person";
  id: string;
  actorName: string;
  createdAt: string;
  body: string | null;
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  href: string;
}

export interface SeriesNextCard {
  type: "series_next";
  seriesName: string;
  finishedTitle: string;
  item: {
    id: string;
    kind: "audiobook" | "ebook";
    title: string;
    coverUrl: string | null;
    href: string;
  };
}

export interface QuoteCard extends DailyQuote {
  type: "quote";
}

export type HomeCard = SentCard | MemoryCard | AddedBatchCard | ActivityCard | SeriesNextCard | QuoteCard;

// Class weights and half-lives (days). The memory card is always age zero, so
// its weight IS its score — above a fresh activity line (1.2) and a same-day
// batch (1.0). The filler's constant puts it under everything time-ranked
// without ever dropping it off the end.
const MEMORY_SCORE = 1.6;
const ACTIVITY_WEIGHT = 1.2;
const ACTIVITY_HALF_LIFE = 5;
const ACTIVITY_MAX_AGE = 14;
const BATCH_WEIGHT = 1.0;
const BATCH_HALF_LIFE = 7;
const BATCH_MAX_AGE = 28;
const BATCH_LIMIT = 6;
const FILLER_SCORE = 0.05;

// SQLite writes ISO with Z via strftime; older rows may carry the space form.
function ageDays(iso: string, now: number): number {
  const then = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`).getTime();
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - then) / 86_400_000);
}

const decay = (age: number, halfLife: number) => Math.exp(-age / halfLife);

/** How many photos the memory card shows. */
const MEMORY_STRIP_SIZE = 4;

// Which of these photos have a person in them (any face that wasn't rejected —
// auto-detected or hand-tagged both count). Installs without face scanning
// simply have no rows here, and the strip falls back to chronology.
function itemsWithPeople(itemIds: string[]): Set<string> {
  if (itemIds.length === 0) return new Set();
  const rows = db.prepare(`
    SELECT DISTINCT item_id FROM gallery_faces
    WHERE assignment != 'rejected' AND item_id IN (${itemIds.map(() => "?").join(", ")})
  `).all(...itemIds) as { item_id: string }[];
  return new Set(rows.map((row) => row.item_id));
}

function memoryCard(user: RequestUser, date: string): MemoryCard | null {
  const libIds = resolveGalleryScopeLibraryIds(user);
  if (libIds.length === 0) return null;
  // Over-fetch per year so the strip has face-photo candidates to prefer.
  const memories = queryGalleryMemories(user.id, libIds, date, 12);
  // A whole-month fallback would put filler on the front page; only a real
  // anniversary (exact day, or a year dated a couple of days off) is a card.
  if (memories.precision === "month" || memories.groups.length === 0) return null;

  // Stay tight when the day itself has enough: the ±3-day widening exists to
  // rescue scanned photos dated a little off, not to pad a day that can already
  // fill the strip. Only when exact-day photos can't fill it do near years join.
  let groups = memories.groups;
  const dayGroups = groups.filter((group) => group.precision === "day");
  const dayCount = dayGroups.reduce((total, group) => total + group.count, 0);
  if (dayCount >= MEMORY_STRIP_SIZE) groups = dayGroups;

  // The strip is picked for variety, not just recency: round one takes one
  // photo from every year (newest year first), later rounds fill any slots
  // left. Within a year, photos with a person in them come first (the sort is
  // stable, so ties stay chronological).
  const withPeople = itemsWithPeople(groups.flatMap((group) => group.items.map((item) => item.id)));
  const byYear = groups.map((group) => ({
    year: group.year,
    items: [...group.items].sort(
      (a, b) => Number(withPeople.has(b.id)) - Number(withPeople.has(a.id))
    )
  }));

  const strip: MemoryCard["strip"] = [];
  for (let round = 0; strip.length < MEMORY_STRIP_SIZE; round += 1) {
    let took = false;
    for (const group of byYear) {
      if (strip.length >= MEMORY_STRIP_SIZE) break;
      const item = group.items[round];
      if (!item) continue;
      strip.push({ year: group.year, item });
      took = true;
    }
    if (!took) break;
  }
  // Rounds interleave years; the strip reads better newest-to-oldest, with a
  // year's photos together. Stable, so the face-first order within a year holds.
  strip.sort((a, b) => b.year - a.year);

  return {
    type: "memory",
    precision: groups.every((group) => group.precision === "day") ? "day" : memories.precision,
    years: groups.map((group) => group.year),
    totalCount: groups.reduce((total, group) => total + group.count, 0),
    strip
  };
}

interface BatchRow {
  day: string;
  discovered_at: string;
  cover: string | null;
  rn: number;
  n: number;
  newest: string;
}

// One card per calendar day that brought books in — count plus a cover fan —
// never the N loose tiles the old "Recently added" row was.
function addedBatchCards(user: RequestUser): AddedBatchCard[] {
  const libIds = bookLibraryIds(user);
  if (libIds.length === 0) return [];
  const inLibs = libIds.map(() => "?").join(", ");

  const rows = db.prepare(`
    WITH recent AS (
      SELECT
        date(library_items.discovered_at) AS day,
        library_items.discovered_at,
        item_metadata.cover_storage_key AS cover,
        ROW_NUMBER() OVER (
          PARTITION BY date(library_items.discovered_at)
          ORDER BY item_metadata.cover_storage_key IS NULL, library_items.discovered_at, library_items.id
        ) AS rn,
        COUNT(*) OVER (PARTITION BY date(library_items.discovered_at)) AS n,
        MAX(library_items.discovered_at) OVER (PARTITION BY date(library_items.discovered_at)) AS newest
      FROM library_items
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      WHERE library_items.deleted_at IS NULL
        AND library_items.library_id IN (${inLibs})
        AND datetime(library_items.discovered_at) >= datetime('now', '-${BATCH_MAX_AGE} days')
    )
    SELECT * FROM recent WHERE rn <= 5 ORDER BY day DESC, rn
  `).all(...libIds) as BatchRow[];

  const cards: AddedBatchCard[] = [];
  for (const row of rows) {
    const last = cards[cards.length - 1];
    if (last && last.day === row.day) {
      if (row.cover) last.coverUrls.push(`/api/library/covers/${row.cover}`);
      continue;
    }
    if (cards.length >= BATCH_LIMIT) break;
    cards.push({
      type: "added_batch",
      day: row.day,
      count: row.n,
      coverUrls: row.cover ? [`/api/library/covers/${row.cover}`] : [],
      newestAt: row.newest
    });
  }
  return cards;
}

interface SeriesNextRow {
  series_name: string;
  finished_title: string | null;
  id: string;
  kind: "audiobook" | "ebook";
  title: string | null;
  folder_path: string;
  cover: string | null;
}

// The one v1 suggestion source: you finished book N of a series, book N+1 is in
// the library and you haven't opened it. All candidates are computed and one is
// chosen by the day, so the card rotates instead of nagging about the same book.
function seriesNextCard(user: RequestUser, now: number): SeriesNextCard | null {
  const libIds = bookLibraryIds(user);
  if (libIds.length === 0) return null;
  const inLibs = libIds.map(() => "?").join(", ");

  const rows = db.prepare(`
    WITH fin AS (
      SELECT item_id FROM playback_progress WHERE user_id = ? AND completed_at IS NOT NULL
      UNION
      SELECT item_id FROM reading_progress WHERE user_id = ? AND completed_at IS NOT NULL
    ),
    started AS (
      SELECT item_id FROM playback_progress
        WHERE user_id = ? AND (completed_at IS NOT NULL OR COALESCE(percent_complete, 0) > 0)
      UNION
      SELECT item_id FROM reading_progress
        WHERE user_id = ? AND (completed_at IS NOT NULL OR COALESCE(percent_complete, 0) > 0)
    ),
    sfin AS (
      SELECT series_items.series_id, MAX(series_items.position) AS max_pos
      FROM series_items
      JOIN fin ON fin.item_id = series_items.item_id
      WHERE series_items.position IS NOT NULL
      GROUP BY series_items.series_id
    )
    SELECT
      series.name AS series_name,
      (SELECT COALESCE(pm.title, pi.folder_path) FROM series_items ps
         JOIN library_items pi ON pi.id = ps.item_id
         LEFT JOIN item_metadata pm ON pm.item_id = pi.id
       WHERE ps.series_id = sfin.series_id AND ps.position = sfin.max_pos
         AND ps.item_id IN (SELECT item_id FROM fin)
       LIMIT 1) AS finished_title,
      next_item.id,
      libraries.type AS kind,
      next_meta.title AS title,
      next_item.folder_path,
      next_meta.cover_storage_key AS cover,
      MIN(nxt.position) AS next_pos
    FROM sfin
    JOIN series ON series.id = sfin.series_id
    JOIN series_items nxt ON nxt.series_id = sfin.series_id AND nxt.position > sfin.max_pos
    JOIN library_items next_item ON next_item.id = nxt.item_id AND next_item.deleted_at IS NULL
    JOIN libraries ON libraries.id = next_item.library_id
    LEFT JOIN item_metadata next_meta ON next_meta.item_id = next_item.id
    WHERE next_item.library_id IN (${inLibs})
      AND nxt.item_id NOT IN (SELECT item_id FROM started)
    GROUP BY sfin.series_id
    ORDER BY series.name COLLATE NOCASE
  `).all(user.id, user.id, user.id, user.id, ...libIds) as SeriesNextRow[];

  if (rows.length === 0) return null;
  const row = rows[Math.floor(now / 86_400_000) % rows.length];
  const title = row.title ?? row.folder_path.split("/").pop() ?? row.folder_path;
  return {
    type: "series_next",
    seriesName: row.series_name,
    finishedTitle: row.finished_title ?? row.series_name,
    item: {
      id: row.id,
      kind: row.kind,
      title,
      coverUrl: row.cover ? `/api/library/covers/${row.cover}` : null,
      href: row.kind === "ebook" ? `/ebooks/books/${row.id}` : `/audiobooks/books/${row.id}`
    }
  };
}

/** The feed: sticky cards first, then everything else by class weight × decay. */
export function loadHomeFeed(
  user: RequestUser,
  date: string,
  opts: { language?: string; quoteCategory?: string; quoteCategories?: string[] } = {}
): HomeCard[] {
  const now = Date.now();

  const sticky: HomeCard[] = loadInboxCards(user, { onlyNew: true })
    .map((card) => ({ type: "sent" as const, ...card }));

  const ranked: { score: number; card: HomeCard }[] = [];

  const memory = memoryCard(user, date);
  if (memory) ranked.push({ score: MEMORY_SCORE, card: memory });

  for (const batch of addedBatchCards(user)) {
    const age = ageDays(batch.newestAt, now);
    if (age > BATCH_MAX_AGE) continue;
    ranked.push({ score: BATCH_WEIGHT * decay(age, BATCH_HALF_LIFE), card: batch });
  }

  for (const item of loadActivity(user, 12)) {
    const age = ageDays(item.createdAt, now);
    if (age > ACTIVITY_MAX_AGE) continue;
    ranked.push({
      score: ACTIVITY_WEIGHT * decay(age, ACTIVITY_HALF_LIFE),
      card: {
        type: item.kind,
        id: item.id,
        actorName: item.actorName,
        createdAt: item.createdAt,
        body: item.body,
        title: item.title,
        subtitle: item.subtitle,
        coverUrl: item.coverUrl,
        href: item.href
      }
    });
  }

  // PINNED, not ranked. It is the one card that is the same for the whole house
  // and changes every morning, so it opens the page rather than competing for a
  // place in it — and it stays put instead of moving down as the day's activity
  // piles up above it.
  const quote = dailyQuote(user, date, {
    language: opts.language,
    category: opts.quoteCategory,
    categories: opts.quoteCategories
  });
  const pinned: HomeCard[] = quote ? [{ type: "quote", ...quote }] : [];

  const next = seriesNextCard(user, now);
  if (next) ranked.push({ score: FILLER_SCORE, card: next });

  ranked.sort((a, b) => b.score - a.score);
  return [...pinned, ...sticky, ...ranked.map((entry) => entry.card)];
}
