// The second look the Photo Inbox check takes at a photo the fingerprint alone
// cannot place — docs/photo-inbox-proposal.md, decision 8, widened.
//
// ── Why the fingerprint is not enough ───────────────────────────────────────
//
// A dHash sees a 9x8 grayscale grid, and the near tier links two photos at three
// bits of it. That window is right for what it was built for: a re-save, a resize,
// a re-encode — the same pixels through a different codec. It is far too tight for
// the case a Photo Inbox exists to serve, which is the same PRINT scanned twice.
// A print laid on the glass by hand is framed a few percent differently each time,
// and every scanner's auto-enhance grades the tones its own way. The pair that
// prompted this module — one photograph, scanned once as a PNG and once by a
// FastFoto as a JPEG — sits THIRTEEN bits apart. Nothing in the near tier could
// ever have found it, and widening the tier to thirteen bits would link half the
// seascapes in a library, which all share "bright above, dark below" at that range.
//
// ── What this does instead ──────────────────────────────────────────────────
//
// Two signals, and a pair must satisfy both. The fingerprint proposes: the nearest
// handful of library photos within a WIDE window, which is cheap bit math over
// hashes already in the database. Then the two pictures are actually compared —
// their cached previews, in grayscale, each patch normalised to zero mean and unit
// length so brightness and contrast fall out of the arithmetic, correlated over a
// few centre crops (a re-framing) and the four rotations (a print fed in sideways).
// The same photograph differently cropped and toned correlates at ~0.94; two
// different pictures that merely share a layout sit near 0.1, and the handful that
// reach 0.9 by coincidence are 20-40 bits away and never pass the gate.
//
// Nothing is stored and nothing is written: one decode per photo compared, on a
// pass that already had the file open. The answer is a proposal for the check to
// turn into a review card — Replace, Discard or Not the same — never a deletion.
import sharp from "sharp";
import { db } from "../../../../db.js";
import { thumbnailAbsolutePath } from "../../shared/thumbnail.js";
import type { GalleryDetailRow, LibraryItemRow } from "../../../../db/rows.js";

/** How far apart two fingerprints may be and still be worth looking at. Well beyond
 *  the near tier's 3, and still far inside the ~32 bits two unrelated photos average. */
export const RESCAN_GATE_BITS = 16;
/** How much of the picture must agree, once actually compared.
 *
 *  0.85 is where two scans of one print land in practice — measured pairs so far:
 *  0.94 and 0.87. The second is the reason this is not higher: the same photograph,
 *  scanned on two machines, differs in sharpening, grain and a few percent of
 *  framing, and no amount of resolution recovers that (at 64px the pair scores
 *  LOWER, not higher — the detail is genuinely different).
 *
 *  It does mean two frames of one scene can reach this bar as well. That is what the
 *  camera check in the snapshot is for: a pair that looks like two exposures is
 *  refused before it becomes a card. What survives both is shown as "Looks the same"
 *  and answered with Replace, Discard or Not the same — a Photo Inbox is a review
 *  queue, and a pair worth a second look costs one click, while a duplicate that is
 *  never proposed enters the library unnoticed. */
export const RESCAN_MATCH_SCORE = 0.85;
/** Library photos looked at per incoming photo, nearest fingerprint first. A twin
 *  13 bits away is never crowded out — a photo with 20 closer neighbours than its
 *  own twin has 20 near-copies, which the near tier has already spoken for. */
const CANDIDATES_PER_PHOTO = 20;
/** A ceiling on the work one check may do. A two-hundred-print delivery would
 *  otherwise decode thousands of previews; past this the check reports what it has. */
const COMPARISON_BUDGET = 1500;

/** Side of the grayscale grid each preview is decoded to, once. Patches are cut from
 *  it, so a crop costs arithmetic rather than another decode. */
const GRID = 128;
/** Side of the patch the correlation runs on. 32x32 is fine enough to tell two
 *  photographs apart and coarse enough that JPEG grain and a scanner's grade don't
 *  register. */
