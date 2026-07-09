import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { emptyTrash } from "../library/shared/trash.js";
import { libraryJobRunning } from "../library/shared/scan-lock.js";
import { enqueueFaceScanBatches } from "../library/gallery/faces/queue.js";
import { enabledFaceLibraryIds } from "../library/gallery/faces/settings.js";
import { enqueueAudiobookScan } from "../library/audiobook/scanner.js";
import { enqueueEbookScan } from "../library/ebook/scanner.js";
import { enqueueGalleryScan } from "../library/gallery/scanner.js";
import { purgeMissingGalleryPhotos, getMissingRetentionDays } from "../library/gallery/cleanup.js";

// Recurring maintenance tasks. The set of jobs is fixed and defined here; the
// scheduled_jobs table only stores per-key state (enabled, schedule, last/next run).
// Each job ships with a built-in default schedule (enabled + frequency + clock time);
// those defaults are seeded into the table on startup for any job the admin hasn't
// configured. Frequency, day, and time all remain editable from the Scheduled jobs tab.
//
// A single lightweight worker ticks periodically and runs any enabled job whose
// next_run_at has passed. Jobs can also be triggered on demand ("Run now").

const KEEP_JOB_LOGS = 100;

interface ScheduledJobDef {
  key: string;
  label: string;
  description: string;
  // Runs the task and returns a human-readable summary. Throws on failure.
  run: () => string;
  // Built-in defaults, applied when the admin hasn't configured this job yet.
  defaultEnabled: boolean;
  defaultFrequency: Frequency;
  defaultTime: string; // local clock time "HH:MM" the job runs at
  // Seed with a random quiet-hours time instead of defaultTime, so same-cadence
  // jobs (nightly library scans) don't all fire at the same moment. defaultTime
  // remains the fallback for rows that somehow predate seeding.
  randomizeDefaultTime?: boolean;
}

// Queue a catalog scan for every library of one media type; each module's scan
// worker (2s poller) picks the jobs up. Libraries mid-scan are skipped rather
// than double-queued.
function enqueueLibraryScans(type: "audiobook" | "ebook" | "gallery", noun: string, enqueue: (libraryId: string) => unknown): string {
  // Skip this run if a library or face task is already running — the heavy jobs run
  // strictly one at a time, and stacking another night's scans on top of an
  // unfinished one just backs up the queue. It runs again at the next scheduled time.
  if (libraryJobRunning()) return `Skipped — a library or face task is already running; will retry at the next scheduled time.`;
  const libraries = db.prepare("SELECT id, scan_status FROM libraries WHERE type = ?").all(type) as { id: string; scan_status: string }[];
  if (libraries.length === 0) return `No ${noun} libraries exist — nothing to scan.`;
  const idle = libraries.filter((library) => library.scan_status !== "scanning");
  for (const library of idle) enqueue(library.id);
  const skipped = libraries.length - idle.length;
  return `Queued a scan for ${idle.length} librar${idle.length === 1 ? "y" : "ies"}` +
    `${skipped > 0 ? ` (${skipped} already scanning)` : ""} — new and changed files are cataloged in the background.`;
}

