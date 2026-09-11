// Taking a cleanup job's SNAPSHOT — turning "what the digests say right now" into
// rows the job owns and can come back to next week.
//
// This is not a second duplicate detector. The digests, the folder fingerprints and
// the keeper scoring are the ones the older pages use; what differs is where the
// answer is written and, for the contained tier, how the covering side is expressed.
//
// The tiers are one file each, strongest statement first: snapshot-photo-sets.ts,
// snapshot-near.ts and snapshot-inbox.ts for single files; snapshot-folders.ts,
// snapshot-contained.ts and snapshot-overlaps.ts for folders. What they share is
// snapshot.ts; reading the answers back is job-results.ts.
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { libraryAllowsDelete } from "../../shared/trash.js";
import { locksByLibrary, lockCoveredIn, lockIntersectsIn } from "../../shared/folder-locks.js";
import { fingerprintFolders, type FolderFingerprint } from "./folders.js";
import { enqueueJobScan } from "./items.js";
import type { FolderPreference } from "./keeper.js";
import { type RescanMatch } from "./inbox-rescans.js";
import {
  getJob,
  recordAction,
  setJobStatus,
  type DuplicateJob,
  type JobOutcome,
  type MediaTypeScope
} from "./jobs.js";
import { isUnder, type DeletionBlocks, type ScanFile, type Writer } from "./snapshot.js";
import { snapshotPhotoSets } from "./snapshot-photo-sets.js";
import { snapshotNearSets } from "./snapshot-near.js";
import { snapshotInboxSets } from "./snapshot-inbox.js";
import { snapshotFolderSets } from "./snapshot-folders.js";
import { snapshotContained } from "./snapshot-contained.js";
import { snapshotOverlaps } from "./snapshot-overlaps.js";

// ── Reading the library, once ───────────────────────────────────────────────

function scanFiles(libraryIds: string[], mediaType: MediaTypeScope): ScanFile[] {
  if (libraryIds.length === 0) return [];
  const kinds = mediaType === "both" ? ["photo", "video"] : [mediaType];
  const rows = db.prepare(`
    SELECT li.id AS item_id, li.library_id, li.folder_path, li.discovered_at,
           gd.content_hash, gd.phash, gd.size, gd.modified_at, gd.kind
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
    WHERE li.deleted_at IS NULL AND li.status = 'ready'
      AND li.library_id IN (${libraryIds.map(() => "?").join(",")})
      AND gd.kind IN (${kinds.map(() => "?").join(",")})
    ORDER BY li.library_id, li.folder_path
  `).all(...libraryIds, ...kinds) as {
    item_id: string; library_id: string; folder_path: string; discovered_at: string;
    content_hash: string | null; phash: string | null; size: number | null;
    modified_at: string | null; kind: string;
  }[];

  return rows.map((row) => ({
    itemId: row.item_id,
    libraryId: row.library_id,
    path: row.folder_path,
    hash: row.content_hash,
    phash: row.phash,
    size: row.size,
    mtime: row.modified_at,
    discoveredAt: row.discovered_at,
    kind: row.kind
  }));
}

