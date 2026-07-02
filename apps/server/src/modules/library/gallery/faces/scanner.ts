// Face-detection job: walks a gallery library's photos, runs the in-process detector,
// and writes one gallery_faces row per detected face (box + embedding), then triggers
// clustering. Mirrors the gallery scan queue (jobs table, 2s poller). Resumable and
// model-aware: an item is skipped only once it has a gallery_face_scans row for the
// CURRENT embedding model, so bumping FACE_EMBEDDING_MODEL re-embeds stale-model photos
// on the next normal scan (no `force` needed). `force` reprocesses every photo regardless.
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { validateLibrarySource, LibrarySourceError } from "../../shared/library-source.js";
import { libraryJobRunning } from "../../shared/scan-lock.js";
import { jobProgressWriter } from "../../shared/job-progress.js";
import { decodeUpright, detectFacesFromRaw, FACE_EMBEDDING_MODEL, type DecodedImage } from "./arcface.js";
import { embeddingToBlob } from "./embedding.js";
import { clusterGalleryFaces } from "./cluster.js";
import { cropFaceFromRaw, backfillFaceThumbnails } from "./thumbnails.js";
import { faceRecognitionEnabledForLibrary } from "./settings.js";
import { faceJobType, enqueueFaceScan, type FaceScanPayload } from "./queue.js";

// Re-export the queue helpers so existing importers keep a single entry point.
export { enqueueFaceScan, enqueueFaceRecompute } from "./queue.js";

// Drop faces smaller than this fraction of the image's short side — tiny/background
// faces yield unreliable embeddings that pollute clusters.
const MIN_FACE_SIDE = 0.045;

// Incremental (non-forced) scans work through the backlog in batches: each queue job
// processes at most this many photos, then re-enqueues a follow-up. Clustering runs
// after every batch, so people appear progressively during a big initial scan, and the
// short gap between batches lets other queued library jobs take the one-at-a-time lock.
const SCAN_BATCH_SIZE = 1000;
// Overall time box for a CHAIN of incremental batches: once 3 hours have passed since
// the chain's first batch started, no follow-up is enqueued — the rest waits for the
// next nightly run. Unprocessed photos keep no scan marker, so nothing is lost.
// Manual full rescans (force) are exempt from both limits — a forced pass re-stamps
// markers as it goes, so stopping early would strand the rest.
const SCAN_TIME_LIMIT_MS = 3 * 60 * 60 * 1000;

// Snapshot of the currently-running (or next-queued) face scan, for the settings UI.
export interface FaceScanStatus {
  libraryId: string | null;
  status: "pending" | "running";
  recompute: boolean;
  processed: number;
  total: number;
  startedAt: string | null;
  etaSeconds: number | null;
}

interface PhotoRow {
  id: string;
  relative_path: string;
}

