// The home feed — one ranked list of typed cards from /api/home/feed.
// Mirrors apps/server/src/modules/home/feed.ts; the server owns the ranking
// (class weight × time decay), the client only renders.
import { api } from "../../api";
import type { InboxCard } from "../social/InboxRow";
import type { ActivityItem } from "../social/ActivityList";
import type { GalleryMemoryGroup } from "../gallery/types";

export type SentCard = InboxCard & { type: "sent" };

export interface MemoryCard {
  type: "memory";
  precision: "day" | "near";
  groups: GalleryMemoryGroup[];
  totalCount: number;
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

/** An activity card back in the shape ActivityList renders. */
export function toActivityItem(card: ActivityCard): ActivityItem {
  const { type, ...rest } = card;
  return { ...rest, kind: type };
}

/** "today", "yesterday", "on Sunday", or the date — for the batch card line. */
export function batchDayLabel(day: string): string {
  const then = new Date(`${day}T00:00:00`);
  if (Number.isNaN(then.getTime())) return day;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `on ${then.toLocaleDateString(undefined, { weekday: "long" })}`;
  return `on ${then.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`;
}
