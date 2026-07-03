// Face-detection job: walks a gallery library's photos, runs the in-process detector,
// and writes one gallery_faces row per detected face (box + embedding). Clustering runs
// once per worker cycle, when the queue drains and only if face rows actually changed —
// never per batch. Mirrors the gallery scan queue (jobs table, 2s poller). Resumable and
// model-aware: an item is skipped only once it has an 'ok' gallery_face_scans row for
// the CURRENT embedding model, so bumping FACE_EMBEDDING_MODEL re-embeds stale-model
// photos on the next normal scan (no `force` needed). Photos that fail to decode/detect
// carry a 'failed' marker with a bounded retry budget (see queue.ts). `force`
// reprocesses every photo regardless.
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
import { removeFaceCropFiles, sweepOrphanFaceCrops } from "./crop-files.js";
import {
  faceJobType, enqueueFaceScanBatches, recordFaceScanFailure,
  SCAN_BATCH_SIZE, MAX_FACE_SCAN_ATTEMPTS, UNSCANNED_PHOTOS_SQL, type FaceScanPayload
} from "./queue.js";

// Re-export the queue helpers so existing importers keep a single entry point.
export { enqueueFaceScan, enqueueFaceScanBatches, enqueueFaceRecompute, resetLibraryFaceScanMarkers } from "./queue.js";

// Drop faces smaller than this fraction of the image's short side — tiny/background
// faces yield unreliable embeddings that pollute clusters.
const MIN_FACE_SIDE = 0.045;

