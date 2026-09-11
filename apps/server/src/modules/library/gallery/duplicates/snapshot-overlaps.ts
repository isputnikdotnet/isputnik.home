import { db } from "../../../../db.js";
import { folderOverlapIgnores, folderSameOrInside, pickFolderKeeper, type FolderFingerprint } from "./folders.js";
import { loadDetails } from "./details.js";
import type { FolderPreference } from "./keeper.js";
import { dirOf, MIN_FOLDER_FILES, SEP, type DeletionBlocks, type ScanFile, type Writer } from "./snapshot.js";
import type { DuplicateJobResultFolderRow } from "../../../../db/rows.js";

// ── Folders sharing some photos ─────────────────────────────────────────────
//
// The third folder-shaped answer, for the common mess of a partial copy: half a card's
// photos re-imported into a new folder, a "best of" pulled from several trips. Neither
// folder equals the other and neither is wholly inside the other, so both stronger
// tiers stay silent — and the two folders go on holding the same pictures for ever.
//
// The action is narrower than the other tiers'. BOTH FOLDERS STAY. Only the shared
// copies on the losing side go, and each one hands its work to its counterpart across
// the way. Everything either folder holds alone is untouched, which is the whole point:
// there is no "winner" here, just copies that need to exist once.

/** A pair of folders and the photos they hold in common, doomed side against keeper. */
interface OverlapPair {
  a: { libraryId: string; folderPath: string };
  b: { libraryId: string; folderPath: string };
  /** Index-aligned: aFiles[i] and bFiles[i] are the same picture in the two places. */
  aFiles: ScanFile[];
  bFiles: ScanFile[];
}

