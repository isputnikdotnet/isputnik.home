// How many requests the gateway passed to each container today, and how many of
// them failed: Diagnostics' "Other containers" (docs/diagnostics-pages-plan.md).
// In memory and per day, on this server's clock: a restart starts the count again,
// and the page says since when. A failure is an answer the container could not
// give — 5xx, which is also what the proxy answers when it can't reach it — not
// a 404 or a refused sign-in, which are answers.

export interface CallCount {
  /** The day counted, YYYY-MM-DD on this server's clock. */
  day: string;
  count: number;
  failed: number;
  /** When counting began today: midnight, or this server's start if later. */
  since: string;
  lastAt: string | null;
  lastFailedAt: string | null;
  lastFailedStatus: number | null;
}

const counts = new Map<string, CallCount>();

function today(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function entry(appId: string, now: Date): CallCount {
  const day = today(now);
  const current = counts.get(appId);
  if (current && current.day === day) return current;
  // A new day (or the first call): since midnight, unless this is the first day.
  const since = current ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() : now.toISOString();
  const fresh: CallCount = { day, count: 0, failed: 0, since, lastAt: null, lastFailedAt: null, lastFailedStatus: null };
  counts.set(appId, fresh);
  return fresh;
}

/** Called as each proxied request finishes, with the status the browser got. */
export function recordCall(appId: string, statusCode: number, now = new Date()): void {
  const count = entry(appId, now);
  count.count += 1;
  count.lastAt = now.toISOString();
  if (statusCode >= 500) {
    count.failed += 1;
    count.lastFailedAt = count.lastAt;
    count.lastFailedStatus = statusCode;
  }
}

/** Today's count for a container; nothing yet is a zero count since now. */
export function callsToday(appId: string, now = new Date()): CallCount {
  return { ...entry(appId, now) };
}

/** Tests only. */
export function resetCallCounts(): void {
  counts.clear();
}