const DEFINITIONS: ScheduledJobDef[] = [
  {
    key: "scan_audiobook_libraries",
    label: "Scan audiobook libraries",
    description: "Look for new, changed, or removed audiobook files in every audiobook library and update the catalog.",
    defaultEnabled: true,
    defaultFrequency: "daily",
    defaultTime: "02:00",
    randomizeDefaultTime: true,
    run: () => enqueueLibraryScans("audiobook", "audiobook", enqueueAudiobookScan)
  },
  {
    key: "scan_ebook_libraries",
    label: "Scan ebook libraries",
    description: "Look for new, changed, or removed book files in every ebook library and update the catalog.",
    defaultEnabled: true,
    defaultFrequency: "daily",
    defaultTime: "02:30",
    randomizeDefaultTime: true,
    run: () => enqueueLibraryScans("ebook", "ebook", enqueueEbookScan)
  },
  {
    key: "scan_gallery_libraries",
    label: "Scan photo & video libraries",
    description: "Look for new, changed, or removed photos and videos in every gallery library and update the catalog.",
    defaultEnabled: true,
    defaultFrequency: "daily",
    defaultTime: "03:00",
    randomizeDefaultTime: true,
    run: () => enqueueLibraryScans("gallery", "photo & video", enqueueGalleryScan)
  },
  {
    key: "purge_missing_gallery",
    label: "Purge missing photos",
    description: "Permanently remove photos that have been missing from disk beyond the grace window (default 30 days) — their catalog record, cached thumbnail, and detected faces. Photos still on disk are never touched; the window guards against a temporarily-offline drive.",
    defaultEnabled: true,
    defaultFrequency: "weekly",
    defaultTime: "01:15",
    run: () => {
      const days = getMissingRetentionDays();
      if (days <= 0) return "Auto-purge is disabled (grace window set to 0) — nothing removed.";
      const { purged, eligible } = purgeMissingGalleryPhotos();
      if (eligible === 0) return `No photos have been missing longer than ${days} days — nothing to purge.`;
      return `Purged ${purged} of ${eligible} photo${eligible === 1 ? "" : "s"} missing longer than ${days} days.`;
    }
  },
  {
    key: "cleanup_job_logs",
    label: "Clean task history",
    description: `Delete completed and failed tasks beyond the most recent ${KEEP_JOB_LOGS}. Running and queued tasks are never removed.`,
    defaultEnabled: true,
    defaultFrequency: "weekly",
    defaultTime: "00:30",
    run: () => {
      const result = db.prepare(`
        DELETE FROM jobs
        WHERE status IN ('completed', 'failed')
          AND id NOT IN (
            SELECT id FROM jobs ORDER BY datetime(created_at) DESC LIMIT ?
          )
      `).run(KEEP_JOB_LOGS);
      return `Removed ${result.changes} old job record${result.changes === 1 ? "" : "s"} (kept the newest ${KEEP_JOB_LOGS}).`;
    }
  },
  {
    key: "empty_recycle_bin",
    label: "Empty recycle bin",
    description: "Permanently delete every item currently in the recycle bin, regardless of its retention window.",
    defaultEnabled: true,
    defaultFrequency: "weekly",
    defaultTime: "00:45",
    run: () => {
      const purged = emptyTrash();
      return `Emptied the recycle bin — purged ${purged} item${purged === 1 ? "" : "s"}.`;
    }
  },
  {
    key: "scan_new_faces",
    label: "Scan new photos for faces",
    description: "Detect and group faces in photos not yet scanned with the current recognition model, across every library with face recognition enabled. Already-processed photos are skipped, and a run pauses after 3 hours — the rest continues the next night.",
    defaultEnabled: true,
    defaultFrequency: "daily",
    // After the nightly library scans (randomized 01:00–04:59), so tonight's new
    // photos are already cataloged and get their faces the same night.
    defaultTime: "05:00",
    run: () => {
      // Skip if a library or face task is already running (see enqueueLibraryScans) —
      // don't stack another backlog behind an in-progress scan.
      if (libraryJobRunning()) return "Skipped — a library or face task is already running; will retry at the next scheduled time.";
      const ids = enabledFaceLibraryIds();
      if (ids.length === 0) return "No libraries have face recognition enabled — nothing to scan.";
      // Pre-queued as numbered batch jobs so the Tasks page shows the whole backlog.
      // The face-scan worker (2s poller) picks these up — no need to kick it here, which
      // keeps this module free of the ML/onnxruntime import chain.
      const batches = ids.reduce((sum, id) => sum + enqueueFaceScanBatches(id).length, 0);
      return `Queued ${batches} face-scan batch${batches === 1 ? "" : "es"} across ${ids.length} librar${ids.length === 1 ? "y" : "ies"} — new or stale-model photos process in the background.`;
    }
  }
];

