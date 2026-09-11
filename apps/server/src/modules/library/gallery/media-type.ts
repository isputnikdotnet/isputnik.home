// What the shared library layer may ask of the gallery — registered into the
// media-type registry from galleryPlugin, so trash, storage moves and the
// maintenance schedule never import this type's scanner, face or video code.
// See library/shared/media-types.ts.
import { registerMediaType } from "../shared/media-types.js";
import { enqueueLibraryScans, libraryJobRunning } from "../shared/scan-lock.js";
import { enqueueGalleryScan, processGalleryScanQueue } from "./scanner.js";
import { faceCropKeysForItem, removeFaceCropFiles } from "./faces/crop-files.js";
import { enqueueFaceScanBatches } from "./faces/queue.js";
import { enabledFaceLibraryIds } from "./faces/settings.js";
import { purgeMissingGalleryPhotos, getMissingRetentionDays } from "./cleanup.js";
import { enqueueTranscodeBatch, unplayableBacklogCount } from "./transcode.js";
import { repointMovedFolder } from "./folder-move.js";

// How many videos the weekly "convert unplayable videos" job queues per run — bounded so
// a big backlog drains over successive weeks instead of hogging the box in one night.
const MAX_TRANSCODE_PER_RUN = 20;

export function registerGalleryMediaType(): void {
  registerMediaType({
    type: "gallery",
    enqueueScan: (libraryId) => enqueueGalleryScan(libraryId),
    processQueue: processGalleryScanQueue,
    // Face-crop thumbnails cascade away as DB rows with the item but live on as
    // files, so the bin snapshots their keys and removes the files afterwards.
    cropKeysForItem: faceCropKeysForItem,
    removeCropFiles: removeFaceCropFiles,
    repointMovedFolder,
    scheduledJobs: [
      {
        key: "scan_gallery_libraries",
        label: "Scan photo & video libraries",
        description: "Look for new, changed, or removed photos and videos in every gallery library and update the catalog.",
        category: "gallery",
        defaultEnabled: true,
        defaultFrequency: "daily",
        defaultTime: "03:00",
        randomizeDefaultTime: true,
        run: () => enqueueLibraryScans("gallery", "photo & video", enqueueGalleryScan)
      },
      {
        key: "purge_missing_gallery",
        label: "Purge missing photos",
        description: "Permanently remove photos that have been missing from disk beyond the grace window (default 30 days) — their catalog record, cached thumbnail, and detected faces. Photos still on disk are never touched; the window guards against a temporarily-offline drive.",
        category: "gallery",
        defaultEnabled: true,
        defaultFrequency: "weekly",
        defaultTime: "01:15",
        run: () => {
          const days = getMissingRetentionDays();
          if (days <= 0) return "Auto-purge is disabled (grace window set to 0) — nothing removed.";
          const { purged, eligible } = purgeMissingGalleryPhotos();
          if (eligible === 0) return `No photos have been missing longer than ${days} days — nothing to purge.`;
          return `Purged ${purged} of ${eligible} photo${eligible === 1 ? "" : "s"} missing longer than ${days} days.`;
        }
      },
      {
        key: "convert_unplayable_videos",
        label: "Convert unplayable videos",
        description: "Make a browser-playable H.264 copy of gallery videos whose codec no browser can decode (legacy MPEG-4/AMR camcorder clips, etc.), so they play inline instead of only downloading. The original file is never changed. CPU-heavy, so it converts a batch at a time — a large backlog drains over several weeks.",
        category: "gallery",
        defaultEnabled: true,
        defaultFrequency: "weekly",
        defaultTime: "01:45",
        run: () => {
          // Don't stack conversions on an in-progress scan/face run (all CPU-heavy).
          if (libraryJobRunning()) return "Skipped — a library or face task is already running; will retry at the next scheduled time.";
          const pending = unplayableBacklogCount();
          if (pending === 0) return "No unplayable videos need converting.";
          const queued = enqueueTranscodeBatch(MAX_TRANSCODE_PER_RUN);
          const remaining = pending - queued;
          return `Queued ${queued} video conversion${queued === 1 ? "" : "s"}${remaining > 0 ? ` (${remaining} more will follow next run)` : ""} — they process in the background.`;
        }
      },
      {
        key: "scan_new_faces",
        label: "Scan new photos for faces",
        description: "Detect and group faces in photos not yet scanned with the current recognition model, across every library with face recognition enabled. Already-processed photos are skipped, and a run pauses after 3 hours — the rest continues the next night.",
        category: "gallery",
        defaultEnabled: true,
        defaultFrequency: "daily",
        // After the nightly library scans (randomized 01:00–04:59), so tonight's new
        // photos are already cataloged and get their faces the same night.
        defaultTime: "05:00",
        run: () => {
          // Skip if a library or face task is already running (see enqueueLibraryScans) —
          // don't stack another backlog behind an in-progress scan.
          if (libraryJobRunning()) return "Skipped — a library or face task is already running; will retry at the next scheduled time.";
          const ids = enabledFaceLibraryIds();
          if (ids.length === 0) return "No libraries have face recognition enabled — nothing to scan.";
          // Pre-queued as numbered batch jobs so the Tasks page shows the whole backlog.
          // The face-scan worker (2s poller) picks these up — no need to kick it here, which
          // keeps this file free of the ML/onnxruntime import chain.
          const batches = ids.reduce((sum, id) => sum + enqueueFaceScanBatches(id).length, 0);
          return `Queued ${batches} face-scan batch${batches === 1 ? "" : "es"} across ${ids.length} librar${ids.length === 1 ? "y" : "ies"} — new or stale-model photos process in the background.`;
        }
      }
    ]
  });
}
