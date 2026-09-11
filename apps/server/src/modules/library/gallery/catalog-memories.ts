import { db } from "../../../db.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type AssetRow } from "./catalog-asset.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

// Memories ("On this day"): past-year assets whose taken_at matches today's
// month/day, grouped by year (newest year first). Assets without taken_at never
// match (substr on NULL yields NULL); the current year is excluded — today's
// photos are not memories yet.
//
// Widening is decided PER YEAR, not once for the whole row. It used to be three
// tiers tried in order — exact day, ±3 days, whole month — returning on the first
// that produced any row at all, which quietly lost a year whose photos were dated
// a day or two off whenever some other year matched exactly: tier one succeeded,
// so the ±3-day tier that would have caught it never ran. A scanned photo dated
// from its negative's sleeve rather than its EXIF is exactly that case, and those
// are the oldest photos in a library — the ones most worth surfacing.
//
// So the day and ±3-day tiers are now one pass, and each year takes the narrowest
// of the two it has anything in. Each group reports its own `precision` so a year
// that had to widen can say so; the top-level one is the narrowest across the
// groups, which is what titles the row. The whole-month tier stays a fallback for
// the whole row, since a month-wide match is a different proposition from an
// anniversary and is only worth offering when there is no anniversary at all.
export interface GalleryMemoryGroup {
  year: number;
  count: number;
  /** How far this year's match had to widen: exactly today, or within ±3 days. */
  precision: GalleryMemoriesPrecision;
  items: ReturnType<typeof mapAsset>[];
}

export type GalleryMemoriesPrecision = "day" | "near" | "month";

// MM-DD strings for `today` ± span days. UTC date arithmetic so a DST boundary
// can't skip or repeat a day; the year-end wrap (Dec 29 → Jan 03) falls out free.
function monthDayWindow(today: string, span: number): string[] {
  const base = new Date(`${today}T00:00:00Z`);
  const out: string[] = [];
  for (let offset = -span; offset <= span; offset += 1) {
    out.push(new Date(base.getTime() + offset * 86_400_000).toISOString().slice(5, 10));
  }
  return out;
}

