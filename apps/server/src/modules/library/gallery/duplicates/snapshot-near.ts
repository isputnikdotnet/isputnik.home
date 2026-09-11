import { duplicateIgnorePairs, groupNearIdentical } from "./grouping.js";
import { loadDetails, type DetailRow } from "./details.js";
import { pickKeeper, type FolderPreference } from "./keeper.js";
import type { DeletionBlocks, ScanFile, Writer } from "./snapshot.js";

// ── Near-identical photos ───────────────────────────────────────────────────
//
// The same picture as a different file: resized, re-compressed, re-exported, or a
// messenger's own copy. Matched on the dHash the catalog scan already computed, so this
// costs no disk access — and only photos have one, so a re-encoded video stays invisible
// to everything except byte-identity.
//
// The important difference from the tier above is not how it matches but what it means.
// Byte-identical copies are interchangeable, so choosing between them is only ever about
// where they sit. These are DIFFERENT FILES — different resolution, possibly stripped
// EXIF — so deleting one loses something, and every part of the page that treats a set
// as safe has to know the difference. That is what the recorded distance is for.

/** Two frames of the same scene rather than two copies of one picture.
 *
 *  A fingerprint cannot tell these apart: consecutive shots of a static scene land one
 *  to three bits from each other, exactly where a re-saved file does. Left alone, most
 *  of what this tier finds on a real library is bursts — IMG_1109 beside IMG_1110, a
 *  second apart, sizes within a percent — and proposing to delete one of those offers
 *  away a photograph nobody has twice.
 *
 *  All three signals are required, because each alone has a false positive:
 *
 *    same pixel dimensions   a resized or re-exported copy is a different size in
 *                            pixels; two frames from one camera are not
 *    taken a moment apart    the shutter moved. Bounded, because `taken_at` falls back
 *                            to the file's mtime when there is no EXIF, and two copies
 *                            made months apart would otherwise look like a burst
 *    similar file size       a re-compressed copy is a fraction of its original;
 *                            sibling frames land within a few percent
 *
 *  Deliberately silent about pairs sharing a timestamp to the second: a camera writing
 *  whole seconds puts two burst frames at the same value, but so does a copy that
 *  inherited its original's EXIF — and one of those must not be dropped. Those stay in
 *  the tier for a person to look at. */
const SHOT_GAP_SECONDS = 120;
const SHOT_SIZE_RATIO = 0.8;

/** The shutter moved between them. Bounded because `taken_at` falls back to the file's
 *  mtime when there is no EXIF, so two copies written months apart must not read as a
 *  burst. Silent when the two share a value: a camera writing whole seconds puts rapid
 *  frames at the same timestamp, but so does a copy that inherited its original's EXIF. */
function tookDifferentMoments(a: DetailRow, b: DetailRow): boolean {
  if (!a.taken_at || !b.taken_at) return false;
  const gap = Math.abs(Date.parse(a.taken_at) - Date.parse(b.taken_at));
  return Number.isFinite(gap) && gap > 0 && gap <= SHOT_GAP_SECONDS * 1000;
}

const FRAME_NUMBER = /^(.*?)(\d+)$/;

/** IMG_1109 beside IMG_1110 — the same name but for a trailing counter one apart, which
 *  is a camera's own sequence and therefore two exposures.
 *
 *  This is what catches the bursts the timestamp cannot: cameras of that era write whole
 *  seconds, so a pair fired inside one second shares its EXIF value exactly.
 *
 *  A copy does not look like this. "Picture 071-001.jpg" beside "Picture 071.jpg" shares
 *  no prefix once the trailing digits are taken off — 'Picture 071-' against 'Picture ' —
 *  because the suffix was ADDED rather than incremented, so a real duplicate stays. */
