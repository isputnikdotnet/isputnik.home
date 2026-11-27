// The scene scan: walks a gallery library's photos, sends each one's thumbnail to
// the engine (isputnik.faces, scene/engine-client.ts) and keeps the vector that
// comes back (docs/scene-search-plan.md, S2). Shaped like the face scan beside it:
// the jobs table, the shared poller, one heavy library job at a time, resumable.
//
// A photo is done once it has an 'ok' marker for the CURRENT model, so a model
// change re-describes everything on the next ordinary scan. A photo that fails
// carries a 'failed' marker with a few tries (queue.ts). An engine that is not
// there fails nothing: the job says so once and the photos wait for the next run.
import fs from "node:fs";
import { db } from "../../../../db.js";
import { libraryJobRunning } from "../../shared/scan-lock.js";
import { requeueInterruptedJobs } from "../../shared/job-recovery.js";
import { jobProgressWriter } from "../../shared/job-progress.js";
import { resolveCoverKey } from "../../shared/thumbnail.js";
import { log } from "../../../../core/logger.js";
import { registerJobHandler } from "../../../../core/job-poller.js";
import type { JobRow } from "../../../../db/rows.js";
import { SCENE_MODEL, SCENE_PASS } from "./model-id.js";
import { NoSceneEngineError, SceneEngineError, sceneEngine } from "./engine-client.js";
import { encodeSceneVector } from "./vectors.js";
import { isSceneLibrary, sceneSearchEnabled } from "./settings.js";
import {
  MAX_SCENE_SCAN_ATTEMPTS, UNDESCRIBED_PHOTOS_SQL, recordSceneScanFailure, sceneJobType, type SceneScanPayload
} from "./queue.js";

export { enqueueSceneScans, resetLibrarySceneMarkers, clearSceneData } from "./queue.js";

// A night's scans, all libraries together, stop after this long; what is left
// keeps no marker and continues the next night. A scan a person asked for runs
// to the end.
const SCAN_TIME_LIMIT_MS = 3 * 60 * 60 * 1000;

/** What a thumbnail's bytes are called on the wire, by extension. */
const TYPES: Record<string, string> = { ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

// Searches read the vectors through a cache; this number tells it they changed.
let vectorsVersion = 0;
export function sceneVectorsVersion(): number {
  return vectorsVersion;
}
/** Vectors were written or removed outside the scan (cleared, a library deleted). */
export function sceneVectorsChanged(): void {
  vectorsVersion += 1;
}

export interface SceneScanResult {
  /** Photos looked at in this run. */
  items: number;
  /** Photos that now have a vector from this run. */
  described: number;
  failed?: number;
  remaining?: number;
  timeLimited?: boolean;
  /** Stopped part-way because the feature was switched off. */
  switchedOff?: boolean;
  skipped?: boolean;
  reason?: string;
}

interface PhotoRow {
  id: string;
  cover: string | null;
}

async function scanLibraryScenes(
  libraryId: string,
  onProgress?: (processed: number, total: number) => void,
  deadline: number = Number.POSITIVE_INFINITY
): Promise<SceneScanResult> {
  if (!sceneSearchEnabled()) return { items: 0, described: 0, skipped: true, reason: "Search by what a photo shows is switched off." };
  // A library that became a Photo Inbox, or went away, since the job was queued.
  if (!isSceneLibrary(libraryId)) return { items: 0, described: 0, skipped: true };

  // Fresh photos before retries, so repeat failures never crowd out new photos.
  const photos = db.prepare(`
    SELECT li.id AS id, (SELECT cover_storage_key FROM item_metadata WHERE item_id = li.id) AS cover
    ${UNDESCRIBED_PHOTOS_SQL}
    ORDER BY (s.item_id IS NOT NULL), li.id
  `).all(SCENE_MODEL, libraryId) as PhotoRow[];
  if (photos.length === 0) return { items: 0, described: 0 };

  // Nothing to describe photos with: say so once, here, instead of failing every
  // photo (and burning each one's tries on a container that is simply down).
  const engine = sceneEngine();
  try {
    await engine.ensure();
  } catch (err) {
    if (!(err instanceof NoSceneEngineError)) throw err;
    log.warn(`scene scan: skipped — ${err.message}`);
    return { items: 0, described: 0, skipped: true, reason: err.message };
  }

  const store = db.prepare(`
    INSERT INTO gallery_scene_vectors (item_id, model, vector) VALUES (?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET model = excluded.model, vector = excluded.vector
  `);
  const markDone = db.prepare(`
    INSERT INTO item_model_scans (item_id, pass, model, status, attempts, scanned_at)
    VALUES (?, '${SCENE_PASS}', ?, 'ok', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(item_id, pass) DO UPDATE SET model = excluded.model, status = 'ok', attempts = 0, scanned_at = excluded.scanned_at
  `);
  const stillThere = db.prepare("SELECT 1 FROM library_items WHERE id = ? AND deleted_at IS NULL");

  let described = 0;
  let failed = 0;
  let stoppedAt = photos.length;
  let timeLimited = false;
  let switchedOff = false;
  let engineLost: string | null = null;
  const fail = (photo: PhotoRow, why: string) => {
    recordSceneScanFailure(photo.id);
    failed += 1;
    if (failed <= 5) log.warn(`scene scan: skipping item ${photo.id}: ${why}`);
  };

  for (let idx = 0; idx < photos.length; idx += 1) {
    onProgress?.(idx, photos.length);
    if (Date.now() > deadline) { stoppedAt = idx; timeLimited = true; break; }
    // Switched off while this ran: stop here, with what was described kept.
    if (!sceneSearchEnabled()) { stoppedAt = idx; switchedOff = true; break; }
    const photo = photos[idx];

    // The 400 px thumbnail the gallery scan made: the model looks at 224 × 224,
    // so the original's megabytes would buy nothing but disk reads.
    const resolved = photo.cover ? resolveCoverKey(photo.cover) : null;
    const type = resolved ? TYPES[resolved.absolutePath.slice(resolved.absolutePath.lastIndexOf(".")).toLowerCase()] : undefined;
    if (!resolved || !type) { fail(photo, "it has no thumbnail"); continue; }
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(resolved.absolutePath);
    } catch {
      fail(photo, "its thumbnail is missing from the thumbnail store");
      continue;
    }

    let vector: Float32Array;
    try {
      vector = await engine.embedImage(bytes, type);
    } catch (err) {
      // Only "this picture cannot be read" is the photo's fault. Anything else is
      // the engine's: stop here with what was done kept, and try again next run.
      if (err instanceof SceneEngineError && err.kind === "undecodable") { fail(photo, err.message); continue; }
      engineLost = err instanceof Error ? err.message : String(err);
      stoppedAt = idx;
      break;
    }

    db.transaction(() => {
      // Deleted while its vector was being made: nothing to keep it for.
      if (!stillThere.get(photo.id)) return;
      store.run(photo.id, SCENE_MODEL, encodeSceneVector(vector));
      markDone.run(photo.id, SCENE_MODEL);
      described += 1;
    })();
  }
  onProgress?.(stoppedAt, photos.length);
  if (described > 0) sceneVectorsChanged();

  const remaining = photos.length - stoppedAt;
  if (failed > 0) log.warn(`scene scan: ${failed} of ${stoppedAt} photos could not be described (tried up to ${MAX_SCENE_SCAN_ATTEMPTS} times, then left until a full rescan).`);
  if (engineLost) log.warn(`scene scan: the engine stopped answering (${engineLost}); ${remaining} photos wait for the next run.`);
  if (timeLimited) log.warn(`scene scan: paused at the ${SCAN_TIME_LIMIT_MS / 3_600_000}-hour limit — ${remaining} photos continue next run.`);
  return {
    items: stoppedAt,
    described,
    ...(failed > 0 ? { failed } : {}),
    ...(remaining > 0 ? { remaining } : {}),
    ...(timeLimited ? { timeLimited: true } : {}),
    ...(switchedOff ? { switchedOff: true } : {}),
    ...(engineLost ? { reason: engineLost } : {})
  };
}

