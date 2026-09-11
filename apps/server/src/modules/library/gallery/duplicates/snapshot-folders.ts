import { folderComponents, folderIgnorePairs, parentOf, pickFolderKeeper, type FolderFingerprint } from "./folders.js";
import type { FolderPreference } from "./keeper.js";
import { folderKeyOf, isUnder, type DeletionBlocks, type MemberRole, type ScanFile, type Writer } from "./snapshot.js";

// ── Identical folders ───────────────────────────────────────────────────────

export function snapshotFolderSets(
  write: Writer,
  prints: FolderFingerprint[],
  filesByFolder: (print: FolderFingerprint) => ScanFile[],
  preferences: FolderPreference[],
  blocks: DeletionBlocks
): { written: number; claimed: Set<string> } {
  const byDigest = new Map<string, FolderFingerprint[]>();
  const byKey = new Map<string, FolderFingerprint>();
  for (const print of prints) {
    byKey.set(folderKeyOf(print), print);
    const bucket = byDigest.get(print.digest);
    if (bucket) bucket.push(print); else byDigest.set(print.digest, [print]);
  }

  // Split each digest's folders over the pairs NOT dismissed, exactly as the photo
  // tier does with its copies: every pair in a set of identical folders matches, so
  // one dismissal only breaks the set apart when it truly disconnects it.
  const ignored = folderIgnorePairs();
  const groups = [...byDigest.values()]
    .filter((group) => group.length > 1)
    .flatMap((group) => folderComponents(group.map(folderKeyOf), ignored))
    .map((keys) => keys.map((key) => byKey.get(key)).filter((print): print is FolderFingerprint => Boolean(print)));

  // A duplicated folder duplicates everything inside it, so Photos/2019 pairs with
  // Backup/2019 exactly as Photos pairs with Backup. Only the topmost pairing is worth
  // a card: drop any group whose members ALL sit inside folders that are themselves in
  // a group, because resolving the parent takes the children with it — and leaves the
  // child's card pointing at folders that are no longer there.
  const inAGroup = new Set(groups.flat().map(folderKeyOf));
  const isNested = (group: FolderFingerprint[]): boolean => group.every((print) => {
    const parent = parentOf(print.folderPath);
    return parent !== null && inAGroup.has(folderKeyOf({ libraryId: print.libraryId, folderPath: parent }));
  });

  const claimed = new Set<string>();
  let written = 0;

  for (const group of groups) {
    if (group.length < 2) continue;
    if (isNested(group)) continue;
    // The same rule within one group: when a parent and its own child both match
    // something, offering both is two answers to one question.
    if (group.some((print) => group.some((other) =>
      other !== print && other.libraryId === print.libraryId && isUnder(other.folderPath, print.folderPath)))) {
      continue;
    }

    const choice = pickFolderKeeper(group, preferences);
    if (!choice) continue;
    const keeper = group.find((print) =>
      print.libraryId === choice.keeper.libraryId && print.folderPath === choice.keeper.folderPath) ?? group[0];
    const others = group.filter((print) => print !== keeper);
    const doomed = others.filter((print) => !blocks.subtree(print.libraryId, print.folderPath));
    if (doomed.length === 0) continue;

    const resultId = write.result({
      type: "folder_set",
      reclaimableBytes: doomed.reduce((sum, print) => sum + print.bytes, 0),
      keeperReason: choice.reason,
      keeperRank: choice.rank
    });

    const keeperFolderId = write.folder(resultId, {
      libraryId: keeper.libraryId, folderPath: keeper.folderPath,
      role: "keep", itemCount: keeper.itemCount, bytes: keeper.bytes
    });
    // The kept folder's files, keyed by their path BELOW the folder — that is what
    // makes a doomed file's counterpart findable, since the two trees are identical
    // in layout by definition of the fingerprint.
    const keeperFiles = new Map<string, string>();
    for (const file of filesByFolder(keeper)) {
      const below = keeper.folderPath === "" ? file.path : file.path.slice(keeper.folderPath.length + 1);
      keeperFiles.set(below, write.member(resultId, { file, role: "keep", folderId: keeperFolderId }));
    }

    for (const print of others) {
      const role: MemberRole = blocks.subtree(print.libraryId, print.folderPath) ? "protected" : "delete";
      const folderId = write.folder(resultId, {
        libraryId: print.libraryId, folderPath: print.folderPath,
        role, itemCount: print.itemCount, bytes: print.bytes
      });
      for (const file of filesByFolder(print)) {
        const below = print.folderPath === "" ? file.path : file.path.slice(print.folderPath.length + 1);
        write.member(resultId, {
          file, role, folderId,
          keeperMemberId: role === "delete" ? keeperFiles.get(below) ?? null : null
        });
      }
      claimed.add(folderKeyOf(print));
    }
    claimed.add(folderKeyOf(keeper));
    written += 1;
  }

  return { written, claimed };
}
