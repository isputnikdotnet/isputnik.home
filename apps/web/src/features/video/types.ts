// What the video engine answers (isputnik.video, behind /video — see
// docs/video-architecture.md). Home draws the screens; the engine keeps the
// catalog and answers only from the libraries this person may see.

export type VideoKind = "shows" | "movies";

export interface VideoLibraryRef {
  id: string;
  name: string;
  kind: VideoKind;
}

/** Pictures and TMDB's rating on a card (engine 0.6.0+): from beside the files
 *  or from TMDB, served by the engine; null when there is none. */
export interface VideoArt {
  poster?: string | null;
  rating?: number | null;
}

/** How a title is matched on TMDB, for the admin's Fix match; null before the
 *  engine has looked. */
export interface VideoTmdbMatch {
  id: string | null;
  /** Where on TMDB the match is: a film here may be a TV show there. Missing or null: the title's own kind. */
  kind?: "movie" | "tv" | null;
  state: "none" | "matched" | "unmatched" | "error";
  /** Fixed by hand: no rescan changes it. */
  locked: boolean;
  error: string | null;
}

export interface VideoShowSummary extends VideoArt {
  id: string;
  libraryId: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  genres: string[];
  seasons: number;
  episodes: number;
}

export interface VideoMovieSummary extends VideoArt {
  id: string;
  libraryId: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  genres: string[];
  runtimeMinutes: number | null;
}

/** A card of the one list of films and shows (engine 0.19.0+), saying which it is. */
export type VideoTitleSummary =
  | (VideoMovieSummary & { kind: "movies" })
  | (VideoShowSummary & { kind: "shows" });

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
  /** A frame of the episode (a thumb beside it, or TMDB's still). */
  still?: string | null;
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

/** A ceiling on the picture (engine 0.31+, docs/video-quality-plan.md): the tallest
 *  it may be, held to that rung's bitrate too; null is the file as it is. */
export type VideoQuality = 1080 | 720 | 480 | null;

export interface VideoQualityChoice {
  /** What is playing. */
  current: VideoQuality;
  /** What this person may pick: everything at home, up to the admin's cap away. */
  allowed: VideoQuality[];
  /** Where the gateway saw the browser: a trusted zone, the home network, or the internet. */
  network: "trusted" | "home" | "internet";
}

