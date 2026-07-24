// On-demand "Memories": cluster the viewer's accessible gallery items into candidate
// moments (a day at the beach, a weekend trip) and return the strongest as PROPOSED
// slideshows — nothing is persisted until the user saves one (see
// docs/gallery-slideshows-proposal.md, Phase 3). Pure SQL + a scoring pass over
// columns already indexed (taken_at, gps_lat/lng, gallery_faces→gallery_people); no
// ML, no new tables, no background job. The shipped date-only "On this day" endpoint
// stays as-is; this is the richer, slideshow-oriented surface.
import { db } from "../../../db.js";
import { pickVisuallyDistinct } from "./similarity.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export interface MemorySuggestion {
  // Stable-ish per the first item, so the same moment keeps its identity across calls.
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string | null;
  count: number;
  itemIds: string[];
}

interface ItemRow {
  id: string;
  taken_at: string;
  gps_lat: number | null;
  gps_lng: number | null;
  cover: string | null;
  phash: string | null;
}

// A moment breaks when photos are more than GAP_MS apart, and never spans more than
// MAX_SPAN_MS (so a year of daily photos in one place doesn't fuse into one blob).
// A candidate needs at least MIN_ITEMS to be worth a slideshow; the montage caps at
// MAX_ITEMS (evenly sampled across the moment).
const GAP_MS = 5 * 60 * 60 * 1000;
const MAX_SPAN_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_ITEMS = 6;
const MAX_ITEMS = 40;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Pull Y/M/D straight from the stored ISO prefix rather than `new Date()` — taken_at
// is the photo's local wall-clock and must not drift through the server's timezone.
function ymd(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

// Human title for a moment's date span: one day, a range within a month, across
// months, or across years.
function titleForRange(startIso: string, endIso: string): string {
  const a = ymd(startIso);
  const b = ymd(endIso);
  if (!a || !b) return "A moment";
  const ma = MONTHS[a.m - 1] ?? "";
  const mb = MONTHS[b.m - 1] ?? "";
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${ma} ${a.d}, ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${ma} ${a.d}–${b.d}, ${a.y}`;
  if (a.y === b.y) return `${ma} ${a.d} – ${mb} ${b.d}, ${a.y}`;
  return `${ma} ${a.y} – ${mb} ${b.y}`;
}

// Evenly sample down to `max` items, preserving chronological order (a spread across
// the whole moment makes a better montage than the first N).
function sampleEvenly<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(arr[Math.floor(i * step)]);
  return out;
}

// Top user-NAMED people across a set of items, for the subtitle ("with Emma & Lucas").
// Auto-clusters carry an empty name, so `name != ''` keeps generated clusters out.
function namedPeopleFor(itemIds: string[]): string[] {
  if (itemIds.length === 0) return [];
  return (db.prepare(`
    SELECT gallery_people.name AS name, COUNT(DISTINCT gallery_faces.item_id) AS n
    FROM gallery_faces
    JOIN gallery_people ON gallery_people.id = gallery_faces.person_id
    WHERE gallery_faces.item_id IN (${inClause(itemIds.length)})
      AND gallery_people.hidden = 0
      AND gallery_people.name != ''
      AND gallery_faces.assignment IN ('confirmed', 'auto', 'suggested')
    GROUP BY gallery_people.id
    HAVING n >= 2
    ORDER BY n DESC, gallery_people.name ASC
    LIMIT 2
  `).all(...itemIds) as { name: string; n: number }[]).map((row) => row.name);
}

function joinPeople(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return ` · with ${names[0]}`;
  return ` · with ${names[0]} & ${names[1]}`;
}

// The cover is a photo near the middle of the moment that actually has a thumbnail
// (search outward from the centre so we don't fail on a missing-cover middle item).
function coverKeyFor(cluster: ItemRow[]): string | null {
  const mid = Math.floor(cluster.length / 2);
  for (let d = 0; d <= cluster.length; d += 1) {
    const after = cluster[mid + d];
    if (after?.cover) return after.cover;
    const before = cluster[mid - d];
    if (before?.cover) return before.cover;
  }
  return null;
}

export function suggestGalleryMemories(libIds: string[], opts: { limit?: number } = {}): MemorySuggestion[] {
  if (libIds.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 40);

  const rows = db.prepare(`
    SELECT library_items.id AS id, gallery_details.taken_at AS taken_at,
           gallery_details.gps_lat AS gps_lat, gallery_details.gps_lng AS gps_lng,
           item_metadata.cover_storage_key AS cover, gallery_details.phash AS phash
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.library_id IN (${inClause(libIds.length)})
      AND library_items.deleted_at IS NULL
      AND gallery_details.taken_at IS NOT NULL
    ORDER BY datetime(gallery_details.taken_at) ASC, library_items.id ASC
  `).all(...libIds) as ItemRow[];
  if (rows.length < MIN_ITEMS) return [];

  // Split the chronological stream into moments on time gaps, capping each moment's
  // total span.
  const clusters: ItemRow[][] = [];
  let cur: ItemRow[] = [];
  let clusterStart = 0;
  let prevTime = 0;
  for (const row of rows) {
    const t = Date.parse(row.taken_at);
    if (Number.isNaN(t)) continue;
    if (cur.length === 0) { cur = [row]; clusterStart = t; prevTime = t; continue; }
    if (t - prevTime <= GAP_MS && t - clusterStart <= MAX_SPAN_MS) {
      cur.push(row);
    } else {
      clusters.push(cur);
      cur = [row];
      clusterStart = t;
    }
    prevTime = t;
  }
  if (cur.length > 0) clusters.push(cur);

  const nowMs = Date.now();
  const scored = clusters
    // Fold near-duplicate shots (bursts, re-takes — see similarity.ts) down to one
    // representative each BEFORE size checks: a 30-frame burst of one scene is not a
    // slideshow-worthy moment, and everything below (score, sample, count, cover)
    // should describe distinct photos. Unhashed photos and videos always survive.
    .map((c) => pickVisuallyDistinct(c))
    .filter((c) => c.length >= MIN_ITEMS)
    .map((c) => {
      const end = Date.parse(c[c.length - 1].taken_at);
      const geo = c.filter((r) => r.gps_lat != null && r.gps_lng != null).length;
      const hasGps = geo >= c.length / 2;
      const ageMonths = Math.max(0, (nowMs - end) / (30 * 24 * 60 * 60 * 1000));
      // Reward bigger moments, geotagged ones, and — gently — more recent ones, so
      // the surface is a mix of "this looks like an event" not just "the newest".
      const score = c.length + (hasGps ? 6 : 0) + Math.max(0, 36 - ageMonths) * 0.4;
      return { cluster: c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ cluster }) => {
    const items = sampleEvenly(cluster, MAX_ITEMS);
    const itemIds = items.map((r) => r.id);
    const people = namedPeopleFor(itemIds);
    const coverKey = coverKeyFor(cluster);
    const count = cluster.length;
    return {
      id: `mem-${cluster[0].id}`,
      title: titleForRange(cluster[0].taken_at, cluster[cluster.length - 1].taken_at),
      subtitle: `${count} photo${count === 1 ? "" : "s"}${joinPeople(people)}`,
      coverUrl: coverKey ? `/api/library/covers/${coverKey}` : null,
      count,
      itemIds
    };
  });
}
