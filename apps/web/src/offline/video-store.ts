import type { VideoKind, VideoPlayInfo, VideoQuality } from "../features/video/types";
import { openOfflineDb } from "./downloads";

// Where a downloaded film is kept on this device (offline/video.ts makes them,
// the player reads them). One row per film, episode or part, and the film itself
// beside it in pieces: a file as slices of itself, a converted one as the HLS
// segments the engine cut. Per person, like every other download here.

/** queued: waiting its turn. downloading: being fetched, or was when the app
 *  closed (it carries on by itself). paused: stopped by the person, or by a
 *  `problem` that may pass. failed: a `problem` that won't. */
export type VideoDownloadState = "queued" | "downloading" | "paused" | "complete" | "failed";

/** Why a download stopped: the server can't be reached, this device is full,
 *  the film is gone (or not theirs any more), it can't be played in a browser at
 *  all, or every place to convert video stayed taken. */
export type VideoDownloadProblem = "connection" | "space" | "gone" | "format" | "busy";

export interface StoredVideoDownload {
  /** The film, episode or part: what /watch/<id> plays. */
  id: string;
  /** Its name, and for an episode its show's and its place in it. */
  title: string;
  showTitle: string | null;
  season: number | null;
  episode: number | null;
  /** The page it was downloaded from. */
  parent: { kind: VideoKind; id: string };
  /** The quality asked for; the engine may hold it lower away from home. */
  quality: VideoQuality;
  /** Its poster, through the gateway: kept as part -1 once fetched. */
  posterUrl: string | null;
  /** Set when the download starts: how it is fetched, and what the player needs. */
  kind: "file" | "hls" | null;
  info: VideoPlayInfo | null;
  /** A file's content type. */
  mime: string | null;
  /** A converted film's playlist, as the engine gave it. */
  playlist: string | null;
  /** Its text subtitles, as WebVTT. */
  subtitles: { id: string; vtt: string }[];
  totalParts: number | null;
  doneParts: number;
  /** A file's size; a converted film's is known only once it is all here. */
  totalBytes: number | null;
  /** What it will take, roughly, for the storage check and the lists. */
  estimatedBytes: number | null;
  downloadedBytes: number;
  state: VideoDownloadState;
  problem: VideoDownloadProblem | null;
  createdAt: string;
  /** Its turn: earlier first. */
  queuedAt: number;
  /** Where this person got to, watching the copy here; `positionSynced` false
   *  until the engine has it (it was watched with no connection). */
  position: number | null;
  duration: number | null;
  watched: boolean;
  positionAt: number;
  positionSynced: boolean;
}

/** The poster's place among a download's parts. */
export const POSTER_PART = -1;

export interface StoredVideoPart {
  /** `<id>:<n>`. */
  key: string;
  id: string;
  n: number;
  blob: Blob;
}

export interface VideoStore {
  get(id: string): Promise<StoredVideoDownload | null>;
  list(): Promise<StoredVideoDownload[]>;
  put(record: StoredVideoDownload): Promise<void>;
  /** Changes some of a row in one step, so the downloader and the player never
   *  write over each other; null when the row has gone. */
  patch(id: string, changes: Partial<StoredVideoDownload>): Promise<StoredVideoDownload | null>;
  /** The row and every part. */
  remove(id: string): Promise<void>;
  /** The film's pieces, not its poster: to start it again from nothing. */
  clearParts(id: string): Promise<void>;
  putPart(id: string, n: number, blob: Blob): Promise<void>;
  getPart(id: string, n: number): Promise<Blob | null>;
  /** The film's pieces in order. */
  getParts(id: string): Promise<Blob[]>;
}

const partKey = (id: string, n: number) => `${id}:${n}`;

/** This person's store in the browser; null when nobody is signed in or the
 *  browser keeps nothing (a private window). */
export function idbVideoStore(): VideoStore | null {
  let handle: ReturnType<typeof openOfflineDb>;
  try {
    handle = openOfflineDb();
  } catch {
    return null;
  }
  if (!handle) return null;
  const opened = handle;
  return {
    async get(id) {
      return (await (await opened).get("videoDownloads", id)) ?? null;
    },
    async list() {
      return (await opened).getAll("videoDownloads");
    },
    async put(record) {
      await (await opened).put("videoDownloads", record);
    },
    async patch(id, changes) {
      const tx = (await opened).transaction("videoDownloads", "readwrite");
      const current = await tx.store.get(id);
      const next = current ? { ...current, ...changes } : null;
      if (next) await tx.store.put(next);
      await tx.done;
      return next;
    },
    async remove(id) {
      const tx = (await opened).transaction(["videoDownloads", "videoParts"], "readwrite");
      const keys = await tx.objectStore("videoParts").index("id").getAllKeys(id);
      await Promise.all(keys.map((key) => tx.objectStore("videoParts").delete(key)));
      await tx.objectStore("videoDownloads").delete(id);
      await tx.done;
    },
    async clearParts(id) {
      const tx = (await opened).transaction("videoParts", "readwrite");
      const keys = await tx.store.index("id").getAllKeys(id);
      await Promise.all(keys.filter((key) => key !== partKey(id, POSTER_PART)).map((key) => tx.store.delete(key)));
      await tx.done;
    },
    async putPart(id, n, blob) {
      await (await opened).put("videoParts", { key: partKey(id, n), id, n, blob });
    },
    async getPart(id, n) {
      return (await (await opened).get("videoParts", partKey(id, n)))?.blob ?? null;
    },
    async getParts(id) {
      const parts = await (await opened).getAllFromIndex("videoParts", "id", id);
      return parts.filter((part) => part.n >= 0).sort((a, b) => a.n - b.n).map((part) => part.blob);
    }
  };
}

/** The same store in memory: what the tests download into. */
export function memoryVideoStore(): VideoStore {
  const records = new Map<string, StoredVideoDownload>();
  const parts = new Map<string, StoredVideoPart>();
  return {
    async get(id) {
      return records.get(id) ?? null;
    },
    async list() {
      return [...records.values()];
    },
    async put(record) {
      records.set(record.id, { ...record });
    },
    async patch(id, changes) {
      const current = records.get(id);
      if (!current) return null;
      const next = { ...current, ...changes };
      records.set(id, next);
      return next;
    },
    async remove(id) {
      records.delete(id);
      for (const [key, part] of parts) if (part.id === id) parts.delete(key);
    },
    async clearParts(id) {
      for (const [key, part] of parts) if (part.id === id && part.n >= 0) parts.delete(key);
    },
    async putPart(id, n, blob) {
      parts.set(partKey(id, n), { key: partKey(id, n), id, n, blob });
    },
    async getPart(id, n) {
      return parts.get(partKey(id, n))?.blob ?? null;
    },
    async getParts(id) {
      return [...parts.values()].filter((part) => part.id === id && part.n >= 0).sort((a, b) => a.n - b.n).map((part) => part.blob);
    }
  };
}
