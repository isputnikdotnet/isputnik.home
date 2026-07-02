import { db } from "../../../db.js";

// Throttled writer that persists live progress ({processed, total, startedAt,
// etaSeconds}) into a job's payload, so the Tasks page can show counts, a percentage,
// and an ETA while the job runs. Writes at most every 1.5s; the final call
// (processed === total) always flushes.
//
// The ETA comes from the rate over a RECENT window (last ~30s), not the whole-run
// average: scans skip already-cataloged items almost instantly and only slow down on
// new ones, so the run average wildly underestimates what's left ("about a minute
// left" for an hour). It's null until the window holds ≥5s of signal.
const RATE_WINDOW_MS = 30_000;
const MIN_WINDOW_MS = 5_000;

export function jobProgressWriter(jobId: string, basePayload: object): (processed: number, total: number) => void {
  const startedAt = new Date().toISOString();
  const samples: { t: number; processed: number }[] = [];
  let lastWrite = 0;
  return (processed: number, total: number) => {
    const now = Date.now();
    if (processed < total && now - lastWrite < 1500) return;
    lastWrite = now;

    samples.push({ t: now, processed });
    while (samples.length > 1 && now - samples[0].t > RATE_WINDOW_MS) samples.shift();
    let etaSeconds: number | null = null;
    const oldest = samples[0];
    const windowMs = now - oldest.t;
    const doneInWindow = processed - oldest.processed;
    if (windowMs >= MIN_WINDOW_MS && doneInWindow > 0 && total > processed) {
      etaSeconds = Math.round((total - processed) / (doneInWindow / (windowMs / 1000)));
    }

    db.prepare("UPDATE jobs SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ ...basePayload, progress: { processed, total, startedAt, etaSeconds } }), jobId);
  };
}
