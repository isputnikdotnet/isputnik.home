import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  requeueInterruptedJobs, releaseAbandonedScanLibraries, reconcileOrphanedScans
} from "../src/modules/library/shared/job-recovery.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// The crash loop this exists to stop:
//
// A slideshow render heavy enough to exhaust the container's memory kills the whole
// server. Docker restarts it, the worker finds its own job still marked 'running',
// re-queues it, and the same render kills the box again — for as long as anyone
// leaves it running. The attempt limit never applied, because the failure path that
// consults it is exactly the path an OOM kill skips.
const TYPE = "TEST_JOB";

function makeJob(id: string, attempts: number, maxAttempts = 2, status = "running") {
  db.prepare(
    "INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, locked_by) VALUES (?, ?, ?, ?, ?, ?, 'pid-1')"
  ).run(id, TYPE, JSON.stringify({ slideshowId: `s-${id}` }), status, attempts, maxAttempts);
}

const statusOf = (id: string) =>
  (db.prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string }).status;

describe("recovering jobs a restart interrupted", () => {
  beforeEach(() => { resetDb(); });

  it("re-queues a job that still has attempts left", () => {
    makeJob("first-try", 1);
    const result = requeueInterruptedJobs(TYPE);
    expect(result.requeued).toBe(1);
    expect(result.abandoned).toEqual([]);
    expect(statusOf("first-try")).toBe("pending");
    // And the lock is released, or nothing could claim it.
    expect(db.prepare("SELECT locked_by FROM jobs WHERE id = 'first-try'").get()).toEqual({ locked_by: null });
  });

  it("gives up on one that has used them all, instead of starting it again", () => {
    makeJob("killer", 2);
    const result = requeueInterruptedJobs(TYPE);
    expect(result.requeued).toBe(0);
    expect(result.abandoned.map((job) => job.id)).toEqual(["killer"]);
    expect(statusOf("killer")).toBe("failed");
    const row = db.prepare("SELECT error, failed_at FROM jobs WHERE id = 'killer'").get() as { error: string; failed_at: string };
    expect(row.error).toMatch(/interrupted/i);
    expect(row.failed_at).toBeTruthy();
  });

  // The point of the whole thing: run it as many times as a container would restart,
  // and the job must stop coming back.
  it("terminates instead of resurrecting the same job forever", () => {
    makeJob("oom", 1);
    let claims = 0;
    for (let restart = 0; restart < 10; restart += 1) {
      requeueInterruptedJobs(TYPE);
      // Simulate the worker claiming whatever is pending and then being killed.
      const pending = db.prepare("SELECT id FROM jobs WHERE id = 'oom' AND status = 'pending'").all() as { id: string }[];
      for (const job of pending) {
        claims += 1;
        db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
      }
    }
    expect(claims).toBe(1);                 // one more go, not ten
    expect(statusOf("oom")).toBe("failed");
  });

  it("leaves other job types and other statuses alone", () => {
    makeJob("mine", 1);
    db.prepare(
      "INSERT INTO jobs (id, type, payload, status, attempts, max_attempts) VALUES ('theirs', 'OTHER_JOB', '{}', 'running', 5, 2)"
    ).run();
    makeJob("done", 2, 2, "completed");

    requeueInterruptedJobs(TYPE);
    expect(statusOf("theirs")).toBe("running");
    expect(statusOf("done")).toBe("completed");
  });

  it("does nothing at all when no job was interrupted", () => {
    expect(requeueInterruptedJobs(TYPE)).toEqual({ requeued: 0, abandoned: [] });
  });
});

