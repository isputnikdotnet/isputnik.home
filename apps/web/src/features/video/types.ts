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

/** Whether a browser plays the file as it is (the engine judges by its kind):
 *  "maybe" is Matroska and QuickTime, which Chrome and Edge mostly play. */
export type VideoDirectPlay = "yes" | "maybe" | "no";

/** How far this person got, from the engine; never anyone else's. */
export interface VideoProgress {
  position: number;
  duration: number | null;
  watched: boolean;
  updatedAt: string;
}

export interface VideoEpisode {
  id: string;
  episode: number;
  title: string | null;
  plot: string | null;
  aired: string | null;
  runtimeMinutes: number | null;
  direct: VideoDirectPlay;
  progress: VideoProgress | null;
}

/** What Play on a show starts, and where. */
export interface VideoNextUp {
  id: string;
  season: number;
  episode: number;
  title: string | null;
  position: number;
}

/** How the file reaches the browser: as it is (byte ranges), or as HLS with
 *  the sound converted (remux) or the picture too (transcode); none when the
 *  engine has no ffmpeg and the browser can't play it as it is. */
export type VideoPlaybackMode = "direct" | "remux" | "transcode" | "none";

export interface VideoPlayback {
  mode: VideoPlaybackMode;
  /** Why it isn't sent as it is. */
  reasons: ("container" | "audio" | "video")[];
  /** The file, or its HLS playlist, through the gateway. */
  url: string | null;
  duration: number | null;
}

/** A sound track, as the engine found it (ffprobe). */
export interface VideoAudioTrack {
  /** The stream's index in the file: what ?audio= takes. */
  index: number;
  codec: string;
  channels: number;
  /** ISO 639-2, e.g. "rus"; null or "und" when the file doesn't say. */
  language: string | null;
  title: string | null;
  default: boolean;
  selected: boolean;
}

/** GET /video/api/play/:id — what the player needs to start. */
export interface VideoPlayInfo {
  id: string;
  type: "episode" | "movie";
  title: string;
  show: { id: string; title: string } | null;
  season: number | null;
  episode: number | null;
  runtimeMinutes: number | null;
  /** false when the file has gone from the disk since the last scan. */
  available: boolean;
  sizeBytes: number | null;
  playback: VideoPlayback;
  /** Every sound track in the file; the one playing is `selected`. Empty when
   *  the engine couldn't look inside it (or is older than 0.4.0). */
  audioTracks?: VideoAudioTrack[];
  progress: VideoProgress | null;
  resumeAt: number;
  next: { id: string; season: number; episode: number; title: string | null } | null;
}

/** GET /video/api/continue — newest first, one per show. */
export interface VideoContinueItem {
  id: string;
  type: "episode" | "movie";
  title: string;
  show: { id: string; title: string } | null;
  season: number | null;
  episode: number | null;
  position: number;
  duration: number | null;
  /** false for the episode after one finished. */
  resume: boolean;
  updatedAt: string;
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
  /** null once every episode is watched. */
  nextUp: VideoNextUp | null;
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
  direct: VideoDirectPlay;
  progress: VideoProgress | null;
}

/** Every address under /video belongs to the engine (the gateway proxies it); the
 *  pages that show it live at /shows and /movies. */
export const VIDEO_API = "/video/api";

export function videoHref(kind: VideoKind, id?: string): string {
  const base = kind === "shows" ? "/shows" : "/movies";
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

/** The player for one episode or movie. */
export function watchHref(id: string): string {
  return `/watch/${encodeURIComponent(id)}`;
}

/** S01E02: the two numbers, padded, for the "video.episodeCode" string. */
export function episodeCodeValues(season: number, episode: number): { season: string; episode: string } {
  return { season: String(season).padStart(2, "0"), episode: String(episode).padStart(2, "0") };
}

/** 1:05:09 or 4:07 — a place in a film, as a player shows it. */
export function formatPlayTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** How far along, 0–1, for a progress bar; 1 once watched. */
export function progressFraction(progress: VideoProgress | null | undefined): number {
  if (!progress) return 0;
  if (progress.watched) return 1;
  return progress.duration ? Math.min(1, progress.position / progress.duration) : 0;
}
