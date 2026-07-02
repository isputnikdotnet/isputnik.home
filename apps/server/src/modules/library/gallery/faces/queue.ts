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

// Photos of a library that the CURRENT model hasn't scanned yet — the same filter the
// scan itself uses, so the pre-queued batch count matches what will actually run.
function unscannedPhotoCount(libraryId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    LEFT JOIN gallery_face_scans s ON s.item_id = li.id AND s.model = ?
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready' AND gd.kind = 'photo'
      AND s.item_id IS NULL
  `).get(FACE_EMBEDDING_MODEL, libraryId) as { n: number };
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

// Re-cluster existing embeddings with the current settings — no re-detection. Cheap
// relative to a scan, so tuning grouping strength is near-instant.
export function enqueueFaceRecompute(): string {
  const jobId = nanoid(16);
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')")
    .run(jobId, faceJobType, JSON.stringify({ recompute: true } satisfies FaceScanPayload));
  return jobId;
}
