// Taking a cleanup job's SNAPSHOT — turning "what the digests say right now" into
// rows the job owns and can come back to next week.
//
// This is not a second duplicate detector. The digests, the folder fingerprints and
// the keeper scoring are the ones the older pages use; what differs is where the
// answer is written and, for the contained tier, how the covering side is expressed.
//
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
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { libraryAllowsDelete } from "../shared/trash.js";
import {
  fingerprintFolders,
  pickFolderKeeper,
  type FolderFingerprint
} from "./duplicate-folders.js";
import {
  loadDetails,
  pickKeeper,
  type DetailRow,
  type FolderPreference
} from "./duplicates.js";
import {
  getJob,
  recordAction,
  setJobStatus,
  type DuplicateJob,
  type JobOutcome,
  type MediaTypeScope
} from "./duplicate-jobs.js";

/** A folder holding a single photo is a duplicate photo, not a duplicate folder —
 *  the same gate the cached tier applies. */
const MIN_FOLDER_FILES = 2;

type MemberRole = "keep" | "delete" | "protected";

interface ScanFile {
  itemId: string;
  libraryId: string;
  /** Path of the FILE relative to its library, which is what library_items stores. */
  path: string;
  hash: string | null;
  size: number | null;
  /** Both stamps are kept: `mtime` is what revalidation compares before deleting,
   *  `discoveredAt` is what the "added first" tiebreak reads. */
  mtime: string | null;
  discoveredAt: string;
  kind: string;
}

const dirOf = (filePath: string): string => {
  const cut = filePath.lastIndexOf("/");
  return cut === -1 ? "" : filePath.slice(0, cut);
};

// A (library, folder) pair as a map key. NUL separates the two because a folder
// path may contain anything else a filesystem allows — and because a plain space
// here once went in as a literal NUL through a tooling quirk, leaving two key
// formats that never matched and a folder answered twice.
const SEP = String.fromCharCode(0);
const folderKeyOf = (ref: { libraryId: string; folderPath: string }): string =>
  ref.libraryId + SEP + ref.folderPath;

const isUnder = (folderPath: string, filePath: string): boolean =>
  folderPath === "" || filePath.startsWith(`${folderPath}/`);

// ── Reading the library, once ───────────────────────────────────────────────

function scanFiles(libraryIds: string[], mediaType: MediaTypeScope): ScanFile[] {
  if (libraryIds.length === 0) return [];
  const kinds = mediaType === "both" ? ["photo", "video"] : [mediaType];
  const rows = db.prepare(`
    SELECT li.id AS item_id, li.library_id, li.folder_path, li.discovered_at,
           gd.content_hash, gd.size, gd.modified_at, gd.kind
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
    WHERE li.deleted_at IS NULL AND li.status = 'ready'
      AND li.library_id IN (${libraryIds.map(() => "?").join(",")})
      AND gd.kind IN (${kinds.map(() => "?").join(",")})
    ORDER BY li.library_id, li.folder_path
  `).all(...libraryIds, ...kinds) as {
    item_id: string; library_id: string; folder_path: string; discovered_at: string;
    content_hash: string | null; size: number | null; modified_at: string | null; kind: string;
  }[];

  return rows.map((row) => ({
    itemId: row.item_id,
    libraryId: row.library_id,
    path: row.folder_path,
    hash: row.content_hash,
    size: row.size,
    mtime: row.modified_at,
    discoveredAt: row.discovered_at,
    kind: row.kind
  }));
}

// ── Writing the snapshot ────────────────────────────────────────────────────

interface Writer {
  result: (input: {
    type: "photo_set" | "folder_set" | "contained" | "overlap";
    reclaimableBytes: number;
    keeperReason: string | null;
  }) => string;
  folder: (resultId: string, input: {
    libraryId: string; folderPath: string; role: MemberRole; itemCount: number; bytes: number;
  }) => string;
  member: (resultId: string, input: {
    file: ScanFile; role: MemberRole; folderId?: string | null; keeperMemberId?: string | null;
  }) => string;
}

