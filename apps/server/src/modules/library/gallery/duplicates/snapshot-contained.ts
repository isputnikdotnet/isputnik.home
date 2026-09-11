// ── Why the contained tier is computed here rather than copied ───────────────
//
// The cached contained rows name ONE covering folder, because the table has one
// column pair for it. containersOf() therefore looks for a single folder that holds
// a copy of EVERY file below the doomed folder — and when the copies are scattered
// (one in FolderOne, one in FolderTwo, one loose at the top) no such folder exists
// except the library's own root. The row then says "root", and the card can only
// render that as "everything in this library" with a note listing folders that each
// hold only part of it. That defect was re-worded across four releases; the shape was
// what was wrong.
//
// So here the question is asked per FILE — does this photo have a counterpart
// somewhere else in scope? — and the answer is recorded per file. The covering side
// is then whatever set of folders those counterparts happen to sit in, which is both
// the truth and exactly the sentence the card wants to say.
import { containedIgnoreKeys, pickFolderKeeper, type FolderFingerprint } from "./folders.js";
import type { FolderPreference } from "./keeper.js";
import {
  dirOf,
  folderKeyOf,
  isUnder,
  MIN_FOLDER_FILES,
  SEP,
  type DeletionBlocks,
  type ScanFile,
  type Writer
} from "./snapshot.js";

// ── Folders already stored elsewhere ────────────────────────────────────────
//
// The tier the "copies sit in '.'" defect lived in. Asked per file, answered per
// file, and the covering side written out as the SET of folders the counterparts
// turned out to be in.

