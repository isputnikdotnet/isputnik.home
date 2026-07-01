import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { emptyTrash } from "../library/shared/trash.js";
import { enqueueFaceScan } from "../library/gallery/faces/queue.js";
import { enabledFaceLibraryIds } from "../library/gallery/faces/settings.js";

// Recurring maintenance tasks. The set of jobs is fixed and defined here; the
// scheduled_jobs table only stores per-key state (enabled, frequency, last/next run).
// Each job ships with a built-in default schedule (enabled + frequency + clock time);
// those defaults are seeded into the table on startup for any job the admin hasn't
// configured, and remain editable from the Scheduled jobs tab.
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
  time: string; // local clock time "HH:MM" the job runs at
}

const DEFINITIONS: ScheduledJobDef[] = [
  {
    key: "cleanup_job_logs",
    label: "Clean job logs",
    description: `Delete completed and failed job records beyond the most recent ${KEEP_JOB_LOGS}. Active jobs are never removed.`,
    defaultEnabled: true,
    defaultFrequency: "weekly",
    time: "00:30",
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
    time: "00:45",
    run: () => {
      const purged = emptyTrash();
      return `Emptied the recycle bin — purged ${purged} item${purged === 1 ? "" : "s"}.`;
    }
  },
  {
    key: "scan_new_faces",
    label: "Scan new photos for faces",
    description: "Detect and group faces in photos not yet scanned with the current recognition model, across every library with face recognition enabled. Already-processed photos are skipped, so this is cheap when nothing is new.",
    defaultEnabled: true,
    defaultFrequency: "daily",
    time: "01:00",
    run: () => {
      const ids = enabledFaceLibraryIds();
      if (ids.length === 0) return "No libraries have face recognition enabled — nothing to scan.";
      for (const id of ids) enqueueFaceScan(id, false);
      // The face-scan worker (2s poller) picks these up — no need to kick it here, which
      // keeps this module free of the ML/onnxruntime import chain.
      return `Queued a face scan for ${ids.length} librar${ids.length === 1 ? "y" : "ies"} — new or stale-model photos process in the background.`;
    }
  }
];

type Frequency = "daily" | "weekly" | "monthly";

// SQLite date modifiers used to compute the next run from "now".
const FREQUENCY_MODIFIER: Record<Frequency, string> = {
  daily: "+1 day",
  weekly: "+7 days",
  monthly: "+1 month"
};

interface ScheduledJobState {
  enabled: boolean;
  frequency: Frequency;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastMessage: string | null;
}

interface ScheduledJobRow {
  enabled: number;
  frequency: Frequency;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: "success" | "error" | null;
  last_message: string | null;
}

function defaultState(def?: ScheduledJobDef): ScheduledJobState {
  const enabled = def?.defaultEnabled ?? false;
  const frequency = def?.defaultFrequency ?? "weekly";
  return {
    enabled,
    frequency,
    nextRunAt: enabled && def ? computeNextRun(frequency, def.time) : null,
    lastRunAt: null,
    lastStatus: null,
    lastMessage: null
  };
}

function getState(key: string): ScheduledJobState {
  const row = db.prepare(
    "SELECT enabled, frequency, next_run_at, last_run_at, last_status, last_message FROM scheduled_jobs WHERE key = ?"
  ).get(key) as ScheduledJobRow | undefined;
  if (!row) return defaultState(DEFINITIONS.find((d) => d.key === key));
  return {
    enabled: Boolean(row.enabled),
    frequency: row.frequency,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastMessage: row.last_message
  };
}

// Next run at the job's local clock time (HH:MM): today at that time if it's still
// ahead, otherwise advanced by one frequency interval. Uses 'localtime' so "01:00" means
// the server's 1 AM (falls back to UTC when the container has no TZ set). Computed in
// SQLite so it matches the stored-timestamp format exactly.
function computeNextRun(frequency: Frequency, time: string): string {
  const todayAt = db.prepare(
    "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', datetime(date('now','localtime') || ' ' || ? || ':00', 'utc')) AS t"
  ).get(time) as { t: string };
  const now = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t").get() as { t: string };
  // ISO-8601 Z timestamps of identical format compare lexicographically == chronologically.
  if (todayAt.t > now.t) return todayAt.t;
  const advanced = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, ?) AS t").get(todayAt.t, FREQUENCY_MODIFIER[frequency]) as { t: string };
  return advanced.t;
}

function jobTime(key: string): string {
  return DEFINITIONS.find((d) => d.key === key)?.time ?? "00:00";
}

function saveConfig(key: string, enabled: boolean, frequency: Frequency) {
  const nextRun = enabled ? computeNextRun(frequency, jobTime(key)) : null;
  db.prepare(`
    INSERT INTO scheduled_jobs (key, enabled, frequency, next_run_at, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET
      enabled = excluded.enabled,
      frequency = excluded.frequency,
      next_run_at = excluded.next_run_at,
      updated_at = excluded.updated_at
  `).run(key, enabled ? 1 : 0, frequency, nextRun);
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
  const nextRun = before.enabled ? computeNextRun(before.frequency, def.time) : before.nextRunAt;
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
  time: string; // local clock time the job runs at, e.g. "01:00"
}

function view(def: ScheduledJobDef): ScheduledJobView {
  return { key: def.key, label: def.label, description: def.description, time: def.time, ...getState(def.key) };
}

// Seed a row for each job so the worker (which queries table rows directly) honours the
// built-in defaults. Existing rows — including any an admin has changed — are left
// untouched (ON CONFLICT DO NOTHING), so this only ever fills in never-configured jobs.
export function seedScheduledJobDefaults(): void {
  const insert = db.prepare(`
    INSERT INTO scheduled_jobs (key, enabled, frequency, next_run_at, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO NOTHING
  `);
  for (const def of DEFINITIONS) {
    const nextRun = def.defaultEnabled ? computeNextRun(def.defaultFrequency, def.time) : null;
    insert.run(def.key, def.defaultEnabled ? 1 : 0, def.defaultFrequency, nextRun);
  }
}

export function listScheduledJobs(): ScheduledJobView[] {
  return DEFINITIONS.map(view);
}

// Enable/disable a job and set its cadence. Returns null for an unknown key.
export function configureScheduledJob(
  key: string,
  enabled: boolean,
  frequency: Frequency,
  actorUserId: string | null,
  ipAddress: string | null = null
): ScheduledJobView | null {
  const def = DEFINITIONS.find((d) => d.key === key);
  if (!def) return null;
  saveConfig(key, enabled, frequency);
  logActivity({
    event: "maintenance.job_updated",
    actorUserId,
    targetType: "scheduled_job",
    targetId: key,
    detail: `"${def.label}" ${enabled ? `enabled (${frequency})` : "disabled"}.`,
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
const TICK_MS = 15 * 60 * 1000; // check for due jobs every 15 minutes

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

const configSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(["daily", "weekly", "monthly"])
});

export async function maintenancePlugin(app: FastifyInstance) {
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
    const job = configureScheduledJob(key, parsed.data.enabled, parsed.data.frequency, request.user!.id, request.ip);
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