const PATCH = 32;

/** Centre crops tried on either side: the whole frame, then 94% and 88% of it at nine
 *  positions — a re-framing of up to ~12%, wherever the hand put the print. */
const CROPS: [number, number, number][] = [[0, 0, 1]];
for (const fraction of [0.94, 0.88]) {
  for (const dy of [0, 0.5, 1]) for (const dx of [0, 0.5, 1]) {
    CROPS.push([(1 - fraction) * dx, (1 - fraction) * dy, fraction]);
  }
}

export interface RescanCandidate {
  itemId: LibraryItemRow["id"];
  phash: NonNullable<GalleryDetailRow["phash"]>;
  previewKey: NonNullable<GalleryDetailRow["preview_storage_key"]>;
  /** Extra fingerprints the photo also answers to — the Inbox's rotated hashes. */
  variants?: string[];
}

export interface RescanMatch {
  incomingId: string;
  /** The photo already in the collection that the incoming one appears to be. */
  libraryItemId: string;
  /** Bits between the two fingerprints, for the member row's `distance`. */
  distance: number;
  /** How much of the picture agreed, 0..1. */
  score: number;
}

function parseHash(hex: string): { hi: number; lo: number } | null {
  if (!/^[0-9a-fA-F]{16}$/.test(hex)) return null;
  return { hi: Number.parseInt(hex.slice(0, 8), 16) >>> 0, lo: Number.parseInt(hex.slice(8), 16) >>> 0 };
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** Fewest bits between one photo's fingerprints (its own and any variants) and another's. */
export function fingerprintGap(a: string[], b: string[]): number {
  let best = 64;
  for (const left of a) {
    const fa = parseHash(left);
    if (!fa) continue;
    for (const right of b) {
      const fb = parseHash(right);
      if (!fb) continue;
      best = Math.min(best, popcount32(fa.hi ^ fb.hi) + popcount32(fa.lo ^ fb.lo));
    }
  }
  return best;
}

/** One PATCH x PATCH sample of a box of the grid, area-averaged, then normalised to
 *  zero mean and unit length — which is what makes the comparison blind to how bright
 *  or contrasty either scan came out. */
export function samplePatch(grid: Uint8Array, x: number, y: number, side: number): Float32Array {
  const out = new Float32Array(PATCH * PATCH);
  const step = (side * GRID) / PATCH;
  const left = x * GRID;
  const top = y * GRID;
  for (let row = 0; row < PATCH; row += 1) {
    const y0 = Math.floor(top + row * step);
    const y1 = Math.min(GRID, Math.max(y0 + 1, Math.floor(top + (row + 1) * step)));
    for (let col = 0; col < PATCH; col += 1) {
      const x0 = Math.floor(left + col * step);
      const x1 = Math.min(GRID, Math.max(x0 + 1, Math.floor(left + (col + 1) * step)));
      let sum = 0;
      let seen = 0;
      for (let sy = y0; sy < y1 && sy < GRID; sy += 1) {
        for (let sx = x0; sx < x1 && sx < GRID; sx += 1) { sum += grid[sy * GRID + sx]; seen += 1; }
      }
      out[row * PATCH + col] = seen > 0 ? sum / seen : 0;
    }
  }
  let mean = 0;
  for (const value of out) mean += value;
  mean /= out.length;
  let square = 0;
  for (let i = 0; i < out.length; i += 1) { out[i] -= mean; square += out[i] * out[i]; }
  const length = Math.sqrt(square) || 1;
  for (let i = 0; i < out.length; i += 1) out[i] /= length;
  return out;
}

function correlate(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/** The grid turned a quarter clockwise. Cheap enough to keep all four in memory, and
 *  the grid is square, so a rotation is an index shuffle. */
export function rotateGrid(grid: Uint8Array): Uint8Array {
  const out = new Uint8Array(grid.length);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) out[x * GRID + (GRID - 1 - y)] = grid[y * GRID + x];
  }
  return out;
}

