import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { parseQuery } from "../../core/shared.js";
import { groupByDisk, homeHoldings, measureHoldings, type DashboardDisk } from "./overview.js";

// How full each drive was, day by day (control panel v2, phase 4 — the Dashboard's
// Growth). Home measures the folders it keeps files on once a day and keeps the
// numbers for KEEP_DAYS; the Dashboard draws the selected drive's line and says how
// much it grew over the period. Nothing is estimated: until two days have been
// measured there is no line, and the page says so.

const KEEP_DAYS = 400;
/** Check hourly whether today has been measured; the first check waits for boot to settle. */
const CHECK_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;

const today = () => new Date().toISOString().slice(0, 10);

/** Record today's numbers for every mount, once a day. A later call the same day
 *  updates the row, so a folder whose background count finished after the first
 *  sample still gets its size in. */
export function sampleStorage(disks: DashboardDisk[] = groupByDisk(measureHoldings(homeHoldings())), day = today()): number {
  const upsert = db.prepare(`
    INSERT INTO storage_samples (day, mount, total_bytes, free_bytes, holds_json)
    VALUES (@day, @mount, @total, @free, @holds)
    ON CONFLICT(day, mount) DO UPDATE SET total_bytes = excluded.total_bytes, free_bytes = excluded.free_bytes, holds_json = excluded.holds_json
  `);
  const write = db.transaction(() => {
    for (const disk of disks) {
      const holds = disk.holds.map((hold) => ({ kind: hold.kind, bytes: hold.kind === "library" ? null : hold.bytes ?? null }));
      upsert.run({ day, mount: disk.mount, total: disk.totalBytes, free: disk.freeBytes, holds: JSON.stringify(holds) });
    }
    db.prepare("DELETE FROM storage_samples WHERE day < date('now', ?)").run(`-${KEEP_DAYS} days`);
  });
  write();
  return disks.length;
}

let lastSampledDay = "";

function sampleIfDue(): void {
  // Twice on the first day (boot, then an hour later once the folder counts have
  // run), then once a day.
  const day = today();
  if (lastSampledDay === day) return;
  try {
    sampleStorage();
    const counted = (db.prepare("SELECT holds_json FROM storage_samples WHERE day = ?").all(day) as { holds_json: string }[])
      .every((row) => (JSON.parse(row.holds_json) as { bytes: number | null; kind: string }[]).every((hold) => hold.kind === "library" || hold.bytes !== null));
    if (counted) lastSampledDay = day;
  } catch {
    // A disk that cannot be read today is tried again next hour.
  }
}

const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(2).max(KEEP_DAYS).default(30)
});

export async function storageHistoryPlugin(app: FastifyInstance) {
  const first = setTimeout(sampleIfDue, FIRST_CHECK_MS);
  const hourly = setInterval(sampleIfDue, CHECK_MS);
  first.unref?.();
  hourly.unref?.();
  app.addHook("onClose", async () => {
    clearTimeout(first);
    clearInterval(hourly);
  });

  app.get("/api/dashboard/storage-history", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = parseQuery(historyQuerySchema, request.query);
    if (parsed.error) return reply.code(400).send({ error: "Invalid query", details: parsed.error });
    const rows = db.prepare(`
      SELECT day, mount, total_bytes, free_bytes FROM storage_samples
      WHERE day >= date('now', ?)
      ORDER BY day, mount
    `).all(`-${parsed.data.days} days`) as { day: string; mount: string; total_bytes: number; free_bytes: number }[];
    return {
      samples: rows.map((row) => ({ day: row.day, mount: row.mount, totalBytes: row.total_bytes, usedBytes: Math.max(0, row.total_bytes - row.free_bytes) }))
    };
  });
}
