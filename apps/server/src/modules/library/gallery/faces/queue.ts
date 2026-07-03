// Face-scan job queue helpers + payload types. Deliberately dependency-light (db + nanoid
// only) and free of any ML imports, so modules that merely ENQUEUE a scan — e.g. the
// maintenance scheduler — don't transitively load arcface.ts / the native onnxruntime
// binding. The actual scan worker lives in scanner.ts.
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { FACE_EMBEDDING_MODEL } from "./model-id.js";

export const faceJobType = "SCAN_GALLERY_FACES";

// Incremental scans work through the backlog in batches of this many photos. The whole
// backlog is pre-queued as numbered batch jobs (batch 2/5, …) so the Tasks page shows
// up front how much work is lined up; each batch just processes the next ≤N unscanned
// photos, so correctness always comes from the scan markers, never the pre-split.
export const SCAN_BATCH_SIZE = 1000;

// A photo whose decode/detect keeps failing (corrupt file, unsupported codec) is
// retried this many times, then skipped by incremental scans — otherwise it would sit
// in every batch's backlog window forever, and enough of them would starve fresh
// photos entirely. A force rescan retries regardless; a success resets the counter.
export const MAX_FACE_SCAN_ATTEMPTS = 3;

// The incremental backlog: photos the CURRENT model still needs — never scanned under
// it, or failed under it with retry budget left. Shared by the batch pre-count and the
// scan itself so the two always agree. Binds: [FACE_EMBEDDING_MODEL, libraryId].
export const UNSCANNED_PHOTOS_SQL = `
  FROM library_items li
  JOIN gallery_details gd ON gd.item_id = li.id
  LEFT JOIN gallery_face_scans s ON s.item_id = li.id AND s.model = ?
  WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready' AND gd.kind = 'photo'
    AND (s.item_id IS NULL OR (s.status = 'failed' AND s.attempts < ${MAX_FACE_SCAN_ATTEMPTS}))
`;

// Record a decode/detect failure for one photo under the current model, bumping its
// retry counter. Never downgrades a successful current-model marker (a force rescan
// that fails on a photo keeps its previously-detected faces and 'ok' state); a failure
// under a DIFFERENT (stale) model starts a fresh count at 1.
export function recordFaceScanFailure(itemId: string): void {
  db.prepare(`
    INSERT INTO gallery_face_scans (item_id, scanned_at, model, face_count, status, attempts)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 0, 'failed', 1)
    ON CONFLICT(item_id) DO UPDATE SET
      scanned_at = excluded.scanned_at,
      attempts = CASE WHEN gallery_face_scans.status = 'failed' AND gallery_face_scans.model = excluded.model
                      THEN gallery_face_scans.attempts + 1 ELSE 1 END,
      status = 'failed',
      model = excluded.model,
      face_count = 0
    WHERE NOT (gallery_face_scans.status = 'ok' AND gallery_face_scans.model = excluded.model)
  `).run(itemId, FACE_EMBEDDING_MODEL);
}

export interface ScanProgress {
  processed: number;
  total: number;
  startedAt: string;
}

export interface FaceScanPayload {
  libraryId?: string;
  force?: boolean;
  // A "recompute" job re-clusters existing embeddings without re-detecting anything.
  recompute?: boolean;
  // Batch bookkeeping for a pre-queued backlog: jobs of one enqueue share a groupId and
  // carry their position (batch N of batches). Display-only apart from group cleanup.
  groupId?: string;
  batch?: number;
  batches?: number;
  // The time the group's FIRST batch started running (stamped onto every sibling by the
  // worker). The scanner's overall night budget is measured from here, not per batch.
  chainStartedAt?: string;
  // Live per-run progress, written into the job row so the UI can show a bar + ETA.
  progress?: ScanProgress;
}

function insertFaceJob(payload: FaceScanPayload, delaySeconds?: number): string {
  const jobId = nanoid(16);
  // A small delay lets other queued library jobs take the one-at-a-time lock first
  // (the worker only claims jobs whose run_at has passed).
  const runAt = delaySeconds ? new Date(Date.now() + delaySeconds * 1000).toISOString() : null;
  db.prepare(
    "INSERT INTO jobs (id, type, payload, status, run_at) VALUES (?, ?, ?, 'pending', COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
  ).run(jobId, faceJobType, JSON.stringify(payload), runAt);
  return jobId;
}

export function enqueueFaceScan(
  libraryId: string,
  force = false,
  opts: { delaySeconds?: number; chainStartedAt?: string } = {}
): string {
  return insertFaceJob(
    { libraryId, force, ...(opts.chainStartedAt ? { chainStartedAt: opts.chainStartedAt } : {}) },
    opts.delaySeconds
  );
}

// Photos of a library the CURRENT model still needs — the same filter the scan itself
// uses, so the pre-queued batch count matches what will actually run.
function unscannedPhotoCount(libraryId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n ${UNSCANNED_PHOTOS_SQL}`)
    .get(FACE_EMBEDDING_MODEL, libraryId) as { n: number };
  return row.n;
}

// Pre-queue a library's incremental backlog as numbered batch jobs (always at least one,
// so a no-op scan still runs and records a history row). Returns the job ids in order.
export function enqueueFaceScanBatches(
  libraryId: string,
  opts: { delaySeconds?: number; chainStartedAt?: string; batchSize?: number } = {}
): string[] {
  const batchSize = opts.batchSize ?? SCAN_BATCH_SIZE;
  const batches = Math.max(1, Math.ceil(unscannedPhotoCount(libraryId) / batchSize));
  const groupId = nanoid(10);
  const ids: string[] = [];
  for (let i = 1; i <= batches; i += 1) {
    ids.push(insertFaceJob(
      {
        libraryId,
        force: false,
        groupId,
        batch: i,
        batches,
        ...(opts.chainStartedAt ? { chainStartedAt: opts.chainStartedAt } : {})
      },
      opts.delaySeconds
    ));
  }
  return ids;
}

// Drop a library's per-photo scan markers so a "rescan" re-embeds every photo. The
// incremental batch pipeline then treats all photos as unscanned and splits them
// into numbered batches (same visible, resumable, time-boxed flow as a normal
// scan) instead of one monolithic job. Detected faces are left in place — each
// batch replaces a photo's scan faces in its own transaction as it reprocesses it,
// so existing avatars don't blink out and manual whole-photo tags are untouched.
export function resetLibraryFaceScanMarkers(libraryId: string): void {
  db.prepare(
    "DELETE FROM gallery_face_scans WHERE item_id IN (SELECT id FROM library_items WHERE library_id = ?)"
  ).run(libraryId);
}

// Re-cluster existing embeddings with the current settings — no re-detection. Cheap
// relative to a scan, so tuning grouping strength is near-instant.
export function enqueueFaceRecompute(): string {
  const jobId = nanoid(16);
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, faceJobType, JSON.stringify({ recompute: true } satisfies FaceScanPayload));
  return jobId;
}
