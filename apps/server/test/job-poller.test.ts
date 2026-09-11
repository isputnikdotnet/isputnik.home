import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { JOB_POLL_INTERVAL_MS, pollJobsOnce, registerJobHandler } from "../src/core/job-poller.js";
import { startEbookScanWorker } from "../src/modules/library/ebook/scanner.js";

// The shared job poller (core/job-poller.ts): one timer and one query for every
// queue, calling a queue's handler only when the jobs table gives it a reason to.

function insertJob(id: string, type: string, status: "pending" | "running", runAt?: string) {
  db.prepare("INSERT INTO jobs (id, type, payload, status, run_at) VALUES (?, ?, '{}', ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))")
    .run(id, type, status, runAt ?? null);
}

let stops: (() => void)[] = [];

// One poll, then let the handlers it called settle (a call in flight is skipped).
async function tick(): Promise<string[]> {
  const called = pollJobsOnce();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  return called;
}

function register(name: string, types: string[], run: () => Promise<void> | void = () => {}) {
  const handler = vi.fn(run);
  stops.push(registerJobHandler({ name, types, run: handler }));
  return handler;
}

beforeEach(() => {
  db.prepare("DELETE FROM jobs").run();
});

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  vi.useRealTimers();
});

describe("dispatch", () => {
  it("calls every handler once after it registers, then only the ones with work", async () => {
    const a = register("a", ["A_JOB"]);
    const b = register("b", ["B_JOB"]);

    // The boot pass: each queue gets its recovery look whatever the table holds.
    expect(await tick()).toEqual(["a", "b"]);
    // Nothing queued: nobody is called.
    expect(await tick()).toEqual([]);

    insertJob("j1", "A_JOB", "pending");
    expect(await tick()).toEqual(["a"]);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("leaves a job alone until its run_at comes", async () => {
    const a = register("a", ["A_JOB"]);
    await tick();
    insertJob("later", "A_JOB", "pending", new Date(Date.now() + 60_000).toISOString());
    expect(await tick()).toEqual([]);
    db.prepare("UPDATE jobs SET run_at = ? WHERE id = 'later'").run(new Date(Date.now() - 1000).toISOString());
    expect(await tick()).toEqual(["a"]);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("calls the handler for a job marked running, so its recovery pass can put back a dead process's job", async () => {
    register("a", ["A_JOB"]);
    await tick();
    insertJob("stale", "A_JOB", "running");
    expect(await tick()).toEqual(["a"]);
  });

  it("matches any of a handler's types, and ignores finished jobs", async () => {
    register("multi", ["X_JOB", "Y_JOB"]);
    await tick();
    db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES ('done', 'Y_JOB', '{}', 'completed')").run();
    db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES ('bad', 'Y_JOB', '{}', 'failed')").run();
    expect(await tick()).toEqual([]);
    insertJob("y", "Y_JOB", "pending");
    expect(await tick()).toEqual(["multi"]);
  });
});

describe("concurrency", () => {
  it("never calls a handler again while its last call is still running, and doesn't hold up the others", async () => {
    let finish!: () => void;
    const slow = register("slow", ["SLOW_JOB"], () => new Promise<void>((resolve) => { finish = resolve; }));
    const quick = register("quick", ["QUICK_JOB"]);
    insertJob("s", "SLOW_JOB", "running");
    insertJob("q", "QUICK_JOB", "pending");

    expect(await tick()).toEqual(["slow", "quick"]);
    // Still mid-pass: the slow queue is skipped, the quick one keeps being served.
    expect(await tick()).toEqual(["quick"]);
    expect(await tick()).toEqual(["quick"]);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(quick).toHaveBeenCalledTimes(3);

    finish();
    await tick(); // lets the finished pass settle; slow is still mid-pass for this poll
    expect(await tick()).toEqual(["slow", "quick"]);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("a failed pass is logged, not fatal, and the handler is called again next time", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const flaky = register("flaky", ["F_JOB"], async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    });
    insertJob("f", "F_JOB", "pending");
    await tick();
    expect(errorLog).toHaveBeenCalled();
    expect(await tick()).toEqual(["flaky"]);
    expect(flaky).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });
});

describe("timer and stop", () => {
  it("ticks on one shared timer and stops it when the last handler leaves", async () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    const a = register("a", ["A_JOB"]);
    const b = register("b", ["B_JOB"]);
    expect(vi.getTimerCount()).toBe(before + 1); // one timer, not one per queue

    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    insertJob("j", "A_JOB", "pending");
    stops[0](); // a's stop hook (what its plugin's onClose calls)
    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS * 3);
    expect(a).toHaveBeenCalledTimes(1); // never called again after it stopped

    stops[1]();
    expect(vi.getTimerCount()).toBe(before);
    // Idempotent: a second stop is a no-op.
    stops[0]();
    stops[1]();
  });

  it("drives a real queue: an ebook scan is claimed on the next tick, and waits behind the library lock", async () => {
    vi.useFakeTimers();
    stops.push(startEbookScanWorker());
    insertJob("faces", "SCAN_GALLERY_FACES", "running");
    db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES ('ebook', 'SCAN_EBOOK_LIBRARY', ?, 'pending')")
      .run(JSON.stringify({ libraryId: "no-such-library" }));
    const attempts = () => (db.prepare("SELECT attempts FROM jobs WHERE id = 'ebook'").get() as { attempts: number }).attempts;

    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
    expect(attempts()).toBe(0); // a face scan holds the one-at-a-time lock

    db.prepare("UPDATE jobs SET status = 'completed' WHERE id = 'faces'").run();
    await vi.advanceTimersByTimeAsync(JOB_POLL_INTERVAL_MS);
    expect(attempts()).toBe(1); // claimed (the missing library then fails the run)
  });
});
