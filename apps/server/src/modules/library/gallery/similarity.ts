// Visual-similarity helpers over precomputed dHash fingerprints (media.ts
// computeDhash → gallery_details.phash). Pure bit math — no sharp, no I/O — so the
// memory-suggestion path (memories.ts) stays cheap and this stays trivially testable.

// Two photos whose 64-bit dHashes differ in at most this many bits look like the same
// shot (burst frames, re-takes, tiny reframings). 10/64 is the conventional dHash
// near-duplicate window: low enough that different scenes at the same spot survive,
// high enough to fold a burst into one representative.
export const NEAR_DUPLICATE_DISTANCE = 10;

function parseHash(hex: string): bigint | null {
  if (!/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
  try { return BigInt(`0x${hex}`); } catch { return null; }
}

function popcount64(value: bigint): number {
  let v = value;
  let count = 0;
  while (v > 0n) {
    count += Number(v & 1n);
    v >>= 1n;
  }
  return count;
}

// Hamming distance between two hex dHashes; null when either doesn't parse (callers
// treat unparseable as "can't judge" and keep the photo).
export function hammingDistanceHex(a: string, b: string): number | null {
  const ha = parseHash(a);
  const hb = parseHash(b);
  if (ha == null || hb == null) return null;
  return popcount64(ha ^ hb);
}

// Greedy near-duplicate filter, preserving order (callers pass chronological input so
// the FIRST shot of a burst is the one kept). An item with no/invalid hash — videos,
// photos the scan hasn't backfilled yet — is always kept: better an occasional dup
// than silently dropping photos we can't judge.
export function pickVisuallyDistinct<T extends { phash: string | null }>(items: T[]): T[] {
  const kept: bigint[] = [];
  return items.filter((item) => {
    if (!item.phash) return true;
    const hash = parseHash(item.phash);
    if (hash == null) return true;
    if (kept.some((seen) => popcount64(hash ^ seen) <= NEAR_DUPLICATE_DISTANCE)) return false;
    kept.push(hash);
    return true;
  });
}