// Photos and videos that ARRIVED recently — newest-added first, within a window
// of whole days counted back from now. Unlike the timeline's sort='added', this
// is bounded by the window itself, so the caller gets an honest total for it:
// the home feed's "Just added" card advertises that number and its viewer pages
// exactly that set.
export function queryGalleryRecentlyAdded(userId: string, libIds: string[], days: number, limit: number): {
  total: number;
  /** The newest arrival's discovered_at — the card's age. Null when none. */
  newestAt: string | null;
  assets: ReturnType<typeof mapAsset>[];
} {
  if (libIds.length === 0) return { total: 0, newestAt: null, assets: [] };
  // Interpolated because SQLite's date modifier is a literal, not a bindable
  // parameter; both numbers are clamped integers, never caller text.
  const windowDays = Math.max(1, Math.min(365, Math.trunc(days)));
  const take = Math.max(1, Math.min(200, Math.trunc(limit)));
  const libIn = inClause(libIds.length);
  const where = `library_items.library_id IN (${libIn})
    AND library_items.deleted_at IS NULL
    AND gallery_details.kind != 'audio'
    AND library_items.discovered_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${windowDays} days')`;

  const summary = db.prepare(`
    SELECT COUNT(*) AS n, MAX(library_items.discovered_at) AS newest
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE ${where}
  `).get(...libIds) as { n: number; newest: string | null };
  if (summary.n === 0) return { total: 0, newestAt: null, assets: [] };

  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS} ${ASSET_JOINS}
    WHERE ${where}
    ORDER BY library_items.discovered_at DESC, library_items.id DESC
    LIMIT ?
  `).all(userId, ...libIds, take) as AssetRow[];

  return { total: summary.n, newestAt: summary.newest, assets: rows.map(mapAsset) };
}

type MemoryRow = AssetRow & { mem_year: string; mem_count: number; mem_exact: number };

export function queryGalleryMemories(userId: string, libIds: string[], today: string, perYear: number): {
  precision: GalleryMemoriesPrecision;
  groups: GalleryMemoryGroup[];
} {
  if (libIds.length === 0) return { precision: "day", groups: [] };
  const libIn = inClause(libIds.length);
  const exactDay = today.slice(5, 10);

  // Day and ±3 days in one pass. Ranking and counting partition on (year, exact)
  // so each year carries a usable count for whichever of the two it ends up
  // shown at, and the ordering puts a year's exact rows ahead of its near ones
  // so the grouping below can simply take the first kind it sees.
  const nearRows = db.prepare(`
    WITH matched AS (
      SELECT ${ASSET_COLUMNS},
        substr(gallery_details.taken_at, 1, 4) AS mem_year,
        CASE WHEN substr(gallery_details.taken_at, 6, 5) = ? THEN 1 ELSE 0 END AS mem_exact
      ${ASSET_JOINS}
      WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
        AND gallery_details.kind != 'audio'
        AND substr(gallery_details.taken_at, 1, 4) < ?
        AND substr(gallery_details.taken_at, 6, 5) IN (${inClause(7)})
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY mem_year, mem_exact ORDER BY taken_at, id) AS mem_rank,
        COUNT(*) OVER (PARTITION BY mem_year, mem_exact) AS mem_count
      FROM matched
    )
    SELECT * FROM ranked WHERE mem_rank <= ? ORDER BY mem_year DESC, mem_exact DESC, mem_rank
  `).all(exactDay, userId, ...libIds, today.slice(0, 4), ...monthDayWindow(today, 3), perYear) as MemoryRow[];

  if (nearRows.length > 0) {
    const groups: GalleryMemoryGroup[] = [];
    const byYear = new Map<number, GalleryMemoryGroup>();
    for (const row of nearRows) {
      const year = Number.parseInt(row.mem_year, 10);
      const group = byYear.get(year);
      if (!group) {
        const fresh: GalleryMemoryGroup = {
          year,
          count: row.mem_count,
          precision: row.mem_exact ? "day" : "near",
          items: [mapAsset(row)]
        };
        byYear.set(year, fresh);
        groups.push(fresh);
        continue;
      }
      // Exact rows come first within a year, so a year that has any is already a
      // "day" group and its looser neighbours are not part of the anniversary.
      if (group.precision === "day" && !row.mem_exact) continue;
      group.items.push(mapAsset(row));
    }
    // The row is titled by the best match in it: one year being a couple of days
    // out does not stop the others from being on this day.
    const precision = groups.some((group) => group.precision === "day") ? "day" : "near";
    return { precision, groups };
  }

  // Nothing anywhere near today — offer the month instead, all years alike.
  const monthRows = db.prepare(`
    WITH matched AS (
      SELECT ${ASSET_COLUMNS},
        substr(gallery_details.taken_at, 1, 4) AS mem_year,
        ROW_NUMBER() OVER (
          PARTITION BY substr(gallery_details.taken_at, 1, 4)
          ORDER BY gallery_details.taken_at, library_items.id
        ) AS mem_rank,
        COUNT(*) OVER (PARTITION BY substr(gallery_details.taken_at, 1, 4)) AS mem_count
      ${ASSET_JOINS}
      WHERE library_items.library_id IN (${libIn}) AND library_items.deleted_at IS NULL
        AND gallery_details.kind != 'audio'
        AND substr(gallery_details.taken_at, 1, 4) < ?
        AND substr(gallery_details.taken_at, 6, 2) = ?
    )
    SELECT * FROM matched WHERE mem_rank <= ? ORDER BY mem_year DESC, mem_rank
  `).all(userId, ...libIds, today.slice(0, 4), today.slice(5, 7), perYear) as (AssetRow & { mem_year: string; mem_count: number })[];
  if (monthRows.length === 0) return { precision: "day", groups: [] };

  const groups: GalleryMemoryGroup[] = [];
  for (const row of monthRows) {
    const year = Number.parseInt(row.mem_year, 10);
    const last = groups[groups.length - 1];
    if (last && last.year === year) last.items.push(mapAsset(row));
    else groups.push({ year, count: row.mem_count, precision: "month", items: [mapAsset(row)] });
  }
  return { precision: "month", groups };
}
