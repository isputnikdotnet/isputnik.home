// The video page's rows (docs/video-home-rows-plan.md), as home keeps them
// (GET /api/video/home): saved queries, never titles. Each row asks the engine for
// its own titles, through the gateway and as the person looking.
import type { TFunction } from "i18next";
import { VIDEO_API, type VideoKind } from "./types";

export const VIDEO_HOME_API = "/api/video/home";
/** The server refuses more. */
export const VIDEO_ROWS_MAX = 15;
/** About what a row can show before it has to scroll a long way. */
export const ROW_SIZE = 30;

export type VideoRowKind = "all" | VideoKind;
export type VideoRowSort = "added" | "title" | "year";

interface RowCommon {
  id: string;
  /** Left out: named from what it asks for, in the viewer's language. */
  title?: string;
  hidden?: boolean;
}
export interface VideoTitlesRow extends RowCommon {
  type: "titles";
  kind: VideoRowKind;
  libraries: string[];
  genres: string[];
  sort: VideoRowSort;
}
/** A Collection's films and shows, in its order. */
export interface VideoCollectionRow extends RowCommon {
  type: "collection";
  collectionId: string;
}
export type VideoRow =
  | (RowCommon & { type: "continue" })
  | VideoTitlesRow
  | (RowCommon & { type: "sets" })
  | VideoCollectionRow
  | (RowCommon & { type: "mylist" });

export interface VideoLayout {
  rows: VideoRow[];
  /** Someone has changed the household's: false is the default rows. */
  custom: boolean;
  /** These are the person's own rows, not the household's. */
  mine: boolean;
  /** This person may change the household's (an admin); their own anyone may. */
  editable: boolean;
  /** The viewing profile this page is (docs/tv-profiles-plan.md), when the session wears one. */
  profileId?: string;
  /** That profile has rows of its own, rather than the household's. */
  own?: boolean;
}

export function newRowId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Which kind a row shows under the page's All · Movies · Shows switch: a row of
 *  both narrows with it, a row of one kind is that kind or (the other chosen) not
 *  there at all. */
export function rowKindUnder(row: VideoRow, switchKind: VideoRowKind): VideoRowKind | null {
  if (row.type === "sets") return switchKind === "shows" ? null : "movies";
  if (row.type !== "titles") return switchKind;
  if (row.kind === "all") return switchKind;
  return switchKind === "all" || switchKind === row.kind ? row.kind : null;
}

/** The engine's list a titles row draws, at the kind it shows. */
export function titlesRowPath(row: VideoTitlesRow, kind: VideoRowKind): string {
  const params = new URLSearchParams({ pageSize: String(ROW_SIZE), sort: row.sort });
  if (kind !== "all") params.set("kind", kind);
  if (row.libraries.length > 0) params.set("libraries", row.libraries.join(","));
  if (row.genres.length > 0) params.set("genres", row.genres.join(","));
  return `${VIDEO_API}/titles?${params}`;
}

/** Movies, Shows, or both, as a row's kind reads. */
export const kindWord = (kind: VideoRowKind, t: TFunction) =>
  kind === "movies" ? t("video.movies") : kind === "shows" ? t("video.shows") : t("video.rows.kindBoth");

/** A row's name: its own, else one made from what it asks for. */
export function rowName(row: VideoRow, t: TFunction, libraryNames: Record<string, string>, collectionNames: Record<string, string> = {}): string {
  if (row.title) return row.title;
  if (row.type === "continue") return t("video.continueWatching");
  if (row.type === "sets") return t("video.viewSets");
  if (row.type === "mylist") return t("video.myList.title");
  if (row.type === "collection") return collectionNames[row.collectionId] ?? t("video.rows.typeCollection");
  const what = row.genres.length > 0 ? row.genres.join(", ")
    : row.libraries.length > 0 ? row.libraries.map((id) => libraryNames[id] ?? id).join(", ")
    : null;
  if (what) return row.kind === "all" ? what : `${what} · ${kindWord(row.kind, t)}`;
  if (row.sort === "added") {
    return row.kind === "movies" ? t("video.recentMovies") : row.kind === "shows" ? t("video.recentShows") : t("video.rows.recentBoth");
  }
  return kindWord(row.kind, t);
}