/** The scene scan running now, or the next one queued; null when idle. */
export interface SceneScanStatus {
  libraryId: string | null;
  status: "pending" | "running";
  processed: number;
  total: number;
  /** Jobs behind this one. */
  queued: number;
}

export function activeSceneScan(): SceneScanStatus | null {
  const jobs = db.prepare(`
    SELECT payload, status FROM jobs
    WHERE type = ? AND status IN ('pending', 'running')
    ORDER BY (status = 'running') DESC, created_at ASC
  `).all(sceneJobType) as (Pick<JobRow, "payload"> & { status: "pending" | "running" })[];
  if (jobs.length === 0) return null;
  let payload: SceneScanPayload;
  try { payload = JSON.parse(jobs[0].payload) as SceneScanPayload; } catch { payload = {}; }
  return {
    libraryId: payload.libraryId ?? null,
    status: jobs[0].status,
    processed: payload.progress?.processed ?? 0,
    total: payload.progress?.total ?? 0,
    queued: jobs.length - 1
  };
}

let queueRunning = false;

export async function processSceneScanQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    requeueInterruptedJobs(sceneJobType);

    for (;;) {
      // One library job at a time server-wide: while a catalog or face scan runs,
      // leave the queue alone until the next poll.
      if (libraryJobRunning()) break;

      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY run_at ASC, created_at ASC LIMIT 1
      `).get(sceneJobType) as Pick<JobRow, "id" | "payload"> | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as SceneScanPayload;
      try {
        // The night's budget covers the whole group: its first job to run stamps
        // the start onto every sibling still waiting, so they share one deadline.
        let chainStartedAt = payload.chainStartedAt;
        if (!payload.manual && !chainStartedAt) {
          chainStartedAt = new Date().toISOString();
          if (payload.groupId) {
            db.prepare(
              "UPDATE jobs SET payload = json_set(payload, '$.chainStartedAt', ?) WHERE type = ? AND status = 'pending' AND json_extract(payload, '$.groupId') = ?"
            ).run(chainStartedAt, sceneJobType, payload.groupId);
          }
        }
        const deadline = payload.manual || !chainStartedAt ? Number.POSITIVE_INFINITY : Date.parse(chainStartedAt) + SCAN_TIME_LIMIT_MS;
        const result = await scanLibraryScenes(payload.libraryId ?? "", jobProgressWriter(job.id, payload), deadline);
        // Out of time, or the engine went away: the group's other libraries would
        // meet the same wall, so they are dropped and wait for the next run too.
        if ((result.timeLimited || result.reason) && payload.groupId) {
          db.prepare("DELETE FROM jobs WHERE type = ? AND status = 'pending' AND json_extract(payload, '$.groupId') = ?")
            .run(sceneJobType, payload.groupId);
        }
        db.prepare("UPDATE jobs SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?")
          .run(JSON.stringify({ ...payload, result }), job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Scene scan failed";
        const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as Pick<JobRow, "attempts" | "max_attempts">;
        if (attempts.attempts < attempts.max_attempts) {
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

export function startSceneScanWorker(): () => void {
  // On the shared job poller (core/job-poller.ts), like every other queue.
  return registerJobHandler({ name: "scene scan", types: [sceneJobType], run: processSceneScanQueue });
}