async function scanLibraryFaces(
  libraryId: string,
  force: boolean,
  onProgress?: (processed: number, total: number) => void,
  deadline: number = Number.POSITIVE_INFINITY
): Promise<{ items: number; faces: number; skipped?: boolean; failed?: number; remaining?: number; timeLimited?: boolean }> {
  if (!faceRecognitionEnabledForLibrary(libraryId)) return { items: 0, faces: 0, skipped: true };

  const library = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as { id: string; source_path: string } | undefined;
  if (!library) throw new Error("Gallery library not found.");
  const root = validateLibrarySource(library.source_path);

  // Non-forced: join the scan marker on the CURRENT model only, so a photo last scanned
  // under a different (old) embedding model fails the join and gets re-embedded.
  const photos = db.prepare(`
    SELECT li.id AS id, gd.relative_path AS relative_path
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    ${force ? "" : "LEFT JOIN gallery_face_scans s ON s.item_id = li.id AND s.model = ?"}
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready' AND gd.kind = 'photo'
    ${force ? "" : "AND s.item_id IS NULL"}
  `).all(...(force ? [libraryId] : [FACE_EMBEDDING_MODEL, libraryId])) as PhotoRow[];

  const insertFace = db.prepare(`
    INSERT INTO gallery_faces
      (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, thumb_storage_key, assignment, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'scan')
  `);
  const markScanned = db.prepare(`
    INSERT INTO gallery_face_scans (item_id, scanned_at, model, face_count)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET scanned_at = excluded.scanned_at, model = excluded.model, face_count = excluded.face_count
  `);

  let totalFaces = 0;
  let failed = 0;
  // This job's slice of the backlog; a follow-up batch (enqueued by the worker) takes
  // the next slice. Forced rescans always run the full set.
  const batchTarget = force ? photos.length : Math.min(photos.length, SCAN_BATCH_SIZE);
  let stoppedAt = batchTarget;
  let timeLimited = false;
  // Report progress at the top of each iteration (idx photos finished so far) plus a
  // final full count; the caller throttles the actual writes. `continue` paths are fine —
  // the next iteration's call (or the post-loop call) advances the count.
  for (let idx = 0; idx < batchTarget; idx += 1) {
    onProgress?.(idx, batchTarget);
    if (Date.now() > deadline) { stoppedAt = idx; timeLimited = true; break; }
    const photo = photos[idx];
    const absolutePath = path.join(root, ...photo.relative_path.split("/"));
    if (!fs.existsSync(absolutePath)) continue; // gone on disk; the gallery scanner reconciles it
    // Decode the photo ONCE and reuse it for detection + every face crop.
    let image: DecodedImage;
    let faces: Awaited<ReturnType<typeof detectFacesFromRaw>>;
    try {
      image = await decodeUpright(absolutePath);
      faces = await detectFacesFromRaw(image);
    } catch (err) {
      // A real decode/detect failure (e.g. memory pressure) must NOT be recorded as a
      // 0-face photo — leave its faces + scan state untouched so a later scan retries.
      failed += 1;
      if (failed <= 5) console.warn(`face scan: skipping ${photo.relative_path}:`, err instanceof Error ? err.message : err);
      continue;
    }
    const usable = faces.filter((face) => Math.min(face.box[2], face.box[3]) >= MIN_FACE_SIDE);
    // Crop a face thumbnail per detected face from the shared decode (before the write).
    const prepared: { faceId: string; face: (typeof usable)[number]; thumbKey: string | null }[] = [];
    for (const face of usable) {
      const faceId = nanoid(16);
      const thumbKey = await cropFaceFromRaw(image, libraryId, faceId, face.box);
      prepared.push({ faceId, face, thumbKey });
    }
    db.transaction(() => {
      // Replace this item's auto-detected faces (idempotent rescan); manual whole-photo
      // tags (source 'manual') are left untouched. Tiny faces are dropped above.
      db.prepare("DELETE FROM gallery_faces WHERE item_id = ? AND source = 'scan'").run(photo.id);
      for (const { faceId, face, thumbKey } of prepared) {
        insertFace.run(
          faceId, photo.id, face.box[0], face.box[1], face.box[2], face.box[3],
          face.score, embeddingToBlob(face.embedding), FACE_EMBEDDING_MODEL, thumbKey
        );
      }
      markScanned.run(photo.id, FACE_EMBEDDING_MODEL, prepared.length);
    })();
    totalFaces += prepared.length;
  }
  onProgress?.(stoppedAt, batchTarget);

  clusterGalleryFaces();
  if (failed > 0) console.warn(`face scan: ${failed} of ${stoppedAt} photos failed to process (left for retry).`);
  const remaining = photos.length - stoppedAt;
  if (timeLimited) console.warn(`face scan: paused at the ${SCAN_TIME_LIMIT_MS / 3_600_000}-hour limit — ${remaining} photos continue next run.`);
  return {
    items: stoppedAt,
    faces: totalFaces,
    failed,
    ...(remaining > 0 ? { remaining } : {}),
    ...(timeLimited ? { timeLimited: true } : {})
  };
}