export function snapshotOverlaps(
  write: Writer,
  files: ScanFile[],
  jobId: string,
  preferences: FolderPreference[],
  blocks: DeletionBlocks
): number {
  // Every hashed file, by the folder it sits DIRECTLY in — an overlap is about two
  // folders' own contents, not their subtrees. Direct contents make even a folder and
  // its own parent a fair pair: a file sits directly in exactly one folder, so the two
  // sides share nothing unless somebody copied files between them — which is exactly
  // the duplication this tier exists to catch.
  const byHashByFolder = new Map<string, Map<string, ScanFile[]>>();
  for (const file of files) {
    if (!file.hash) continue;
    const folderKey = file.libraryId + SEP + dirOf(file.path);
    let folders = byHashByFolder.get(file.hash);
    if (!folders) { folders = new Map(); byHashByFolder.set(file.hash, folders); }
    const bucket = folders.get(folderKey);
    if (bucket) bucket.push(file); else folders.set(folderKey, [file]);
  }

  // Accumulate per unordered pair, lexically smaller side first so a pair has exactly
  // one entry however its digests are ordered.
  const pairs = new Map<string, OverlapPair>();
  const refOf = (key: string) => {
    const cut = key.indexOf(SEP);
    return { libraryId: key.slice(0, cut), folderPath: key.slice(cut + 1) };
  };
  for (const folders of byHashByFolder.values()) {
    const entries = [...folders.entries()];
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const [first, second] = entries[i][0] <= entries[j][0] ? [entries[i], entries[j]] : [entries[j], entries[i]];
        const key = `${first[0]}|${second[0]}`;
        let entry = pairs.get(key);
        if (!entry) {
          entry = { a: refOf(first[0]), b: refOf(second[0]), aFiles: [], bFiles: [] };
          pairs.set(key, entry);
        }
        // Multiplicity respected: a folder holding one picture twice needs two copies
        // across the way before both count as shared.
        const shared = Math.min(first[1].length, second[1].length);
        entry.aFiles.push(...first[1].slice(0, shared));
        entry.bFiles.push(...second[1].slice(0, shared));
      }
    }
  }
  if (pairs.size === 0) return 0;

  // What this scan's stronger tiers already said. A pair either of whose sides is
  // spoken for by an identical-folders set or a stored-elsewhere card is answered
  // there, and repeating it here as a weaker statement is two answers to one question.
  const spokenFor = db.prepare(
    "SELECT library_id, folder_path FROM duplicate_job_result_folders WHERE job_id = ?"
  ).all(jobId) as Pick<DuplicateJobResultFolderRow, "library_id" | "folder_path">[];
  const answeredAlready = (ref: { libraryId: string; folderPath: string }): boolean =>
    spokenFor.some((row) => folderSameOrInside(ref, { libraryId: row.library_id, folderPath: row.folder_path }));

  const ignored = folderOverlapIgnores();
  const details = loadDetails(
    [...pairs.values()].flatMap((pair) => [...pair.aFiles, ...pair.bFiles]).map((file) => file.itemId)
  );
  let written = 0;

  for (const [key, pair] of pairs) {
    if (pair.aFiles.length < MIN_FOLDER_FILES) continue;
    if (ignored.has(key)) continue;
    // Nested pairs are NOT excluded here. They used to be, on the theory that the
    // tiers above own a folder copied into its own parent — but "contained" fires
    // only on TOTAL coverage, so a child differing from its parent by a single
    // photo (one stray frame either side, the commonest sync-client mess) fell
    // between the tiers and produced no folder-shaped answer at all, only a
    // hundred one-photo cards. When the stronger tiers DID answer the pair,
    // answeredAlready below still retires it from this one.
    if (answeredAlready(pair.a) || answeredAlready(pair.b)) continue;

    // Which side keeps, scored on the SHARED photos only: what matters is the work
    // attached to the copies that would actually move.
    const sideOf = (ref: { libraryId: string; folderPath: string }, sideFiles: ScanFile[]): FolderFingerprint => ({
      libraryId: ref.libraryId,
      folderPath: ref.folderPath,
      digest: "",
      itemCount: sideFiles.length,
      bytes: sideFiles.reduce((sum, file) => sum + (file.size ?? 0), 0),
      firstSeen: sideFiles.reduce((first, file) => (file.discoveredAt < first ? file.discoveredAt : first),
        sideFiles[0]?.discoveredAt ?? ""),
      itemIds: sideFiles.map((file) => file.itemId)
    });
    const aPrint = sideOf(pair.a, pair.aFiles);
    const bPrint = sideOf(pair.b, pair.bFiles);
    const choice = pickFolderKeeper([aPrint, bPrint], preferences);
    const aKeeps = choice !== null
      && choice.keeper.libraryId === pair.a.libraryId && choice.keeper.folderPath === pair.a.folderPath;

    const keepRef = aKeeps ? pair.a : pair.b;
    const loseRef = aKeeps ? pair.b : pair.a;
    const keepFiles = aKeeps ? pair.aFiles : pair.bFiles;
    const loseFiles = aKeeps ? pair.bFiles : pair.aFiles;

    // Nothing may be removed from the losing side, so there is no offer to make.
    // The copies going are the folder's DIRECT contents, so a lock covering the
    // folder covers all of them; a lock deeper down is some other folder's problem.
    if (blocks.path(loseRef.libraryId, loseRef.folderPath)) continue;
    // A pair where either side's copies carry no detail row lost its items between
    // grouping and writing.
    if (loseFiles.some((file) => !details.has(file.itemId))) continue;

    const goingBytes = loseFiles.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const resultId = write.result({
      type: "overlap", reclaimableBytes: goingBytes, keeperReason: choice?.reason ?? null,
      keeperRank: choice?.rank ?? -1
    });

    const keepFolderId = write.folder(resultId, {
      libraryId: keepRef.libraryId, folderPath: keepRef.folderPath,
      role: blocks.path(keepRef.libraryId, keepRef.folderPath) ? "protected" : "keep",
      itemCount: keepFiles.length,
      bytes: keepFiles.reduce((sum, file) => sum + (file.size ?? 0), 0)
    });
    const loseFolderId = write.folder(resultId, {
      libraryId: loseRef.libraryId, folderPath: loseRef.folderPath,
      role: "delete", itemCount: loseFiles.length, bytes: goingBytes
    });

    const keepMembers = keepFiles.map((file) =>
      write.member(resultId, { file, role: "keep", folderId: keepFolderId }));
    loseFiles.forEach((file, index) => {
      write.member(resultId, {
        file, role: "delete", folderId: loseFolderId, keeperMemberId: keepMembers[index] ?? null
      });
    });
    written += 1;
  }

  return written;
}
