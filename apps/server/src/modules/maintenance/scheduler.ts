// When each scheduled job runs: its stored schedule, the next-run arithmetic, running
// one and recording the outcome, and the worker that fires whatever has come due.
import { db, logActivity } from "../../db.js";
import { definitions, type Frequency, type ScheduledJobCategory, type ScheduledJobDef } from "./jobs-catalog.js";
import type { ScheduledJobRow as DbScheduledJobRow } from "../../db/rows.js";

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

type ScheduledJobRow = Pick<
  DbScheduledJobRow,
  | "enabled" | "frequency" | "run_time" | "day_of_week" | "day_of_month"
  | "next_run_at" | "last_run_at" | "last_status" | "last_message"
>;

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
  const def = definitions().find((d) => d.key === key);
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
  category: ScheduledJobCategory;
}

function view(def: ScheduledJobDef): ScheduledJobView {
  return {
    key: def.key,
    label: def.label,
    description: def.description,
    category: def.category,
    ...getState(def.key)
  };
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
  for (const def of definitions()) {
    const time = def.randomizeDefaultTime ? randomNightTime() : null; // NULL = built-in default
    const schedule = { ...defaultSchedule(def), ...(time ? { time } : {}) };
    const nextRun = def.defaultEnabled ? computeNextRun(schedule) : null;
    insert.run(def.key, def.defaultEnabled ? 1 : 0, def.defaultFrequency, time, nextRun);
  }
}

// Grouped by what the job is about, then by name — the admin page lists them in
// this order, so the three library scans sit together instead of being scattered
// among the housekeeping jobs. Media types come before the system chores.
const CATEGORY_ORDER: ScheduledJobCategory[] = ["audiobooks", "ebooks", "gallery", "system"];

export function listScheduledJobs(): ScheduledJobView[] {
  return definitions().map(view).sort((a, b) =>
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
    || a.label.localeCompare(b.label));
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
  const def = definitions().find((d) => d.key === key);
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
  const def = definitions().find((d) => d.key === key);
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
    "SELECT key FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  ).all() as Pick<DbScheduledJobRow, "key">[];
  for (const { key } of due) {
    try { runScheduledJob(key, null, "scheduled"); } catch { /* recorded as error; retried next due window */ }
  }
}

export function startScheduledJobsWorker(): () => void {
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
