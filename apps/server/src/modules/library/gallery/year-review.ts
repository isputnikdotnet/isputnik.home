// "2026 in review" — a year's best photos and videos, proposed as a slideshow.
//
// The signal is the heart (`item_saves`), collected casually all year long from the
// lightbox and the multi-select bar. This turns a year of those taps into a film.
//
// Like memories.ts, nothing here is persisted: this returns PROPOSED slideshows in
// the same shape the suggestion row already renders, and the user saves one through
// the normal create-slideshow path (sourceKind 'memory', sourceRef 'year-2026').
//
// The whole difficulty is not ranking, it's COVERAGE. Sorting a year by likes and
// taking the top 60 gives you a film about the one week everyone was tapping — the
// summer trip — and nothing else. So the year is cut into months first, each month
// gets a guaranteed share of the slots, and the ranking only decides what fills them.
// A year should read as a year.
import { db } from "../../../db.js";
import { pickVisuallyDistinct } from "./similarity.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export interface YearReviewSuggestion {
  // Same shape as MemorySuggestion (memories.ts) so the suggestion row, the preview
  // modal and the create-slideshow call all work on it unchanged.
  id: string;
  title: string;
  subtitle: string;
  coverUrl: string | null;
  count: number;
  itemIds: string[];
  year: number;
}

interface YearItemRow {
  id: string;
  taken_at: string;
  kind: string;
  gps_lat: number | null;
  gps_lng: number | null;
  cover: string | null;
  phash: string | null;
  likes: number;
  mine: number;
}

interface Candidate extends YearItemRow {
  score: number;
  people: string[];
}

// A year needs at least this many distinct items to be worth proposing at all.
const MIN_ITEMS = 12;
// Slides in the finished film. 60 at the default 4s dwell is about four minutes —
// long enough to feel like a year, short enough that people watch to the end.
const MAX_ITEMS = 60;
// Videos carry their own length (up to VIDEO_CAP = 20s each in slideshow-render.ts),
// so a film that is one third video runs far longer than its slide count suggests.
const MAX_VIDEO_SHARE = 0.2;
// Per month, how deep the ranking is allowed to look before the balancing pass. A
// month of 4000 photos does not need all 4000 walked to find its best half-dozen.
const MONTH_POOL = 200;

// A heart outranks everything else on purpose: one person liking a photo (6) beats
// the best score any un-liked photo can reach (~5.5), so likes always make the
// film and the other signals only decide what backfills the empty months.
const WEIGHT_LIKE = 6;      // per household member who liked it
const WEIGHT_MINE = 3;      // the viewer's own heart, on top of the above
const WEIGHT_PERSON = 1.5;  // per named face, up to three
const WEIGHT_GPS = 1;       // went somewhere
// How hard to push back on a person who is already all over the film. Roughly one
// heart's worth by the third repeat — enough to break a tie, not enough to drop a
// genuinely loved photo.
const PERSON_FATIGUE = 1.2;

// Named people per item for one year, in a single query — a correlated subquery per
// row would be thousands of statements, and an `IN (...)` over a year's item ids
// would blow the placeholder limit. Auto-clusters carry an empty name and are
// skipped: an unnamed cluster says nothing about who the year was about.
function peopleByItem(libIds: string[], year: string): Map<string, string[]> {
  const rows = db.prepare(`
    SELECT gallery_faces.item_id AS item_id, gallery_people.name AS name
    FROM gallery_faces
    JOIN gallery_people ON gallery_people.id = gallery_faces.person_id
    JOIN library_items ON library_items.id = gallery_faces.item_id
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.library_id IN (${inClause(libIds.length)})
      AND library_items.deleted_at IS NULL
      AND substr(gallery_details.taken_at, 1, 4) = ?
      AND gallery_people.hidden = 0
      AND gallery_people.name != ''
      AND gallery_faces.assignment IN ('confirmed', 'auto', 'suggested')
  `).all(...libIds, year) as { item_id: string; name: string }[];

  const map = new Map<string, string[]>();
  for (const row of rows) {
    const names = map.get(row.item_id);
    if (names) { if (!names.includes(row.name)) names.push(row.name); }
    else map.set(row.item_id, [row.name]);
  }
  return map;
}