function consecutiveFrames(a: DetailRow, b: DetailRow): boolean {
  const stem = (row: DetailRow) => (row.relative_path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
  const left = FRAME_NUMBER.exec(stem(a));
  const right = FRAME_NUMBER.exec(stem(b));
  if (!left || !right || left[1] !== right[1]) return false;
  return Math.abs(Number(left[2]) - Number(right[2])) === 1;
}

/** Same camera output: identical pixel dimensions and a file size within a few percent.
 *  A resized or re-compressed copy fails one of these, which is what keeps every genuine
 *  copy in the tier no matter what the time checks say. */
function sameCameraShape(a: DetailRow, b: DetailRow): boolean {
  if (a.width == null || b.width == null) return false;
  if (a.width !== b.width || a.height !== b.height) return false;
  const sizes = [a.size ?? 0, b.size ?? 0];
  return Math.min(...sizes) / Math.max(...sizes, 1) >= SHOT_SIZE_RATIO;
}

export function looksLikeSeparateShots(a: DetailRow, b: DetailRow): boolean {
  if (!sameCameraShape(a, b)) return false;
  // Then either piece of evidence that these are two exposures rather than one picture
  // stored twice.
  return tookDifferentMoments(a, b) || consecutiveFrames(a, b);
}

/** How much to trust a near-identical pair.
 *
 *  The fingerprint sees a 9x8 grayscale grid, which is gross tonal layout and nothing
 *  else — so two landscapes from the same afternoon, both "bright sky above dark water",
 *  match at three bits while being entirely different photographs. One such pair on the
 *  dev library was 3,318,030 against 3,317,962 bytes at the same dimensions, taken two
 *  hours and forty minutes apart.
 *
 *  That is the shape of the doubt: everything about the two FILES agrees, and they were
 *  taken at quite different moments. A real copy inherits its original's EXIF or carries
 *  none, so a wide gap means the fingerprint is the only thing linking them — and the
 *  fingerprint is exactly what cannot be trusted alone. The burst check above has
 *  already taken the pairs that are provably two exposures; this grades what is left. */
export function nearConfidence(keeper: DetailRow, other: DetailRow): "likely" | "unsure" {
  if (!sameCameraShape(keeper, other)) return "likely";
  if (!keeper.taken_at || !other.taken_at) return "likely";
  const gap = Math.abs(Date.parse(keeper.taken_at) - Date.parse(other.taken_at));
  return Number.isFinite(gap) && gap > SHOT_GAP_SECONDS * 1000 ? "unsure" : "likely";
}

export function snapshotNearSets(
  write: Writer,
  files: ScanFile[],
  suppressed: Set<string>,
  preferences: FolderPreference[],
  blocks: DeletionBlocks
): { written: number; separateShots: number } {
  const candidates = files.filter((file) => file.phash && !suppressed.has(file.itemId));
  if (candidates.length < 2) return { written: 0, separateShots: 0 };

  const byId = new Map(candidates.map((file) => [file.itemId, file]));
  // Loaded before grouping, not after: the dimensions and dates are what decide
  // whether a matching pair is a copy at all.
  const details = loadDetails(candidates.map((file) => file.itemId));

  let separateShots = 0;
  const { components, distance } = groupNearIdentical(
    candidates.map((file) => ({ itemId: file.itemId, phash: file.phash })),
    duplicateIgnorePairs(),
    (a, b) => {
      const left = details.get(a);
      const right = details.get(b);
      if (!left || !right || !looksLikeSeparateShots(left, right)) return true;
      separateShots += 1;
      return false;
    }
  );
  if (components.length === 0) return { written: 0, separateShots };

  let written = 0;

  for (const ids of components) {
    const group = ids.map((id) => byId.get(id)).filter((file): file is ScanFile => Boolean(file));
    const rows = group.map((file) => details.get(file.itemId)).filter((row): row is DetailRow => Boolean(row));
    if (rows.length < 2) continue;

    const choice = pickKeeper(rows, preferences);
    if (!choice) continue;
    const keeperFile = group.find((file) => file.itemId === choice.keeperId) ?? group[0];
    const others = group.filter((file) => file.itemId !== keeperFile.itemId);

    const doomed = others.filter((file) => !blocks.path(file.libraryId, file.path));
    if (doomed.length === 0) continue;

    // Graded against the copy that survives: if every FILE property agrees and only the
    // moment differs, the fingerprint is the only thing linking them and it sees very
    // little. Worst answer across the set wins — one doubtful pair makes the set doubtful.
    const keeperDetail = details.get(keeperFile.itemId);
    const confidence = others.reduce<"likely" | "unsure">((worst, file) => {
      const otherDetail = details.get(file.itemId);
      if (!keeperDetail || !otherDetail) return worst;
      return nearConfidence(keeperDetail, otherDetail) === "unsure" ? "unsure" : worst;
    }, "likely");

    const resultId = write.result({
      type: "photo_set",
      reclaimableBytes: doomed.reduce((sum, file) => sum + (file.size ?? 0), 0),
      keeperReason: choice.reason,
      matchConfidence: confidence,
      keeperRank: choice.rank
    });
    const keeperMemberId = write.member(resultId, { file: keeperFile, role: "keep" });
    for (const file of others) {
      const isProtected = blocks.path(file.libraryId, file.path);
      write.member(resultId, {
        file,
        role: isProtected ? "protected" : "delete",
        keeperMemberId: isProtected ? null : keeperMemberId,
        // What makes this a near set rather than an exact one, on every row that is
        // not the keeper. A set whose members are all at 0 is byte-identical.
        distance: Math.max(distance(keeperFile.itemId, file.itemId), 1)
      });
    }
    written += 1;
  }
  return { written, separateShots };
}
