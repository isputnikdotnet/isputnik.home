import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats } from "hls.js";
import { getOfflineVideo, videoDownloads } from "../../offline/video";
import type { StoredVideoDownload, VideoStore } from "../../offline/video-store";
import type { VideoPlayInfo } from "./types";

// A film kept on this device (offline/video.ts), as the player takes it: an
// address for the <video>, and for a converted film the loader hls.js reads its
// playlist and segments through — from the store here, never the network.

export interface OfflineVideoSource {
  /** A file: its blob's address. A converted film: an address only the loader answers. */
  url: string;
  /** hls.js's loader for a converted film; null for a file. */
  loader: HlsConfig["loader"] | null;
  /** Each text subtitle's address, by track id. */
  subtitles: Record<string, string>;
  /** Lets go of the addresses made. */
  close(): void;
}

const emptyStats = (): LoaderStats => ({
  aborted: false,
  loaded: 0,
  retry: 0,
  total: 0,
  chunkCount: 0,
  bwEstimate: 0,
  loading: { start: 0, first: 0, end: 0 },
  parsing: { start: 0, end: 0 },
  buffering: { start: 0, first: 0, end: 0 }
});

/** A loader that answers hls.js from the store: the playlist kept with the
 *  download, and segment `<n>.ts` as part n. */
export function offlineHlsLoader(store: VideoStore, record: Pick<StoredVideoDownload, "id" | "playlist">): NonNullable<HlsConfig["loader"]> {
  return class OfflineLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = emptyStats();
    private gone = false;

    load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context;
      const stats = this.stats;
      stats.loading.start = performance.now();
      const name = context.url.split("?")[0].split("/").pop() ?? "";
      const segment = /^(\d+)\.ts$/.exec(name);
      const work: Promise<string | ArrayBuffer> = segment
        ? store.getPart(record.id, Number(segment[1])).then((blob) => {
            if (!blob) throw new Error("Not saved");
            return blob.arrayBuffer();
          })
        : Promise.resolve(record.playlist ?? "");
      work.then(
        (data) => {
          if (this.gone) return;
          const size = typeof data === "string" ? data.length : data.byteLength;
          stats.loaded = size;
          stats.total = size;
          stats.loading.first = Math.max(performance.now(), stats.loading.start + 1);
          stats.loading.end = stats.loading.first;
          callbacks.onSuccess({ url: context.url, data }, stats, context, null);
        },
        () => {
          if (this.gone) return;
          callbacks.onError({ code: 404, text: "Not saved on this device" }, context, null, stats);
        }
      );
    }

    abort(): void {
      this.gone = true;
      this.stats.aborted = true;
    }

    destroy(): void {
      this.gone = true;
    }
  };
}

/** Opens a finished download for playing. */
export async function openOfflineVideo(record: StoredVideoDownload): Promise<OfflineVideoSource> {
  const store = videoDownloads.store;
  if (!store) throw new Error("No offline storage");
  const made: string[] = [];
  const address = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    made.push(url);
    return url;
  };
  const subtitles: Record<string, string> = {};
  for (const track of record.subtitles) subtitles[track.id] = address(new Blob([track.vtt], { type: "text/vtt" }));
  const close = () => made.forEach((url) => URL.revokeObjectURL(url));
  if (record.kind === "file") {
    // The slices put together again: the browser reads them from the disk as the
    // film plays, none of it is copied into memory here.
    const parts = await store.getParts(record.id);
    return { url: address(new Blob(parts, { type: record.mime ?? "video/mp4" })), loader: null, subtitles, close };
  }
  return {
    url: `${window.location.origin}/video/offline/${encodeURIComponent(record.id)}/index.m3u8`,
    loader: offlineHlsLoader(store, record),
    subtitles,
    close
  };
}

/** What the player starts from for a downloaded film: what was kept with it,
 *  brought up to date by the engine's answer when there is one (`fresh`) — where
 *  this person got to on another screen, the marks, what comes next. */
export async function offlinePlayInfo(record: StoredVideoDownload, source: OfflineVideoSource, fresh: VideoPlayInfo | null): Promise<VideoPlayInfo> {
  const info = record.info!;
  const here = record.watched ? 0 : record.position ?? 0;
  // Watched here with no connection since: this device knows best.
  const resumeAt = !record.positionSynced && record.position !== null ? here : fresh ? fresh.resumeAt : record.position !== null ? here : info.resumeAt;
  let next = fresh ? fresh.next : info.next;
  // With no connection, only what is on this device can follow.
  if (!fresh && next && !(await getOfflineVideo(next.id))) next = null;
  return {
    ...info,
    playback: { ...info.playback, url: source.url, busy: null, quality: undefined },
    // The one sound track downloaded, and the subtitles kept as text.
    audioTracks: (info.audioTracks ?? []).filter((track) => track.selected),
    subtitleTracks: (info.subtitleTracks ?? [])
      .filter((track) => track.kind === "text" && subtitles(source, track.id))
      .map((track) => ({ ...track, url: subtitles(source, track.id), burned: false })),
    markers: fresh?.markers ?? info.markers,
    progress: fresh?.progress ?? info.progress,
    resumeAt,
    next
  };
}

const subtitles = (source: OfflineVideoSource, id: string): string | null => source.subtitles[id] ?? null;