/** How much of the picture two grids share, at their best alignment: every crop of
 *  each against the whole of the other, over the incoming photo's four rotations.
 *  Both directions are tried because either copy may be the tighter one. */
export function gridScore(incoming: Uint8Array, library: Uint8Array, rotations = 4): number {
  const libraryWhole = samplePatch(library, 0, 0, 1);
  const libraryCrops = CROPS.map(([x, y, side]) => samplePatch(library, x, y, side));
  let turned = incoming;
  let best = -1;
  for (let turn = 0; turn < rotations; turn += 1) {
    if (turn > 0) turned = rotateGrid(turned);
    const whole = samplePatch(turned, 0, 0, 1);
    for (const crop of libraryCrops) best = Math.max(best, correlate(whole, crop));
    for (const [x, y, side] of CROPS) {
      best = Math.max(best, correlate(samplePatch(turned, x, y, side), libraryWhole));
    }
  }
  return best;
}

async function decodeGrid(previewKey: string): Promise<Uint8Array | null> {
  try {
    const source = thumbnailAbsolutePath(previewKey);
    const { data } = await sharp(source, { failOn: "none" })
      .grayscale()
      .resize(GRID, GRID, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return new Uint8Array(data.buffer, data.byteOffset, data.length);
  } catch {
    return null;   // a preview that has gone missing simply produces no match
  }
}

/** Every photo of a library that can take part: fingerprinted, with a preview to read. */
export function rescanCandidates(libraryIds: string[]): RescanCandidate[] {
  if (libraryIds.length === 0) return [];
  const marks = libraryIds.map(() => "?").join(",");
  return db.prepare(`
    SELECT li.id AS itemId, gd.phash AS phash, gd.preview_storage_key AS previewKey
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.library_id IN (${marks}) AND li.deleted_at IS NULL AND li.status = 'ready'
      AND gd.kind = 'photo' AND gd.phash IS NOT NULL AND gd.preview_storage_key IS NOT NULL
  `).all(...libraryIds) as RescanCandidate[];
}

/** Look for the photograph each incoming photo already is, one library photo at a
 *  time. Returns at most one match per incoming photo — its best — because the
 *  question a check asks is "is this one already here?", not "how many times". */
export async function findInboxRescans(
  incoming: RescanCandidate[],
  library: RescanCandidate[]
): Promise<RescanMatch[]> {
  if (incoming.length === 0 || library.length === 0) return [];

  const prints = (photo: RescanCandidate): string[] => [photo.phash, ...(photo.variants ?? [])];
  const grids = new Map<string, Uint8Array | null>();
  const gridFor = async (photo: RescanCandidate): Promise<Uint8Array | null> => {
    const held = grids.get(photo.itemId);
    if (held !== undefined) return held;
    const grid = await decodeGrid(photo.previewKey);
    grids.set(photo.itemId, grid);
    return grid;
  };

  const matches: RescanMatch[] = [];
  let spent = 0;
  for (const photo of incoming) {
    if (spent >= COMPARISON_BUDGET) break;
    const own = prints(photo);
    const nearest = library
      .map((other) => ({ other, distance: fingerprintGap(own, prints(other)) }))
      .filter((pair) => pair.distance <= RESCAN_GATE_BITS)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, CANDIDATES_PER_PHOTO);
    if (nearest.length === 0) continue;

    const grid = await gridFor(photo);
    if (!grid) continue;
    let best: RescanMatch | null = null;
    for (const { other, distance } of nearest) {
      if (spent >= COMPARISON_BUDGET) break;
      const twin = await gridFor(other);
      if (!twin) continue;
      spent += 1;
      const score = gridScore(grid, twin);
      if (score < RESCAN_MATCH_SCORE) continue;
      if (!best || score > best.score) {
        best = { incomingId: photo.itemId, libraryItemId: other.itemId, distance, score };
      }
    }
    if (best) matches.push(best);
  }
  return matches;
}