// Slots per month: every month that has anything gets one, then the rest go out in
// proportion to sqrt(liked items). sqrt, not the raw count, because the point is
// to let an eventful month be bigger — not to let it be the whole film.
function allocate(monthSizes: Map<string, number>, monthLiked: Map<string, number>, total: number): Map<string, number> {
  const months = [...monthSizes.keys()];
  const slots = new Map(months.map((m) => [m, 1]));
  let remaining = total - months.length;
  if (remaining <= 0) return slots;

  const weights = new Map(months.map((m) => [m, Math.sqrt((monthLiked.get(m) ?? 0) + 1)]));
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);

  // Hand out the whole-number share first, then the leftovers (from rounding down)
  // to the months with the most left on the table — so `total` is actually reached.
  const fractions: { month: string; frac: number }[] = [];
  for (const month of months) {
    const exact = (remaining * (weights.get(month) ?? 0)) / totalWeight;
    const whole = Math.min(Math.floor(exact), (monthSizes.get(month) ?? 0) - 1);
    slots.set(month, (slots.get(month) ?? 0) + Math.max(0, whole));
    fractions.push({ month, frac: exact - Math.floor(exact) });
  }
  let left = total - [...slots.values()].reduce((a, b) => a + b, 0);
  for (const { month } of fractions.sort((a, b) => b.frac - a.frac)) {
    if (left <= 0) break;
    if ((slots.get(month) ?? 0) >= (monthSizes.get(month) ?? 0)) continue;
    slots.set(month, (slots.get(month) ?? 0) + 1);
    left -= 1;
  }
  return slots;
}

// Pick `count` items from one month: best-first, near-duplicates folded away, and a
// growing penalty for whoever is already dominating the film.
function pickFromMonth(pool: Candidate[], count: number, seen: Map<string, number>, videoBudget: { left: number }): Candidate[] {
  // Highest score first so that when pickVisuallyDistinct keeps the FIRST of a burst
  // (its documented behaviour), the one it keeps is the burst's best frame.
  const ranked = [...pool].sort((a, b) => b.score - a.score || a.taken_at.localeCompare(b.taken_at));
  const distinct = pickVisuallyDistinct(ranked.slice(0, MONTH_POOL));

  const picked: Candidate[] = [];
  const remaining = [...distinct];
  while (picked.length < count && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const item = remaining[i];
      if (item.kind === "video" && videoBudget.left <= 0) continue;
      // Fatigue is measured on this item's most over-represented person, not the sum:
      // a group shot of four people shouldn't be punished four times over.
      const fatigue = item.people.reduce((worst, name) => Math.max(worst, seen.get(name) ?? 0), 0);
      const value = item.score - fatigue * PERSON_FATIGUE;
      if (value > bestValue) { bestValue = value; bestIndex = i; }
    }
    if (bestValue === -Infinity) break; // nothing left but videos, and the budget is spent
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen.kind === "video") videoBudget.left -= 1;
    for (const name of chosen.people) seen.set(name, (seen.get(name) ?? 0) + 1);
    picked.push(chosen);
  }
  return picked;
}

function subtitleFor(items: Candidate[], monthCount: number, people: string[]): string {
  const videos = items.filter((i) => i.kind === "video").length;
  const photos = items.length - videos;
  const parts: string[] = [];
  if (photos > 0) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  if (videos > 0) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  const head = parts.join(" & ") || `${items.length} items`;
  const across = `${monthCount} month${monthCount === 1 ? "" : "s"}`;
  if (people.length === 0) return `${head} · ${across}`;
  if (people.length === 1) return `${head} · ${across} · with ${people[0]}`;
  return `${head} · ${across} · with ${people[0]} & ${people[1]}`;
}

// The years worth offering, newest first: those with enough distinct material in the
// viewer's accessible libraries.
export function galleryReviewableYears(libIds: string[]): number[] {
  if (libIds.length === 0) return [];
  const rows = db.prepare(`
    SELECT substr(gallery_details.taken_at, 1, 4) AS year, COUNT(*) AS n
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.library_id IN (${inClause(libIds.length)})
      AND library_items.deleted_at IS NULL
      AND gallery_details.taken_at IS NOT NULL
    GROUP BY year
    HAVING n >= ?
    ORDER BY year DESC
  `).all(...libIds, MIN_ITEMS) as { year: string; n: number }[];
  return rows.map((row) => Number(row.year)).filter((year) => Number.isFinite(year) && year > 1800);
}