// A library's scan_status is the browse page's "Scanning…" notice AND the gate the
// nightly scheduler checks (enqueueLibraryScans skips anything already 'scanning').
// Left stuck there by a scan that will never finish, a library shows the notice
// forever and is never scanned again — with no task and no log line to say why.
describe("releasing libraries a dead scan left marked as scanning", () => {
  const SCAN_TYPE = "SCAN_GALLERY_LIBRARY";

  beforeEach(() => {
    resetDb();
    db.prepare("DELETE FROM jobs").run();
    makeUser("admin", "admin");
  });

  function scanningLibrary(id: string, type = "gallery"): string {
    makeLibrary(id, { createdBy: "admin", type });
    db.prepare("UPDATE libraries SET scan_status = 'scanning' WHERE id = ?").run(id);
    return id;
  }

  function scanJob(id: string, libraryId: string, status: string, type = SCAN_TYPE) {
    db.prepare(
      "INSERT INTO jobs (id, type, payload, status, attempts, max_attempts) VALUES (?, ?, ?, ?, 1, 3)"
    ).run(id, type, JSON.stringify({ libraryId, options: {} }), status);
  }

  const scanStatusOf = (id: string) =>
    (db.prepare("SELECT scan_status FROM libraries WHERE id = ?").get(id) as { scan_status: string }).scan_status;

  it("marks the library as errored and logs why when its scan is given up on", () => {
    scanningLibrary("gal");
    db.prepare(
      "INSERT INTO jobs (id, type, payload, status, attempts, max_attempts) VALUES ('spent', ?, ?, 'running', 3, 3)"
    ).run(SCAN_TYPE, JSON.stringify({ libraryId: "gal", options: {} }));

    releaseAbandonedScanLibraries(requeueInterruptedJobs(SCAN_TYPE).abandoned);

    expect(scanStatusOf("gal")).toBe("error");
    const log = db.prepare("SELECT event, target_id, detail FROM activity_logs WHERE event = 'library.scan_abandoned'").get() as
      { event: string; target_id: string; detail: string };
    expect(log.target_id).toBe("gal");
    expect(log.detail).toMatch(/interrupted every time/i);
  });

  it("leaves the library scanning when the interrupted scan is only re-queued", () => {
    scanningLibrary("gal");
    scanJob("retry", "gal", "running");

    const recovery = requeueInterruptedJobs(SCAN_TYPE);
    releaseAbandonedScanLibraries(recovery.abandoned);

    expect(recovery.requeued).toBe(1);
    expect(scanStatusOf("gal")).toBe("scanning");
  });

  it("releases a library whose scan job no longer exists", () => {
    scanningLibrary("pruned");           // its failed job was pruned by "Clean task history"
    scanningLibrary("queued");
    scanJob("live", "queued", "pending");

    const unstuck = reconcileOrphanedScans();

    expect(unstuck.map((library) => library.id)).toEqual(["pruned"]);
    expect(scanStatusOf("pruned")).toBe("error");
    expect(scanStatusOf("queued")).toBe("scanning");
  });

  it("spares a library whose job a dead process left 'running', so the requeue can have it", () => {
    scanningLibrary("crashed");
    scanJob("stale-lock", "crashed", "running");

    expect(reconcileOrphanedScans()).toEqual([]);
    expect(scanStatusOf("crashed")).toBe("scanning");
  });

  it("does not count a face job as a catalog scan", () => {
    // Face scans carry a libraryId too, but never set scan_status — a library left
    // 'scanning' with only a face job queued is still stranded.
    scanningLibrary("faces-only");
    scanJob("face", "faces-only", "pending", "SCAN_GALLERY_FACES");

    expect(reconcileOrphanedScans().map((library) => library.id)).toEqual(["faces-only"]);
    expect(scanStatusOf("faces-only")).toBe("error");
  });

  it("covers audiobook and ebook libraries too", () => {
    scanningLibrary("audio", "audiobook");
    scanningLibrary("books", "ebook");
    scanJob("audio-job", "audio", "pending", "SCAN_AUDIOBOOK_LIBRARY");

    expect(reconcileOrphanedScans().map((library) => library.id)).toEqual(["books"]);
    expect(scanStatusOf("audio")).toBe("scanning");
    expect(scanStatusOf("books")).toBe("error");
  });

  it("leaves idle libraries alone and is a no-op on a healthy install", () => {
    makeLibrary("idle", { createdBy: "admin", type: "gallery" });
    expect(reconcileOrphanedScans()).toEqual([]);
    expect(scanStatusOf("idle")).toBe("idle");
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs").get()).toEqual({ n: 0 });
  });
});