function writerFor(jobId: string): Writer {
  const insertResult = db.prepare(`
    INSERT INTO duplicate_job_results
      (id, job_id, result_type, reclaimable_bytes, keeper_reason, match_confidence, keeper_rank)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFolder = db.prepare(`
    INSERT INTO duplicate_job_result_folders (id, job_id, result_id, library_id, folder_path, role, item_count, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO duplicate_job_result_members
      (id, job_id, result_id, folder_id, item_id, library_id, path, size_snapshot, mtime_snapshot,
       content_hash, distance, role, keeper_member_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    result: (input) => {
      const id = nanoid(16);
      insertResult.run(
        id, jobId, input.type, input.reclaimableBytes, input.keeperReason,
        input.matchConfidence ?? "certain", input.keeperRank ?? -1
      );
      return id;
    },
    folder: (resultId, input) => {
      const id = nanoid(16);
      insertFolder.run(
        id, jobId, resultId, input.libraryId, input.folderPath, input.role, input.itemCount, input.bytes
      );
      return id;
    },
    member: (resultId, input) => {
      const id = nanoid(16);
      insertMember.run(
        id, jobId, resultId, input.folderId ?? null, input.file.itemId, input.file.libraryId,
        input.file.path, input.file.size, input.file.mtime, input.file.hash,
        input.distance ?? 0, input.role, input.keeperMemberId ?? null
      );
      return id;
    }
  };
}

// ── Folder fingerprints, scoped to the job ──────────────────────────────────

function scopedFingerprints(files: ScanFile[]): FolderFingerprint[] {
  // fingerprintFolders takes the same row shape the global pass reads, so the job's
  // narrower file list produces folder prints over exactly its own libraries.
  return fingerprintFolders(files.map((file) => ({
    item_id: file.itemId,
    library_id: file.libraryId,
    folder_path: file.path,
    content_hash: file.hash,
    size: file.size,
    discovered_at: file.discoveredAt
  })));
}

// ── The scan ────────────────────────────────────────────────────────────────

export interface ScanSummary {
  photoSets: number;
  /** Byte-identical's sibling: same picture, different file. Files mode only. */
  nearSets: number;
  /** Lookalike pairs left out because they are two separate photographs, not copies.
   *  Counted rather than hidden: it is a big share of what the fingerprint matches on
   *  a real library, and "we found less than you expected" deserves a reason. */
  separateShots: number;
  folderSets: number;
  contained: number;
  /** Folder pairs sharing photos without either equalling or containing the other. */
  overlaps: number;
  results: number;
}

/** Ask for the job's scan, and come straight back.
 *
 *  Two phases, because the snapshot below reads no files and therefore needs digests
 *  that may not exist yet. Phase 1 is the fingerprint pass over THIS job's libraries,
 *  queued as an ordinary background job so it inherits requeue-on-restart, the attempt
 *  limit, and the standing courtesy of yielding to catalog and face scans. Phase 2 is
 *  runJobScan, which the worker calls once the digests are in place.
 *
 *  The pass is queued even when nothing looks like it needs reading. `pendingCount` is
 *  an estimate off the catalogue, and it is the stat pass itself that notices a file
 *  edited in place since the last library scan — so skipping it when the estimate says
 *  zero would trade correctness for a progress bar that flickers. With nothing to read
 *  the pass finishes in a moment anyway.
 *
 *  Distinct from applyPreferences, which re-runs the snapshot ALONE: reshuffling
 *  keepers under changed folder instructions needs no new digests, so that stays
 *  synchronous. */
export function startJobScan(jobId: string, userId: string): JobOutcome<DuplicateJob> {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  if (job.status !== "draft" && job.status !== "review" && job.status !== "paused") {
    return { ok: false, refused: "not_reviewable", detail: job.status };
  }

  const libraryIds = job.libraries.filter((library) => library.included && !library.missing)
    .map((library) => library.libraryId);
  if (libraryIds.length === 0) return { ok: false, refused: "no_libraries" };

  const moved = setJobStatus(jobId, userId, "scanning");
  if (!moved.ok) return moved;
  enqueueJobScan(jobId, libraryIds);
  return { ok: true, job: moved.job };
}

/** Compute the job's answers and write them into its own tables, replacing whatever
 *  a previous run left. Reads no files: everything here is derived from digests the
 *  hashing pass has already stored. */
export function runJobScan(
  jobId: string,
  userId: string,
  /** What only the worker can supply: the Inbox check's rotated fingerprints
   *  (inbox-variants.ts), computed before this synchronous pass. A re-run from the
   *  preferences page passes nothing and matches upright only. */
  extras: { nearVariants?: Map<string, string[]>; rescans?: RescanMatch[] } = {}
): JobOutcome<DuplicateJob> & { summary?: ScanSummary } {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };

  const libraryIds = job.libraries.filter((library) => library.included && !library.missing)
    .map((library) => library.libraryId);
  if (libraryIds.length === 0) return { ok: false, refused: "no_libraries" };

  setJobStatus(jobId, userId, "scanning");

  const preferences: FolderPreference[] = job.folderPreferences.map((folder) => ({
    libraryId: folder.libraryId,
    folderPath: folder.folderPath,
    mode: folder.mode
  }));
  const preferenceFor = (libraryId: string, path: string): "keep" | "clear" | null => {
    let best: FolderPreference | null = null;
    for (const folder of preferences) {
      if (folder.libraryId !== libraryId) continue;
      if (!(folder.folderPath === "" || path === folder.folderPath || path.startsWith(`${folder.folderPath}/`))) continue;
      if (!best || folder.folderPath.length > best.folderPath.length) best = folder;
    }
    return best?.mode ?? null;
  };
  const protectedLibs = new Set(libraryIds.filter((id) => !libraryAllowsDelete(id)));
  const locks = locksByLibrary(libraryIds);
  const blocks: DeletionBlocks = {
    path: (libraryId, relPath) =>
      protectedLibs.has(libraryId) || lockCoveredIn(locks.get(libraryId), relPath),
    subtree: (libraryId, folderPath) =>
      protectedLibs.has(libraryId) || lockIntersectsIn(locks.get(libraryId), folderPath)
  };

  const summary: ScanSummary = {
    photoSets: 0, nearSets: 0, separateShots: 0, folderSets: 0, contained: 0, overlaps: 0, results: 0
  };

  try {
    const files = scanFiles(libraryIds, job.mediaType);
    const prints = scopedFingerprints(files);

    // Files below a folder, resolved once rather than re-scanned per folder.
    const byLibrary = new Map<string, ScanFile[]>();
    for (const file of files) {
      const bucket = byLibrary.get(file.libraryId);
      if (bucket) bucket.push(file); else byLibrary.set(file.libraryId, [file]);
    }
    const filesByFolder = (print: FolderFingerprint): ScanFile[] =>
      (byLibrary.get(print.libraryId) ?? []).filter((file) => isUnder(print.folderPath, file.path));

    db.transaction(() => {
      // A rescan replaces the job's answers. The members cascade from the results.
      db.prepare("DELETE FROM duplicate_job_results WHERE job_id = ?").run(jobId);

      const write = writerFor(jobId);

      // One or the other, never both. A folder cleanup answers "is this whole folder
      // redundant"; a file cleanup answers "is this one picture here twice". Running
      // both at once meant every folder cleared re-ordered the single-file half
      // underneath it, and the two kinds of decision were nothing like the same size
      // of work to sit down to.
      if (job.duplicateType === "inbox" && job.inboxLibraryId) {
        // One library's photos against the rest, never the rest against itself.
        const inbox = snapshotInboxSets(
          write, files, job.inboxLibraryId, blocks, extras.nearVariants, extras.rescans
        );
        summary.photoSets = inbox.exact;
        summary.nearSets = inbox.near;
        summary.separateShots = inbox.separateShots;
      } else if (job.duplicateType === "folders") {
        // Strongest statement first, each pass deferring to the ones before it: an
        // identical-folders set speaks for everything inside it, a stored-elsewhere card
        // speaks for its whole folder, and overlaps are only what is left over.
        const sets = snapshotFolderSets(write, prints, filesByFolder, preferences, blocks);
        summary.folderSets = sets.written;
        summary.contained = snapshotContained(
          write, prints, files, filesByFolder, sets.claimed, preferences, blocks, preferenceFor
        );
        summary.overlaps = snapshotOverlaps(write, files, jobId, preferences, blocks);
      } else {
        // Exact first, then near over what it did not already speak for. The order is
        // not a preference: run the other way round and every byte-identical copy
        // appears twice, once in its own set and once inside a near set beside it.
        const exact = snapshotPhotoSets(write, files, preferences, blocks);
        summary.photoSets = exact.written;
        const near = snapshotNearSets(write, files, exact.suppressed, preferences, blocks);
        summary.nearSets = near.written;
        summary.separateShots = near.separateShots;
      }
      summary.results = summary.photoSets + summary.nearSets
        + summary.folderSets + summary.contained + summary.overlaps;
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : "The scan failed.";
    setJobStatus(jobId, userId, "failed", message);
    return { ok: false, refused: "scan_failed", detail: message };
  }

  recordAction({
    jobId,
    userId,
    action: "job.scanned",
    details: `${summary.results} results: ${summary.photoSets} identical files, ${summary.nearSets} near-identical, ${summary.folderSets} folder sets, ${summary.contained} folders stored elsewhere, ${summary.overlaps} sharing photos.`
      + (summary.separateShots > 0
        ? ` ${summary.separateShots} lookalike pair${summary.separateShots === 1 ? "" : "s"} left out as separate shots.`
        : "")
  });
  const moved = setJobStatus(jobId, userId, "review");
  return moved.ok ? { ok: true, job: moved.job, summary } : moved;
}
