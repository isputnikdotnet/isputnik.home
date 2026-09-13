import { db } from "../../db.js";
import { libraryQueueState } from "../library/shared/scan-lock.js";
import type { JobRow, LibraryRow } from "../../db/rows.js";

// ── Tasks (background job queue) ────────────────────────────────────
// Read-only admin view over the shared `jobs` table (library scans, face scans),
// plus cancel. Each media type writes its own result/progress payload shape; the
// helpers below normalize them so the Tasks page renders one consistent grid.

interface TaskProgress {
  processed: number;
  total: number;
  unit: string; // what's being counted: "books", "photos", …
  etaSeconds: number | null; // projected time remaining, from the observed rate
}

function summarizeTaskResult(type: string, result: Record<string, any> | null): string | null {
  if (!result) return null;
  if (type === "SCAN_AUDIOBOOK_LIBRARY") {
    const errors = Array.isArray(result.bookErrors) ? result.bookErrors.length : 0;
    return `${result.discoveredBooks ?? 0} books, ${result.discoveredFiles ?? 0} files${errors > 0 ? ` · ${errors} skipped` : ""}`;
  }
  if (type === "SCAN_EBOOK_LIBRARY") return result.books != null ? `${result.books} book${result.books === 1 ? "" : "s"}` : null;
  if (type === "SCAN_GALLERY_LIBRARY") return result.assets != null ? `${result.assets} item${result.assets === 1 ? "" : "s"}` : null;
  if (type === "SCAN_GALLERY_FACES") {
    if (result.reclustered != null) {
      const swept = result.orphanCrops > 0 ? ` · removed ${result.orphanCrops} orphaned face crop${result.orphanCrops === 1 ? "" : "s"}` : "";
      return `Re-grouped faces into ${result.reclustered} groups${swept}`;
    }
    if (result.skipped) return "Face recognition disabled — skipped";
    const base = `${result.items ?? 0} photos, ${result.faces ?? 0} faces${result.failed ? ` · ${result.failed} failed` : ""}`;
    if (!(result.remaining > 0)) return base;
    return result.timeLimited
      ? `${base} · paused at the 3-hour limit, ${result.remaining} photos continue next run`
      : `${base} · ${result.remaining} more continue in the next batch`;
  }
  if (type === "gallery-slideshow-render") {
    if (result.bytes == null) return null;
    const mb = (result.bytes / (1024 * 1024)).toFixed(1);
    return `Movie ${mb} MB${result.savedToLibrary ? " · saved to library" : ""}`;
  }
  if (type === "TRANSCODE_GALLERY_VIDEO") {
    return result.bytes != null ? `Web copy ${(result.bytes / (1024 * 1024)).toFixed(1)} MB` : null;
  }
  if (type === "MOVE_STORAGE") {
    if (result.moved == null) return null;
    const failed = Array.isArray(result.failed) ? result.failed.length : 0;
    const base = `${result.moved} carried and verified`;
    if (result.cancelled) return `Stopped: ${base}, the rest left where it was`;
    return failed > 0 ? `${base} · ${failed} could not be moved` : base;
  }
  if (type === "BUILD_PLACES") {
    if (result.places == null) return null;
    return `${result.places} places · ${(Number(result.sizeBytes ?? 0) / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (type === "SCAN_GALLERY_DUPLICATES") {
    // Every pass belongs to a cleanup now, and what it FOUND is the cleanup's own
    // business — this line is about the pass itself: what it had to read off the disk.
    if (result.hashed == null) return null;
    const stale = result.stale > 0
      ? ` · ${result.stale} changed on disk, rescan the library`
      : "";
    return result.hashed === 0
      ? `Nothing new to read${stale}`
      : `${result.hashed} photo${result.hashed === 1 ? "" : "s"} read${stale}`;
  }
  return null;
}

// What a {processed, total} progress payload counts, per job type.
const PROGRESS_UNIT: Record<string, string> = {
  SCAN_GALLERY_FACES: "photos",
  SCAN_GALLERY_LIBRARY: "items",
  SCAN_EBOOK_LIBRARY: "books",
  "gallery-slideshow-render": "seconds",
  TRANSCODE_GALLERY_VIDEO: "seconds",
  SCAN_GALLERY_DUPLICATES: "files",
  MOVE_STORAGE: "items"
};

function normalizeTaskProgress(type: string, progress: Record<string, any> | null, startedAt: string | null): TaskProgress | null {
  if (!progress) return null;
  let counts: { processed: number; total: number; unit: string } | null = null;
  // Face/ebook/gallery scans: { processed, total } via the shared jobProgressWriter.
  if (typeof progress.processed === "number" && typeof progress.total === "number") {
    counts = { processed: progress.processed, total: progress.total, unit: PROGRESS_UNIT[type] ?? "items" };
  } else if (typeof progress.authorsProcessed === "number" && typeof progress.authorsTotal === "number") {
    // Audiobook scan: books phase, then an author-enrichment phase.
    counts = { processed: progress.authorsProcessed, total: progress.authorsTotal, unit: "authors" };
  } else if (typeof progress.booksProcessed === "number" && typeof progress.booksTotal === "number") {
    counts = { processed: progress.booksProcessed, total: progress.booksTotal, unit: "books" };
  }
  if (!counts) return null;

  // Prefer the writer's own ETA (recent-window rate — see jobProgressWriter): catalog
  // scans skip already-known items almost instantly, so a whole-run average wildly
  // underestimates what's left once the slow (new-item) phase starts.
  if ("etaSeconds" in progress) {
    return { ...counts, etaSeconds: typeof progress.etaSeconds === "number" ? progress.etaSeconds : null };
  }

  // Legacy payloads (audiobook scan): project from the whole-run average since the
  // work started — startedAt from the payload, else when the worker claimed the job.
  const start = typeof progress.startedAt === "string" ? progress.startedAt : startedAt;
  let etaSeconds: number | null = null;
  if (start && counts.processed > 0 && counts.total > counts.processed) {
    const elapsedSeconds = (Date.now() - new Date(start).getTime()) / 1000;
    if (elapsedSeconds > 0) {
      etaSeconds = Math.round((elapsedSeconds / counts.processed) * (counts.total - counts.processed));
    }
  }
  return { ...counts, etaSeconds };
}

// TASK_COLUMNS: a jobs row with its library LEFT JOINed (NULL when the job names none).
type TaskRow = Pick<
  JobRow,
  | "id" | "type" | "status" | "attempts" | "created_at" | "started_at" | "locked_at"
  | "completed_at" | "failed_at" | "error" | "payload"
> & { library_name: LibraryRow["name"] | null };

const TASK_COLUMNS = `
  jobs.id, jobs.type, jobs.status, jobs.attempts, jobs.created_at, jobs.started_at, jobs.locked_at,
  jobs.completed_at, jobs.failed_at, jobs.error, jobs.payload,
  libraries.name AS library_name
`;

// How long a running task may go without a sign of life before the page says it may
// be stuck. Every worker writes a progress heartbeat as it goes (jobProgressWriter),
// so silence for this long means the work is not moving — a hung read on a network
// share, a wedged ffmpeg — not that it is merely slow. Per type, because "no news"
// means different things: catalog scans tick every 1.5–3 seconds, while ffmpeg work
// reports once per video or clip and one long item can legitimately hold the process.
const STALE_AFTER_SECONDS: Record<string, number> = {
  SCAN_AUDIOBOOK_LIBRARY: 15 * 60,
  SCAN_EBOOK_LIBRARY: 15 * 60,
  SCAN_GALLERY_LIBRARY: 15 * 60,
  SCAN_GALLERY_FACES: 15 * 60,
  SCAN_GALLERY_DUPLICATES: 15 * 60,
  TRANSCODE_GALLERY_VIDEO: 60 * 60,
  "gallery-slideshow-render": 60 * 60,
  // One unit of a move can be a whole library bucket or a bin item of many files
  // copied across volumes; progress ticks per unit, not per file.
  MOVE_STORAGE: 60 * 60
};
const DEFAULT_STALE_AFTER_SECONDS = 30 * 60;

// A running task's last sign of life: its most recent progress write, else the moment
// the worker claimed it. A job that has not yet written progress is judged from its
// claim time, so one that hangs before its first tick is still caught.
function taskHeartbeat(row: TaskRow, progress: Record<string, any> | null): string | null {
  if (progress && typeof progress.updatedAt === "string") return progress.updatedAt;
  return row.started_at ?? row.locked_at ?? null;
}

function taskStalledSeconds(row: TaskRow, progress: Record<string, any> | null): number | null {
  if (row.status !== "running") return null;
  const heartbeat = taskHeartbeat(row, progress);
  if (!heartbeat) return null;
  const since = Math.floor((Date.now() - new Date(heartbeat).getTime()) / 1000);
  if (!Number.isFinite(since)) return null;
  return since > (STALE_AFTER_SECONDS[row.type] ?? DEFAULT_STALE_AFTER_SECONDS) ? since : null;
}

function taskView(row: TaskRow) {
  let payload: Record<string, any> = {};
  try { payload = JSON.parse(row.payload); } catch { /* ignore */ }
  const active = row.status === "running";
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    libraryName: row.library_name,
    createdAt: row.created_at,
    // When the job actually began running (null until claimed); the UI measures
    // duration from here so queue-wait time isn't counted as work time.
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    error: row.error,
    summary: summarizeTaskResult(row.type, payload.result ?? null),
    progress: active ? normalizeTaskProgress(row.type, payload.progress ?? null, row.started_at ?? row.locked_at ?? row.created_at) : null,
    // Seconds since this running task last showed a sign of life, but only once that
    // silence is long enough to be worth saying out loud; null means it looks healthy.
    stalledSeconds: taskStalledSeconds(row, payload.progress ?? null),
    // Position within a pre-queued batch group ("batch 2 of 5"); null for single jobs.
    batch: typeof payload.batch === "number" && typeof payload.batches === "number" && payload.batches > 1
      ? { index: payload.batch as number, total: payload.batches as number }
      : null,
    bookErrors: Array.isArray(payload.result?.bookErrors) ? (payload.result.bookErrors as string[]) : []
  };
}

// Most scheduled jobs only ENQUEUE the real work — a library scan, a face-scan
// batch — and return the moment the queue rows exist, so "the job returned" is not
// "the job is done". This reports which task rows an action created, which is what
// lets the admin page follow a manual run to completion and link to those tasks.
// Jobs that do their work inline (emptying the recycle bin) create none.
export function withNewTaskIds<T>(action: () => T): { result: T; taskIds: string[] } {
  const idsNow = () => new Set((db.prepare("SELECT id FROM jobs").all() as Pick<JobRow, "id">[]).map((row) => row.id));
  const before = idsNow();
  const result = action();
  return { result, taskIds: [...idsNow()].filter((id) => !before.has(id)) };
}

// How the finished history may be narrowed. Each facet is optional and they
// AND together; the in-flight rows above the history are never filtered, since
// "what is running right now" is the one answer the page must always give.
export interface TaskFilters {
  /** "failed" or "completed"; anything else means both. */
  status?: string;
  type?: string;
  libraryId?: string;
}

export function listTasks(page = 1, pageSize = 25, filters: TaskFilters = {}) {
  // Everything in flight (however old) is always returned; only the finished
  // history is paged. The paging metadata therefore describes the history grid.
  const activeRows = db.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM jobs
    LEFT JOIN libraries ON libraries.id = json_extract(jobs.payload, '$.libraryId')
    WHERE jobs.status IN ('pending', 'running')
    ORDER BY jobs.created_at ASC
  `).all() as TaskRow[];

  const conditions = ["jobs.status IN ('completed', 'failed')"];
  const params: Record<string, string> = {};
  if (filters.status === "failed" || filters.status === "completed") {
    conditions.push("jobs.status = @status");
    params.status = filters.status;
  }
  if (filters.type) {
    conditions.push("jobs.type = @type");
    params.type = filters.type;
  }
  if (filters.libraryId) {
    conditions.push("json_extract(jobs.payload, '$.libraryId') = @libraryId");
    params.libraryId = filters.libraryId;
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM jobs ${where}`).get(params) as { total: number };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const finishedRows = db.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM jobs
    LEFT JOIN libraries ON libraries.id = json_extract(jobs.payload, '$.libraryId')
    ${where}
    ORDER BY jobs.created_at DESC
    LIMIT @pageSize OFFSET @offset
  `).all({ ...params, pageSize, offset: (current - 1) * pageSize }) as TaskRow[];

  // What the filter controls can offer, across the whole history rather than the
  // page — and the glance numbers for the cards above the tables.
  const typeRows = db.prepare("SELECT DISTINCT type AS value FROM jobs ORDER BY value").all() as { value: JobRow["type"] }[];
  const libraryRows = db.prepare(`
    SELECT DISTINCT libraries.id, libraries.name
    FROM jobs JOIN libraries ON libraries.id = json_extract(jobs.payload, '$.libraryId')
    ORDER BY libraries.name
  `).all() as Pick<LibraryRow, "id" | "name">[];
  const failedWeek = (db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE status = 'failed' AND COALESCE(failed_at, created_at) > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
  `).get() as { n: number }).n;
  const lastFinished = db.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM jobs
    LEFT JOIN libraries ON libraries.id = json_extract(jobs.payload, '$.libraryId')
    WHERE jobs.status = 'completed'
    ORDER BY jobs.completed_at DESC
    LIMIT 1
  `).get() as TaskRow | undefined;

  // Library scans and face scans run strictly one at a time server-wide, so a queue
  // that isn't moving is usually correct rather than broken — but only if the page
  // says so. Name the job holding the lock and how many are behind it; without that
  // line, six queued scans and nothing starting reads as a dead worker.
  const lock = libraryQueueState();
  const lockHolder = lock.runningJobId ? activeRows.find((row) => row.id === lock.runningJobId) : undefined;

  return {
    jobs: [...activeRows, ...finishedRows].map(taskView),
    page: current,
    pageSize,
    total,
    totalPages,
    queue: {
      holder: lockHolder ? taskView(lockHolder) : null,
      waiting: lock.waiting
    },
    facets: { types: typeRows.map((row) => row.value), libraries: libraryRows },
    summary: {
      running: activeRows.filter((row) => row.status === "running").length,
      queued: activeRows.filter((row) => row.status === "pending").length,
      failedWeek,
      lastFinished: lastFinished ? taskView(lastFinished) : null
    }
  };
}