type Frequency = "daily" | "weekly" | "monthly";

// When a weekly/monthly job has no admin-chosen day yet: Sunday / the 1st.
const DEFAULT_DAY_OF_WEEK = 0;
const DEFAULT_DAY_OF_MONTH = 1;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The full "when does this run" picture: cadence, anchor day, and local clock time.
// dayOfWeek only applies to weekly jobs (0=Sunday..6=Saturday); dayOfMonth only to
// monthly jobs (1..28, capped so every month has the day).
export interface JobSchedule {
  frequency: Frequency;
  time: string; // local clock time "HH:MM"
  dayOfWeek: number;
  dayOfMonth: number;
}

export function describeSchedule(schedule: JobSchedule): string {
  if (schedule.frequency === "daily") return `daily at ${schedule.time}`;
  if (schedule.frequency === "weekly") return `weekly on ${WEEKDAYS[schedule.dayOfWeek]} at ${schedule.time}`;
  return `monthly on day ${schedule.dayOfMonth} at ${schedule.time}`;
}

interface ScheduledJobState extends JobSchedule {
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastMessage: string | null;
}

interface ScheduledJobRow {
  enabled: number;
  frequency: Frequency;
  run_time: string | null;
  day_of_week: number | null;
  day_of_month: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: "success" | "error" | null;
  last_message: string | null;
}

function defaultSchedule(def?: ScheduledJobDef): JobSchedule {
  return {
    frequency: def?.defaultFrequency ?? "weekly",
    time: def?.defaultTime ?? "00:00",
    dayOfWeek: DEFAULT_DAY_OF_WEEK,
    dayOfMonth: DEFAULT_DAY_OF_MONTH
  };
}

function defaultState(def?: ScheduledJobDef): ScheduledJobState {
  const enabled = def?.defaultEnabled ?? false;
  const schedule = defaultSchedule(def);
  return {
    enabled,
    ...schedule,
    nextRunAt: enabled && def ? computeNextRun(schedule) : null,
    lastRunAt: null,
    lastStatus: null,
    lastMessage: null
  };
}

function getState(key: string): ScheduledJobState {
  const def = DEFINITIONS.find((d) => d.key === key);
  const row = db.prepare(
    "SELECT enabled, frequency, run_time, day_of_week, day_of_month, next_run_at, last_run_at, last_status, last_message FROM scheduled_jobs WHERE key = ?"
  ).get(key) as ScheduledJobRow | undefined;
  if (!row) return defaultState(def);
  const fallback = defaultSchedule(def);
  return {
    enabled: Boolean(row.enabled),
    frequency: row.frequency,
    time: row.run_time ?? fallback.time,
    dayOfWeek: row.day_of_week ?? fallback.dayOfWeek,
    dayOfMonth: row.day_of_month ?? fallback.dayOfMonth,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastMessage: row.last_message
  };
}

