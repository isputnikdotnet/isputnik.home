
const inClause = (n: number) => Array(n).fill("?").join(", ");

// One display string per camera, shared by the facet list and the filter WHERE so
// the two always agree. Models usually embed the make ("Canon EOS 400D"), so the
// make is only prepended when the model doesn't already start with it.
export const CAMERA_SQL = `
  CASE
    WHEN gallery_details.camera_model IS NULL THEN gallery_details.camera_make
    WHEN gallery_details.camera_make IS NULL THEN gallery_details.camera_model
    WHEN instr(lower(gallery_details.camera_model), lower(gallery_details.camera_make)) = 1 THEN gallery_details.camera_model
    ELSE gallery_details.camera_make || ' ' || gallery_details.camera_model
  END`;

// File-size buckets (the audiobook length buckets, for bytes). Boundaries are
// binary megabytes; each code maps to a half-open [min, max) range on
// gallery_details.size.
const MIB = 1024 * 1024;
const SIZE_BUCKETS: Record<string, { min: number; max: number | null }> = {
  small: { min: 0, max: MIB },            // under 1 MB
  medium: { min: MIB, max: 5 * MIB },     // 1–5 MB
  large: { min: 5 * MIB, max: 25 * MIB }, // 5–25 MB
  huge: { min: 25 * MIB, max: null }      // 25 MB+
};

// Advanced filters (mirrors the audiobook catalog's filter arrays): every list is
// OR within itself and AND against the others. `location` takes the codes
// 'with_gps' / 'no_gps' — selecting both is the same as selecting neither. The one
// exception is `people`: `peopleMatch` switches it from OR ("any of these people")
// to AND ("all of these people, together in the same photo").
export interface GalleryTimelineFilters {
  people: string[];   // gallery_people names (named face groups / manual tags)
  peopleMatch?: "any" | "all";
  tags: string[];     // tag display names
  years: string[];    // 'YYYY' from taken_at
  months: string[];   // 'MM' (01–12) from taken_at, any year
  taken: string[];    // date-taken bounds: 'from:YYYY-MM-DD' / 'to:YYYY-MM-DD' (inclusive)
  cameras: string[];  // CAMERA_SQL display strings
  sizes: string[];    // SIZE_BUCKETS codes: small | medium | large | huge
  location: string[]; // 'with_gps' | 'no_gps'
  likes: string[]; // LIKE_SQL codes: mine | anyone | none
}

export const EMPTY_GALLERY_FILTERS: GalleryTimelineFilters = {
  people: [], peopleMatch: "any", tags: [], years: [], months: [], taken: [], cameras: [], sizes: [], location: [], likes: []
};

// The Likes facet. `item_saves` is already LEFT JOINed for the `saved` column,
// but the COUNT(*) half of a timeline query doesn't carry that join — so these are
// EXISTS subqueries, which read the same on both. 'mine' takes the viewer's id; the
// other two are viewer-independent ("someone in the house liked it"), which is
// the signal the year-in-review scores on (see year-review.ts).
const LIKE_SQL: Record<string, { sql: string; needsUser: boolean }> = {
  mine:   { sql: "EXISTS (SELECT 1 FROM item_saves s WHERE s.item_id = library_items.id AND s.user_id = ?)", needsUser: true },
  anyone: { sql: "EXISTS (SELECT 1 FROM item_saves s WHERE s.item_id = library_items.id)", needsUser: false },
  none:   { sql: "NOT EXISTS (SELECT 1 FROM item_saves s WHERE s.item_id = library_items.id)", needsUser: false }
};
const LIKE_ORDER = ["mine", "anyone", "none"];

export function galleryFilterClauses(filters: GalleryTimelineFilters, userId: string): { clauses: string[]; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filters.people.length > 0) {
    if (filters.peopleMatch === "all") {
      // AND, not OR: one EXISTS per person, so a match needs every one of them
      // tagged on the SAME item — a single IN(...) can't express co-occurrence.
      for (const name of filters.people) {
        clauses.push(`EXISTS (
          SELECT 1 FROM gallery_faces gf JOIN gallery_people gp ON gp.id = gf.person_id
          WHERE gf.item_id = library_items.id AND gf.assignment != 'rejected' AND gp.name = ?)`);
        args.push(name);
      }
    } else {
      clauses.push(`EXISTS (
        SELECT 1 FROM gallery_faces gf JOIN gallery_people gp ON gp.id = gf.person_id
        WHERE gf.item_id = library_items.id AND gf.assignment != 'rejected' AND gp.name IN (${inClause(filters.people.length)}))`);
      args.push(...filters.people);
    }
  }
  if (filters.tags.length > 0) {
    clauses.push(`EXISTS (
      SELECT 1 FROM taggables JOIN tags ON tags.id = taggables.tag_id
      WHERE taggables.entity_type = 'library_item' AND taggables.entity_id = library_items.id
        AND tags.display_name IN (${inClause(filters.tags.length)}))`);
    args.push(...filters.tags);
  }
  if (filters.years.length > 0) {
    clauses.push(`substr(gallery_details.taken_at, 1, 4) IN (${inClause(filters.years.length)})`);
    args.push(...filters.years);
  }
  if (filters.months.length > 0) {
    clauses.push(`substr(gallery_details.taken_at, 6, 2) IN (${inClause(filters.months.length)})`);
    args.push(...filters.months);
  }
  // Inclusive date bounds on the calendar day of taken_at. Comparing the date
  // prefix keeps both ends inclusive whatever the stored time-of-day is; an asset
  // with no taken_at compares NULL and drops out, which is what a date filter means.
  for (const bound of filters.taken) {
    if (bound.startsWith("from:")) {
      clauses.push("substr(gallery_details.taken_at, 1, 10) >= ?");
      args.push(bound.slice(5));
    } else if (bound.startsWith("to:")) {
      clauses.push("substr(gallery_details.taken_at, 1, 10) <= ?");
      args.push(bound.slice(3));
    }
  }
  if (filters.cameras.length > 0) {
    clauses.push(`${CAMERA_SQL} IN (${inClause(filters.cameras.length)})`);
    args.push(...filters.cameras);
  }
  const buckets = filters.sizes.map((code) => SIZE_BUCKETS[code]).filter(Boolean);
  if (buckets.length > 0) {
    clauses.push(`(${buckets.map((b) =>
      b.max == null ? "gallery_details.size >= ?" : "(gallery_details.size >= ? AND gallery_details.size < ?)"
    ).join(" OR ")})`);
    for (const b of buckets) {
      args.push(b.min);
      if (b.max != null) args.push(b.max);
    }
  }
  const withGps = filters.location.includes("with_gps");
  const noGps = filters.location.includes("no_gps");
  if (withGps !== noGps) {
    clauses.push(withGps
      ? "gallery_details.gps_lat IS NOT NULL AND gallery_details.gps_lng IS NOT NULL"
      : "(gallery_details.gps_lat IS NULL OR gallery_details.gps_lng IS NULL)");
  }
  // OR within the facet, like every other list here. Walked in a fixed order so the
  // placeholders and the args pushed for them can't drift apart. Selecting all three
  // means "everything", which is the same as selecting none — so it drops out.
  const likes = LIKE_ORDER.filter((code) => filters.likes.includes(code));
  if (likes.length > 0 && likes.length < LIKE_ORDER.length) {
    clauses.push(`(${likes.map((code) => LIKE_SQL[code].sql).join(" OR ")})`);
    for (const code of likes) {
      if (LIKE_SQL[code].needsUser) args.push(userId);
    }
  }
  return { clauses, args };
}
