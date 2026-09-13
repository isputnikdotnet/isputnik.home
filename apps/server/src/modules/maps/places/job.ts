// Building the places database as a task (docs/map-approach-proposal.md, phase 2):
// queued from the Maps page, run on the shared job poller, shown on the Tasks page
// with its progress. The build downloads ~220 MB, so it is never done inside a
// request — and one build at a time: asking again while one is queued or running
// returns that one.
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { registerJobHandler } from "../../../core/job-poller.js";
import { jobProgressWriter } from "../../library/shared/job-progress.js";
import { requeueInterruptedJobs } from "../../library/shared/job-recovery.js";
import type { JobRow } from "../../../db/rows.js";
import { buildPlaces, type BuildResult, type BuildStage } from "./build.js";

export const PLACES_BUILD_JOB_TYPE = "BUILD_PLACES";

interface BuildPayload {
  actorUserId: string | null;
  stage?: BuildStage;
  progress?: { processed: number; total: number };
  result?: BuildResult;
}

export interface PlacesBuildStatus {
  running: boolean;
  jobId: string | null;
  stage: BuildStage | null;
  done: number;
  total: number;
  /** The last build's failure, when the last build failed. */
  error: string | null;
  finishedAt: string | null;
}

type Listener = (result: BuildResult) => void;
const afterBuild: Listener[] = [];

/** Run something once a build has swapped a new database in — naming photos
 *  against it, for one. */
export function onPlacesBuilt(listener: Listener): () => void {
  afterBuild.push(listener);
  return () => {
    const index = afterBuild.indexOf(listener);
    if (index !== -1) afterBuild.splice(index, 1);
  };
}

function latestJob() {
  return db.prepare(`
    SELECT id, status, payload, error, completed_at, failed_at
    FROM jobs WHERE type = ? ORDER BY created_at DESC LIMIT 1
  `).get(PLACES_BUILD_JOB_TYPE) as (Pick<JobRow, "id" | "status" | "payload" | "error"> & { completed_at: string | null; failed_at: string | null }) | undefined;
}

export function placesBuildStatus(): PlacesBuildStatus {
  const job = latestJob();
  if (!job) return { running: false, jobId: null, stage: null, done: 0, total: 0, error: null, finishedAt: null };
  let payload: BuildPayload = { actorUserId: null };
  try {
    payload = JSON.parse(job.payload) as BuildPayload;
  } catch {
    // An unreadable payload reads as no progress.
  }
  const running = job.status === "pending" || job.status === "running";
  return {
    running,
    jobId: job.id,
    stage: payload.stage ?? null,
    done: payload.progress?.processed ?? 0,
    total: payload.progress?.total ?? 0,
    error: job.status === "failed" ? job.error ?? "The build failed." : null,
    finishedAt: job.completed_at ?? job.failed_at ?? null
  };
}

export function enqueuePlacesBuild(actorUserId: string | null): PlacesBuildStatus {
  if (!placesBuildStatus().running) {
    db.prepare("INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 1)")
      .run(nanoid(16), PLACES_BUILD_JOB_TYPE, JSON.stringify({ actorUserId } satisfies BuildPayload));
  }
  return placesBuildStatus();
}

/** An activity line that never throws. The admin who asked may have been deleted
 *  since (the log's actor is a foreign key), in which case the line is kept with
 *  no actor rather than lost. */
function record(event: string, actorUserId: string | null, detail: string): void {
  try {
    logActivity({ event, actorUserId, detail });
  } catch {
    try {
      logActivity({ event, actorUserId: null, detail });
    } catch {
      // The build's outcome is on its job row either way.
    }
  }
}

let queueRunning = false;

export async function processPlacesBuildQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    requeueInterruptedJobs(PLACES_BUILD_JOB_TYPE);
    for (;;) {
      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY created_at ASC LIMIT 1
      `).get(PLACES_BUILD_JOB_TYPE) as Pick<JobRow, "id" | "payload"> | undefined;
      if (!job) break;
      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const data = JSON.parse(job.payload) as BuildPayload;
      const started = Date.now();
      let stage: BuildStage | null = null;
      let write = jobProgressWriter(job.id, data);

      // The build alone decides the outcome. Recording it comes after, and cannot
      // undo it: a log line that fails must not turn a finished build into a
      // failed one, or throw out of the queue with the job still marked running.
      let result: BuildResult;
      try {
        result = await buildPlaces((next, done, total) => {
          if (next !== stage) {
            stage = next;
            write = jobProgressWriter(job.id, { ...data, stage: next });
          }
          write(done, total);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "The place names database could not be built.";
        db.prepare(`
          UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ?
          WHERE id = ?
        `).run(message, job.id);
        record("maps.places_build_failed", data.actorUserId, `Could not build the place names database: ${message}`);
        continue;
      }

      db.prepare(`
        UPDATE jobs SET status = 'completed', payload = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL
        WHERE id = ?
      `).run(JSON.stringify({ ...data, stage: "write", result } satisfies BuildPayload), job.id);
      const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
      record(
        "maps.places_built",
        data.actorUserId,
        `Built the place names database: ${result.places} places, ${(result.sizeBytes / 1_048_576).toFixed(1)} MB, in ${seconds}s.`
      );
      for (const listener of [...afterBuild]) {
        try {
          listener(result);
        } catch {
          // A listener's failure is its own; the database is built either way.
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startPlacesBuildWorker(): () => void {
  return registerJobHandler({ name: "places build", types: [PLACES_BUILD_JOB_TYPE], run: processPlacesBuildQueue });
}

/** Test hook: run the queue until no build is queued. */
export async function waitForPlacesBuild(): Promise<void> {
  for (let i = 0; i < 200 && placesBuildStatus().running; i += 1) {
    await processPlacesBuildQueue();
    if (placesBuildStatus().running) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
