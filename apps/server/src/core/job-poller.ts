// One timer for every queue on the jobs table.
//
// Each background queue (catalog scans, face scans, video conversion, slideshow
// renders, the duplicate pass, storage moves) used to run its own 2-second
// setInterval, and every tick of every one of them ran its recovery query, the
// library-lock count and its own claim query — about a dozen compiled-and-run
// queries a second with nothing queued at all.
//
// Now the queues register here and this file owns the only timer. Each tick asks
// the jobs table ONE question — which types have a job due, and which have one
// marked running — and calls only the handlers that have something to look at. An
// idle server pays one indexed query every two seconds.
//
// What stays with each handler is everything that made its queue correct: its
// re-entrancy guard, its recovery pass (requeueInterruptedJobs), the one-library-
// job-at-a-time lock (scan-lock.ts), the atomic claim, its own retry rules. This
// file only decides WHEN to call a handler, by the rule each one polled by before:
//
//   - on the first tick after it registers, unconditionally — the boot-time pass
//     every worker had, which is where a restart's interrupted jobs are put back;
//   - whenever one of its types has a pending job whose run_at has come;
//   - whenever one of its types has a job marked 'running' — either the handler is
//     working it (its guard returns at once) or a process that died left it, and the
//     handler's recovery pass puts it back in the queue, as it did on every poll.
//
// A handler this file has called and that has not finished yet is not called again
// (the handlers guard themselves too, because routes call them directly as well).
// Like core/status-contributors.ts, the dependency points inward: this file knows
// the jobs table and nothing about what any job does.
import { stmt } from "../db/statement-cache.js";
import { log } from "./logger.js";
import type { JobRow } from "../db/rows.js";

export interface JobHandler {
  /** For log lines only. */
  name: string;
  /** The jobs.type values this handler works. */
  types: readonly string[];
  /** Work the queue until it has nothing it may run now. */
  run: () => Promise<void> | void;
}

interface Registration {
  handler: JobHandler;
  /** Not yet called since it registered — the next tick calls it regardless. */
  fresh: boolean;
  /** A call this poller made is still in flight. */
  busy: boolean;
}

export const JOB_POLL_INTERVAL_MS = 2000;

const registrations: Registration[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

// Per type: is a job due, is one running. Rides idx_jobs_status (status, run_at);
// an idle queue has no pending/running rows, so this reads nothing but the index.
const SNAPSHOT_SQL = `
  SELECT type,
         MAX(status = 'running') AS running,
         MAX(status = 'pending' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS due
  FROM jobs
  WHERE status IN ('pending', 'running')
  GROUP BY type
`;

function dispatch(registration: Registration): void {
  registration.fresh = false;
  registration.busy = true;
  const done = () => { registration.busy = false; };
  let result: Promise<void> | void;
  try {
    result = registration.handler.run();
  } catch (err) {
    done();
    log.error({ err }, `${registration.handler.name}: the queue pass failed`);
    return;
  }
  Promise.resolve(result).then(done, (err: unknown) => {
    done();
    log.error({ err }, `${registration.handler.name}: the queue pass failed`);
  });
}

/** One tick: ask the jobs table once, then call whichever handlers have work.
 *  Returns the names of the handlers it called. Exported for tests. */
export function pollJobsOnce(): string[] {
  if (registrations.length === 0) return [];
  let rows: (Pick<JobRow, "type"> & { running: number; due: number })[];
  try {
    rows = stmt(SNAPSHOT_SQL).all() as typeof rows;
  } catch (err) {
    log.warn({ err }, "job poller: could not read the jobs table; will try again next tick");
    return [];
  }
  const due = new Set<string>();
  const running = new Set<string>();
  for (const row of rows) {
    if (row.due) due.add(row.type);
    if (row.running) running.add(row.type);
  }
  const called: string[] = [];
  // A snapshot of the list: a handler may register or unregister another mid-tick.
  for (const registration of [...registrations]) {
    if (!registrations.includes(registration) || registration.busy) continue;
    const { types } = registration.handler;
    if (registration.fresh || types.some((type) => due.has(type) || running.has(type))) {
      called.push(registration.handler.name);
      dispatch(registration);
    }
  }
  return called;
}

/**
 * Put a queue on the shared poller. Returns the function that takes it off again —
 * the worker's stop hook, called from its plugin's onClose. The timer runs while at
 * least one handler is registered; the last one off stops it, so a shut-down server
 * (or a test that closed its app) is left with no timer at all.
 */
export function registerJobHandler(handler: JobHandler): () => void {
  const registration: Registration = { handler, fresh: true, busy: false };
  registrations.push(registration);
  if (!timer) timer = setInterval(() => { pollJobsOnce(); }, JOB_POLL_INTERVAL_MS);
  return () => {
    const index = registrations.indexOf(registration);
    if (index === -1) return;
    registrations.splice(index, 1);
    if (registrations.length === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