// The face scan that is currently running, or the next one queued (oldest non-finished
// job wins, so a running job is reported over later pending ones). Returns null when the
// queue is idle. ETA is a simple processed/elapsed extrapolation over the current run.
export function activeFaceScan(): FaceScanStatus | null {
  const job = db.prepare(`
    SELECT payload, status FROM jobs
    WHERE type = ? AND status IN ('pending', 'running')
    ORDER BY datetime(created_at) ASC LIMIT 1
  `).get(faceJobType) as { payload: string; status: "pending" | "running" } | undefined;
  if (!job) return null;

  let payload: FaceScanPayload;
  try { payload = JSON.parse(job.payload) as FaceScanPayload; }
  catch { payload = {}; }

  const progress = payload.progress;
  const processed = progress?.processed ?? 0;
  const total = progress?.total ?? 0;
  let etaSeconds: number | null = null;
  if (progress && processed > 0 && total > processed) {
    const elapsedMs = Date.now() - Date.parse(progress.startedAt);
    if (elapsedMs > 0) etaSeconds = Math.round((total - processed) * (elapsedMs / processed) / 1000);
  }
  return {
    libraryId: payload.libraryId ?? null,
    status: job.status,
    recompute: payload.recompute ?? false,
    processed,
    total,
    startedAt: progress?.startedAt ?? null,
    etaSeconds
  };
}

let queueRunning = false;

export async function processFaceScanQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    db.prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, error = NULL WHERE type = ? AND status = 'running'")
      .run(faceJobType);

    for (;;) {
      // One library job at a time server-wide: while another scan or face job is
      // running (whatever its type), leave the queue alone until the next poll.
      if (libraryJobRunning()) break;

      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(run_at) ASC LIMIT 1
      `).get(faceJobType) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as FaceScanPayload;
      try {
        let result;
        if (payload.recompute) {
          // Backfill any missing face crops (existing libraries get avatars) then group.
          const thumbnails = await backfillFaceThumbnails();
          result = { reclustered: clusterGalleryFaces().clusters, thumbnails };
        } else {
          // The night's time budget spans the whole batch CHAIN, measured from the
          // first batch's start (carried through follow-up jobs via chainStartedAt).
          const chainStartedAt = payload.chainStartedAt ?? new Date().toISOString();
          const deadline = payload.force ? Number.POSITIVE_INFINITY : Date.parse(chainStartedAt) + SCAN_TIME_LIMIT_MS;
          // Persist live progress into the job payload (throttled) so the Tasks page
          // shows photos scanned + ETA while the scan runs.
          result = await scanLibraryFaces(payload.libraryId ?? "", payload.force ?? false, jobProgressWriter(job.id, payload), deadline);
          // Backlog left with budget to spare → continue in a follow-up batch after a
          // short delay (other queued library jobs can take the lock in between).
          // Time-limited leftovers instead wait for the next nightly run.
          if (!payload.force && payload.libraryId && result.remaining && !result.timeLimited) {
            const dupe = db.prepare(
              "SELECT 1 FROM jobs WHERE type = ? AND status = 'pending' AND json_extract(payload, '$.libraryId') = ? LIMIT 1"
            ).get(faceJobType, payload.libraryId);
            if (!dupe) enqueueFaceScan(payload.libraryId, false, { delaySeconds: 5, chainStartedAt });
          }
        }
        db.prepare("UPDATE jobs SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?")
          .run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        const permanent = err instanceof LibrarySourceError;
        const message = err instanceof Error ? err.message : "Face scan failed";
        const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number };
        if (!permanent && attempts.attempts < attempts.max_attempts) {
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(new Date(Date.now() + 5000).toISOString(), message, job.id);
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startFaceScanWorker(): () => void {
  const timer = setInterval(() => { void processFaceScanQueue(); }, 2000);
  return () => clearInterval(timer);
}
