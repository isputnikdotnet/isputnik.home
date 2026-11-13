import { ApiError, api, csrfToken } from "../api";
import { VIDEO_API, VIDEO_AUDIO_LANGUAGE_KEY, type VideoKind, type VideoPlayInfo, type VideoQuality } from "../features/video/types";
import { POSTER_PART, idbVideoStore, type StoredVideoDownload, type VideoDownloadProblem, type VideoPrepareStatus, type VideoStore } from "./video-store";

// Films and episodes kept on this device, to watch with no connection
// (docs/video-quality-plan.md → Q3, as built).
//
// A film a browser plays as it is comes down as the file, in slices (byte
// ranges). A smaller picture is a copy the server prepares first (engine 0.33+,
// its copies.ts): asked for here, made there on a queue whether or not this app
// stays open, and fetched as one MP4 once it is ready — a download waiting on one
// is "preparing", and costs this device nothing. An engine before that has no
// copies: the film then comes down the way it plays, as the HLS segments the
// engine cuts at the quality asked, which needs the app open throughout. The
// player reads the copy here instead of the server's
// (features/video/offlineSource.ts).
//
// One film at a time, in turn. The engine converts one film per person, so a
// download gives way to watching: the player holds the queue (holdVideoDownloads)
// and the film being fetched lets go of its place on the engine.

/** How big a slice of a file is. */
const FILE_PART_BYTES = 8 * 1024 * 1024;
/** How long to wait before each new try once the server stops answering. */
const RETRY_AFTER_S = [2, 4, 8, 15, 30, 30];
/** Every place to convert taken: asked again this often, this many times. */
const BUSY_RETRY_S = 20;
const BUSY_TRIES = 30;
/** Kept free on the device beyond what the film takes. */
const SPACE_MARGIN = 100 * 1024 * 1024;

/** What a copy for download takes per second, picture and sound (the engine's
 *  COPY_LIMITS: 1080p is held lower for a copy than for a stream). */
const RUNG_BITS: Record<1080 | 720 | 480, number> = { 1080: 5_160_000, 720: 3_128_000, 480: 1_596_000 };

/** Roughly what a film takes at a quality: the file itself for the original, and
 *  never more than the file for a rung (one already under it is sent as it is).
 *  Null when neither its size nor its length is known. */
export function estimateVideoBytes(sizeBytes: number | null, durationSeconds: number | null, quality: VideoQuality): number | null {
  if (quality === null) return sizeBytes;
  if (!durationSeconds) return null;
  const rung = Math.round((RUNG_BITS[quality] * durationSeconds) / 8);
  return sizeBytes ? Math.min(sizeBytes, rung) : rung;
}

/** What to download, as the page that asks knows it. */
export interface VideoDownloadRequest {
  id: string;
  title: string;
  showTitle?: string | null;
  season?: number | null;
  episode?: number | null;
  /** For the estimate, before the engine has been asked. */
  runtimeMinutes?: number | null;
}

class Stopped extends Error {}
class Busy extends Error {}
/** The server is still making the copy: nothing to fetch yet, and nothing wrong. */
class Preparing extends Error {}

/** How often the server is asked about the copies it is making. */
const PREPARE_LOOK_S = 8;

/** GET/PUT /video/api/copies/:id (the engine's copies.ts). */
export interface VideoCopyAnswer {
  state: "none" | "unneeded" | "queued" | "running" | "ready" | "failed";
  progress?: number;
  ahead?: number;
  paused?: boolean;
  etaSeconds?: number | null;
  /** Before it is made: about how long making it takes. */
  estimateSeconds?: number;
  sizeBytes?: number | null;
  /** The finished copy, or for "unneeded" the film itself. */
  url?: string | null;
  /** Engine 0.35+: no copies are prepared (no disk for them); it is converted as it downloads. */
  unavailable?: "no-disk";
  /** Engine 0.35+: queued, and kept waiting for the night or a quiet moment. */
  waitingFor?: "idle" | "night" | null;
}

const copyUrl = (id: string) => `${VIDEO_API}/copies/${encodeURIComponent(id)}`;

