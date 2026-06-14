import { api } from "../../api";

// A cross-type home-feed entry (audiobook or ebook), from /api/library/feed/*.
export interface FeedItem {
  id: string;
  kind: "audiobook" | "ebook";
  title: string;
  authors: string[];
  coverUrl: string | null;
  percentComplete: number | null;
  completedAt: string | null;
  discoveredAt: string;
}

export interface FeedResponse {
  items: FeedItem[];
  total: number;
}

export type FeedMode = "recent" | "continue";

export function fetchFeed(mode: FeedMode, limit: number, offset = 0): Promise<FeedResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return api<FeedResponse>(`/api/library/feed/${mode}?${params.toString()}`);
}

// Ebooks and audiobooks have separate detail routes.
export function feedHref(item: FeedItem): string {
  return item.kind === "ebook" ? `/ebooks/books/${item.id}` : `/audiobooks/books/${item.id}`;
}

export function authorLine(item: FeedItem): string {
  return item.authors.length > 0 ? item.authors.join(", ") : "Unknown author";
}

// SQLite timestamps come back as "YYYY-MM-DD HH:MM:SS" (UTC, no zone) — normalize
// the same way shared/utils does before diffing against now.
export function timeAgo(value: string): string {
  const then = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} wk ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}