export function buildYearReview(libIds: string[], userId: string, year: number, opts: { maxItems?: number } = {}): YearReviewSuggestion | null {
  if (libIds.length === 0) return null;
  const maxItems = Math.min(Math.max(opts.maxItems ?? MAX_ITEMS, MIN_ITEMS), 200);
  const yearKey = String(year);

  const rows = db.prepare(`
    SELECT
      library_items.id AS id,
      gallery_details.taken_at AS taken_at,
      gallery_details.kind AS kind,
      gallery_details.gps_lat AS gps_lat,
      gallery_details.gps_lng AS gps_lng,
      gallery_details.phash AS phash,
      item_metadata.cover_storage_key AS cover,
      (SELECT COUNT(*) FROM item_saves s WHERE s.item_id = library_items.id) AS likes,
      (SELECT COUNT(*) FROM item_saves s WHERE s.item_id = library_items.id AND s.user_id = ?) AS mine
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.library_id IN (${inClause(libIds.length)})
      AND library_items.deleted_at IS NULL
      AND substr(gallery_details.taken_at, 1, 4) = ?
    ORDER BY datetime(gallery_details.taken_at) ASC, library_items.id ASC
  `).all(userId, ...libIds, yearKey) as YearItemRow[];
  if (rows.length < MIN_ITEMS) return null;

  const people = peopleByItem(libIds, yearKey);
  const candidates: Candidate[] = rows.map((row) => {
    const names = people.get(row.id) ?? [];
    const score =
      row.likes * WEIGHT_LIKE +
      (row.mine > 0 ? WEIGHT_MINE : 0) +
      Math.min(names.length, 3) * WEIGHT_PERSON +
      (row.gps_lat != null && row.gps_lng != null ? WEIGHT_GPS : 0);
    return { ...row, score, people: names };
  });

  // Bucket by calendar month, so coverage is decided before ranking is.
  const byMonth = new Map<string, Candidate[]>();
  for (const item of candidates) {
    const month = item.taken_at.slice(5, 7);
    const bucket = byMonth.get(month);
    if (bucket) bucket.push(item);
    else byMonth.set(month, [item]);
  }
  const monthSizes = new Map([...byMonth].map(([m, items]) => [m, items.length]));
  const monthLiked = new Map([...byMonth].map(([m, items]) => [m, items.filter((i) => i.likes > 0).length]));
  const slots = allocate(monthSizes, monthLiked, maxItems);

  // Walked in calendar order so the fatigue counter accumulates the way the film
  // actually plays — January's faces are what make February's feel repetitive.
  const seen = new Map<string, number>();
  // The share is of the film that will actually exist, not of the slot target: a
  // thin year fills far fewer than `maxItems`, and budgeting against the target
  // there lets video run away with most of the RUNNING TIME (a 20s clip is five
  // slides' worth). rows.length over-counts slightly — near-duplicates are folded
  // later — which only ever makes the cap stricter.
  const videoBudget = { left: Math.max(1, Math.round(Math.min(maxItems, rows.length) * MAX_VIDEO_SHARE)) };
  const chosen: Candidate[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    chosen.push(...pickFromMonth(byMonth.get(month) ?? [], slots.get(month) ?? 0, seen, videoBudget));
  }
  if (chosen.length < MIN_ITEMS) return null;

  chosen.sort((a, b) => a.taken_at.localeCompare(b.taken_at) || a.id.localeCompare(b.id));

  // Who the year was about, by how often they appear in what was actually chosen.
  const tally = new Map<string, number>();
  for (const item of chosen) for (const name of item.people) tally.set(name, (tally.get(name) ?? 0) + 1);
  const topPeople = [...tally.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([name]) => name);

  const cover = [...chosen].sort((a, b) => b.score - a.score).find((item) => item.cover)?.cover ?? null;
  const monthsCovered = new Set(chosen.map((item) => item.taken_at.slice(5, 7))).size;
  // A year still running gets an honest title — "2026 in review" in March is a lie
  // about what it contains.
  const inProgress = year === new Date().getFullYear();

  return {
    id: `year-${year}`,
    title: inProgress ? `${year} so far` : `${year} in review`,
    subtitle: subtitleFor(chosen, monthsCovered, topPeople),
    coverUrl: cover ? `/api/library/covers/${cover}` : null,
    count: chosen.length,
    itemIds: chosen.map((item) => item.id),
    year
  };
}

// The year cards to offer, newest first. `limit` years back from the most recent one
// with material — the current year included, honestly labelled.
export function suggestYearReviews(libIds: string[], userId: string, opts: { limit?: number; maxItems?: number } = {}): YearReviewSuggestion[] {
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 12);
  const out: YearReviewSuggestion[] = [];
  for (const year of galleryReviewableYears(libIds)) {
    if (out.length >= limit) break;
    const review = buildYearReview(libIds, userId, year, { maxItems: opts.maxItems });
    if (review) out.push(review);
  }
  return out;
}
