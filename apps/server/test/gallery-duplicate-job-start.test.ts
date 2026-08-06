// Starting a cleanup's scan — the two-phase flow.
//
// The snapshot reads no files, so it needs digests that may not exist yet. Pressing Run
// scan therefore queues a fingerprint pass over the job's libraries and comes straight
// back, and the worker calls the snapshot once the digests are in place. These tests pin
// the orchestration: what gets queued, what the job's status does, and the case the
// old "refuse if a scan is already running" rule got wrong.
//
// No filesystem is touched. The seeded libraries point at /src/<id>, which does not
// exist, so the hashing pass skips them wholesale and completes with nothing read —
// which is exactly the shape needed to exercise everything around it.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { createJob, getJob, setJobStatus } from "../src/modules/library/gallery/duplicates/jobs.js";
import { startJobScan, listJobResults } from "../src/modules/library/gallery/duplicates/job-scan.js";
import {
  DUPLICATE_SCAN_JOB_TYPE,
  enqueueJobScan,
  processDuplicateScanQueue
} from "../src/modules/library/gallery/duplicates/items.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

interface ScanJobRow { id: string; status: string; payload: string }

const scanJobs = (): ScanJobRow[] =>
  db.prepare("SELECT id, status, payload FROM jobs WHERE type = ? ORDER BY rowid")
    .all(DUPLICATE_SCAN_JOB_TYPE) as ScanJobRow[];

const payloadOf = (row: ScanJobRow) => JSON.parse(row.payload) as {
  libraryId?: string | null; libraryIds?: string[] | null; cleanupJobId?: string | null;
};

function asset(id: string, relativePath: string, opts: { library?: string; hash?: string } = {}): void {
  const { library = "GAL", hash = `h-${id}` } = opts;
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at)
    VALUES (?, ?, 'gallery', ?, 'ready', '2024-01-01T00:00:00.000Z')
  `).run(id, library, relativePath);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, content_hash, content_hash_at, modified_at)
    VALUES (?, 'photo', ?, 1000, ?, 'm1', 'm1')
  `).run(id, relativePath, hash);
}

const newJob = (libraries = ["GAL"], duplicateType: "folders" | "files" = "files") => {
  const created = createJob({ ownerUserId: "u1", libraryIds: libraries, duplicateType });
  if (!created.ok) throw new Error(`job refused: ${created.refused}`);
  return created.job.id;
};

beforeEach(() => {
  resetDb();
  // resetDb deliberately leaves `jobs` alone — most suites never touch the queue. This
  // one lives in it, and a pending row surviving into the next test is another pass the
  // worker runs before the one under test.
  db.prepare("DELETE FROM jobs").run();
  makeUser("u1", "admin");
  makeUser("u2", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("GAL2", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
});

describe("startJobScan", () => {
  it("moves the job to scanning and queues a pass over its own libraries", () => {
    const jobId = newJob(["GAL", "GAL2"]);
    const outcome = startJobScan(jobId, "u1");

    expect(outcome.ok).toBe(true);
    expect(getJob(jobId)!.status).toBe("scanning");

    const queued = scanJobs();
    expect(queued).toHaveLength(1);
    expect(payloadOf(queued[0])).toEqual({ cleanupJobId: jobId, libraryIds: ["GAL", "GAL2"] });
  });

  it("comes back before the pass has run — nothing is snapshotted yet", () => {
    const jobId = newJob();
    asset("a1", "one/pic.jpg", { hash: "same" });
    asset("a2", "two/pic.jpg", { hash: "same" });

    startJobScan(jobId, "u1");

    expect(scanJobs()[0].status).toBe("pending");
    expect(listJobResults(jobId)).toHaveLength(0);
  });

  it("does not scan a library the job left out", () => {
    const jobId = newJob(["GAL2"]);
    startJobScan(jobId, "u1");
    expect(payloadOf(scanJobs()[0]).libraryIds).toEqual(["GAL2"]);
  });

  // The behaviour the old rule got wrong. enqueueDuplicateScan refuses when any scan is
  // in flight, which is right for the button and the scheduled job — they would just
  // pile up redundant install-wide passes. Applied here it would leave the cleanup with
  // no scan at all, waiting on a pass that may cover entirely different libraries.
  it("refuses someone else's job", () => {
    const jobId = newJob();
    const outcome = startJobScan(jobId, "u2");
    expect(outcome).toMatchObject({ ok: false, refused: "not_owner" });
    expect(scanJobs()).toHaveLength(0);
  });

  it("refuses a job that is already scanning, so one press is one pass", () => {
    const jobId = newJob();
    startJobScan(jobId, "u1");
    const second = startJobScan(jobId, "u1");

    expect(second).toMatchObject({ ok: false, refused: "not_reviewable", detail: "scanning" });
    expect(scanJobs()).toHaveLength(1);
  });
});

describe("enqueueJobScan", () => {
  it("refuses a second pass for the same cleanup", () => {
    const jobId = newJob();
    expect(enqueueJobScan(jobId, ["GAL"])).toBe(true);
    expect(enqueueJobScan(jobId, ["GAL"])).toBe(false);
    expect(scanJobs()).toHaveLength(1);
  });

  it("still allows a pass for a different cleanup", () => {
    const first = newJob();
    expect(enqueueJobScan(first, ["GAL"])).toBe(true);
    // Only one cleanup may be active at a time, so retire this one before the next.
    setJobStatus(first, "u1", "completed");
    const second = newJob();
    expect(enqueueJobScan(second, ["GAL"])).toBe(true);
    expect(scanJobs()).toHaveLength(2);
  });
});

describe("the worker's second phase", () => {
  it("snapshots the cleanup once the digests are in place, and lands it in review", async () => {
    asset("a1", "one/pic.jpg", { hash: "same" });
    asset("a2", "two/pic.jpg", { hash: "same" });
    const jobId = newJob();
    startJobScan(jobId, "u1");

    await processDuplicateScanQueue();

    const job = getJob(jobId)!;
    expect(job.status).toBe("review");
    expect(job.scanCompletedAt).not.toBeNull();

    const results = listJobResults(jobId);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("photo_set");
    expect(scanJobs()[0].status).toBe("completed");
  });

  it("leaves the progress bar full rather than stranded part-way", async () => {
    const jobId = newJob();
    startJobScan(jobId, "u1");
    expect(getJob(jobId)!.scanProgress).toBe(0);

    await processDuplicateScanQueue();

    expect(getJob(jobId)!.scanProgress).toBe(100);
  });
  it("completes even if the cleanup was deleted while its pass sat in the queue", async () => {
    const jobId = newJob();
    startJobScan(jobId, "u1");
    db.prepare("DELETE FROM duplicate_jobs WHERE id = ?").run(jobId);

    await processDuplicateScanQueue();

    expect(scanJobs()[0].status).toBe("completed");
  });
});
