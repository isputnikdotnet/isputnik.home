// How much of a photo's date is actually known (docs/photo-review-plan.md).
//
// `taken_at` stays a full instant everywhere — the Timeline, Memories, Year in
// review and the dated Keep layout all sort and bucket on it — and the precision
// says how much of that instant to believe. A coarser precision is always
// stored as the FIRST instant of its period (July 1962 -> 1962-07-01T00:00:00Z),
// which is what `floorTakenAt` guarantees, so two photos "from 1962" sort
// together and a year-only photo lands at the head of its year rather than
// somewhere random inside it.
//
// Pure functions, so the edit path, the bulk path and the Keep layout agree.

export const TAKEN_PRECISIONS = ["time", "day", "month", "year", "decade"] as const;
export type TakenPrecision = (typeof TAKEN_PRECISIONS)[number];

export function isTakenPrecision(value: unknown): value is TakenPrecision {
  return typeof value === "string" && (TAKEN_PRECISIONS as readonly string[]).includes(value);
}

/** The stored form of `takenAt` at `precision`: the period's first instant, in
 *  UTC, from the ISO prefix (no timezone shift — a person who said "1962" did not
 *  mean 31 December 1961 in some zone). 'time' passes the instant through
 *  untouched. Returns null for an unparseable date. */
export function floorTakenAt(takenAt: string, precision: TakenPrecision): string | null {
  if (precision === "time") {
    const d = new Date(takenAt);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const parts = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(takenAt);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = precision === "day" || precision === "month" ? Number(parts[2] ?? "1") : 1;
  const day = precision === "day" ? Number(parts[3] ?? "1") : 1;
  const y = precision === "decade" ? Math.floor(year / 10) * 10 : year;
  const iso = `${String(y).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}
