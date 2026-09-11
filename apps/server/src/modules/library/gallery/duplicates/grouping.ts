import { db } from "../../../../db.js";

// ────────────────────────────────────────────────────────────────────────────
//  Grouping
// ────────────────────────────────────────────────────────────────────────────

function ignoredPairs(): Set<string> {
  const rows = db.prepare("SELECT item_a, item_b FROM gallery_duplicate_ignores").all() as { item_a: string; item_b: string }[];
  return new Set(rows.map((r) => `${r.item_a}|${r.item_b}`));
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ── Perceptual fingerprints (tier 2) ────────────────────────────────────────
//
// similarity.ts already has hex-dHash helpers, but its popcount walks bits on a BigInt.
// That is fine for the few hundred items the memory picker compares and far too slow for
// the millions of comparisons banding produces, so parse once into two 32-bit halves and
// use the SWAR popcount. similarity.ts is left alone — Memories depends on it.
interface Fingerprint { hi: number; lo: number }

function parseFingerprint(hex: string | null): Fingerprint | null {
  if (!hex || !/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
  const padded = hex.padStart(16, "0");
  const hi = Number.parseInt(padded.slice(0, 8), 16);
  const lo = Number.parseInt(padded.slice(8), 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

// Same picture, different file: a resized, re-compressed or re-exported copy. In
// practice those land 0–3 bits from the original.
//
// This is NOT similarity.ts's NEAR_DUPLICATE_DISTANCE (10/64). That one deliberately
// folds a whole burst into one representative for Memories — a different question, and
// far too loose to propose deleting anything.
export const NEAR_IDENTICAL_DISTANCE = 3;

// The 64-bit hash is split into 4 x 16-bit bands. Any two hashes differing by at most
// BAND_COUNT - 1 bits must, by pigeonhole, leave at least one band untouched — so
// comparing only within band buckets misses NOTHING at distance 3. Raising
// NEAR_IDENTICAL_DISTANCE without raising BAND_COUNT would silently start missing pairs,
// so that mistake fails at load instead.
const BAND_COUNT = 4;
if (NEAR_IDENTICAL_DISTANCE > BAND_COUNT - 1) {
  throw new Error(`NEAR_IDENTICAL_DISTANCE (${NEAR_IDENTICAL_DISTANCE}) needs more than ${BAND_COUNT} bands`);
}

/** Hamming distance between two fingerprints — how many of the 64 bits differ. */
function fingerprintDistance(a: Fingerprint, b: Fingerprint): number {
  return popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo);
}

function bandsOf(print: Fingerprint): number[] {
  return [print.hi >>> 16, print.hi & 0xffff, print.lo >>> 16, print.lo & 0xffff];
}

// Components over an explicit edge list (tier 2 links specific pairs, rather than tier
// 1's "everything sharing a digest").
function componentsFromEdges(edges: [string, string][]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) { const next = parent.get(id)!; parent.set(id, root); id = next; }
    return root;
  };
  for (const [a, b] of edges) {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of [...parent.keys()]) {
    const root = find(id);
    const bucket = groups.get(root);
    if (bucket) bucket.push(id); else groups.set(root, [id]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

// Split a candidate set into components over the pairs that are NOT dismissed. For an
// exact group every pair matches, so one dismissal only breaks the set apart when it
// disconnects it — dismissing A/B in {A,B,C} still leaves all three linked through C,
// which is correct: they really are the same bytes.
export function connectedComponents(ids: string[], ignored: Set<string>): string[][] {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) { const next = parent.get(id)!; parent.set(id, root); id = next; }
    return root;
  };
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (ignored.has(pairKey(ids[i], ids[j]))) continue;
      const [ra, rb] = [find(ids[i]), find(ids[j])];
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const bucket = groups.get(root);
    if (bucket) bucket.push(id); else groups.set(root, [id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export interface NearGrouping {
  /** Sets of two or more ids that are all within the near distance of each other. */
  components: string[][];
  /** Bits between two of the fingerprints; 0 when either could not be parsed. */
  distance: (a: string, b: string) => number;
}

/** Group ids whose 64-bit fingerprints sit within NEAR_IDENTICAL_DISTANCE of each other.
 *
 *  Shared by the cache tier below and the cleanup job's snapshot, so there is exactly
 *  one banding implementation to keep in step with the threshold. That matters more than
 *  usual here: the bucketing is only lossless because 4 bands of 16 bits mean any pair
 *  within 3 bits must leave one band untouched, and a second copy of this loop would be
 *  a second place for that invariant to be broken quietly.
 *
 *  Rows with no fingerprint — every video, and photos the scan has not backfilled — are
 *  simply absent from the result rather than grouped on a guess. */
export interface NearGroupingOptions {
  /** Asymmetric mode (the Photo Inbox check): a pair is only linked when at least
   *  one side is a candidate, so the collection is never compared with itself.
   *  Absent = every pair may link. */
  candidates?: Set<string>;
  /** Extra fingerprints an item may ALSO be matched on — the Inbox check hashes an
   *  incoming scan turned 90/180/270°, so a print fed in sideways still finds its
   *  upright twin. The distance reported is the best over all of them. Variants
   *  take part in bucketing, so the band invariant holds for them too. */
  variants?: Map<string, string[]>;
}

export function groupNearIdentical(
  rows: { itemId: string; phash: string | null }[],
  ignored: Set<string> = new Set(),
  /** A last say on whether a matching pair may actually be linked. The fingerprint
   *  says two pictures LOOK alike; a caller with more context — dimensions, when each
   *  was taken — can use this to refuse a pair it can tell apart. Defaults to
   *  accepting everything, which is what the cache tier wants. */
  linkable: (a: string, b: string) => boolean = () => true,
  options: NearGroupingOptions = {}
): NearGrouping {
  // Every fingerprint an item answers to: its own first, then any variants.
  const prints = new Map<string, Fingerprint[]>();
  for (const row of rows) {
    const own = parseFingerprint(row.phash);
    const extra = (options.variants?.get(row.itemId) ?? [])
      .map(parseFingerprint)
      .filter((print): print is Fingerprint => print != null);
    const all = own ? [own, ...extra] : extra;
    if (all.length > 0) prints.set(row.itemId, all);
  }
  const bestDistance = (a: string, b: string): number => {
    const fa = prints.get(a);
    const fb = prints.get(b);
    if (!fa || !fb) return 0;
    let best = Number.POSITIVE_INFINITY;
    for (const pa of fa) for (const pb of fb) best = Math.min(best, fingerprintDistance(pa, pb));
    return best;
  };
  const mayLink = (a: string, b: string): boolean =>
    !options.candidates || options.candidates.has(a) || options.candidates.has(b);

  // Bucket by (band index, band value); only items sharing a bucket are ever compared.
  const buckets = new Map<string, string[]>();
  for (const [id, all] of prints) {
    const seen = new Set<string>();
    for (const print of all) {
      bandsOf(print).forEach((band, index) => {
        const key = `${index}:${band}`;
        if (seen.has(key)) return;
        seen.add(key);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(id); else buckets.set(key, [id]);
      });
    }
  }

  const edges: [string, string][] = [];
  const compared = new Set<string>(); // a pair can share several bands
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const key = pairKey(bucket[i], bucket[j]);
        if (compared.has(key)) continue;
        compared.add(key);
        if (ignored.has(key)) continue;
        if (!mayLink(bucket[i], bucket[j])) continue;
        if (bestDistance(bucket[i], bucket[j]) > NEAR_IDENTICAL_DISTANCE) continue;
        if (!linkable(bucket[i], bucket[j])) continue;
        edges.push([bucket[i], bucket[j]]);
      }
    }
  }

  return {
    components: componentsFromEdges(edges),
    distance: bestDistance
  };
}

/** "These two are not duplicates", as pairs. Exported so the cleanup job's snapshot
 *  honours the same standing decisions this module's tiers do. */
export const duplicateIgnorePairs = (): Set<string> => ignoredPairs();
/** How a pair is spelled in that set — so a caller checking one pair spells it the same. */
export const duplicatePairKey = pairKey;

// ────────────────────────────────────────────────────────────────────────────
//  Reading groups
// ────────────────────────────────────────────────────────────────────────────

// ── Searching and paging the sets ───────────────────────────────────────────
//
// The page used to receive every set it had found and do the filtering, sorting and
// paging itself. On a library with thousands of duplicates that is a response
// describing tens of thousands of photos, rebuilt on every load and every three
// seconds during a scan, to show twenty-five of them.
//
// The work splits in two. Deciding WHICH sets match and in what order needs only a
// handful of cheap columns per copy — path, title, library, kind, size, keeper. What
// a card actually renders — covers, dimensions, EXIF, the nine link counts — is
// needed for one page. So the lean pass runs over everything and the expensive one
// runs over twenty-five.
//
// The filtering and scoping below is a straight port of what the page did, kept
// deliberately as the same shape of code rather than rewritten into SQL: this is what
// decides which sets a bulk delete touches, and a clever rewrite that drifts by one
// set is a photo nobody meant to delete.
