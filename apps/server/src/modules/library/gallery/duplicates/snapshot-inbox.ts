import { connectedComponents, duplicateIgnorePairs, duplicatePairKey, groupNearIdentical } from "./grouping.js";
import { loadDetails, type DetailRow } from "./details.js";
import { pickKeeper } from "./keeper.js";
import type { RescanMatch } from "./inbox-rescans.js";
import { looksLikeSeparateShots, nearConfidence } from "./snapshot-near.js";
import type { DeletionBlocks, ScanFile, Writer } from "./snapshot.js";

// ── The Photo Inbox check ───────────────────────────────────────────────────
//
// Asymmetric on purpose (docs/photo-inbox-proposal.md, decisions 6–8): the
// candidates are ONE library's photos, twins are looked for in the rest, and the
// collection is never compared with itself — a delivery of two hundred scans must
// not turn into a cleanup of the whole house. The copy already in the library is
// the keeper: the question a set asks is "is the new one better?", answered on the
// card by Replace, Discard or Not the same, never by keeper scoring. Where the
// library holds several copies, scoring only picks which of THEM the incoming one
// is measured against; none of them is ever offered for deletion here.

export const INBOX_KEEPER_REASON = "already in the library";
// Ranks as a decision — the ladder's "folder you chose to keep" rung — so the card
// reads the keeper as evidence rather than a guess. It is: the library is the
// answer, not a property read off the files.
const INBOX_KEEPER_RANK = 2;

