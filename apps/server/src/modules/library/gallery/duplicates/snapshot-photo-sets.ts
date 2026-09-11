import { connectedComponents, duplicateIgnorePairs } from "./grouping.js";
import { loadDetails, type DetailRow } from "./details.js";
import { pickKeeper, type FolderPreference } from "./keeper.js";
import type { DeletionBlocks, ScanFile, Writer } from "./snapshot.js";

// ── Photo sets ──────────────────────────────────────────────────────────────
//
// Byte-identical copies of one picture, wherever they sit. Grouped straight from the
// digests rather than read back from the cached groups: the cache spans every library
// and this job may cover two of five, and a set whose other copies were filtered out
// is a different set — one that would offer to delete the last copy in scope.

export function snapshotPhotoSets(
  write: Writer,
  files: ScanFile[],
  preferences: FolderPreference[],
  blocks: DeletionBlocks
): { written: number; suppressed: Set<string> } {
  // Every copy an exact set already speaks for. The near tier below must skip these:
  // an identical set is presented as one row, and without this every byte-identical
  // copy would turn up again inside the near set sitting beside it.
  const suppressed = new Set<string>();

  const byHash = new Map<string, ScanFile[]>();
  const byId = new Map<string, ScanFile>();
  for (const file of files) {
    if (!file.hash) continue;
    byId.set(file.itemId, file);
    const bucket = byHash.get(file.hash);
    if (bucket) bucket.push(file); else byHash.set(file.hash, [file]);
  }

  // Split each digest's copies over the pairs NOT dismissed. Every pair in a set of
  // identical bytes matches, so one dismissal only breaks the set apart when it
  // actually disconnects it — saying A and B are not the same leaves {A,B,C} whole,
  // because both are still linked through C, and they really are the same bytes.
  const ignored = duplicateIgnorePairs();
  const sets = [...byHash.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => connectedComponents(group.map((file) => file.itemId), ignored))
    .map((ids) => ids.map((id) => byId.get(id)).filter((file): file is ScanFile => Boolean(file)))
    .filter((group) => group.length > 1);
  if (sets.length === 0) return { written: 0, suppressed };

  const details = loadDetails(sets.flat().map((file) => file.itemId));
  let written = 0;

  for (const group of sets) {
    const rows = group
      .map((file) => details.get(file.itemId))
      .filter((row): row is DetailRow => Boolean(row));
    if (rows.length < 2) continue;

    const choice = pickKeeper(rows, preferences);
    if (!choice) continue;
    const keeperFile = group.find((file) => file.itemId === choice.keeperId) ?? group[0];
    const others = group.filter((file) => file.itemId !== keeperFile.itemId);

    // Every copy outside a protected library or locked folder can go; the ones
    // inside are shown and never offered, so the card can say which copy is
    // staying and why.
    const doomed = others.filter((file) => !blocks.path(file.libraryId, file.path));
    const reclaimable = doomed.reduce((sum, file) => sum + (file.size ?? 0), 0);

    const resultId = write.result({
      type: "photo_set", reclaimableBytes: reclaimable, keeperReason: choice.reason,
      keeperRank: choice.rank
    });
    const keeperMemberId = write.member(resultId, { file: keeperFile, role: "keep" });
    for (const file of others) {
      const blocked = blocks.path(file.libraryId, file.path);
      write.member(resultId, {
        file,
        role: blocked ? "protected" : "delete",
        keeperMemberId: blocked ? null : keeperMemberId
      });
      suppressed.add(file.itemId);
    }
    written += 1;
  }
  return { written, suppressed };
}