// Next occurrence of the schedule: the nearest anchor day at the job's local clock
// time if that is still ahead, otherwise the following occurrence (tomorrow / next
// <weekday> / next month's day N). Uses 'localtime' so "01:00" means the server's
// 1 AM (falls back to UTC when the container has no TZ set). Computed in SQLite so
// it matches the stored-timestamp format exactly.
function computeNextRun(schedule: JobSchedule): string {
  const { frequency, time, dayOfWeek, dayOfMonth } = schedule;
  const localDate = (sql: string, ...params: unknown[]): string =>
    (db.prepare(`SELECT ${sql} AS d`).get(...params) as { d: string }).d;

  let first: string; // local date of the nearest possible occurrence (may be today, may be past)
  let next: string;  // local date of the occurrence after it
  if (frequency === "daily") {
    first = localDate("date('now','localtime')");
    next = localDate("date('now','localtime','+1 day')");
  } else if (frequency === "weekly") {
    // 'weekday N' advances to the next such weekday, staying put when already on it.
    first = localDate("date('now','localtime','weekday ' || ?)", dayOfWeek);
    next = localDate("date('now','localtime','+1 day','weekday ' || ?)", dayOfWeek);
  } else {
    const day = String(dayOfMonth).padStart(2, "0");
    first = localDate("date(strftime('%Y-%m','now','localtime') || '-' || ?)", day);
    next = localDate("date(strftime('%Y-%m','now','localtime') || '-' || ?, '+1 month')", day);
  }

  const utcAt = (date: string): string =>
    (db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', datetime(? || ' ' || ? || ':00', 'utc')) AS t").get(date, time) as { t: string }).t;
  const now = (db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t").get() as { t: string }).t;
  // ISO-8601 Z timestamps of identical format compare lexicographically == chronologically.
  const candidate = utcAt(first);
  return candidate > now ? candidate : utcAt(next);
}

function saveConfig(key: string, enabled: boolean, schedule: JobSchedule) {
  const nextRun = enabled ? computeNextRun(schedule) : null;
  db.prepare(`
    INSERT INTO scheduled_jobs (key, enabled, frequency, run_time, day_of_week, day_of_month, next_run_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET
      enabled = excluded.enabled,
      frequency = excluded.frequency,
      run_time = excluded.run_time,
      day_of_week = excluded.day_of_week,
      day_of_month = excluded.day_of_month,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at
  `).run(key, enabled ? 1 : 0, schedule.frequency, schedule.time, schedule.dayOfWeek, schedule.dayOfMonth, nextRun);
}

// Run one job now and record the outcome. When the job is enabled its next run is
// rolled forward; a disabled job (manual "Run now") keeps its null next run.
function runJob(def: ScheduledJobDef, trigger: "scheduled" | "manual", actorUserId: string | null): ScheduledJobState {
  const before = getState(def.key);
  let status: "success" | "error";
  let message: string;
  try {
    message = def.run();
    status = "success";
  } catch (err) {
    message = err instanceof Error ? err.message : "Job failed";
    status = "error";
  }
  const nextRun = before.enabled ? computeNextRun(before) : before.nextRunAt;
  db.prepare(`
    INSERT INTO scheduled_jobs (key, enabled, frequency, next_run_at, last_run_at, last_status, last_message, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET
      next_run_at = excluded.next_run_at,
      last_run_at = excluded.last_run_at,
      last_status = excluded.last_status,
      last_message = excluded.last_message,
      updated_at = excluded.updated_at
  `).run(def.key, before.enabled ? 1 : 0, before.frequency, nextRun, status, message);

  logActivity({
    event: status === "success" ? "maintenance.job_ran" : "maintenance.job_failed",
    actorUserId,
    targetType: "scheduled_job",
    targetId: def.key,
    detail: `${trigger === "scheduled" ? "Scheduled" : "Manual"} "${def.label}": ${message}`,
    ipAddress: null
  });
  return getState(def.key);
}

// ── Public surface ──────────────────────────────────────────────────

export interface ScheduledJobView extends ScheduledJobState {
  key: string;
  label: string;
  description: string;
}

function view(def: ScheduledJobDef): ScheduledJobView {
  return { key: def.key, label: def.label, description: def.description, ...getState(def.key) };
}

// A random minute inside the quiet-hours window 01:00–04:59. Chosen once, when a
// randomizeDefaultTime job is first seeded, then persisted like an admin choice.
function randomNightTime(): string {
  const minutes = 60 + Math.floor(Math.random() * 240);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// Seed a row for each job so the worker (which queries table rows directly) honours the
// built-in defaults. Existing rows — including any an admin has changed — are left
// untouched (ON CONFLICT DO NOTHING), so this only ever fills in never-configured jobs.
export function seedScheduledJobDefaults(): void {
  const insert = db.prepare(`
    INSERT INTO scheduled_jobs (key, enabled, frequency, run_time, next_run_at, updated_at)
    VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO NOTHING
  `);
  for (const def of DEFINITIONS) {
    const time = def.randomizeDefaultTime ? randomNightTime() : null; // NULL = built-in default
    const schedule = { ...defaultSchedule(def), ...(time ? { time } : {}) };
    const nextRun = def.defaultEnabled ? computeNextRun(schedule) : null;
    insert.run(def.key, def.defaultEnabled ? 1 : 0, def.defaultFrequency, time, nextRun);
  }
}

export function listScheduledJobs(): ScheduledJobView[] {
  return DEFINITIONS.map(view);
}

// Enable/disable a job and set its schedule. Fields left out of `schedule` keep
// their current (or default) value. Returns null for an unknown key.
export function configureScheduledJob(
  key: string,
  enabled: boolean,
  schedule: Partial<JobSchedule> & { frequency: Frequency },
  actorUserId: string | null,
  ipAddress: string | null = null
): ScheduledJobView | null {
  const def = DEFINITIONS.find((d) => d.key === key);
  if (!def) return null;
  const current = getState(key);
  const next: JobSchedule = {
    frequency: schedule.frequency,
    time: schedule.time ?? current.time,
    dayOfWeek: schedule.dayOfWeek ?? current.dayOfWeek,
    dayOfMonth: schedule.dayOfMonth ?? current.dayOfMonth
  };
  saveConfig(key, enabled, next);
  logActivity({
    event: "maintenance.job_updated",
    actorUserId,
    targetType: "scheduled_job",
    targetId: key,
    detail: `"${def.label}" ${enabled ? `enabled (${describeSchedule(next)})` : "disabled"}.`,
    ipAddress
  });
  return view(def);
}

// Run a job immediately. Returns null for an unknown key.
export function runScheduledJob(key: string, actorUserId: string | null, trigger: "scheduled" | "manual" = "manual"): ScheduledJobView | null {
  const def = DEFINITIONS.find((d) => d.key === key);
  if (!def) return null;
  runJob(def, trigger, actorUserId);
  return view(def);
}

// ── Worker ──────────────────────────────────────────────────────────
// Poll every 5 minutes so a job fires within ~5 min of its scheduled clock time (the
// query is a cheap indexed lookup). A one-off kickoff shortly after boot catches jobs
// that came due while the server was down.
const TICK_MS = 5 * 60 * 1000;

export function processDueScheduledJobs() {
  const due = db.prepare(
    "SELECT key FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND datetime(next_run_at) <= datetime('now')"
  ).all() as { key: string }[];
  for (const { key } of due) {
    try { runScheduledJob(key, null, "scheduled"); } catch { /* recorded as error; retried next due window */ }
  }
}

function startScheduledJobsWorker(): () => void {
  const timer = setInterval(() => {
    try { processDueScheduledJobs(); } catch { /* swallow; retried next tick */ }
  }, TICK_MS);
  timer.unref?.();
  const kickoff = setTimeout(() => {
    try { processDueScheduledJobs(); } catch { /* ignore */ }
  }, 60 * 1000);
  kickoff.unref?.();
  return () => { clearInterval(timer); clearTimeout(kickoff); };
}

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
  return null;
}

// What a {processed, total} progress payload counts, per job type.
const PROGRESS_UNIT: Record<string, string> = {
  SCAN_GALLERY_FACES: "photos",
  SCAN_GALLERY_LIBRARY: "items",
  SCAN_EBOOK_LIBRARY: "books"
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

interface TaskRow {
  id: string;
  type: string;
  status: string;
  attempts: number;
  created_at: string;
  started_at: string | null;
  locked_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error: string | null;
  payload: string;
  library_name: string | null;
}

const TASK_COLUMNS = `
  jobs.id, jobs.type, jobs.status, jobs.attempts, jobs.created_at, jobs.started_at, jobs.locked_at,
  jobs.completed_at, jobs.failed_at, jobs.error, jobs.payload,
  libraries.name AS library_name
`;

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
    // Position within a pre-queued batch group ("batch 2 of 5"); null for single jobs.
    batch: typeof payload.batch === "number" && typeof payload.batches === "number" && payload.batches > 1
      ? { index: payload.batch as number, total: payload.batches as number }
      : null,
    bookErrors: Array.isArray(payload.result?.bookErrors) ? (payload.result.bookErrors as string[]) : []
  };
}

export function listTasks(page = 1, pageSize = 25) {
  // Everything in flight (however old) is always returned; only the finished
  // history is paged. The paging metadata therefore describes the history grid.
  const activeRows = db.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM jobs
    LEFT JOIN libraries ON libraries.id = json_extract(jobs.payload, '$.libraryId')
    WHERE jobs.status IN ('pending', 'running')
    ORDER BY datetime(jobs.created_at) ASC
  `).all() as TaskRow[];

  const { total } = db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE status IN ('completed', 'failed')").get() as { total: number };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const finishedRows = db.prepare(`
    SELECT ${TASK_COLUMNS}
    FROM jobs
    LEFT JOIN libraries ON libraries.id = json_extract(jobs.payload, '$.libraryId')
    WHERE jobs.status IN ('completed', 'failed')
    ORDER BY datetime(jobs.created_at) DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, (current - 1) * pageSize) as TaskRow[];

  return {
    jobs: [...activeRows, ...finishedRows].map(taskView),
    page: current,
    pageSize,
    total,
    totalPages
  };
}

const configSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional()
});

export async function maintenancePlugin(app: FastifyInstance) {
  app.get("/api/jobs", { preHandler: app.requireAdmin }, async (request) => {
    const query = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? "25", 10) || 25));
    return listTasks(page, pageSize);
  });

  app.post("/api/jobs/:id/cancel", { preHandler: app.requireAdmin }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const job = db.prepare("SELECT id, status, payload FROM jobs WHERE id = ?").get(id) as { id: string; status: string; payload: string } | undefined;
    if (!job) {
      reply.code(404).send({ error: "Task not found" });
      return;
    }
    if (job.status !== "pending" && job.status !== "running") {
      reply.code(409).send({ error: "Task is not active" });
      return;
    }
    db.prepare(`
      UPDATE jobs
      SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = 'Cancelled by user'
      WHERE id = ?
    `).run(id);
    try {
      const p = JSON.parse(job.payload) as { libraryId?: string };
      if (p.libraryId) {
        db.prepare("UPDATE libraries SET scan_status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND scan_status = 'scanning'")
          .run(p.libraryId);
      }
    } catch { /* ignore */ }
    reply.send({ cancelled: true });
  });

  app.get("/api/scheduled-jobs", { preHandler: app.requireAdmin }, async () => {
    return { jobs: listScheduledJobs() };
  });

  app.patch("/api/scheduled-jobs/:key", { preHandler: app.requireAdmin }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const parsed = parseBody(configSchema, request.body);
    if (parsed.error) {
      reply.code(400).send({ error: "Invalid scheduled job settings", details: parsed.error });
      return;
    }
    const { enabled, ...schedule } = parsed.data;
    const job = configureScheduledJob(key, enabled, schedule, request.user!.id, request.ip);
    if (!job) {
      reply.code(404).send({ error: "Unknown scheduled job" });
      return;
    }
    reply.send({ job });
  });

  app.post("/api/scheduled-jobs/:key/run", { preHandler: app.requireAdmin }, async (request, reply) => {
    const key = (request.params as { key: string }).key;
    const job = runScheduledJob(key, request.user!.id, "manual");
    if (!job) {
      reply.code(404).send({ error: "Unknown scheduled job" });
      return;
    }
    if (job.lastStatus === "error") {
      reply.code(500).send({ error: job.lastMessage ?? "Job failed", job });
      return;
    }
    reply.send({ job });
  });

  seedScheduledJobDefaults();
  const stopWorker = startScheduledJobsWorker();
  app.addHook("onClose", async () => { stopWorker(); });
}
