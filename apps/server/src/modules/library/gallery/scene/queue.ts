// The scene scan's queue: its job type, what is still to do, and the markers
// (item_model_scans, pass 'scene'). Light on purpose, so the maintenance schedule
// can queue a scan without loading the scanner. The worker is scanner.ts.
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { SCENE_MODEL, SCENE_PASS } from "./model-id.js";
import { isSceneLibrary, sceneLibraryIds } from "./settings.js";

export const sceneJobType = "SCAN_GALLERY_SCENES";

/** A photo that keeps failing (no thumbnail, one the engine cannot read) is tried
 *  this many times, then left alone until a full rescan or a model change. */
export const MAX_SCENE_SCAN_ATTEMPTS = 3;

// What the CURRENT model still has to look at in one library: photos with no
// marker, with another model's marker, or failed with tries left. Shared by the
// count and the scan so the two always agree. Binds: [SCENE_MODEL, libraryId].
export const UNDESCRIBED_PHOTOS_SQL = `
  FROM library_items li
  JOIN gallery_details gd ON gd.item_id = li.id
  LEFT JOIN item_model_scans s ON s.item_id = li.id AND s.pass = '${SCENE_PASS}' AND s.model = ?
  WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready' AND gd.kind = 'photo'
    -- A picture made from another (a portrait crop) shows what its source shows.
    AND gd.derived_from_item_id IS NULL
    AND (s.item_id IS NULL OR (s.status = 'failed' AND s.attempts < ${MAX_SCENE_SCAN_ATTEMPTS}))
`;

export interface SceneScanProgress {
  processed: number;
  total: number;
  startedAt: string;
}

export interface SceneScanPayload {
  libraryId?: string;
  /** Jobs queued together share one id, and one night's time budget. */
  groupId?: string;
  /** When the group's first job started running; the budget is measured from here. */
  chainStartedAt?: string;
  /** A person asked for it: no time budget. */
  manual?: boolean;
  progress?: SceneScanProgress;
}

/** Photos of one library still to describe. */
export function undescribedPhotoCount(libraryId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n ${UNDESCRIBED_PHOTOS_SQL}`).get(SCENE_MODEL, libraryId) as { n: number }).n;
}

/** One failed try for one photo under the current model. Never downgrades a
 *  current-model success; a failure under another model starts counting at 1. */
export function recordSceneScanFailure(itemId: string): void {
  db.prepare(`
    INSERT INTO item_model_scans (item_id, pass, model, status, attempts, scanned_at)
    VALUES (?, '${SCENE_PASS}', ?, 'failed', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(item_id, pass) DO UPDATE SET
      scanned_at = excluded.scanned_at,
      attempts = CASE WHEN item_model_scans.status = 'failed' AND item_model_scans.model = excluded.model
                      THEN item_model_scans.attempts + 1 ELSE 1 END,
      status = 'failed',
      model = excluded.model
    WHERE NOT (item_model_scans.status = 'ok' AND item_model_scans.model = excluded.model)
  `).run(itemId, SCENE_MODEL);
}

/** Forget what was done in one library, so "Scan again" describes every photo
 *  anew. The vectors stay until each is replaced: search keeps working meanwhile. */
export function resetLibrarySceneMarkers(libraryId: string): void {
  db.prepare(
    `DELETE FROM item_model_scans WHERE pass = '${SCENE_PASS}' AND item_id IN (SELECT id FROM library_items WHERE library_id = ?)`
  ).run(libraryId);
}

/** Every vector and marker, everywhere: what "delete search data" removes. Returns
 *  how many vectors went. */
export function clearSceneData(): number {
  return db.transaction(() => {
    db.prepare(`DELETE FROM item_model_scans WHERE pass = '${SCENE_PASS}'`).run();
    return db.prepare("DELETE FROM gallery_scene_vectors").run().changes;
  })();
}

function sceneJobWaiting(libraryId: string): boolean {
  return db.prepare(
    "SELECT 1 FROM jobs WHERE type = ? AND status IN ('pending', 'running') AND json_extract(payload, '$.libraryId') = ? LIMIT 1"
  ).get(sceneJobType, libraryId) != null;
}

/** Queue one job per library that has photos to describe (all the described
 *  libraries by default). A library already queued or running is not queued twice.
 *  Returns the job ids. */
export function enqueueSceneScans(options: { libraryIds?: string[]; manual?: boolean } = {}): string[] {
  const ids = (options.libraryIds ?? sceneLibraryIds()).filter(isSceneLibrary);
  const groupId = nanoid(10);
  const jobs: string[] = [];
  for (const libraryId of ids) {
    if (sceneJobWaiting(libraryId) || undescribedPhotoCount(libraryId) === 0) continue;
    const jobId = nanoid(16);
    const payload: SceneScanPayload = { libraryId, groupId, ...(options.manual ? { manual: true } : {}) };
    db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, 'pending')").run(jobId, sceneJobType, JSON.stringify(payload));
    jobs.push(jobId);
  }
  return jobs;
}