function writerFor(jobId: string): Writer {
  const insertResult = db.prepare(`
    INSERT INTO duplicate_job_results (id, job_id, result_type, reclaimable_bytes, keeper_reason)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertFolder = db.prepare(`
    INSERT INTO duplicate_job_result_folders (id, job_id, result_id, library_id, folder_path, role, item_count, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO duplicate_job_result_members
      (id, job_id, result_id, folder_id, item_id, library_id, path, size_snapshot, mtime_snapshot,
       content_hash, role, keeper_member_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    result: (input) => {
      const id = nanoid(16);
      insertResult.run(id, jobId, input.type, input.reclaimableBytes, input.keeperReason);
      return id;
    },
    folder: (resultId, input) => {
      const id = nanoid(16);
      insertFolder.run(
        id, jobId, resultId, input.libraryId, input.folderPath, input.role, input.itemCount, input.bytes
      );
      return id;
    },
    member: (resultId, input) => {
      const id = nanoid(16);
      insertMember.run(
        id, jobId, resultId, input.folderId ?? null, input.file.itemId, input.file.libraryId,
        input.file.path, input.file.size, input.file.mtime, input.file.hash,
        input.role, input.keeperMemberId ?? null
      );
      return id;
    }
  };
}

// ── Photo sets ──────────────────────────────────────────────────────────────
//
// Byte-identical copies of one picture, wherever they sit. Grouped straight from the
// digests rather than read back from the cached groups: the cache spans every library
// and this job may cover two of five, and a set whose other copies were filtered out
// is a different set — one that would offer to delete the last copy in scope.

function snapshotPhotoSets(
  write: Writer,
  files: ScanFile[],
  preferences: FolderPreference[],
  protectedLibs: Set<string>
): number {
  const byHash = new Map<string, ScanFile[]>();
  for (const file of files) {
    if (!file.hash) continue;
    const bucket = byHash.get(file.hash);
    if (bucket) bucket.push(file); else byHash.set(file.hash, [file]);
  }

  const sets = [...byHash.values()].filter((group) => group.length > 1);
  if (sets.length === 0) return 0;

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

    // Every copy outside a protected library can go; the ones inside are shown and
    // never offered, so the card can say which copy is staying and why.
    const doomed = others.filter((file) => !protectedLibs.has(file.libraryId));
    const reclaimable = doomed.reduce((sum, file) => sum + (file.size ?? 0), 0);

    const resultId = write.result({ type: "photo_set", reclaimableBytes: reclaimable, keeperReason: choice.reason });
    const keeperMemberId = write.member(resultId, { file: keeperFile, role: "keep" });
    for (const file of others) {
      write.member(resultId, {
        file,
        role: protectedLibs.has(file.libraryId) ? "protected" : "delete",
        keeperMemberId: protectedLibs.has(file.libraryId) ? null : keeperMemberId
      });
    }
    written += 1;
  }
  return written;
}

// ── Folder fingerprints, scoped to the job ──────────────────────────────────

function scopedFingerprints(files: ScanFile[]): FolderFingerprint[] {
  // fingerprintFolders takes the same row shape the global pass reads, so the job's
  // narrower file list produces folder prints over exactly its own libraries.
  return fingerprintFolders(files.map((file) => ({
    item_id: file.itemId,
    library_id: file.libraryId,
    folder_path: file.path,
    content_hash: file.hash,
    size: file.size,
    discovered_at: file.discoveredAt
  })));
}

// ── Identical folders ───────────────────────────────────────────────────────

function snapshotFolderSets(
  write: Writer,
  prints: FolderFingerprint[],
  filesByFolder: (print: FolderFingerprint) => ScanFile[],
  preferences: FolderPreference[],
  protectedLibs: Set<string>
): { written: number; claimed: Set<string> } {
  const byDigest = new Map<string, FolderFingerprint[]>();
  for (const print of prints) {
    const bucket = byDigest.get(print.digest);
    if (bucket) bucket.push(print); else byDigest.set(print.digest, [print]);
  }

  const claimed = new Set<string>();
  let written = 0;

  for (const group of byDigest.values()) {
    if (group.length < 2) continue;
    // The topmost folder wins: when a parent and its child both match something,
    // removing the parent takes the child with it, and offering both is two answers
    // to one question.
    if (group.some((print) => group.some((other) =>
      other !== print && other.libraryId === print.libraryId && isUnder(other.folderPath, print.folderPath)))) {
      continue;
    }

    const choice = pickFolderKeeper(group, preferences);
    if (!choice) continue;
    const keeper = group.find((print) =>
      print.libraryId === choice.keeper.libraryId && print.folderPath === choice.keeper.folderPath) ?? group[0];
    const others = group.filter((print) => print !== keeper);
    const doomed = others.filter((print) => !protectedLibs.has(print.libraryId));
    if (doomed.length === 0) continue;

    const resultId = write.result({
      type: "folder_set",
      reclaimableBytes: doomed.reduce((sum, print) => sum + print.bytes, 0),
      keeperReason: choice.reason
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
      const role: MemberRole = protectedLibs.has(print.libraryId) ? "protected" : "delete";
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

// ── Folders already stored elsewhere ────────────────────────────────────────
//
// The tier the "copies sit in '.'" defect lived in. Asked per file, answered per
// file, and the covering side written out as the SET of folders the counterparts
// turned out to be in.

function snapshotContained(
  write: Writer,
  prints: FolderFingerprint[],
  files: ScanFile[],
  filesByFolder: (print: FolderFingerprint) => ScanFile[],
  claimed: Set<string>,
  preferences: FolderPreference[],
  protectedLibs: Set<string>,
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
        && !(other.libraryId === print.libraryId && isUnder(print.folderPath, other.path)));
      if (options.length === 0) return null;
      // Which copy is named as the survivor, best first: one that cannot be deleted
      // anyway, then a folder marked keep, then anything not being cleared out.
      const best = options.sort((a, b) =>
        Number(protectedLibs.has(b.libraryId)) - Number(protectedLibs.has(a.libraryId))
        || Number(preferenceFor(b.libraryId, b.path) === "keep") - Number(preferenceFor(a.libraryId, a.path) === "keep")
        || Number(preferenceFor(a.libraryId, a.path) === "clear") - Number(preferenceFor(b.libraryId, b.path) === "clear")
        || (a.path < b.path ? -1 : 1))[0];
      taken.add(best.itemId);
      found.push({ file, counterpart: best });
    }
    return found;
  };

  const eligible = (print: FolderFingerprint): boolean => {
    // A library's own root going "elsewhere" means emptying the library, which is
    // never what "this folder is redundant" is meant to say.
    if (print.folderPath === "") return false;
    if (claimed.has(folderKeyOf(print))) return false;
    if (print.itemCount < MIN_FOLDER_FILES) return false;
    // Never propose removing a folder the job says to keep photos in.
    if (preferenceFor(print.libraryId, print.folderPath) === "keep") return false;
    return !protectedLibs.has(print.libraryId);
  };

  let written = 0;

  // Deepest folders first: if an inner folder is covered, saying so is more useful
  // than offering its parent, and the parent's own offer would take it along anyway.
  const ordered = [...prints].filter(eligible).sort((a, b) =>
    b.folderPath.split("/").length - a.folderPath.split("/").length
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

    const bytes = inside.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const resultId = write.result({
      type: "contained",
      reclaimableBytes: bytes,
      keeperReason: null
    });

    const doomedFolderId = write.folder(resultId, {
      libraryId: print.libraryId, folderPath: print.folderPath,
      role: "delete", itemCount: inside.length, bytes
    });

    // ONE folder row per folder the counterparts actually sit in — the union that the
    // single target column could never hold. This is what the card reads.
    const keeperFolders = new Map<string, { id: string; itemCount: number; bytes: number }>();
    const keeperMembers = new Map<string, string>();
    for (const { counterpart } of pairs) {
      const folderPath = dirOf(counterpart.path);
      const folderKey = counterpart.libraryId + SEP + folderPath;
      let folder = keeperFolders.get(folderKey);
      if (!folder) {
        folder = {
          id: write.folder(resultId, {
            libraryId: counterpart.libraryId, folderPath,
            role: protectedLibs.has(counterpart.libraryId) ? "protected" : "keep",
            itemCount: 0, bytes: 0
          }),
          itemCount: 0,
          bytes: 0
        };
        keeperFolders.set(folderKey, folder);
      }
      folder.itemCount += 1;
      folder.bytes += counterpart.size ?? 0;
      if (!keeperMembers.has(counterpart.itemId)) {
        keeperMembers.set(
          counterpart.itemId,
          write.member(resultId, { file: counterpart, role: "keep", folderId: folder.id })
        );
      }
    }
    const countFolder = db.prepare(
      "UPDATE duplicate_job_result_folders SET item_count = ?, bytes = ? WHERE id = ?"
    );
    for (const folder of keeperFolders.values()) countFolder.run(folder.itemCount, folder.bytes, folder.id);

    for (const { file, counterpart } of pairs) {
      write.member(resultId, {
        file, role: "delete", folderId: doomedFolderId,
        keeperMemberId: keeperMembers.get(counterpart.itemId) ?? null
      });
    }

    for (const { file, counterpart } of pairs) {
      doomed.add(file.itemId);
      survivors.add(counterpart.itemId);
    }
    written += 1;
  }

  return written;
}

// ── The scan ────────────────────────────────────────────────────────────────

export interface ScanSummary {
  photoSets: number;
  folderSets: number;
  contained: number;
  results: number;
}

/** Compute the job's answers and write them into its own tables, replacing whatever
 *  a previous run left. Reads no files: everything here is derived from digests the
 *  hashing pass has already stored. */
export function runJobScan(jobId: string, userId: string): JobOutcome<DuplicateJob> & { summary?: ScanSummary } {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };

  const libraryIds = job.libraries.filter((library) => library.included && !library.missing)
    .map((library) => library.libraryId);
  if (libraryIds.length === 0) return { ok: false, refused: "no_libraries" };

  setJobStatus(jobId, userId, "scanning");

  const preferences: FolderPreference[] = job.folderPreferences.map((folder) => ({
    libraryId: folder.libraryId,
    folderPath: folder.folderPath,
    mode: folder.mode
  }));
  const preferenceFor = (libraryId: string, path: string): "keep" | "clear" | null => {
    let best: FolderPreference | null = null;
    for (const folder of preferences) {
      if (folder.libraryId !== libraryId) continue;
      if (!(folder.folderPath === "" || path === folder.folderPath || path.startsWith(`${folder.folderPath}/`))) continue;
      if (!best || folder.folderPath.length > best.folderPath.length) best = folder;
    }
    return best?.mode ?? null;
  };
  const protectedLibs = new Set(libraryIds.filter((id) => !libraryAllowsDelete(id)));

  let summary: ScanSummary = { photoSets: 0, folderSets: 0, contained: 0, results: 0 };

  try {
    const files = scanFiles(libraryIds, job.mediaType);
    const prints = scopedFingerprints(files);

    // Files below a folder, resolved once rather than re-scanned per folder.
    const byLibrary = new Map<string, ScanFile[]>();
    for (const file of files) {
      const bucket = byLibrary.get(file.libraryId);
      if (bucket) bucket.push(file); else byLibrary.set(file.libraryId, [file]);
    }
    const filesByFolder = (print: FolderFingerprint): ScanFile[] =>
      (byLibrary.get(print.libraryId) ?? []).filter((file) => isUnder(print.folderPath, file.path));

    db.transaction(() => {
      // A rescan replaces the job's answers. The members cascade from the results.
      db.prepare("DELETE FROM duplicate_job_results WHERE job_id = ?").run(jobId);

      const write = writerFor(jobId);
      const wantsFolders = job.duplicateType !== "files";
      const wantsFiles = job.duplicateType !== "folders";

      let claimed = new Set<string>();
      if (wantsFolders) {
        const sets = snapshotFolderSets(write, prints, filesByFolder, preferences, protectedLibs);
        summary.folderSets = sets.written;
        claimed = sets.claimed;
        summary.contained = snapshotContained(
          write, prints, files, filesByFolder, claimed, preferences, protectedLibs, preferenceFor
        );
      }
      if (wantsFiles) {
        summary.photoSets = snapshotPhotoSets(write, files, preferences, protectedLibs);
      }
      summary.results = summary.photoSets + summary.folderSets + summary.contained;
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : "The scan failed.";
    setJobStatus(jobId, userId, "failed", message);
    return { ok: false, refused: "not_reviewable", detail: message };
  }

  recordAction({
    jobId,
    userId,
    action: "job.scanned",
    details: `${summary.results} results: ${summary.photoSets} photo sets, ${summary.folderSets} folder sets, ${summary.contained} folders stored elsewhere.`
  });
  const moved = setJobStatus(jobId, userId, "review");
  return moved.ok ? { ok: true, job: moved.job, summary } : moved;
}

// ── Reading the snapshot back ───────────────────────────────────────────────

export interface SnapshotFolder {
  libraryId: string;
  libraryName: string;
  folderPath: string;
  role: MemberRole;
  itemCount: number;
  bytes: number;
}

export interface SnapshotMember {
  id: string;
  itemId: string | null;
  libraryId: string;
  libraryName: string;
  path: string;
  size: number | null;
  role: MemberRole;
  status: string;
  /** Where this copy survives, when it is one being deleted. */
  keeperPath: string | null;
}

export interface SnapshotResult {
  id: string;
  type: "photo_set" | "folder_set" | "contained" | "overlap";
  status: string;
  reviewStatus: string;
  reclaimableBytes: number;
  keeperReason: string | null;
  folders: SnapshotFolder[];
  members: SnapshotMember[];
}

/** Every folder the copies of a contained result actually live in — the sentence the
 *  old card could not say. Derived from the snapshot, never from a single column. */
export const keeperFoldersOf = (result: SnapshotResult): string[] =>
  result.folders.filter((folder) => folder.role !== "delete").map((folder) => folder.folderPath).sort();

/** How the page narrows what it shows. */
export interface ResultFilter {
  /** Substring over folder paths, file paths and library names. */
  search?: string;
  type?: SnapshotResult["type"];
  review?: "unreviewed" | "reviewed" | "skipped";
  libraryId?: string;
}

// One WHERE clause for both the listing and its count, so the pager can never report
// a total from one set of filters and a page from another.
function filterSql(jobId: string, filter: ResultFilter): { where: string; args: unknown[] } {
  const clauses = ["r.job_id = ?"];
  const args: unknown[] = [jobId];

  if (filter.type) { clauses.push("r.result_type = ?"); args.push(filter.type); }
  if (filter.review) { clauses.push("r.review_status = ?"); args.push(filter.review); }
  if (filter.libraryId) {
    clauses.push(
      "EXISTS (SELECT 1 FROM duplicate_job_result_members m WHERE m.result_id = r.id AND m.library_id = ?)"
    );
    args.push(filter.libraryId);
  }
  const needle = filter.search?.trim();
  if (needle) {
    const like = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
    clauses.push(`(
      EXISTS (SELECT 1 FROM duplicate_job_result_members m
              LEFT JOIN libraries lib ON lib.id = m.library_id
              WHERE m.result_id = r.id
                AND (m.path LIKE ? ESCAPE '\\' OR lib.name LIKE ? ESCAPE '\\'))
      OR EXISTS (SELECT 1 FROM duplicate_job_result_folders f
                 WHERE f.result_id = r.id AND f.folder_path LIKE ? ESCAPE '\\')
    )`);
    args.push(like, like, like);
  }

  return { where: clauses.join(" AND "), args };
}

export function listJobResults(
  jobId: string,
  limit = 50,
  offset = 0,
  filter: ResultFilter = {}
): SnapshotResult[] {
  const scope = filterSql(jobId, filter);
  const results = db.prepare(`
    SELECT r.id, r.result_type, r.status, r.review_status, r.reclaimable_bytes, r.keeper_reason
    FROM duplicate_job_results r WHERE ${scope.where}
    ORDER BY
      CASE r.result_type WHEN 'folder_set' THEN 0 WHEN 'contained' THEN 1 WHEN 'overlap' THEN 2 ELSE 3 END,
      r.reclaimable_bytes DESC, r.id
    LIMIT ? OFFSET ?
  `).all(...scope.args, limit, offset) as {
    id: string; result_type: SnapshotResult["type"]; status: string; review_status: string;
    reclaimable_bytes: number; keeper_reason: string | null;
  }[];
  if (results.length === 0) return [];

  const ids = results.map((row) => row.id);
  const list = ids.map(() => "?").join(",");

  const folders = db.prepare(`
    SELECT f.result_id, f.library_id, lib.name AS library_name, f.folder_path, f.role, f.item_count, f.bytes
    FROM duplicate_job_result_folders f
    LEFT JOIN libraries lib ON lib.id = f.library_id
    WHERE f.result_id IN (${list})
    ORDER BY f.role DESC, f.folder_path
  `).all(...ids) as {
    result_id: string; library_id: string; library_name: string | null; folder_path: string;
    role: MemberRole; item_count: number; bytes: number;
  }[];

  const members = db.prepare(`
    SELECT m.id, m.result_id, m.item_id, m.library_id, lib.name AS library_name, m.path,
           m.size_snapshot, m.role, m.status, keeper.path AS keeper_path
    FROM duplicate_job_result_members m
    LEFT JOIN libraries lib ON lib.id = m.library_id
    LEFT JOIN duplicate_job_result_members keeper ON keeper.id = m.keeper_member_id
    WHERE m.result_id IN (${list})
    ORDER BY m.role DESC, m.path
  `).all(...ids) as {
    id: string; result_id: string; item_id: string | null; library_id: string;
    library_name: string | null; path: string; size_snapshot: number | null;
    role: MemberRole; status: string; keeper_path: string | null;
  }[];

  const foldersBy = new Map<string, SnapshotFolder[]>();
  for (const row of folders) {
    const bucket = foldersBy.get(row.result_id) ?? [];
    bucket.push({
      libraryId: row.library_id,
      libraryName: row.library_name ?? "(removed library)",
      folderPath: row.folder_path,
      role: row.role,
      itemCount: row.item_count,
      bytes: row.bytes
    });
    foldersBy.set(row.result_id, bucket);
  }

  const membersBy = new Map<string, SnapshotMember[]>();
  for (const row of members) {
    const bucket = membersBy.get(row.result_id) ?? [];
    bucket.push({
      id: row.id,
      itemId: row.item_id,
      libraryId: row.library_id,
      libraryName: row.library_name ?? "(removed library)",
      path: row.path,
      size: row.size_snapshot,
      role: row.role,
      status: row.status,
      keeperPath: row.keeper_path
    });
    membersBy.set(row.result_id, bucket);
  }

  return results.map((row) => ({
    id: row.id,
    type: row.result_type,
    status: row.status,
    reviewStatus: row.review_status,
    reclaimableBytes: row.reclaimable_bytes,
    keeperReason: row.keeper_reason,
    folders: foldersBy.get(row.id) ?? [],
    members: membersBy.get(row.id) ?? []
  }));
}

export function countJobResults(jobId: string, filter: ResultFilter = {}): number {
  const scope = filterSql(jobId, filter);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM duplicate_job_results r WHERE ${scope.where}`)
    .get(...scope.args) as { n: number };
  return row.n;
}
