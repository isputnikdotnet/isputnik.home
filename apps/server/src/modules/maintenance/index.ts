import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, logActivity } from "../../db.js";
import { parseBody } from "../../core/shared.js";
import { emptyTrash } from "../library/shared/trash.js";

// Recurring maintenance tasks. The set of jobs is fixed and defined here; the
// scheduled_jobs table only stores per-key state (enabled, frequency, last/next
// run). Every job ships disabled — an admin opts in from the Scheduled jobs tab.
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
}

const DEFINITIONS: ScheduledJobDef[] = [
  {
    key: "cleanup_job_logs",
    label: "Clean job logs",
    description: `Delete completed and failed job records beyond the most recent ${KEEP_JOB_LOGS}. Active jobs are never removed.`,
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
    run: () => {
      const purged = emptyTrash();
      return `Emptied the recycle bin — purged ${purged} item${purged === 1 ? "" : "s"}.`;
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

function defaultState(): ScheduledJobState {
  return { enabled: false, frequency: "weekly", nextRunAt: null, lastRunAt: null, lastStatus: null, lastMessage: null };
}

function getState(key: string): ScheduledJobState {
  const row = db.prepare(
    "SELECT enabled, frequency, next_run_at, last_run_at, last_status, last_message FROM scheduled_jobs WHERE key = ?"
  ).get(key) as ScheduledJobRow | undefined;
  if (!row) return defaultState();
  return {
    enabled: Boolean(row.enabled),
    frequency: row.frequency,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastMessage: row.last_message
  };
}

// Compute an ISO timestamp `frequency` from now, using SQLite so it matches the
// column defaults exactly.
function computeNextRun(frequency: Frequency): string {
  const row = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) AS t").get(FREQUENCY_MODIFIER[frequency]) as { t: string };
  return row.t;
}

function saveConfig(key: string, enabled: boolean, frequency: Frequency) {
  const nextRun = enabled ? computeNextRun(frequency) : null;
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
  const nextRun = before.enabled ? computeNextRun(before.frequency) : before.nextRunAt;
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

  const stopWorker = startScheduledJobsWorker();
  app.addHook("onClose", async () => { stopWorker(); });
}
