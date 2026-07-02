import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  listScheduledJobs,
  configureScheduledJob,
  runScheduledJob,
  processDueScheduledJobs,
  seedScheduledJobDefaults,
  listTasks
} from "../src/modules/maintenance/index.js";
import { makeUser, makeLibrary } from "./helpers/seed.js";

beforeEach(() => {
  db.prepare("DELETE FROM jobs").run();
  db.prepare("DELETE FROM scheduled_jobs").run();
  db.prepare("DELETE FROM trashed_items").run();
  db.prepare("DELETE FROM libraries").run();
  db.prepare("DELETE FROM users").run();
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
    expect(jobs.map((j) => j.key).sort()).toEqual([
      "cleanup_job_logs",
      "empty_recycle_bin",
      "scan_audiobook_libraries",
      "scan_ebook_libraries",
      "scan_gallery_libraries",
      "scan_new_faces"
    ]);

    const byKey = Object.fromEntries(jobs.map((j) => [j.key, j]));
    // Face scan runs LAST, after the randomized 01:00–04:59 library-scan window.
    expect(byKey.scan_new_faces).toMatchObject({ enabled: true, frequency: "daily", time: "05:00" });
    expect(byKey.cleanup_job_logs).toMatchObject({ enabled: true, frequency: "weekly", time: "00:30" });
    expect(byKey.empty_recycle_bin).toMatchObject({ enabled: true, frequency: "weekly", time: "00:45" });
    expect(byKey.scan_audiobook_libraries).toMatchObject({ enabled: true, frequency: "daily" });
    expect(byKey.scan_ebook_libraries).toMatchObject({ enabled: true, frequency: "daily" });
    expect(byKey.scan_gallery_libraries).toMatchObject({ enabled: true, frequency: "daily" });

    for (const job of jobs) {
      expect(job.nextRunAt).not.toBeNull();
      expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
      expect(job.lastRunAt).toBeNull();
    }
  });

  it("returns null for an unknown key", () => {
    expect(configureScheduledJob("nope", true, { frequency: "daily" }, null)).toBeNull();
    expect(runScheduledJob("nope", null)).toBeNull();
  });

  it("seeding writes default rows the worker can see, without overriding admin choices", () => {
    // Admin has already turned one job off; the others were never configured.
    configureScheduledJob("empty_recycle_bin", false, { frequency: "weekly" }, null);
    seedScheduledJobDefaults();

    const rows = db.prepare("SELECT key, enabled FROM scheduled_jobs ORDER BY key").all() as { key: string; enabled: number }[];
    expect(rows.map((r) => r.key)).toEqual([
      "cleanup_job_logs",
      "empty_recycle_bin",
      "scan_audiobook_libraries",
      "scan_ebook_libraries",
      "scan_gallery_libraries",
      "scan_new_faces"
    ]);
    // Never-configured jobs seed enabled; the admin-disabled one is left off.
    expect(rows.find((r) => r.key === "scan_new_faces")!.enabled).toBe(1);
    expect(rows.find((r) => r.key === "cleanup_job_logs")!.enabled).toBe(1);
    expect(rows.find((r) => r.key === "empty_recycle_bin")!.enabled).toBe(0);
  });

  it("seeding gives nightly library scans a persisted random quiet-hours time", () => {
    seedScheduledJobDefaults();

    const scanKeys = ["scan_audiobook_libraries", "scan_ebook_libraries", "scan_gallery_libraries"];
    const byKey = Object.fromEntries(listScheduledJobs().map((j) => [j.key, j]));
    for (const key of scanKeys) {
      const stored = db.prepare("SELECT run_time FROM scheduled_jobs WHERE key = ?").get(key) as { run_time: string | null };
      // Inside the 01:00–04:59 window, and the view reflects the stored choice.
      expect(stored.run_time).toMatch(/^0[1-4]:[0-5]\d$/);
      expect(byKey[key].time).toBe(stored.run_time);
    }
    // Fixed-time jobs keep NULL (= built-in default).
    const fixed = db.prepare("SELECT run_time FROM scheduled_jobs WHERE key = 'cleanup_job_logs'").get() as { run_time: string | null };
    expect(fixed.run_time).toBeNull();
  });
});

