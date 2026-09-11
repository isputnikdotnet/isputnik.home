// The registry of media types, for the shared library layer.
//
// library/shared is the cross-type layer: the Recycle Bin, scan rules, storage
// moves and the maintenance schedule act on items and libraries of every type.
// They used to import each type's scanner directly, which meant the shared layer
// depended on every media type while every media type depended on it — a
// 17-file import cycle, and a new media type had to edit each of those files.
//
// So the dependency is inverted, the way core/status-contributors.ts does it for
// the status page: each media type registers what it can do from its own plugin
// (modules/library/<type>/media-type.ts), and the shared code asks the registry.
// Everything here is optional except scanning: a type without an operation simply
// does not take part in whatever uses it (no rescanItem → restored items are
// found by a library scan; no previewRulePattern → no scan rules).
//
// This file imports nothing at runtime, so any file may depend on it without
// joining a cycle. Registration happens when the type's plugin registers, before
// any request, worker tick or maintenance job can ask; tests that exercise
// cross-type behaviour without booting the plugins register the types themselves
// (test/helpers/media-types.ts).
import type { RulePreviewRow } from "./scan-rules.js";

export type MediaJobCategory = "audiobooks" | "ebooks" | "gallery";

/** A recurring maintenance job a media type brings. modules/maintenance lists,
 *  schedules and runs these alongside its own system jobs. */
export interface MediaScheduledJob {
  key: string;
  label: string;
  description: string;
  category: MediaJobCategory;
  /** Runs the task and returns a human-readable summary. Throws on failure. */
  run: () => string;
  /** Built-in defaults, applied when the admin hasn't configured this job yet. */
  defaultEnabled: boolean;
  defaultFrequency: "daily" | "weekly" | "monthly";
  /** Local clock time "HH:MM" the job runs at. */
  defaultTime: string;
  /** Seed with a random quiet-hours time instead of defaultTime (see maintenance). */
  randomizeDefaultTime?: boolean;
}

export interface MediaType {
  /** libraries.type */
  type: string;
  /** Queue a catalog scan of one library, optionally confined to one scan rule's
   *  folders. Returns the job id; the type's worker picks it up on its next poll. */
  enqueueScan: (libraryId: string, options?: { ruleId?: string }) => string;
  /** Work the scan queue now rather than at the worker's next poll. */
  processQueue: () => Promise<void>;
  /** Re-catalogue ONE item in place from its own folder. A type that has this gets
   *  a restored bin item back item by item (trash.ts re-creates its row first); a
   *  type without it has the file re-discovered by a library scan. */
  rescanItem?: (itemId: string) => Promise<unknown>;
  /** Thumbnail-store keys an item owns that the database cascade does not clean
   *  up (face crops). Snapshotted before the teardown deletes the rows… */
  cropKeysForItem?: (itemId: string) => string[];
  /** …and removed once the teardown has committed. */
  removeCropFiles?: (keys: string[]) => void;
  /** Dry-run a scan rule's layouts over its folders. A type without it has no
   *  scan rules. */
  previewRulePattern?: (
    libraryId: string,
    folders: string[],
    layouts: string[],
    ruleId: string | null
  ) => RulePreviewRow[] | Promise<RulePreviewRow[]>;
  /** Whether a folder is one part of a book (Disc 1, CD 2…), by the scanner's own
   *  rule — the scan-rule examples show those shapes separately. */
  isDiscFolder?: (folderName: string) => boolean;
  /** Re-point what the database knows about a folder the storage move task has
   *  just carried into another library. Returns how many items moved. */
  repointMovedFolder?: (libraryId: string, folder: string, targetLibraryId: string, targetFolder: string) => number;
  scheduledJobs?: MediaScheduledJob[];
}

const mediaTypes = new Map<string, MediaType>();

/** Register (or replace — a test may boot the plugin twice) a media type. */
export function registerMediaType(mediaType: MediaType): void {
  mediaTypes.set(mediaType.type, mediaType);
}

export function getMediaType(type: string): MediaType | undefined {
  return mediaTypes.get(type);
}

export function listMediaTypes(): MediaType[] {
  return [...mediaTypes.values()];
}

/** Queue a scan of one library and start working the queue at once. Returns the
 *  job id, or null when no such media type is registered. */
export function scanLibraryNow(type: string, libraryId: string): string | null {
  const mediaType = getMediaType(type);
  if (!mediaType) return null;
  const jobId = mediaType.enqueueScan(libraryId);
  void mediaType.processQueue();
  return jobId;
}
