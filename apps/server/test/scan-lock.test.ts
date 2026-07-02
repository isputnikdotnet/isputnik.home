import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db.js";
import { libraryJobRunning } from "../src/modules/library/shared/scan-lock.js";
import { jobProgressWriter } from "../src/modules/library/shared/job-progress.js";
import { processEbookScanQueue } from "../src/modules/library/ebook/scanner.js";

function insertJob(id: string, type: string, status: string, payload: object = {}) {
  db.prepare("INSERT INTO jobs (id, type, payload, status) VALUES (?, ?, ?, ?)")
    .run(id, type, JSON.stringify(payload), status);
}

beforeEach(() => {
  db.prepare("DELETE FROM jobs").run();
});

describe("global library-job lock", () => {
  it("reports a running library job of any type", () => {
    expect(libraryJobRunning()).toBe(false);
    insertJob("f1", "SCAN_GALLERY_FACES", "running");
    expect(libraryJobRunning()).toBe(true);
  });

  it("ignores non-library jobs and non-running states", () => {
    insertJob("x", "SOME_OTHER_JOB", "running");
    insertJob("p", "SCAN_EBOOK_LIBRARY", "pending");
    insertJob("c", "SCAN_AUDIOBOOK_LIBRARY", "completed");
    expect(libraryJobRunning()).toBe(false);
  });

  it("a queued ebook scan stays pending while a face scan is running", async () => {
    insertJob("faces", "SCAN_GALLERY_FACES", "running");
    insertJob("ebook", "SCAN_EBOOK_LIBRARY", "pending", { libraryId: "nope" });

    await processEbookScanQueue();

    const job = db.prepare("SELECT status, attempts FROM jobs WHERE id = 'ebook'").get() as { status: string; attempts: number };
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    // The running job of the other type was left alone (only own-type rows are reclaimed).
    expect((db.prepare("SELECT status FROM jobs WHERE id = 'faces'").get() as { status: string }).status).toBe("running");
  });

  it("the same queued scan is claimed once nothing else is running", async () => {
    insertJob("ebook", "SCAN_EBOOK_LIBRARY", "pending", { libraryId: "nope" });

    await processEbookScanQueue();

    // Claimed and attempted — the missing library makes the run itself fail/retry,
    // but the point is the worker picked it up now that the lock is free.
    const job = db.prepare("SELECT attempts FROM jobs WHERE id = 'ebook'").get() as { attempts: number };
    expect(job.attempts).toBe(1);
  });
});

describe("jobProgressWriter", () => {
  it("persists processed/total with a stable startedAt, always flushing the final count", () => {
    insertJob("j1", "SCAN_GALLERY_LIBRARY", "running", { libraryId: "L" });
    const write = jobProgressWriter("j1", { libraryId: "L" });

    write(0, 10);
    const first = JSON.parse((db.prepare("SELECT payload FROM jobs WHERE id = 'j1'").get() as { payload: string }).payload);
    expect(first.libraryId).toBe("L");
    expect(first.progress).toMatchObject({ processed: 0, total: 10 });
    expect(typeof first.progress.startedAt).toBe("string");

    // Mid-run writes are throttled (1.5s window) — this one lands too soon and is skipped…
    write(3, 10);
    const second = JSON.parse((db.prepare("SELECT payload FROM jobs WHERE id = 'j1'").get() as { payload: string }).payload);
    expect(second.progress.processed).toBe(0);

    // …but the final count always flushes, keeping the same startedAt.
    write(10, 10);
    const last = JSON.parse((db.prepare("SELECT payload FROM jobs WHERE id = 'j1'").get() as { payload: string }).payload);
    expect(last.progress).toMatchObject({ processed: 10, total: 10 });
    expect(last.progress.startedAt).toBe(first.progress.startedAt);
  });

  it("computes the ETA from the recent rate, so a fast catch-up phase doesn't poison it", () => {
    vi.useFakeTimers();
    try {
      insertJob("j2", "SCAN_GALLERY_LIBRARY", "running", { libraryId: "L" });
      const write = jobProgressWriter("j2", { libraryId: "L" });
      const progressOf = () =>
        JSON.parse((db.prepare("SELECT payload FROM jobs WHERE id = 'j2'").get() as { payload: string }).payload).progress;

      // No signal yet → no ETA rather than a wild guess.
      write(0, 1000);
      expect(progressOf().etaSeconds).toBeNull();

      // Fast phase: 900 already-cataloged items fly by in 10s → tiny ETA, correctly.
      vi.advanceTimersByTime(10_000);
      write(900, 1000);
      expect(progressOf().etaSeconds).toBeLessThanOrEqual(2);

      // Slow phase: new items trickle in. The 30s window forgets the fast burst, so
      // the ETA reflects the CURRENT rate (~0.5/s → ~150s for the remaining 75) —
      // a whole-run average would still claim ~5s here.
      vi.advanceTimersByTime(40_000);
      write(920, 1000);
      vi.advanceTimersByTime(10_000);
      write(925, 1000);
      expect(progressOf().etaSeconds).toBeGreaterThanOrEqual(100);
      expect(progressOf().etaSeconds).toBeLessThanOrEqual(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