export interface VideoPlayback {
  mode: VideoPlaybackMode;
  /** Why it isn't sent as it is; "size": it is above the quality rung asked. */
  reasons: ("container" | "audio" | "video" | "subtitles" | "size")[];
  /** The file, or its HLS playlist, through the gateway. */
  url: string | null;
  duration: number | null;
  /** Converted, and every place the admin allows is taken (engine 0.5.0+), or
   *  ("person", engine 0.7.0+) this person is converting `title` already, on
   *  another screen or in a tab left open. */
  busy?: { limit: number; reason?: "household" | "person"; title?: string } | null;
  /** The quality playing and the rungs on offer (engine 0.31+). */
  quality?: VideoQualityChoice;
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

/** A subtitle, inside the file or beside it (engine 0.6.0+). */
export interface VideoSubtitleTrack {
  /** s<stream index> inside the file, x<hash> for a file beside it: what ?subtitle= takes. */
  id: string;
  /** text: shown by the browser from `url`; image: burned into the picture when chosen. */
  kind: "text" | "image";
  codec: string;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  external: boolean;
  /** WebVTT through the gateway; null for an image track. */
  url: string | null;
  /** An image track drawn onto the picture now playing. */
  burned: boolean;
}

/** Where a title's intro and credits are, when its files say (engine 0.12.0+;
 *  docs/video-skip-plan.md): seconds on the player's clock. */
/** Where an admin's mark is kept: this episode or film alone, or its whole season. */
export type VideoMarkScope = "episode" | "season";

/** "manual" (engine 0.15.0+) is an admin's mark, with its `scope`; "detected"
 *  (0.16.0+) what the engine found by itself. */
export type VideoMarkerSource = "manual" | "edl" | "chapter" | "detected";

export interface VideoMarkers {
  /** "Previously on" (engine 0.17.0+): always an episode's own. */
  recap?: { start: number; end: number; source: VideoMarkerSource; scope?: VideoMarkScope } | null;
  intro: { start: number; end: number; source: VideoMarkerSource; scope?: VideoMarkScope } | null;
  credits: { start: number; source: VideoMarkerSource; scope?: VideoMarkScope } | null;
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
  /** Every subtitle offered; empty from an engine older than 0.6.0. */
  subtitleTracks?: VideoSubtitleTrack[];
  markers?: VideoMarkers;
  progress: VideoProgress | null;
  resumeAt: number;
  /** After an episode the next one; after a film the next of its set (engine
   *  0.10.0+), without a season or episode. */
  next: { id: string; season: number | null; episode: number | null; title: string | null } | null;
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

export interface VideoShow extends VideoArt {
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
  backdrop?: string | null;
  tmdbMatch?: VideoTmdbMatch | null;
  /** In billing order (engine 0.26.0+). */
  cast?: VideoCredit[];
  /** director, writer, composer, creator (engine 0.26.0+). */
  crew?: VideoCredit[];
}

export interface VideoMovie extends VideoArt {
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
  /** What Play starts: the part this person has got to (engine 0.14.0+). */
  playId?: string;
  /** Its files, when the film is in several; empty when it is in one (engine 0.14.0+). */
  /** Its files, when it is in several. A film TMDB has as a TV show (a miniseries)
   *  names each part as that show's episode (engine 0.24.0+); null otherwise. */
  parts?: {
    id: string;
    part: number;
    title?: string | null;
    plot?: string | null;
    aired?: string | null;
    still?: string | null;
    direct: VideoDirectPlay;
    progress: VideoProgress | null;
  }[];
  backdrop?: string | null;
  tmdbMatch?: VideoTmdbMatch | null;
  /** The set it is in, with the films of it this person may see (engine 0.10.0+). */
  set?: { id: string; name: string; films: { id: string; title: string; year: number | null; poster: string | null }[] } | null;
  /** In billing order (engine 0.26.0+). */
  cast?: VideoCredit[];
  /** director, writer, composer, creator (engine 0.26.0+). */
  crew?: VideoCredit[];
}

/** GET /video/api/sets — film sets (docs/video-sets-plan.md): those this person
 *  can see two or more films of. */
export interface VideoSetSummary {
  id: string;
  name: string;
  films: number;
  watched: number;
  firstYear: number | null;
  lastYear: number | null;
  poster: string | null;
}

/** GET /video/api/sets/:id — one set, its films in order. */
export interface VideoSet {
  id: string;
  name: string;
  overview: string | null;
  poster: string | null;
  backdrop: string | null;
  films: { id: string; title: string; year: number | null; runtimeMinutes: number | null; poster: string | null; progress: VideoProgress | null }[];
  /** What Play starts: the first film not yet watched; null once all are. */
  next: { id: string; title: string; position: number } | null;
}

/** GET /video/api/admin/metadata/search — TMDB's candidates for Fix match. */
export interface VideoTmdbCandidate {
  tmdbId: string;
  /** Film or TV show on TMDB (engine 0.22+); the title's own kind when missing. */
  kind?: "movie" | "tv";
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  /** A small poster, through the engine. */
  poster: string | null;
}

/** Every address under /video belongs to the engine (the gateway proxies it); the
 *  pages that show it live at /shows and /movies. */
export const VIDEO_API = "/video/api";

/** The sound language last chosen, in this browser: the next episode (or film)
 *  starts in it when it has it — a dub watched once is the dub wanted. A download
 *  is made in it too. */
export const VIDEO_AUDIO_LANGUAGE_KEY = "isputnik.video.audioLanguage";

/** Video's front page. Not under /video: that address belongs to the engine. */
export const VIDEO_OVERVIEW_HREF = "/videos";
/** What Collections calls a film and a show (home 4.64+). */
export const VIDEO_ENTITY_TYPE = { movies: "video_movie", shows: "video_show" } as const;

/** My list: the films and shows this person means to watch (home's own list). */
export const MY_LIST_HREF = "/videos/my-list";

/** A show's or film's page. */
export function videoHref(kind: VideoKind, id: string): string {
  return `${kind === "shows" ? "/shows" : "/movies"}/${encodeURIComponent(id)}`;
}

/** The video page narrowed to one kind, as a grid or (films) as sets: what the
 *  Movies and Shows pages were before there was one page. */
export function videoBrowseHref(kind: VideoKind, view: "grid" | "sets" = "grid"): string {
  return `${VIDEO_OVERVIEW_HREF}?kind=${kind}&view=${view}`;
}

/** A film set's page: under /movies, two segments so it never reads as a film. */
export function videoSetHref(id: string): string {
  return `/movies/sets/${encodeURIComponent(id)}`;
}

/** 1999–2003, or one year, or nothing. */
export function yearSpan(first: number | null, last: number | null): string | null {
  if (!first || !last) return null;
  return first === last ? String(first) : `${first}–${last}`;
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

/** What people do in a title, besides acting (the engine's credits.ts). */
export type VideoCrewJob = "director" | "writer" | "composer" | "creator";

/** Someone in a title: the character they play, or their job. */
export interface VideoCredit {
  id: string;
  name: string;
  role: string | null;
  photo: string | null;
}

/** GET /video/api/people?q= — someone a search found. */
export interface VideoPersonSummary {
  id: string;
  name: string;
  photo: string | null;
  titles: number;
}

/** GET /video/api/people/:id — someone, and what of theirs this person may see. */
export interface VideoPerson {
  id: string;
  name: string;
  tmdbId: string | null;
  photo: string | null;
  titles: {
    kind: VideoKind;
    id: string;
    title: string;
    year: number | null;
    poster: string | null;
    characters: string[];
    jobs: VideoCrewJob[];
    actor: boolean;
  }[];
}

/** A person's page. */
export function personHref(id: string): string {
  return `/videos/people/${encodeURIComponent(id)}`;
}