describe("configuring a scheduled job", () => {
  it("enabling sets a future next run; disabling clears it", () => {
    const enabled = configureScheduledJob("cleanup_job_logs", true, { frequency: "weekly" }, null);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.frequency).toBe("weekly");
    expect(enabled?.nextRunAt).not.toBeNull();
    expect(new Date(enabled!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

    const disabled = configureScheduledJob("cleanup_job_logs", false, { frequency: "weekly" }, null);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.nextRunAt).toBeNull();
  });

  it("stores a chosen day and time, and omitted fields keep their current value", () => {
    const job = configureScheduledJob(
      "cleanup_job_logs",
      true,
      { frequency: "weekly", dayOfWeek: 3, time: "06:15" },
      null
    );
    expect(job).toMatchObject({ frequency: "weekly", dayOfWeek: 3, time: "06:15" });

    // A later save without time/day keeps the admin's choices.
    const again = configureScheduledJob("cleanup_job_logs", true, { frequency: "weekly" }, null);
    expect(again).toMatchObject({ dayOfWeek: 3, time: "06:15" });
  });

  it("a weekly job's next run lands on the chosen weekday at the chosen time", () => {
    const job = configureScheduledJob(
      "cleanup_job_logs",
      true,
      { frequency: "weekly", dayOfWeek: 2, time: "04:30" },
      null
    );
    const next = new Date(job!.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getDay()).toBe(2);
    expect(next.getHours()).toBe(4);
    expect(next.getMinutes()).toBe(30);
    // Within the next 7 days — the nearest Tuesday, not an arbitrary later one.
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
  });

  it("a monthly job's next run lands on the chosen day of month", () => {
    const job = configureScheduledJob(
      "empty_recycle_bin",
      true,
      { frequency: "monthly", dayOfMonth: 15, time: "02:00" },
      null
    );
    const next = new Date(job!.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(2);
  });

  it("a daily job's next run is within 24 hours at the chosen time", () => {
    const job = configureScheduledJob(
      "scan_new_faces",
      true,
      { frequency: "daily", time: "23:59" },
      null
    );
    const next = new Date(job!.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(next.getHours()).toBe(23);
    expect(next.getMinutes()).toBe(59);
  });
});

describe("clean task history", () => {
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

describe("nightly library scans", () => {
  it("reports nothing to scan when no libraries of the type exist", () => {
    const result = runScheduledJob("scan_audiobook_libraries", null);
    expect(result?.lastStatus).toBe("success");
    expect(result?.lastMessage).toContain("No audiobook libraries exist");
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(0);
  });

  it("queues a scan for every idle library of its type, skipping ones mid-scan", () => {
    makeUser("admin", "admin");
    makeLibrary("ab1", { createdBy: "admin", type: "audiobook" });
    makeLibrary("ab2", { createdBy: "admin", type: "audiobook" });
    makeLibrary("eb1", { createdBy: "admin", type: "ebook" });
    db.prepare("UPDATE libraries SET scan_status = 'scanning' WHERE id = 'ab2'").run();

    const result = runScheduledJob("scan_audiobook_libraries", null);
    expect(result?.lastStatus).toBe("success");
    expect(result?.lastMessage).toContain("Queued a scan for 1 library");
    expect(result?.lastMessage).toContain("1 already scanning");

    // Only the idle audiobook library got a queue entry; the ebook one is untouched.
    const queued = db.prepare("SELECT type, payload FROM jobs").all() as { type: string; payload: string }[];
    expect(queued).toHaveLength(1);
    expect(queued[0].type).toBe("SCAN_AUDIOBOOK_LIBRARY");
    expect(JSON.parse(queued[0].payload).libraryId).toBe("ab1");
  });

  it("each media type's job queues its own scanner's jobs", () => {
    makeUser("admin", "admin");
    makeLibrary("eb", { createdBy: "admin", type: "ebook" });
    makeLibrary("ph", { createdBy: "admin", type: "gallery" });

    expect(runScheduledJob("scan_ebook_libraries", null)?.lastStatus).toBe("success");
    expect(runScheduledJob("scan_gallery_libraries", null)?.lastStatus).toBe("success");

    const types = (db.prepare("SELECT type FROM jobs ORDER BY type").all() as { type: string }[]).map((r) => r.type);
    expect(types).toEqual(["SCAN_EBOOK_LIBRARY", "SCAN_GALLERY_LIBRARY"]);
  });
});

describe("tasks view", () => {
  function insertTask(id: string, type: string, status: string, payload: object, secondsAgo: number) {
    db.prepare(
      "INSERT INTO jobs (id, type, payload, status, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', ?))"
    ).run(id, type, JSON.stringify(payload), status, `-${secondsAgo} seconds`);
  }

  it("lists active tasks first (oldest first), then finished ones newest first", () => {
    insertTask("done-old", "SCAN_EBOOK_LIBRARY", "completed", { result: { books: 3 } }, 300);
    insertTask("done-new", "SCAN_EBOOK_LIBRARY", "completed", { result: { books: 7 } }, 100);
    insertTask("run-1", "SCAN_AUDIOBOOK_LIBRARY", "running", {}, 200);
    insertTask("pend-1", "SCAN_GALLERY_FACES", "pending", {}, 50);

    const ids = listTasks().jobs.map((t) => t.id);
    expect(ids).toEqual(["run-1", "pend-1", "done-new", "done-old"]);
  });

  it("pages the finished history while always returning every active task", () => {
    for (let i = 0; i < 5; i++) insertTask(`done-${i}`, "SCAN_EBOOK_LIBRARY", "completed", {}, 100 + i);
    insertTask("run-1", "SCAN_AUDIOBOOK_LIBRARY", "running", {}, 500);

    const first = listTasks(1, 2);
    expect(first).toMatchObject({ page: 1, pageSize: 2, total: 5, totalPages: 3 });
    expect(first.jobs.map((t) => t.id)).toEqual(["run-1", "done-0", "done-1"]);

    const last = listTasks(3, 2);
    expect(last.jobs.map((t) => t.id)).toEqual(["run-1", "done-4"]);

    // Out-of-range pages clamp instead of returning nothing.
    expect(listTasks(99, 2).page).toBe(3);
  });

  it("normalizes each job type's progress shape into processed/total with a unit and ETA", () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    insertTask("ab", "SCAN_AUDIOBOOK_LIBRARY", "running", { progress: { booksProcessed: 3, booksTotal: 12 } }, 10);
    insertTask("ab2", "SCAN_AUDIOBOOK_LIBRARY", "running", { progress: { booksProcessed: 12, booksTotal: 12, authorsProcessed: 1, authorsTotal: 4 } }, 9);
    insertTask("faces", "SCAN_GALLERY_FACES", "running", { progress: { processed: 40, total: 200, startedAt } }, 8);
    insertTask("eb", "SCAN_EBOOK_LIBRARY", "running", { progress: { processed: 2, total: 9, startedAt } }, 7);
    insertTask("ph", "SCAN_GALLERY_LIBRARY", "running", { progress: { processed: 15, total: 80, startedAt } }, 6);
    insertTask("bare", "SCAN_AUDIOBOOK_LIBRARY", "running", {}, 5);
    // Writers that report their own recent-window ETA: taken verbatim, including null.
    insertTask("own-eta", "SCAN_GALLERY_LIBRARY", "running", { progress: { processed: 10, total: 100, startedAt, etaSeconds: 777 } }, 4);
    insertTask("warmup", "SCAN_GALLERY_LIBRARY", "running", { progress: { processed: 1, total: 100, startedAt, etaSeconds: null } }, 3);

    const byId = Object.fromEntries(listTasks().jobs.map((t) => [t.id, t]));
    expect(byId.ab.progress).toMatchObject({ processed: 3, total: 12, unit: "books" });
    expect(byId.ab2.progress).toMatchObject({ processed: 1, total: 4, unit: "authors" });
    expect(byId.eb.progress).toMatchObject({ processed: 2, total: 9, unit: "books" });
    expect(byId.ph.progress).toMatchObject({ processed: 15, total: 80, unit: "items" });
    expect(byId.bare.progress).toBeNull();
    expect(byId["own-eta"].progress).toMatchObject({ etaSeconds: 777 });
    expect(byId.warmup.progress!.etaSeconds).toBeNull();

    // 40 photos in ~60s → 160 remaining at 1.5s each ≈ 240s left.
    expect(byId.faces.progress).toMatchObject({ processed: 40, total: 200, unit: "photos" });
    expect(byId.faces.progress!.etaSeconds).toBeGreaterThanOrEqual(230);
    expect(byId.faces.progress!.etaSeconds).toBeLessThanOrEqual(250);

    // No startedAt in the payload → falls back to created_at (10s ago), still yields an ETA.
    expect(byId.ab.progress!.etaSeconds).toBeGreaterThan(0);
  });

  it("summarizes each job type's result shape, exposing skipped-book details", () => {
    insertTask("ab", "SCAN_AUDIOBOOK_LIBRARY", "completed", { result: { discoveredBooks: 5, discoveredFiles: 60, bookErrors: ["a", "b"] } }, 10);
    insertTask("eb", "SCAN_EBOOK_LIBRARY", "completed", { result: { books: 1 } }, 9);
    insertTask("ph", "SCAN_GALLERY_LIBRARY", "completed", { result: { assets: 42 } }, 8);
    insertTask("faces", "SCAN_GALLERY_FACES", "completed", { result: { items: 5, faces: 9 } }, 7);
    insertTask("regroup", "SCAN_GALLERY_FACES", "completed", { result: { reclustered: 4, thumbnails: 0 } }, 6);
    insertTask("paused", "SCAN_GALLERY_FACES", "completed", { result: { items: 4000, faces: 900, remaining: 1200, timeLimited: true } }, 5);
    insertTask("batched", "SCAN_GALLERY_FACES", "completed", { result: { items: 1000, faces: 230, remaining: 4200 } }, 4);
    insertTask("boom", "SCAN_EBOOK_LIBRARY", "failed", {}, 3);

    const byId = Object.fromEntries(listTasks().jobs.map((t) => [t.id, t]));
    expect(byId.ab.summary).toBe("5 books, 60 files · 2 skipped");
    expect(byId.ab.bookErrors).toEqual(["a", "b"]);
    expect(byId.eb.summary).toBe("1 book");
    expect(byId.ph.summary).toBe("42 items");
    expect(byId.faces.summary).toBe("5 photos, 9 faces");
    expect(byId.regroup.summary).toBe("Re-grouped faces into 4 groups");
    expect(byId.paused.summary).toBe("4000 photos, 900 faces · paused at the 3-hour limit, 1200 photos continue next run");
    expect(byId.batched.summary).toBe("1000 photos, 230 faces · 4200 more continue in the next batch");
    expect(byId.boom.summary).toBeNull();
  });
});

describe("due-job worker", () => {
  it("runs an enabled job once due and rolls the next run forward", () => {
    configureScheduledJob("cleanup_job_logs", true, { frequency: "weekly" }, null);
    // Force it due.
    db.prepare("UPDATE scheduled_jobs SET next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE key = 'cleanup_job_logs'").run();

    processDueScheduledJobs();

    const [job] = listScheduledJobs().filter((j) => j.key === "cleanup_job_logs");
    expect(job.lastRunAt).not.toBeNull();
    expect(job.lastStatus).toBe("success");
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves disabled jobs untouched", () => {
    configureScheduledJob("empty_recycle_bin", false, { frequency: "weekly" }, null);
    processDueScheduledJobs();
    const [job] = listScheduledJobs().filter((j) => j.key === "empty_recycle_bin");
    expect(job.lastRunAt).toBeNull();
  });
});
