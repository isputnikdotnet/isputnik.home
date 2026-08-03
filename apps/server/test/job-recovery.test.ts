import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { requeueInterruptedJobs } from "../src/modules/library/shared/job-recovery.js";
import { resetDb } from "./helpers/seed.js";

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