/** How a smaller copy stands on the server; null from an engine that makes none. */
export async function askVideoCopy(id: string, quality: 1080 | 720 | 480, audio: number | null, request = false): Promise<VideoCopyAnswer | null> {
  try {
    return request
      ? await api<VideoCopyAnswer>(copyUrl(id), { method: "PUT", body: JSON.stringify({ quality, ...(audio === null ? {} : { audio }) }) })
      : await api<VideoCopyAnswer>(`${copyUrl(id)}?quality=${quality}${audio === null ? "" : `&audio=${audio}`}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

const prepareOf = (answer: VideoCopyAnswer): VideoPrepareStatus =>
  ({ progress: answer.progress ?? 0, ahead: answer.ahead ?? 0, paused: answer.paused ?? false, etaSeconds: answer.etaSeconds ?? null, waitingFor: answer.waitingFor ?? null });
class Problem extends Error {
  constructor(readonly problem: VideoDownloadProblem) {
    super(problem);
  }
}

const sleep = (seconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(new Stopped());
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", stop);
    resolve();
  }, seconds * 1000);
  const stop = () => {
    clearTimeout(timer);
    reject(new Stopped());
  };
  signal.addEventListener("abort", stop, { once: true });
});

const isQuota = (err: unknown) => err instanceof DOMException && (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");

/** The segment names of a playlist, in order. */
export function playlistSegments(playlist: string): string[] {
  return playlist.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The film as the engine would play it at this quality, in the sound language
 *  chosen last time in the player. */
export async function askVideoPlay(id: string, quality: VideoQuality): Promise<VideoPlayInfo> {
  const base = `${VIDEO_API}/play/${encodeURIComponent(id)}?quality=${quality === null ? "original" : quality}`;
  const payload = await api<VideoPlayInfo>(base);
  const language = readPreference(VIDEO_AUDIO_LANGUAGE_KEY);
  const wanted = language ? (payload.audioTracks ?? []).find((track) => track.language === language) : undefined;
  if (!wanted || wanted.selected) return payload;
  return api<VideoPlayInfo>(`${base}&audio=${wanted.index}`).catch(() => payload);
}

export type VideoDownloadSnapshot = ReadonlyMap<string, StoredVideoDownload>;

export class VideoDownloads {
  private records = new Map<string, StoredVideoDownload>();
  private snapshot: VideoDownloadSnapshot = new Map();
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private running: { id: string; abort: AbortController; done: Promise<void> } | null = null;
  private holds = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  private looking: ReturnType<typeof setTimeout> | null = null;

  constructor(private open: () => VideoStore | null = idbVideoStore) {}

  /** Null when nobody is signed in, or the browser keeps nothing. */
  get store(): VideoStore | null {
    try {
      return this.open();
    } catch {
      return null;
    }
  }

  /** Keeps them somewhere else from now on: the tests' store in memory. */
  use(open: () => VideoStore | null): void {
    this.open = open;
    this.loading = null;
    this.records = new Map();
    this.publish();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    void this.load();
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VideoDownloadSnapshot => this.snapshot;

  /** What is kept here, read once; `again` after another person signed in. */
  load(again = false): Promise<void> {
    if (again) this.loading = null;
    this.loading ??= (async () => {
      const rows = await this.store?.list().catch(() => []) ?? [];
      this.records = new Map(rows.map((row) => [row.id, row]));
      this.publish();
      this.lookLater();
    })();
    return this.loading;
  }

  private publish(): void {
    this.snapshot = new Map(this.records);
    for (const listener of this.listeners) listener();
  }

  private async change(id: string, changes: Partial<StoredVideoDownload>): Promise<StoredVideoDownload | null> {
    const next = await this.store?.patch(id, changes) ?? null;
    if (next) this.records.set(id, next);
    else this.records.delete(id);
    this.publish();
    return next;
  }

  /** Adds films to the queue; one already here (or on its way) is left as it is. */
  async enqueue(items: VideoDownloadRequest[], options: { quality: VideoQuality; parent: { kind: VideoKind; id: string }; posterUrl: string | null }): Promise<void> {
    const store = this.store;
    if (!store) throw new Error("This browser keeps no downloads");
    await this.load();
    void requestPersistence();
    let turn = Date.now();
    for (const item of items) {
      const existing = this.records.get(item.id);
      if (existing && existing.state !== "failed") continue;
      if (existing) await store.remove(item.id);
      const record: StoredVideoDownload = {
        id: item.id,
        title: item.title,
        showTitle: item.showTitle ?? null,
        season: item.season ?? null,
        episode: item.episode ?? null,
        parent: options.parent,
        quality: options.quality,
        posterUrl: options.posterUrl,
        kind: null,
        info: null,
        fileUrl: null,
        prepare: null,
        mime: null,
        playlist: null,
        subtitles: [],
        totalParts: null,
        doneParts: 0,
        totalBytes: null,
        estimatedBytes: estimateVideoBytes(null, item.runtimeMinutes ? item.runtimeMinutes * 60 : null, options.quality),
        downloadedBytes: 0,
        state: "queued",
        problem: null,
        createdAt: new Date().toISOString(),
        queuedAt: turn++,
        position: null,
        duration: null,
        watched: false,
        positionAt: 0,
        positionSynced: true
      };
      await store.put(record);
      this.records.set(record.id, record);
    }
    this.publish();
    void this.pump();
  }

  /** Stops one where it is; Resume carries on from there. */
  async pause(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.state === "complete") return;
    await this.change(id, { state: "paused", problem: null });
    await this.stopRunning(id);
    void this.pump();
  }

  async resume(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.state === "complete" || record.state === "downloading") return;
    // Asked of the server afresh: what it was told before may be long gone.
    await this.change(id, { state: "queued", problem: null, ...(record.state === "failed" ? { kind: null, info: null, fileUrl: null } : {}) });
    void this.pump();
  }

  /** Asks the server about every copy it is making for this device: the ones
   *  now ready take their turn to be fetched. Again in a few seconds while any
   *  is still being made, and not at all otherwise. */
  async lookAtPreparing(): Promise<void> {
    this.looking = null;
    for (const record of [...this.records.values()]) {
      if (record.state !== "preparing" || record.quality === null) continue;
      const audio = record.info?.audioTracks?.find((track) => track.selected)?.index ?? null;
      try {
        const answer = await askVideoCopy(record.id, record.quality, audio);
        if (this.records.get(record.id)?.state !== "preparing") continue;
        // Ready — or nothing known of it there any more (a restart, a cleared
        // cache): its turn comes, and the turn asks again.
        if (!answer || answer.state === "ready" || answer.state === "none" || answer.state === "unneeded") {
          await this.change(record.id, { state: "queued", prepare: null, kind: null });
        } else if (answer.state === "failed") {
          await this.change(record.id, { state: "failed", problem: "prepare", prepare: null });
        } else {
          await this.change(record.id, { prepare: prepareOf(answer) });
        }
      } catch {
        // No connection just now: the server carries on without us.
      }
    }
    void this.pump();
    this.lookLater();
  }

  private lookLater(): void {
    if (this.looking !== null) return;
    if (![...this.records.values()].some((record) => record.state === "preparing")) return;
    this.looking = setTimeout(() => void this.lookAtPreparing(), PREPARE_LOOK_S * 1000);
  }

  /** Takes a download off this device, finished or not. */
  async remove(id: string): Promise<void> {
    await this.load();
    await this.stopRunning(id);
    await this.store?.remove(id).catch(() => undefined);
    this.records.delete(id);
    this.publish();
    void this.pump();
  }

  /** Carries on with whatever a closed app or a lost connection interrupted. */
  async resumeInterrupted(): Promise<void> {
    await this.load();
    for (const record of [...this.records.values()]) {
      if (record.state === "paused" && (record.problem === "connection" || record.problem === "busy")) {
        await this.change(record.id, { state: "queued", problem: null });
      }
    }
    void this.pump();
  }

  /** While someone watches a film from the server, nothing downloads: the engine
   *  converts one film per person, and the stream wants the link. `ready` is when
   *  the film being fetched has let go; `release` lets the queue carry on. */
  hold(): { ready: Promise<void>; release: () => void } {
    this.holds += 1;
    const running = this.running;
    const ready = running ? this.stopRunning(running.id) : Promise.resolve();
    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        this.holds -= 1;
        void this.pump();
      }
    };
  }

  /** Whether anything waits or downloads. */
  get busy(): boolean {
    return [...this.records.values()].some((record) => record.state === "queued" || record.state === "downloading");
  }

  private async stopRunning(id: string): Promise<void> {
    const running = this.running;
    if (!running || running.id !== id) return;
    running.abort.abort();
    await running.done;
    // The engine stops converting it now rather than after a minute of silence,
    // and this person may watch something else converted at once.
    if (this.records.get(id)?.kind === "hls") await leaveConversion(id);
  }

  private async pump(): Promise<void> {
    if (this.running || this.holds > 0) return;
    const next = [...this.records.values()]
      .filter((record) => record.state === "downloading" || record.state === "queued")
      .sort((a, b) => a.queuedAt - b.queuedAt)[0];
    if (!next) {
      void this.wakeLock?.release().catch(() => undefined);
      this.wakeLock = null;
      return;
    }
    const abort = new AbortController();
    const done = this.run(next.id, abort.signal).catch(() => undefined);
    this.running = { id: next.id, abort, done };
    void this.keepAwake();
    await done;
    this.running = null;
    void this.pump();
  }

  /** A phone that locks its screen stops the download with it. */
  private async keepAwake(): Promise<void> {
    if (this.wakeLock) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    try {
      this.wakeLock = await wakeLock?.request("screen") ?? null;
    } catch {
      // Not allowed just now (a hidden tab): the download goes on while it can.
    }
  }

  /** The screen came back: a wake lock is dropped whenever the page is hidden. */
  awake(): void {
    this.wakeLock = null;
    if (this.running) void this.keepAwake();
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const store = this.store;
    if (!store) return;
    try {
      let record = await this.change(id, { state: "downloading", problem: null });
      if (!record) return;
      if (!record.info || !record.kind) record = await this.begin(record, store, signal);
      if (record.state === "preparing") throw new Preparing();
      if (record.kind === "file") await this.fetchFile(record, store, signal);
      else await this.fetchSegments(record, store, signal);
      if (signal.aborted) return;
      await this.change(id, { state: "complete", problem: null });
      if (record.kind === "hls") await leaveConversion(id);
    } catch (err) {
      // Stopped by Pause, Remove or the player: whoever did it set the state.
      if (err instanceof Stopped || signal.aborted) return;
      // Waiting on the server's copy: looked in on now and then, fetched once ready.
      if (err instanceof Preparing) {
        this.lookLater();
        return;
      }
      const problem: VideoDownloadProblem = err instanceof Problem ? err.problem : err instanceof Busy ? "busy" : isQuota(err) ? "space" : "connection";
      const passing = problem === "connection" || problem === "busy";
      await this.change(id, { state: passing ? "paused" : "failed", problem }).catch(() => undefined);
    }
  }

  /** Asks the engine how the film plays at this quality, checks there is room,
   *  and keeps its poster and subtitles. */
  private async begin(record: StoredVideoDownload, store: VideoStore, signal: AbortSignal): Promise<StoredVideoDownload> {
    const info = await this.patiently(signal, async () => {
      let payload: VideoPlayInfo;
      try {
        payload = await askVideoPlay(record.id, record.quality);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) throw new Problem("gone");
        throw err;
      }
      if (payload.playback.busy) throw new Busy();
      return payload;
    });
    if (!info.available) throw new Problem("gone");
    if (info.playback.mode === "none" || !info.playback.url) throw new Problem("format");
    const quality = info.playback.quality?.current ?? record.quality;
    // A smaller picture than the file's: the server prepares one MP4 of it, where
    // it can (engine 0.33+). Until that is ready there is nothing here to do.
    let fileUrl: string | null = null;
    if (info.playback.mode !== "direct" && quality !== null) {
      const audio = info.audioTracks?.find((track) => track.selected)?.index ?? null;
      const copy = await this.patiently(signal, () => askVideoCopy(record.id, quality, audio, true));
      if (copy && (copy.state === "queued" || copy.state === "running")) {
        const waiting = await this.change(record.id, { state: "preparing", info, quality, prepare: prepareOf(copy) });
        if (!waiting) throw new Stopped();
        return waiting;
      }
      if (copy?.state === "failed") throw new Problem("prepare");
      if (copy && (copy.state === "ready" || copy.state === "unneeded") && copy.url) fileUrl = copy.url;
    }
    const kind = info.playback.mode === "direct" || fileUrl ? "file" as const : "hls" as const;
    const estimatedBytes = estimateVideoBytes(info.sizeBytes, info.playback.duration ?? (info.runtimeMinutes ? info.runtimeMinutes * 60 : null), kind === "file" && !fileUrl ? null : quality);
    if (estimatedBytes !== null && !(await hasRoomFor(estimatedBytes))) throw new Problem("space");

    if (record.posterUrl) {
      const poster = await fetch(record.posterUrl, { credentials: "same-origin", signal }).then((res) => (res.ok ? res.blob() : null), () => null);
      if (poster) await store.putPart(record.id, POSTER_PART, poster).catch(() => undefined);
    }
    const subtitles: StoredVideoDownload["subtitles"] = [];
    for (const track of info.subtitleTracks ?? []) {
      if (track.kind !== "text" || !track.url) continue;
      const vtt = await fetch(track.url, { credentials: "same-origin", signal }).then((res) => (res.ok ? res.text() : null), () => null);
      if (vtt) subtitles.push({ id: track.id, vtt });
    }
    if (signal.aborted) throw new Stopped();
    const next = await this.change(record.id, { info, kind, quality, estimatedBytes, subtitles, fileUrl, prepare: null });
    if (!next) throw new Stopped();
    return next;
  }

  /** The file itself, a slice at a time. */
  private async fetchFile(record: StoredVideoDownload, store: VideoStore, signal: AbortSignal): Promise<void> {
    const url = record.fileUrl ?? record.info!.playback.url!;
    let { doneParts, downloadedBytes, totalBytes, totalParts } = record;
    while (totalParts === null || doneParts < totalParts) {
      const from = doneParts * FILE_PART_BYTES;
      const response = await this.patiently(signal, () => this.get(url, signal, { Range: `bytes=${from}-${from + FILE_PART_BYTES - 1}` }));
      const blob = await this.patiently(signal, () => response.blob());
      if (response.status === 206) {
        const size = Number(/\/(\d+)\s*$/.exec(response.headers.get("Content-Range") ?? "")?.[1]);
        if (!Number.isFinite(size)) throw new Problem("connection");
        // Another file under the same name since the last slice: from the start.
        if (totalBytes !== null && size !== totalBytes) {
          await store.clearParts(record.id);
          await this.change(record.id, { doneParts: 0, downloadedBytes: 0, totalBytes: null, totalParts: null });
          doneParts = 0;
          downloadedBytes = 0;
          totalBytes = null;
          totalParts = null;
          continue;
        }
        totalBytes = size;
        totalParts = Math.max(1, Math.ceil(size / FILE_PART_BYTES));
      } else {
        // The whole file in one answer: a server that takes no ranges.
        await store.clearParts(record.id);
        doneParts = 0;
        downloadedBytes = 0;
        totalBytes = blob.size;
        totalParts = 1;
      }
      await store.putPart(record.id, doneParts, blob);
      doneParts += 1;
      downloadedBytes += blob.size;
      const mime = response.headers.get("Content-Type") ?? record.mime;
      if (!(await this.change(record.id, { doneParts, downloadedBytes, totalBytes, totalParts, mime }))) throw new Stopped();
    }
  }

  /** The film as the engine converts it: its playlist, then each segment in turn. */
  private async fetchSegments(record: StoredVideoDownload, store: VideoStore, signal: AbortSignal): Promise<void> {
    const url = record.info!.playback.url!;
    const playlist = await this.patiently(signal, async () => (await this.get(url, signal)).text());
    const names = playlistSegments(playlist);
    if (names.length === 0) throw new Problem("format");
    let { doneParts, downloadedBytes } = record;
    // Cut differently than last time (the file was replaced): from the start.
    if (record.playlist !== null && record.playlist !== playlist) {
      await store.clearParts(record.id);
      doneParts = 0;
      downloadedBytes = 0;
    }
    if (!(await this.change(record.id, { playlist, totalParts: names.length, doneParts, downloadedBytes }))) throw new Stopped();
    const base = url.slice(0, url.lastIndexOf("/") + 1);
    while (doneParts < names.length) {
      const name = names[doneParts];
      const blob = await this.patiently(signal, async () => (await this.get(base + name, signal)).blob());
      await store.putPart(record.id, doneParts, blob);
      doneParts += 1;
      downloadedBytes += blob.size;
      const done = doneParts === names.length;
      if (!(await this.change(record.id, { doneParts, downloadedBytes, ...(done ? { totalBytes: downloadedBytes } : {}) }))) throw new Stopped();
    }
  }

  private async get(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<Response> {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal, headers });
    if (response.ok) return response;
    if (response.status === 404 || response.status === 403 || response.status === 401) throw new Problem("gone");
    if (response.status === 503) {
      const body = await response.json().catch(() => null) as { code?: string } | null;
      if (body?.code === "busy") throw new Busy();
    }
    throw new Error(`HTTP ${response.status}`);
  }

  /** Tries again while the server may yet answer: a lost connection a few times,
   *  a busy engine for some minutes. What can't pass is thrown at once. */
  private async patiently<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    let failures = 0;
    let busy = 0;
    for (;;) {
      if (signal.aborted) throw new Stopped();
      try {
        return await work();
      } catch (err) {
        if (signal.aborted) throw new Stopped();
        if (err instanceof Problem || err instanceof Stopped || isQuota(err)) throw err;
        if (err instanceof Busy) {
          if (++busy >= BUSY_TRIES) throw err;
          await sleep(BUSY_RETRY_S, signal);
          continue;
        }
        if (failures >= RETRY_AFTER_S.length) throw err;
        await sleep(RETRY_AFTER_S[failures++], signal);
      }
    }
  }
}

/** Tells the engine nobody is fetching this film any more. */
async function leaveConversion(id: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = csrfToken();
  if (token) headers["X-CSRF-Token"] = token;
  await fetch(`${VIDEO_API}/hls/${encodeURIComponent(id)}`, { method: "DELETE", headers, credentials: "same-origin" }).catch(() => undefined);
}

/** Whether the device has this much free, by the browser's own count; true when it won't say. */
async function hasRoomFor(bytes: number): Promise<boolean> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.quota) return true;
    return estimate.quota - (estimate.usage ?? 0) >= bytes + SPACE_MARGIN;
  } catch {
    return true;
  }
}

/** Asks the browser not to clear downloads when the device runs short. */
async function requestPersistence(): Promise<void> {
  try {
    if (!(await navigator.storage?.persisted?.())) await navigator.storage?.persist?.();
  } catch {
    // Best effort.
  }
}

/** This device's downloads, for whoever is signed in. */
export const videoDownloads = new VideoDownloads();

/** The copy of a film kept here, once it is all here; null otherwise. */
export async function getOfflineVideo(id: string): Promise<StoredVideoDownload | null> {
  try {
    const record = await videoDownloads.store?.get(id) ?? null;
    return record && record.state === "complete" && record.info && record.kind ? record : null;
  } catch {
    return null;
  }
}

export interface VideoPosition {
  position: number;
  duration: number | null;
  watched?: boolean;
}

/** Remembers where a downloaded film was stopped, here first — so it survives
 *  having no connection — and on the engine when `send` gets through. */
export async function saveOfflineVideoPosition(id: string, at: VideoPosition, send: () => Promise<boolean>): Promise<void> {
  const store = videoDownloads.store;
  const stamp = Date.now();
  const sent = send().catch(() => false);
  await store?.patch(id, {
    position: at.position,
    duration: at.duration,
    ...(at.watched === undefined ? {} : { watched: at.watched }),
    positionAt: stamp,
    positionSynced: false
  }).catch(() => undefined);
  if (!(await sent) || !store) return;
  const current = await store.get(id).catch(() => null);
  // Not over a newer write that arrived meanwhile.
  if (current && current.positionAt === stamp) await store.patch(id, { positionSynced: true }).catch(() => undefined);
}

/** Sends the engine every place a film was stopped at with no connection. */
export async function flushVideoProgress(): Promise<number> {
  const store = videoDownloads.store;
  if (!store) return 0;
  let flushed = 0;
  const rows = await store.list().catch(() => []);
  for (const row of rows) {
    if (row.positionSynced || row.position === null) continue;
    try {
      await api(`${VIDEO_API}/progress/${encodeURIComponent(row.id)}`, {
        method: "PUT",
        body: JSON.stringify({ position: row.position, duration: row.duration, ...(row.watched ? { watched: true } : {}) })
      });
      const current = await store.get(row.id);
      if (current && current.positionAt === row.positionAt) await store.patch(row.id, { positionSynced: true });
      flushed += 1;
    } catch {
      // Still no connection: kept for the next time.
    }
  }
  return flushed;
}

/** On opening the app and whenever the connection returns: what was watched
 *  offline goes to the engine, interrupted downloads carry on, and the player's
 *  code is fetched again if a new release replaced it — the service worker keeps
 *  only what has been loaded once (vite.config.ts), and a film saved for a flight
 *  must not need the network to open its player. */
export async function wakeVideoDownloads(): Promise<void> {
  await videoDownloads.load(true);
  if (videoDownloads.getSnapshot().size === 0) return;
  void flushVideoProgress();
  void videoDownloads.resumeInterrupted();
  if (navigator.onLine) warmVideoPlayer();
}

/** Loads the player and hls.js, so the service worker has them for later. */
export function warmVideoPlayer(): void {
  void import("../features/video/VideoPlayerPage").catch(() => undefined);
  void import("hls.js").catch(() => undefined);
}

/** See VideoDownloads.hold. */
export function holdVideoDownloads(): { ready: Promise<void>; release: () => void } {
  return videoDownloads.hold();
}