// Overall time box for a GROUP of pre-queued incremental batches: once 3 hours have
// passed since the group's first batch started, the running batch stops and the group's
// remaining queued batches are dropped — the rest waits for the next nightly run.
// Unprocessed photos keep no scan marker, so nothing is lost. Manual full rescans
// (force) are exempt — a forced pass re-stamps markers as it goes, so stopping early
// would strand the rest.
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
): Promise<{ items: number; faces: number; changed?: boolean; skipped?: boolean; failed?: number; remaining?: number; timeLimited?: boolean }> {
  if (!faceRecognitionEnabledForLibrary(libraryId)) return { items: 0, faces: 0, skipped: true };

  const library = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as { id: string; source_path: string } | undefined;
  if (!library) throw new Error("Gallery library not found.");
  const root = validateLibrarySource(library.source_path);

  // Non-forced: the shared backlog query — photos never scanned under the CURRENT model
  // (a model bump re-embeds automatically) or failed under it with retry budget left.
  // Fresh photos order BEFORE retries, so repeat failures can never occupy the batch
  // window and starve new photos. Forced: every photo, failures included.
  const photos = (force
    ? db.prepare(`
        SELECT li.id AS id, gd.relative_path AS relative_path
        FROM library_items li
        JOIN gallery_details gd ON gd.item_id = li.id
        WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready' AND gd.kind = 'photo'
      `).all(libraryId)
    : db.prepare(`
        SELECT li.id AS id, gd.relative_path AS relative_path ${UNSCANNED_PHOTOS_SQL}
        ORDER BY (s.item_id IS NOT NULL), li.id
      `).all(FACE_EMBEDDING_MODEL, libraryId)) as PhotoRow[];

  const insertFace = db.prepare(`
    INSERT INTO gallery_faces
      (id, item_id, box_x, box_y, box_w, box_h, det_score, embedding, embedding_model, thumb_storage_key, assignment, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', 'scan')
  `);
  const markScanned = db.prepare(`
    INSERT INTO gallery_face_scans (item_id, scanned_at, model, face_count, status, attempts)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, 'ok', 0)
    ON CONFLICT(item_id) DO UPDATE SET
      scanned_at = excluded.scanned_at, model = excluded.model, face_count = excluded.face_count,
      status = 'ok', attempts = 0
  `);

  let totalFaces = 0;
  let failed = 0;
  // Whether this run wrote or removed any face rows — the worker only reclusters when
  // something actually changed, so a no-op batch skips the O(n²) grouping pass.
  let mutated = false;
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
      // A real decode/detect failure must NOT be recorded as a 0-face photo — existing
      // faces are left untouched. It IS recorded as a failed attempt: retried on later
      // scans (after every fresh photo) until the cap, then skipped so a corrupt file
      // can't clog the backlog forever. A force rescan always retries it.
      recordFaceScanFailure(photo.id);
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
    // The rescan replaces this item's auto faces with fresh rows (fresh ids, fresh crop
    // files), so the outgoing rows' crop files must go too — collect their keys first,
    // delete the files only after the swap commits.
    const staleCropKeys = (db.prepare(
      "SELECT thumb_storage_key AS k FROM gallery_faces WHERE item_id = ? AND source = 'scan' AND thumb_storage_key IS NOT NULL"
    ).all(photo.id) as { k: string }[]).map((r) => r.k);
    db.transaction(() => {
      // Replace this item's auto-detected faces (idempotent rescan); manual whole-photo
      // tags (source 'manual') are left untouched. Tiny faces are dropped above.
      const removed = db.prepare("DELETE FROM gallery_faces WHERE item_id = ? AND source = 'scan'").run(photo.id).changes;
      for (const { faceId, face, thumbKey } of prepared) {
        insertFace.run(
          faceId, photo.id, face.box[0], face.box[1], face.box[2], face.box[3],
          face.score, embeddingToBlob(face.embedding), FACE_EMBEDDING_MODEL, thumbKey
        );
      }
      markScanned.run(photo.id, FACE_EMBEDDING_MODEL, prepared.length);
      if (removed > 0 || prepared.length > 0) mutated = true;
    })();
    removeFaceCropFiles(staleCropKeys);
    totalFaces += prepared.length;
  }
  onProgress?.(stoppedAt, batchTarget);

  if (failed > 0) console.warn(`face scan: ${failed} of ${stoppedAt} photos failed to process (retried up to ${MAX_FACE_SCAN_ATTEMPTS} times, then skipped until a full rescan).`);
  const remaining = photos.length - stoppedAt;
  if (timeLimited) console.warn(`face scan: paused at the ${SCAN_TIME_LIMIT_MS / 3_600_000}-hour limit — ${remaining} photos continue next run.`);
  return {
    items: stoppedAt,
    faces: totalFaces,
    failed,
    ...(mutated ? { changed: true } : {}),
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

// Crash-recovery net for the drain-time clustering below: a batch that completed right
// before a crash left current-model scan faces with no person (its recluster never ran).
// Cheap probe, checked once per completed scan job (and once at worker startup — see
// recoverOrphanFaceClusters) — not per poll.
function hasUnassignedScanFaces(): boolean {
  return db.prepare(
    "SELECT 1 FROM gallery_faces WHERE source = 'scan' AND person_id IS NULL AND assignment != 'rejected' AND embedding_model = ? LIMIT 1"
  ).get(FACE_EMBEDDING_MODEL) != null;
}

// Adopt faces an interrupted scan left unclustered. Clustering (which creates People
// and assigns faces) runs only once when the whole queue drains, keyed off an
// IN-MEMORY flag. If the process is killed after the last batch committed its faces
// but before that clustering ran — a container restart mid-scan, which is exactly how
// this bit in production — the flag is gone, no jobs are pending, and nothing ever
// re-triggers clustering: the faces sit with person_id = NULL and the People page
// looks empty ("like it never ran"). Run this once on worker startup to catch that.
// Skips while a scan is still active — that scan's own drain clustering will cover it.
export async function recoverOrphanFaceClusters(): Promise<void> {
  if (activeFaceScan()) return;            // a scan is queued/running — let it finish + cluster
  if (hasUnassignedScanFaces()) await clusterGalleryFaces();
}

export async function processFaceScanQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  // Clustering is global and O(n²) over all faces, so it runs ONCE when the queue
  // drains — not after every batch — and only when a scan actually changed face rows
  // (or left unassigned faces behind). A no-op nightly pass never pays for it.
  let clusterDirty = false;
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
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as FaceScanPayload;
      try {
        let result;
        if (payload.recompute) {
          // Backfill any missing face crops (existing libraries get avatars), sweep crop
          // files nothing references any more (rescans/purges/deleted libraries from
          // before the delete paths removed files), then group.
          const thumbnails = await backfillFaceThumbnails();
          const orphanCrops = sweepOrphanFaceCrops();
          result = { reclustered: (await clusterGalleryFaces()).clusters, thumbnails, orphanCrops };
          clusterDirty = false; // just clustered — earlier scan jobs are covered
        } else {
          // The night's time budget spans the whole pre-queued batch GROUP, measured
          // from when its first batch starts running. That first batch stamps the
          // start time onto every queued sibling so they all share one deadline.
          let chainStartedAt = payload.chainStartedAt;
          if (!payload.force && !chainStartedAt) {
            chainStartedAt = new Date().toISOString();
            if (payload.groupId) {
              db.prepare(
                "UPDATE jobs SET payload = json_set(payload, '$.chainStartedAt', ?) WHERE type = ? AND status = 'pending' AND json_extract(payload, '$.groupId') = ?"
              ).run(chainStartedAt, faceJobType, payload.groupId);
            }
          }
          const deadline = payload.force || !chainStartedAt ? Number.POSITIVE_INFINITY : Date.parse(chainStartedAt) + SCAN_TIME_LIMIT_MS;
          // Persist live progress into the job payload (throttled) so the Tasks page
          // shows photos scanned + ETA while the scan runs.
          result = await scanLibraryFaces(payload.libraryId ?? "", payload.force ?? false, jobProgressWriter(job.id, payload), deadline);
          if (!clusterDirty && (result.changed || hasUnassignedScanFaces())) clusterDirty = true;
          if (!payload.force && payload.libraryId) {
            if (result.timeLimited) {
              // Night budget exhausted: drop the group's remaining queued batches — the
              // summary says the rest continues on the next nightly run.
              if (payload.groupId) {
                db.prepare("DELETE FROM jobs WHERE type = ? AND status = 'pending' AND json_extract(payload, '$.groupId') = ?")
                  .run(faceJobType, payload.groupId);
              }
            } else if (result.remaining) {
              // More unscanned photos than the queued batches cover (e.g. photos added
              // mid-run): top the queue up, unless batches are already waiting.
              const dupe = db.prepare(
                "SELECT 1 FROM jobs WHERE type = ? AND status = 'pending' AND json_extract(payload, '$.libraryId') = ? LIMIT 1"
              ).get(faceJobType, payload.libraryId);
              if (!dupe) enqueueFaceScanBatches(payload.libraryId, { delaySeconds: 5, chainStartedAt });
            }
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

    // Queue drained (or yielded to another library job): fold everything the completed
    // batches changed into the people groups in one clustering pass.
    if (clusterDirty) await clusterGalleryFaces();
  } finally {
    queueRunning = false;
  }
}

export function startFaceScanWorker(): () => void {
  // Deferred so it never blocks boot: recover faces an interrupted scan left
  // unclustered (see recoverOrphanFaceClusters). A cheap no-op when there's nothing
  // to recover. Runs after the first poll would have re-queued any interrupted
  // batches, so it only fires when the queue is genuinely drained-but-unclustered.
  const recovery = setTimeout(() => {
    void recoverOrphanFaceClusters().catch((err) => console.warn("face scan: orphan-cluster recovery failed:", err instanceof Error ? err.message : err));
  }, 5000);
  recovery.unref?.();
  const timer = setInterval(() => { void processFaceScanQueue(); }, 2000);
  return () => { clearTimeout(recovery); clearInterval(timer); };
}
