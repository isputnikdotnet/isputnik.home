// The home feed — one ranked list of typed cards from /api/home/feed.
// Mirrors apps/server/src/modules/home/feed.ts; the server owns the ranking
// (class weight × time decay), the client only renders.
import { api } from "../../api";
import i18n from "../../i18n";
import type { InboxCard } from "../social/InboxRow";
import type { ActivityItem } from "../social/ActivityList";
import type { GalleryAsset, GalleryMemoryGroup } from "../gallery/types";

export type SentCard = InboxCard & { type: "sent" };

export interface MemoryCard {
  type: "memory";
  precision: "day" | "near";
  /** Every year with photos on this day, newest first. */
  years: number[];
  totalCount: number;
  /** The photos shown: one per year first, people preferred (see the server). */
  strip: { year: number; item: GalleryAsset }[];
}

export interface AddedBatchCard {
  type: "added_batch";
  day: string;
  count: number;
  coverUrls: string[];
  newestAt: string;
}

export type ActivityCard = Omit<ActivityItem, "kind"> & {
  type: "note" | "album" | "slideshow" | "person";
};

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

export interface QuoteCard {
  type: "quote";
  quoteId: string;
  text: string;
  attribution: string | null;
  source: string | null;
  /** The category this pick came from; null when drawn from everything. */
  category: string | null;
  /** The categories the card offers today — capped, rotating unless chosen. */
  categories: string[];
  /** Everything the pool wears, for the preferences dialog to choose from. */
  allCategories: string[];
  /** Years since it was said, when today is the anniversary; null otherwise. */
  yearsAgo: number | null;
}

export type HomeCard = SentCard | MemoryCard | AddedBatchCard | ActivityCard | SeriesNextCard | QuoteCard;

// Which category this viewer last chose on the quote card. A per-viewer
// convenience, so it lives in the browser rather than the database — losing it
// (a new device, cleared site data) just means the card goes back to All.
const QUOTE_CATEGORY_KEY = "isputnik.quoteCategory";
const QUOTE_PREFS_KEY = "isputnik.quotePrefs";

/** What this viewer asked the daily card to show them. */
export interface QuotePrefs {
  /** A language code, or "" to follow whatever language the app is being read in. */
  language: string;
  /** The categories they care about; empty means the whole library. */
  categories: string[];
}

export const EMPTY_QUOTE_PREFS: QuotePrefs = { language: "", categories: [] };

export function storedQuotePrefs(): QuotePrefs {
  try {
    const raw = window.localStorage.getItem(QUOTE_PREFS_KEY);
    if (!raw) return EMPTY_QUOTE_PREFS;
    const parsed = JSON.parse(raw) as Partial<QuotePrefs>;
    return {
      language: typeof parsed.language === "string" ? parsed.language : "",
      categories: Array.isArray(parsed.categories) ? parsed.categories.filter((c) => typeof c === "string") : []
    };
  } catch {
    // Unreadable or hand-edited: the card works without preferences.
    return EMPTY_QUOTE_PREFS;
  }
}

export function storeQuotePrefs(prefs: QuotePrefs): void {
  try {
    window.localStorage.setItem(QUOTE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode / quota — the card still works, it just forgets.
  }
}

/** The language the card should prefer: the viewer's choice, else the UI's. */
export function quoteLanguage(prefs: QuotePrefs): string {
  return prefs.language || i18n.language;
}

export function storedQuoteCategory(): string {
  try {
    return window.localStorage.getItem(QUOTE_CATEGORY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeQuoteCategory(category: string): void {
  try {
    if (category) window.localStorage.setItem(QUOTE_CATEGORY_KEY, category);
    else window.localStorage.removeItem(QUOTE_CATEGORY_KEY);
  } catch {
    // Private mode / quota — the card still works, it just forgets the choice.
  }
}

/** Swap just the quote when the viewer changes category, not the whole feed. */
export function fetchDailyQuote(
  category: string,
  prefs: QuotePrefs = storedQuotePrefs()
): Promise<{ quote: QuoteCard | null }> {
  const params = new URLSearchParams({ date: localDate(), lang: quoteLanguage(prefs) });
  if (category) params.set("category", category);
  if (prefs.categories.length > 0) params.set("categories", prefs.categories.join(","));
  return api<{ quote: QuoteCard | null }>(`/api/library/quotes/daily?${params}`);
}

/** The viewer's local calendar date — the server may sit in another timezone. */
export function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function fetchHomeFeed(): Promise<{ cards: HomeCard[] }> {
  // The quote-of-the-day parameters, and only those: the viewer's preferred
  // language and categories, plus whichever chip they were last standing on.
  // They travel with the FEED request as well as the card's own, or the first
  // paint would ignore the preferences and correct itself a moment later.
  const prefs = storedQuotePrefs();
  const params = new URLSearchParams({ date: localDate(), lang: quoteLanguage(prefs) });
  const category = storedQuoteCategory();
  if (category) params.set("quoteCategory", category);
  if (prefs.categories.length > 0) params.set("quoteCategories", prefs.categories.join(","));
  return api<{ cards: HomeCard[] }>(`/api/home/feed?${params}`);
}

/** How many photos the memory card's strip holds — also the tightness bar. */
export const MEMORY_STRIP_SIZE = 4;

// The home card's tightness rule, mirrored for the viewer it opens (the server
// applies the same rule building the card — modules/home/feed.ts): when the
// exact day can fill the strip on its own, the ±3-day near-match years stay
// out. The viewer must browse the same set the card advertises, or tapping a
// tight card pages through photos from days the card deliberately left out.
export function tightMemoryGroups(groups: GalleryMemoryGroup[]): GalleryMemoryGroup[] {
  const day = groups.filter((group) => group.precision === "day");
  const dayCount = day.reduce((total, group) => total + group.count, 0);
  return dayCount >= MEMORY_STRIP_SIZE ? day : groups;
}

/** An activity card back in the shape ActivityList renders. */
export function toActivityItem(card: ActivityCard): ActivityItem {
  const { type, ...rest } = card;
  return { ...rest, kind: type };
}

/** "today", "yesterday", "3 days ago", or the date — for the batch card line.
 *  Recent days use Intl.RelativeTimeFormat rather than a weekday name: weekday
 *  phrases need case declension in Russian ("в среду"), which the raw weekday
 *  from toLocaleDateString can't provide, while relative days localize cleanly. */
export function batchDayLabel(day: string): string {
  const then = new Date(`${day}T00:00:00`);
  if (Number.isNaN(then.getTime())) return day;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return i18n.t("home.today");
  if (days === 1) return i18n.t("home.yesterday");
  if (days < 7) return new Intl.RelativeTimeFormat(i18n.language, { numeric: "always" }).format(-days, "day");
  return i18n.t("home.onDate", { date: then.toLocaleDateString(i18n.language, { month: "long", day: "numeric" }) });
}