export function snapshotInboxSets(
  write: Writer,
  files: ScanFile[],
  inboxLibraryId: string,
  blocks: DeletionBlocks,
  nearVariants?: Map<string, string[]>,
  rescans?: RescanMatch[]
): { exact: number; near: number; separateShots: number } {
  const incomingFile = (file: ScanFile): boolean => file.libraryId === inboxLibraryId;
  const suppressed = new Set<string>();
  const ignored = duplicateIgnorePairs();
  let exact = 0;
  let near = 0;
  let separateShots = 0;

  // Write one set; false when it has nothing to say (no incoming copy, no library
  // copy, or every incoming copy sits behind a lock).
  const writeSet = (
    group: ScanFile[],
    details: Map<string, DetailRow>,
    distance: ((a: string, b: string) => number) | null
  ): boolean => {
    const incoming = group.filter(incomingFile);
    const outside = group.filter((file) => !incomingFile(file));
    if (incoming.length === 0 || outside.length === 0) return false;
    const doomed = incoming.filter((file) => !blocks.path(file.libraryId, file.path));
    if (doomed.length === 0) return false;

    const outsideRows = outside.map((file) => details.get(file.itemId)).filter((row): row is DetailRow => Boolean(row));
    const choice = outsideRows.length > 1 ? pickKeeper(outsideRows, []) : null;
    const keeperFile = outside.find((file) => file.itemId === choice?.keeperId) ?? outside[0];
    const keeperDetail = details.get(keeperFile.itemId);
    const away = (file: ScanFile): number => (distance ? Math.max(distance(keeperFile.itemId, file.itemId), 1) : 0);
    const confidence = !distance ? "certain" : incoming.reduce<"likely" | "unsure">((worst, file) => {
      const other = details.get(file.itemId);
      if (!keeperDetail || !other) return worst;
      return nearConfidence(keeperDetail, other) === "unsure" ? "unsure" : worst;
    }, "likely");

    const resultId = write.result({
      type: "photo_set",
      reclaimableBytes: doomed.reduce((sum, file) => sum + (file.size ?? 0), 0),
      keeperReason: INBOX_KEEPER_REASON,
      matchConfidence: confidence,
      keeperRank: INBOX_KEEPER_RANK
    });
    const keeperMemberId = write.member(resultId, { file: keeperFile, role: "keep" });
    for (const file of outside) {
      if (file === keeperFile) continue;
      write.member(resultId, { file, role: "keep", distance: away(file) });
    }
    for (const file of incoming) {
      const blocked = blocks.path(file.libraryId, file.path);
      write.member(resultId, {
        file,
        role: blocked ? "protected" : "delete",
        keeperMemberId: blocked ? null : keeperMemberId,
        distance: away(file)
      });
    }
    for (const file of group) suppressed.add(file.itemId);
    return true;
  };

  // Identical bytes. A digest bucket is only worth splitting when both sides are
  // in it; the split itself is the same dismissal-aware one the file tier uses.
  const byHash = new Map<string, ScanFile[]>();
  const byId = new Map<string, ScanFile>();
  for (const file of files) {
    if (!file.hash) continue;
    byId.set(file.itemId, file);
    const bucket = byHash.get(file.hash);
    if (bucket) bucket.push(file); else byHash.set(file.hash, [file]);
  }
  const exactSets = [...byHash.values()]
    .filter((group) => group.length > 1 && group.some(incomingFile) && group.some((file) => !incomingFile(file)))
    .flatMap((group) => connectedComponents(group.map((file) => file.itemId), ignored))
    .map((ids) => ids.map((id) => byId.get(id)).filter((file): file is ScanFile => Boolean(file)))
    .filter((group) => group.length > 1);
  if (exactSets.length > 0) {
    const details = loadDetails(exactSets.flat().map((file) => file.itemId));
    for (const group of exactSets) if (writeSet(group, details, null)) exact += 1;
  }

  // Same picture, different file. The banding is the file tier's; what differs is
  // that only pairs touching an incoming photo may link (`candidates`), and that an
  // incoming photo also answers to its rotated fingerprints (`variants`).
  const candidates = files.filter((file) => file.phash && !suppressed.has(file.itemId));
  const incomingIds = new Set(candidates.filter(incomingFile).map((file) => file.itemId));
  if (incomingIds.size === 0 || candidates.length < 2) return { exact, near, separateShots };

  const candidateById = new Map(candidates.map((file) => [file.itemId, file]));
  const details = loadDetails(candidates.map((file) => file.itemId));
  const { components, distance } = groupNearIdentical(
    candidates.map((file) => ({ itemId: file.itemId, phash: file.phash })),
    ignored,
    (a, b) => {
      const left = details.get(a);
      const right = details.get(b);
      if (!left || !right || !looksLikeSeparateShots(left, right)) return true;
      separateShots += 1;
      return false;
    },
    { candidates: incomingIds, variants: nearVariants }
  );
  for (const ids of components) {
    const group = ids.map((id) => candidateById.get(id)).filter((file): file is ScanFile => Boolean(file));
    if (writeSet(group, details, distance)) near += 1;
  }

  // The same print scanned twice. Proposed by a wide fingerprint gate and settled by
  // comparing the pictures themselves (inbox-rescans.ts, run before this pass); each
  // surviving pair is a set of exactly two, since what it establishes is "this photo
  // is that photo" and nothing about the rest of the bucket.
  for (const match of rescans ?? []) {
    const incoming = candidateById.get(match.incomingId);
    const twin = candidateById.get(match.libraryItemId);
    if (!incoming || !twin) continue;                                   // spoken for above
    if (suppressed.has(incoming.itemId) || suppressed.has(twin.itemId)) continue;
    if (ignored.has(duplicatePairKey(incoming.itemId, twin.itemId))) continue;
    const pair = loadDetails([incoming.itemId, twin.itemId]);
    const left = pair.get(incoming.itemId);
    const right = pair.get(twin.itemId);
    // The second look is deliberately generous — a print scanned twice can measure
    // as low as two frames of one scene do. This is where the two are told apart:
    // one camera, two moments is two photographs, whatever they look like.
    if (left && right && looksLikeSeparateShots(left, right)) { separateShots += 1; continue; }
    if (writeSet([twin, incoming], pair, () => match.distance)) near += 1;
  }
  return { exact, near, separateShots };
}
