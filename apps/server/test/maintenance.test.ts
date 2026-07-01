import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  listScheduledJobs,
  configureScheduledJob,
  runScheduledJob,
  processDueScheduledJobs,
  seedScheduledJobDefaults
} from "../src/modules/maintenance/index.js";

beforeEach(() => {
  db.prepare("DELETE FROM jobs").run();
  db.prepare("DELETE FROM scheduled_jobs").run();
  db.prepare("DELETE FROM trashed_items").run();
});

// Insert a finished (or active) job whose created_at is `secondsAgo` in the past, so
// ordering by created_at is deterministic.
function insertJob(id: string, status: "completed" | "failed" | "pending" | "running", secondsAgo: number) {
  db.prepare(
    "INSERT INTO jobs (id, type, payload, status, created_at) VALUES (?, 'TEST', '{}', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))"
  ).run(id, status, `-${secondsAgo} seconds`);
}

describe("scheduled jobs registry", () => {
  it("ships every job enabled by default with its clock-time schedule and a future next run", () => {
    const jobs = listScheduledJobs();
    expect(jobs.map((j) => j.key).sort()).toEqual(["cleanup_job_logs", "empty_recycle_bin", "scan_new_faces"]);

    const byKey = Object.fromEntries(jobs.map((j) => [j.key, j]));
    expect(byKey.scan_new_faces).toMatchObject({ enabled: true, frequency: "daily", time: "01:00" });
    expect(byKey.cleanup_job_logs).toMatchObject({ enabled: true, frequency: "weekly", time: "00:30" });
    expect(byKey.empty_recycle_bin).toMatchObject({ enabled: true, frequency: "weekly", time: "00:45" });

    for (const job of jobs) {
      expect(job.nextRunAt).not.toBeNull();
      expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
      expect(job.lastRunAt).toBeNull();
    }
  });

  it("returns null for an unknown key", () => {
    expect(configureScheduledJob("nope", true, "daily", null)).toBeNull();
    expect(runScheduledJob("nope", null)).toBeNull();
  });

  it("seeding writes default rows the worker can see, without overriding admin choices", () => {
    // Admin has already turned one job off; the others were never configured.
    configureScheduledJob("empty_recycle_bin", false, "weekly", null);
    seedScheduledJobDefaults();

    const rows = db.prepare("SELECT key, enabled FROM scheduled_jobs ORDER BY key").all() as { key: string; enabled: number }[];
    expect(rows.map((r) => r.key)).toEqual(["cleanup_job_logs", "empty_recycle_bin", "scan_new_faces"]);
    // Never-configured jobs seed enabled; the admin-disabled one is left off.
    expect(rows.find((r) => r.key === "scan_new_faces")!.enabled).toBe(1);
    expect(rows.find((r) => r.key === "cleanup_job_logs")!.enabled).toBe(1);
    expect(rows.find((r) => r.key === "empty_recycle_bin")!.enabled).toBe(0);
  });
});

describe("configuring a scheduled job", () => {
  it("enabling sets a future next run; disabling clears it", () => {
    const enabled = configureScheduledJob("cleanup_job_logs", true, "weekly", null);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.frequency).toBe("weekly");
    expect(enabled?.nextRunAt).not.toBeNull();
    expect(new Date(enabled!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

    const disabled = configureScheduledJob("cleanup_job_logs", false, "weekly", null);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.nextRunAt).toBeNull();
  });
});

describe("clean job logs", () => {
  it("keeps the newest 100 and deletes older terminal records, never active ones", () => {
    // 120 completed jobs, newest first (j0 is most recent).
    for (let i = 0; i < 120; i++) insertJob(`j${i}`, i % 2 === 0 ? "completed" : "failed", i + 10);
    // Two active jobs that are older than everything — must survive regardless.
    insertJob("run-old", "running", 5000);
    insertJob("pend-old", "pending", 6000);

    const result = runScheduledJob("cleanup_job_logs", null);
    expect(result?.lastStatus).toBe("success");

    const remaining = db.prepare("SELECT id, status FROM jobs").all() as { id: string; status: string }[];
    // 100 newest terminal + 2 active = 102 rows.
    expect(remaining).toHaveLength(102);
    expect(remaining.some((r) => r.id === "run-old")).toBe(true);
    expect(remaining.some((r) => r.id === "pend-old")).toBe(true);
    // The 20 oldest terminal jobs (j100..j119) are gone.
    expect(remaining.some((r) => r.id === "j119")).toBe(false);
    expect(remaining.some((r) => r.id === "j0")).toBe(true);
  });

  it("records the count in the run message", () => {
    for (let i = 0; i < 105; i++) insertJob(`c${i}`, "completed", i + 1);
    const result = runScheduledJob("cleanup_job_logs", null);
    expect(result?.lastMessage).toContain("Removed 5 old job records");
  });
});

describe("empty recycle bin", () => {
  it("purges every trashed item and reports the count", () => {
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO trashed_items (id, library_id, library_type, library_name, source_path, title, origin_path, trash_path) VALUES (?, 'lib', 'audiobook', 'Lib', ?, ?, ?, ?)"
      ).run(`t${i}`, `/nope/src${i}`, `Item ${i}`, `/nope/src${i}/item`, ".trash/tok");
    }
    const result = runScheduledJob("empty_recycle_bin", null);
    expect(result?.lastStatus).toBe("success");
    expect(result?.lastMessage).toContain("purged 3 items");
    expect((db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get() as { n: number }).n).toBe(0);
  });
});

describe("due-job worker", () => {
  it("runs an enabled job once due and rolls the next run forward", () => {
    configureScheduledJob("cleanup_job_logs", true, "weekly", null);
    // Force it due.
    db.prepare("UPDATE scheduled_jobs SET next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE key = 'cleanup_job_logs'").run();

    processDueScheduledJobs();

    const [job] = listScheduledJobs().filter((j) => j.key === "cleanup_job_logs");
    expect(job.lastRunAt).not.toBeNull();
    expect(job.lastStatus).toBe("success");
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves disabled jobs untouched", () => {
    configureScheduledJob("empty_recycle_bin", false, "weekly", null);
    processDueScheduledJobs();
    const [job] = listScheduledJobs().filter((j) => j.key === "empty_recycle_bin");
    expect(job.lastRunAt).toBeNull();
  });
});