export function snapshotContained(
  write: Writer,
  prints: FolderFingerprint[],
  files: ScanFile[],
  filesByFolder: (print: FolderFingerprint) => ScanFile[],
  claimed: Set<string>,
  preferences: FolderPreference[],
  blocks: DeletionBlocks,
  preferenceFor: (libraryId: string, path: string) => "keep" | "clear" | null
): number {
  // Every file that could be somebody's counterpart, by digest.
  const byHash = new Map<string, ScanFile[]>();
  for (const file of files) {
    if (!file.hash) continue;
    const bucket = byHash.get(file.hash);
    if (bucket) bucket.push(file); else byHash.set(file.hash, [file]);
  }

  type Pair = { file: ScanFile; counterpart: ScanFile };

  // Match every file below `print` to a counterpart OUTSIDE it, one counterpart per
  // file so a folder holding the same picture twice needs two copies elsewhere.
  // `offLimits` holds files already promised to another folder's removal — they are
  // on their way to the Recycle Bin and cannot be anyone's surviving copy.
  const coverageOf = (print: FolderFingerprint, offLimits: Set<string>): Pair[] | null => {
    const inside = filesByFolder(print);
    if (inside.length === 0) return null;
    const taken = new Set<string>();
    const found: Pair[] = [];
    for (const file of inside) {
      if (!file.hash) return null;
      const options = (byHash.get(file.hash) ?? []).filter((other) =>
        !taken.has(other.itemId)
        && !offLimits.has(other.itemId)
        && !(other.libraryId === print.libraryId && isUnder(print.folderPath, other.path))
        // A folder being cleared out is not somewhere a photo is SAFE. Naming one as
        // the survivor says "this folder is redundant, the copies live over there"
        // about the very folder the admin asked to empty — and it was only a tiebreak
        // before, so with no alternative the scan pointed there anyway. When this
        // leaves nothing, the folder simply is not covered, which is the truth.
        && preferenceFor(other.libraryId, dirOf(other.path)) !== "clear");
      if (options.length === 0) return null;
      // Which copy is named as the survivor, best first: one that cannot be deleted
      // anyway, then a folder marked keep, then whatever sorts first.
      const best = options.sort((a, b) =>
        Number(blocks.path(b.libraryId, b.path)) - Number(blocks.path(a.libraryId, a.path))
        || Number(preferenceFor(b.libraryId, b.path) === "keep") - Number(preferenceFor(a.libraryId, a.path) === "keep")
        || (a.path < b.path ? -1 : 1))[0];
      taken.add(best.itemId);
      found.push({ file, counterpart: best });
    }
    return found;
  };

  // Dismissals here are read by FOLDER, not by folder-and-target — "leave this one
  // alone" is a statement about the folder, and matching on the pair would bring it
  // straight back under whichever folder covers it next, which is the same suggestion
  // again wearing a different label.
  const dismissed = containedIgnoreKeys();

  const eligible = (print: FolderFingerprint): boolean => {
    // A library's own root going "elsewhere" means emptying the library, which is
    // never what "this folder is redundant" is meant to say.
    if (print.folderPath === "") return false;
    if (claimed.has(folderKeyOf(print))) return false;
    if (dismissed.has(folderKeyOf(print))) return false;
    if (print.itemCount < MIN_FOLDER_FILES) return false;
    // Never propose removing a folder the job says to keep photos in.
    if (preferenceFor(print.libraryId, print.folderPath) === "keep") return false;
    // Nor one a protected library or a folder lock forbids clearing out — a lock
    // ANYWHERE inside counts, because emptying the folder would delete the locked part.
    return !blocks.subtree(print.libraryId, print.folderPath);
  };

  let written = 0;

  // Folders marked "clear" first, then deepest first.
  //
  // Depth alone is the right default — if an inner folder is covered, saying so is
  // more useful than offering its parent, and the parent's offer would take it along
  // anyway. But the doomed side is claimed in this order, and whatever is claimed
  // first turns everything covering it into a survivor. A shallow folder marked clear
  // therefore lost every race to the deep dated folders it duplicated, and ended up
  // named as THEIR survivor: the one outcome the instruction rules out.
  const clearedFirst = (print: FolderFingerprint): number =>
    preferenceFor(print.libraryId, print.folderPath) === "clear" ? 0 : 1;

  const ordered = [...prints].filter(eligible).sort((a, b) =>
    clearedFirst(a) - clearedFirst(b)
    || b.folderPath.split("/").length - a.folderPath.split("/").length
    || a.folderPath.localeCompare(b.folderPath));

  const candidates = new Map<string, { print: FolderFingerprint; pairs: Pair[] }>();
  for (const print of ordered) {
    const found = coverageOf(print, new Set());
    if (found) candidates.set(folderKeyOf(print), { print, pairs: found });
  }

  // Two folders holding the same pictures in a different LAYOUT cover each other —
  // every copy of A's sits inside B and every copy of B's inside A — so both
  // qualify, and offering both would, taken together, delete every copy. One has to
  // stay, chosen by the same scoring the identical-folder sets use.
  const dropped = new Set<string>();
  for (const [key, entry] of candidates) {
    if (dropped.has(key)) continue;
    for (const [otherKey, other] of candidates) {
      if (otherKey === key || dropped.has(otherKey)) continue;
      const mineInsideTheirs = entry.pairs.every((pair) =>
        pair.counterpart.libraryId === other.print.libraryId
        && isUnder(other.print.folderPath, pair.counterpart.path));
      const theirsInsideMine = other.pairs.every((pair) =>
        pair.counterpart.libraryId === entry.print.libraryId
        && isUnder(entry.print.folderPath, pair.counterpart.path));
      if (!mineInsideTheirs || !theirsInsideMine) continue;
      const winner = pickFolderKeeper([entry.print, other.print], preferences);
      const keeperKey = winner ? (winner.keeper.libraryId + SEP + winner.keeper.folderPath) : key;
      dropped.add(keeperKey);
      if (keeperKey === key) break;
    }
  }

  // Two ledgers, kept as the offers are written. The pairwise check above settles the
  // ordinary two-folder case; these are what also hold for a longer ring of folders
  // each covered by the next, where no single pair looks mutual.
  //
  //   doomed    — already offered for removal, so it can't be anyone's surviving copy
  //   survivors — already named as somebody's surviving copy, so the folder holding it
  //               can't itself be offered for removal
  //
  // Without the second one, "A survives in Album" and "Album is redundant" can both be
  // offered, and carrying out both deletes the only copies A was promised.
  const doomed = new Set<string>();
  const survivors = new Set<string>();

  for (const print of ordered) {
    const key = folderKeyOf(print);
    if (!candidates.has(key) || dropped.has(key)) continue;

    const inside = filesByFolder(print);
    if (inside.some((file) => survivors.has(file.itemId))) continue;

    const pairs = coverageOf(print, doomed);
    if (!pairs) continue;

    // ONE RESULT PER DESTINATION. The files of a folder rarely all survive in the
    // same place, and a card that lists several destinations has to be read as "one
    // folder against a set", which nobody does — it gets read as "these folders are
    // duplicates of each other". Grouping the pairs by where the copies actually
    // live makes every card a plain sentence: these N photos of yours are already
    // in that folder.
    //
    // The cards stay independent: a photo may go because ITS counterpart exists, and
    // that is true whatever happens to the others. Clearing only some of them leaves
    // the folder part-emptied, which is a smaller version of the same safe act.
    const byDestination = new Map<string, Pair[]>();
    for (const pair of pairs) {
      const folderPath = dirOf(pair.counterpart.path);
      const destination = pair.counterpart.libraryId + SEP + folderPath;
      const bucket = byDestination.get(destination);
      if (bucket) bucket.push(pair);
      else byDestination.set(destination, [pair]);
    }

    for (const [destination, group] of byDestination) {
      const cut = destination.indexOf(SEP);
      const destLibraryId = destination.slice(0, cut);
      const destFolderPath = destination.slice(cut + 1);
      const goingBytes = group.reduce((sum, pair) => sum + (pair.file.size ?? 0), 0);

      const resultId = write.result({
        type: "contained",
        reclaimableBytes: goingBytes,
        keeperReason: null
      });

      // The doomed side of THIS card is only the photos that survive here — not the
      // whole folder, which may be leaving across several cards.
      const doomedFolderId = write.folder(resultId, {
        libraryId: print.libraryId, folderPath: print.folderPath,
        role: "delete", itemCount: group.length, bytes: goingBytes
      });
      const keeperFolderId = write.folder(resultId, {
        libraryId: destLibraryId, folderPath: destFolderPath,
        role: blocks.path(destLibraryId, destFolderPath) ? "protected" : "keep",
        itemCount: group.length,
        bytes: group.reduce((sum, pair) => sum + (pair.counterpart.size ?? 0), 0)
      });

      const keeperMembers = new Map<string, string>();
      for (const { counterpart } of group) {
        if (keeperMembers.has(counterpart.itemId)) continue;
        keeperMembers.set(
          counterpart.itemId,
          write.member(resultId, { file: counterpart, role: "keep", folderId: keeperFolderId })
        );
      }
      for (const { file, counterpart } of group) {
        write.member(resultId, {
          file, role: "delete", folderId: doomedFolderId,
          keeperMemberId: keeperMembers.get(counterpart.itemId) ?? null
        });
      }
      written += 1;
    }

    for (const { file, counterpart } of pairs) {
      doomed.add(file.itemId);
      survivors.add(counterpart.itemId);
    }
  }

  return written;
}
