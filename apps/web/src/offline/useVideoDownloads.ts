import { useSyncExternalStore } from "react";
import { videoDownloads, type VideoDownloadSnapshot } from "./video";
import type { StoredVideoDownload } from "./video-store";

/** Every film kept (or being fetched) on this device, by id; follows the downloads as they go. */
export function useVideoDownloads(): VideoDownloadSnapshot {
  return useSyncExternalStore(videoDownloads.subscribe, videoDownloads.getSnapshot);
}

/** How far along a download is, 0–1. */
export function downloadFraction(record: StoredVideoDownload): number {
  if (record.state === "complete") return 1;
  if (record.kind === "file" && record.totalBytes) return Math.min(1, record.downloadedBytes / record.totalBytes);
  return record.totalParts ? Math.min(1, record.doneParts / record.totalParts) : 0;
}
