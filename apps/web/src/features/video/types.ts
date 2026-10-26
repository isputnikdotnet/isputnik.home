// What the video engine answers (isputnik.video, behind /video — see
// docs/video-architecture.md). Home draws the screens; the engine keeps the
// catalog and answers only from the libraries this person may see.

export type VideoKind = "shows" | "movies";

export interface VideoLibraryRef {
  id: string;
  name: string;
  kind: VideoKind;
}

export interface VideoShowSummary {
  id: string;
  libraryId: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  genres: string[];
  seasons: number;
  episodes: number;
}

export interface VideoMovieSummary {
  id: string;
  libraryId: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  genres: string[];
  runtimeMinutes: number | null;
}

export interface VideoPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface VideoEpisode {
  id: string;
  episode: number;
  title: string | null;
  plot: string | null;
  aired: string | null;
  runtimeMinutes: number | null;
}

export interface VideoShow {
  id: string;
  libraryId: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  premiered: string | null;
  status: string | null;
  genres: string[];
  imdbId: string | null;
  tmdbId: string | null;
  source: "nfo" | "folder";
  seasons: { number: number; episodes: VideoEpisode[] }[];
}

export interface VideoMovie {
  id: string;
  libraryId: string;
  title: string;
  originalTitle: string | null;
  year: number | null;
  plot: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  imdbId: string | null;
  tmdbId: string | null;
  source: "nfo" | "folder";
}

/** Every address under /video belongs to the engine (the gateway proxies it); the
 *  pages that show it live at /shows and /movies. */
export const VIDEO_API = "/video/api";

export function videoHref(kind: VideoKind, id?: string): string {
  const base = kind === "shows" ? "/shows" : "/movies";
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}
