import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { jobProgressWriter } from "../shared/job-progress.js";
import { requeueInterruptedJobs } from "../shared/job-recovery.js";
import { getSlideshow, setSlideshowRenderState, setSlideshowSaveError, type SlideshowRow } from "./slideshows.js";
import { resolveGalleryScopeLibraryIds } from "./catalog-scope.js";
import { log } from "../../../core/logger.js";
import { renderSlideshow } from "./slideshow-render.js";
import { saveMovieToLibrary } from "./slideshow-movie-files.js";

export const RENDER_JOB_TYPE = "gallery-slideshow-render";

interface RenderPayload {
  slideshowId: string;
  userId: string;
}

// ── Enqueue + worker ─────────────────────────────────────────────────────────

// Live render progress for the editor/Tasks page, read from the job payload.
export function renderProgressPercent(jobId: string | null): number | null {
  if (!jobId) return null;
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const progress = (JSON.parse(row.payload) as { progress?: { processed: number; total: number } }).progress;
    if (!progress || progress.total <= 0) return null;
    return Math.min(100, Math.round((progress.processed / progress.total) * 100));
  } catch {
    return null;
  }
}

// Merge a final result into the job payload (preserving the last progress the writer
// left), so the Tasks page history can summarize the outcome.
function writeResult(jobId: string, result: Record<string, unknown>): void {
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string } | undefined;
  let payload: Record<string, unknown> = {};
  try { payload = row ? JSON.parse(row.payload) : {}; } catch { /* start fresh on a bad payload */ }
  db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(JSON.stringify({ ...payload, result }), jobId);
}

export function enqueueSlideshowRender(slideshow: SlideshowRow, userId: string): string {
  const jobId = nanoid(16);
  db.prepare(
    "INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 2)"
  ).run(jobId, RENDER_JOB_TYPE, JSON.stringify({ slideshowId: slideshow.id, userId } satisfies RenderPayload));
  setSlideshowRenderState(slideshow.id, { status: "queued", jobId, error: null });
  return jobId;
}

// A job counts as active (its render is still coming) while it's pending or running.
function jobIsRunning(jobId: string): boolean {
  return (db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | undefined)?.status === "running";
}

// Release slideshows stuck in 'queued'/'rendering' whose job is no longer active —
// cancelled from the Tasks page, or lost to a crash — so the editor stops showing
// "Rendering movie…" forever. Restores the previous movie ('ready') when one exists on
// disk (output_storage_key set), otherwise drops back to the 'Render movie' CTA
// ('draft'). Active (pending/running) jobs are left untouched.
export function reconcileOrphanedRenders(): number {
  return db.prepare(`
    UPDATE gallery_slideshows
    SET render_status = CASE WHEN output_storage_key IS NOT NULL THEN 'ready' ELSE 'draft' END,
        render_error = NULL
    WHERE render_status IN ('queued', 'rendering')
      AND (render_job_id IS NULL OR render_job_id NOT IN (SELECT id FROM jobs WHERE status IN ('pending', 'running')))
  `).run().changes;
}

let queueRunning = false;

export async function processSlideshowRenderQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // A render interrupted by a restart: re-queue it (idempotent — it re-renders) —
    // but only while it has attempts left. A render heavy enough to exhaust the
    // container's memory kills the whole server, and an unbounded re-queue then
    // starts it again on every restart, forever. Whatever this gives up on is told
    // to its slideshow, so the editor shows why rather than sitting on "Rendering…".
    const recovery = requeueInterruptedJobs(RENDER_JOB_TYPE);
    for (const job of recovery.abandoned) {
      try {
        const { slideshowId } = JSON.parse(job.payload) as RenderPayload;
        setSlideshowRenderState(slideshowId, {
          status: "failed",
          error: "The render was interrupted every time it ran — the server may not have enough memory for a slideshow this long. Try fewer photos."
        });
      } catch { /* unreadable payload: reconcileOrphanedRenders below still unsticks it */ }
    }
    // Then unstick any slideshow whose render job is no longer active (post-cancel or
    // post-crash) — after the re-queue above, a resumable render's job is 'pending' and
    // so is excluded here.
    reconcileOrphanedRenders();

    for (;;) {
      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY run_at ASC LIMIT 1
      `).get(RENDER_JOB_TYPE) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1,
          locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as RenderPayload;
      const slideshow = getSlideshow(payload.slideshowId);
      if (!slideshow) {
        // Slideshow deleted before the render ran — nothing to do.
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?").run(job.id);
        continue;
      }

      setSlideshowRenderState(slideshow.id, { status: "rendering", error: null });
      const writeProgress = jobProgressWriter(job.id, payload);
      try {
        // The render belongs to whoever asked; resolve their accessible libraries.
        const libIds = resolveRendererLibraries(payload.userId);
        const { storageKey, bytes } = await renderSlideshow(slideshow, libIds, writeProgress, () => !jobIsRunning(job.id));
        // Cancelled from the Tasks page while ffmpeg ran: the cancel handler already
        // released the slideshow, so don't resurrect it to 'ready' or complete the job.
        if (!jobIsRunning(job.id)) continue;
        setSlideshowRenderState(slideshow.id, {
          status: "ready", outputStorageKey: storageKey, outputBytes: bytes,
          renderedAt: new Date().toISOString(), error: null
        });

        // File the movie into the slideshow's chosen library, if it named one. Best-effort:
        // a failure here (unusable mount, a name taken by someone's video) must NOT fail the
        // render — the movie is still ready and playable/downloadable in the editor. The
        // reason is stored so the editor can say why rather than just not saving.
        let savedToLibrary = false;
        try {
          const result = await saveMovieToLibrary(getSlideshow(slideshow.id)!, storageKey);
          savedToLibrary = result.saved;
          setSlideshowSaveError(slideshow.id, result.error);
          if (result.error) {
            log.warn(`slideshow render: movie encoded but not saved to the library: ${result.error}`);
          }
        } catch (saveErr) {
          const message = saveErr instanceof Error ? saveErr.message : String(saveErr);
          setSlideshowSaveError(slideshow.id, message);
          log.warn(`slideshow render: movie encoded but couldn't be saved to the library: ${message}`);
        }

        // Record a result on the job so the Tasks page history shows an outcome.
        writeResult(job.id, { bytes, savedToLibrary });
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?").run(job.id);
      } catch (err) {
        // Cancelled during the render: honour it — don't retry or overwrite the status
        // the cancel handler set.
        if (!jobIsRunning(job.id)) continue;
        const message = err instanceof Error ? err.message : "Render failed";
        const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number };
        if (attempts.attempts < attempts.max_attempts) {
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(new Date(Date.now() + 5000).toISOString(), message, job.id);
          setSlideshowRenderState(slideshow.id, { status: "queued", error: null });
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
          setSlideshowRenderState(slideshow.id, { status: "failed", error: message });
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

// The creator's accessible gallery libraries (the worker has no request context, so
// it rebuilds the user and reuses the normal scope resolver).
function resolveRendererLibraries(userId: string): string[] {
  const user = db.prepare("SELECT id, role FROM users WHERE id = ?").get(userId) as { id: string; role: string } | undefined;
  if (!user) return [];
  return resolveGalleryScopeLibraryIds(user);
}

export function startSlideshowRenderWorker(): () => void {
  const timer = setInterval(() => { void processSlideshowRenderQueue().catch(() => { /* logged per-job */ }); }, 2000);
  return () => clearInterval(timer);
}
