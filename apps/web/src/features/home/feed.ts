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

export type HomeCard = SentCard | MemoryCard | AddedBatchCard | ActivityCard | SeriesNextCard;

/** The viewer's local calendar date — the server may sit in another timezone. */
export function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function fetchHomeFeed(): Promise<{ cards: HomeCard[] }> {
  return api<{ cards: HomeCard[] }>(`/api/home/feed?date=${localDate()}`);
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
