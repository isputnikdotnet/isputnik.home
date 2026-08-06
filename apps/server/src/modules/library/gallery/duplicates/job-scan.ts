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
import { db } from "../../../../db.js";
import { libraryAllowsDelete } from "../../shared/trash.js";
import {
  containedIgnoreKeys,
  fingerprintFolders,
  folderComponents,
  folderIgnorePairs,
  folderOverlapIgnores,
  folderSameOrInside,
  parentOf,
  pickFolderKeeper,
  type FolderFingerprint
} from "./folders.js";
import {
  connectedComponents,
  duplicateIgnorePairs,
  enqueueJobScan,
  groupNearIdentical,
  loadDetails,
  pickKeeper,
  type DetailRow,
  type FolderPreference
} from "./items.js";
import {
  getJob,
  recordAction,
  setJobStatus,
  type DuplicateJob,
  type JobOutcome,
  type MediaTypeScope
} from "./jobs.js";

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
  /** 64-bit dHash, for the near-identical tier. NULL on every video and on photos the
   *  catalog scan has not backfilled — those simply never join a near set. */
  phash: string | null;
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
           gd.content_hash, gd.phash, gd.size, gd.modified_at, gd.kind
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
    WHERE li.deleted_at IS NULL AND li.status = 'ready'
      AND li.library_id IN (${libraryIds.map(() => "?").join(",")})
      AND gd.kind IN (${kinds.map(() => "?").join(",")})
    ORDER BY li.library_id, li.folder_path
  `).all(...libraryIds, ...kinds) as {
    item_id: string; library_id: string; folder_path: string; discovered_at: string;
    content_hash: string | null; phash: string | null; size: number | null;
    modified_at: string | null; kind: string;
  }[];

  return rows.map((row) => ({
    itemId: row.item_id,
    libraryId: row.library_id,
    path: row.folder_path,
    hash: row.content_hash,
    phash: row.phash,
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
    /** Defaults to the byte-identical answer, which is what every tier but near is. */
    matchConfidence?: "certain" | "likely" | "unsure";
    /** Which criterion settled the keeper; -1 when nothing did. */
    keeperRank?: number;
  }) => string;
  folder: (resultId: string, input: {
    libraryId: string; folderPath: string; role: MemberRole; itemCount: number; bytes: number;
  }) => string;
  member: (resultId: string, input: {
    file: ScanFile; role: MemberRole; folderId?: string | null; keeperMemberId?: string | null;
    /** Bits from the keeper. Omitted — and so 0 — everywhere except a near-identical set. */
    distance?: number;
  }) => string;
}

function writerFor(jobId: string): Writer {
  const insertResult = db.prepare(`
    INSERT INTO duplicate_job_results
      (id, job_id, result_type, reclaimable_bytes, keeper_reason, match_confidence, keeper_rank)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFolder = db.prepare(`
    INSERT INTO duplicate_job_result_folders (id, job_id, result_id, library_id, folder_path, role, item_count, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO duplicate_job_result_members
      (id, job_id, result_id, folder_id, item_id, library_id, path, size_snapshot, mtime_snapshot,
       content_hash, distance, role, keeper_member_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    result: (input) => {
      const id = nanoid(16);
      insertResult.run(
        id, jobId, input.type, input.reclaimableBytes, input.keeperReason,
        input.matchConfidence ?? "certain", input.keeperRank ?? -1
      );
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
        input.distance ?? 0, input.role, input.keeperMemberId ?? null
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

    // Every copy outside a protected library can go; the ones inside are shown and
    // never offered, so the card can say which copy is staying and why.
    const doomed = others.filter((file) => !protectedLibs.has(file.libraryId));
    const reclaimable = doomed.reduce((sum, file) => sum + (file.size ?? 0), 0);

    const resultId = write.result({
      type: "photo_set", reclaimableBytes: reclaimable, keeperReason: choice.reason,
      keeperRank: choice.rank
    });
    const keeperMemberId = write.member(resultId, { file: keeperFile, role: "keep" });
    for (const file of others) {
      write.member(resultId, {
        file,
        role: protectedLibs.has(file.libraryId) ? "protected" : "delete",
        keeperMemberId: protectedLibs.has(file.libraryId) ? null : keeperMemberId
      });
      suppressed.add(file.itemId);
    }
    written += 1;
  }
  return { written, suppressed };
}

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

function looksLikeSeparateShots(a: DetailRow, b: DetailRow): boolean {
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
function nearConfidence(keeper: DetailRow, other: DetailRow): "likely" | "unsure" {
  if (!sameCameraShape(keeper, other)) return "likely";
  if (!keeper.taken_at || !other.taken_at) return "likely";
  const gap = Math.abs(Date.parse(keeper.taken_at) - Date.parse(other.taken_at));
  return Number.isFinite(gap) && gap > SHOT_GAP_SECONDS * 1000 ? "unsure" : "likely";
}

function snapshotNearSets(
  write: Writer,
  files: ScanFile[],
  suppressed: Set<string>,
  preferences: FolderPreference[],
  protectedLibs: Set<string>
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

    const doomed = others.filter((file) => !protectedLibs.has(file.libraryId));
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
      const isProtected = protectedLibs.has(file.libraryId);
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
    const doomed = others.filter((print) => !protectedLibs.has(print.libraryId));
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
        role: protectedLibs.has(destLibraryId) ? "protected" : "keep",
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

function snapshotOverlaps(
  write: Writer,
  files: ScanFile[],
  jobId: string,
  preferences: FolderPreference[],
  protectedLibs: Set<string>
): number {
  // Every hashed file, by the folder it sits DIRECTLY in — an overlap is about two
  // folders' own contents, not their subtrees. A folder and its parent share photos by
  // definition and that is the contained tier's business, not this one's.
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
  ).all(jobId) as { library_id: string; folder_path: string }[];
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
    // A folder does not "overlap" its own parent — those copies belong to the tiers
    // above, and the pair reads as nonsense on a card.
    if (folderSameOrInside(pair.a, pair.b) || folderSameOrInside(pair.b, pair.a)) continue;
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
    if (protectedLibs.has(loseRef.libraryId)) continue;
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
      role: protectedLibs.has(keepRef.libraryId) ? "protected" : "keep",
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

// ── The scan ────────────────────────────────────────────────────────────────

export interface ScanSummary {
  photoSets: number;
  /** Byte-identical's sibling: same picture, different file. Files mode only. */
  nearSets: number;
  /** Lookalike pairs left out because they are two separate photographs, not copies.
   *  Counted rather than hidden: it is a big share of what the fingerprint matches on
   *  a real library, and "we found less than you expected" deserves a reason. */
  separateShots: number;
  folderSets: number;
  contained: number;
  /** Folder pairs sharing photos without either equalling or containing the other. */
  overlaps: number;
  results: number;
}

/** Ask for the job's scan, and come straight back.
 *
 *  Two phases, because the snapshot below reads no files and therefore needs digests
 *  that may not exist yet. Phase 1 is the fingerprint pass over THIS job's libraries,
 *  queued as an ordinary background job so it inherits requeue-on-restart, the attempt
 *  limit, and the standing courtesy of yielding to catalog and face scans. Phase 2 is
 *  runJobScan, which the worker calls once the digests are in place.
 *
 *  The pass is queued even when nothing looks like it needs reading. `pendingCount` is
 *  an estimate off the catalogue, and it is the stat pass itself that notices a file
 *  edited in place since the last library scan — so skipping it when the estimate says
 *  zero would trade correctness for a progress bar that flickers. With nothing to read
 *  the pass finishes in a moment anyway.
 *
 *  Distinct from applyPreferences, which re-runs the snapshot ALONE: reshuffling
 *  keepers under changed folder instructions needs no new digests, so that stays
 *  synchronous. */
export function startJobScan(jobId: string, userId: string): JobOutcome<DuplicateJob> {
  const job = getJob(jobId);
  if (!job) return { ok: false, refused: "not_found" };
  if (job.ownerUserId !== userId) return { ok: false, refused: "not_owner" };
  if (job.status !== "draft" && job.status !== "review" && job.status !== "paused") {
    return { ok: false, refused: "not_reviewable", detail: job.status };
  }

  const libraryIds = job.libraries.filter((library) => library.included && !library.missing)
    .map((library) => library.libraryId);
  if (libraryIds.length === 0) return { ok: false, refused: "no_libraries" };

  const moved = setJobStatus(jobId, userId, "scanning");
  if (!moved.ok) return moved;
  enqueueJobScan(jobId, libraryIds);
  return { ok: true, job: moved.job };
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

  let summary: ScanSummary = {
    photoSets: 0, nearSets: 0, separateShots: 0, folderSets: 0, contained: 0, overlaps: 0, results: 0
  };

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

      // One or the other, never both. A folder cleanup answers "is this whole folder
      // redundant"; a file cleanup answers "is this one picture here twice". Running
      // both at once meant every folder cleared re-ordered the single-file half
      // underneath it, and the two kinds of decision were nothing like the same size
      // of work to sit down to.
      if (job.duplicateType === "folders") {
        // Strongest statement first, each pass deferring to the ones before it: an
        // identical-folders set speaks for everything inside it, a stored-elsewhere card
        // speaks for its whole folder, and overlaps are only what is left over.
        const sets = snapshotFolderSets(write, prints, filesByFolder, preferences, protectedLibs);
        summary.folderSets = sets.written;
        summary.contained = snapshotContained(
          write, prints, files, filesByFolder, sets.claimed, preferences, protectedLibs, preferenceFor
        );
        summary.overlaps = snapshotOverlaps(write, files, jobId, preferences, protectedLibs);
      } else {
        // Exact first, then near over what it did not already speak for. The order is
        // not a preference: run the other way round and every byte-identical copy
        // appears twice, once in its own set and once inside a near set beside it.
        const exact = snapshotPhotoSets(write, files, preferences, protectedLibs);
        summary.photoSets = exact.written;
        const near = snapshotNearSets(write, files, exact.suppressed, preferences, protectedLibs);
        summary.nearSets = near.written;
        summary.separateShots = near.separateShots;
      }
      summary.results = summary.photoSets + summary.nearSets
        + summary.folderSets + summary.contained + summary.overlaps;
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : "The scan failed.";
    setJobStatus(jobId, userId, "failed", message);
    return { ok: false, refused: "scan_failed", detail: message };
  }

  recordAction({
    jobId,
    userId,
    action: "job.scanned",
    details: `${summary.results} results: ${summary.photoSets} identical files, ${summary.nearSets} near-identical, ${summary.folderSets} folder sets, ${summary.contained} folders stored elsewhere, ${summary.overlaps} sharing photos.`
      + (summary.separateShots > 0
        ? ` ${summary.separateShots} lookalike pair${summary.separateShots === 1 ? "" : "s"} left out as separate shots.`
        : "")
  });
  const moved = setJobStatus(jobId, userId, "review");
  return moved.ok ? { ok: true, job: moved.job, summary } : moved;
}

// ── Reading the snapshot back ───────────────────────────────────────────────

export interface SnapshotFolder {
  /** What a member's `folderId` points at. */
  id: string;
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
  /** Which of the result's folders this file belongs to. NULL on a photo set, whose
   *  members are loose files. What lets a folder comparison put each copy in the right
   *  column without guessing from path prefixes. */
  folderId: string | null;
  libraryId: string;
  libraryName: string;
  path: string;
  size: number | null;
  role: MemberRole;
  status: string;
  /** Bits from the keeper: 0 on a byte-identical copy, 1..3 on a near-identical one. */
  distance: number;
  /** Where this copy survives, when it is one being deleted. */
  keeperPath: string | null;
  /** WHICH member that is. The path is for reading; this is for pairing — two folders
   *  compared side by side line up on ids, not on a string that happens to match. */
  keeperMemberId: string | null;

  // ── Looking at the copy, not just reading about it ────────────────────────
  //
  // All three are NULL once the item is gone: `item_id` is ON DELETE SET NULL, because
  // the snapshot still has to describe what a photo WAS in order to say it has left.
  // A viewer showing these has to cope with that rather than assume a live row.
  /** Grid-sized thumbnail. */
  coverUrl: string | null;
  /** Web-sized preview — big enough to judge a near-identical pair by. */
  previewUrl: string | null;
  /** The original file itself, for when the preview is not enough. */
  fileUrl: string | null;
  width: number | null;
  height: number | null;
}

/** How sure the match is. `result_type` says what SHAPE a result has — a set of files,
 *  a pair of folders — and this says what it rests on: identical bytes, or a perceptual
 *  fingerprint a few bits apart. Two different questions, kept in two different fields
 *  because a byte-identical set can still be a coin toss about which copy to keep, and
 *  folding them into one label loses exactly that. Derived from the members rather than
 *  stored, so it can never disagree with the distances it describes. */
export type ResultTier = "exact" | "near";

/** How sure the MATCH is. Never merged with the keeper answer below: a byte-identical
 *  set is certain about the match and can still be a coin toss about which copy stays. */
export type MatchConfidence = "certain" | "likely" | "unsure";

/** How sure the KEEPER CHOICE is, from which criterion in the ordered ladder decided.
 *  evidence = something a person created or chose (rank 0-4); 'guess' = a property of
 *  the file itself; 'tossup' = nothing separated them. */
export type KeeperConfidence = "evidence" | "guess" | "tossup";

// Ranks 0-4 are the protected library, the two folder instructions, hand-filed work and
// hand-edited details — all of them somebody's decision. Past that the ladder is
// guessing from the file, and -1 means it never got to guess.
const KEEPER_EVIDENCE_RANKS = 5;
export const keeperConfidenceOf = (rank: number): KeeperConfidence =>
  rank < 0 ? "tossup" : rank < KEEPER_EVIDENCE_RANKS ? "evidence" : "guess";

export interface SnapshotResult {
  id: string;
  type: "photo_set" | "folder_set" | "contained" | "overlap";
  tier: ResultTier;
  matchConfidence: MatchConfidence;
  keeperConfidence: KeeperConfidence;
  status: string;
  reviewStatus: string;
  reclaimableBytes: number;
  keeperReason: string | null;
  coverUrls: string[];
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
  /** Byte-identical sets or perceptual ones. A separate axis from `type`, so
   *  "single files I'm certain about" is expressible without a third result type. */
  tier?: ResultTier;
  review?: "unreviewed" | "reviewed" | "skipped";
  libraryId?: string;
}

// A result is 'near' when any member sits off its keeper. Written once, used by the
// filter, the ordering and the read-back, so the three can't disagree.
const NEAR_EXISTS = "EXISTS (SELECT 1 FROM duplicate_job_result_members m WHERE m.result_id = r.id AND m.distance > 0)";

const RESULT_COVER_LIMIT = 4;

// One WHERE clause for both the listing and its count, so the pager can never report
// a total from one set of filters and a page from another.
function filterSql(jobId: string, filter: ResultFilter): { where: string; args: unknown[] } {
  const clauses = ["r.job_id = ?"];
  const args: unknown[] = [jobId];

  if (filter.type) { clauses.push("r.result_type = ?"); args.push(filter.type); }
  if (filter.tier) { clauses.push(filter.tier === "near" ? NEAR_EXISTS : `NOT ${NEAR_EXISTS}`); }
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
    SELECT r.id, r.result_type, r.status, r.review_status, r.reclaimable_bytes, r.keeper_reason,
           r.match_confidence, r.keeper_rank
    FROM duplicate_job_results r WHERE ${scope.where}
    ORDER BY
      CASE r.result_type WHEN 'folder_set' THEN 0 WHEN 'contained' THEN 1 WHEN 'overlap' THEN 2 ELSE 3 END,
      -- Certain before uncertain, so the page's headings stay contiguous and the sets
      -- that need no thought come first.
      ${NEAR_EXISTS},
      r.reclaimable_bytes DESC, r.id
    LIMIT ? OFFSET ?
  `).all(...scope.args, limit, offset) as {
    id: string; result_type: SnapshotResult["type"]; status: string; review_status: string;
    reclaimable_bytes: number; keeper_reason: string | null;
    match_confidence: MatchConfidence; keeper_rank: number;
  }[];
  if (results.length === 0) return [];

  const ids = results.map((row) => row.id);
  const list = ids.map(() => "?").join(",");

  const folders = db.prepare(`
    SELECT f.id, f.result_id, f.library_id, lib.name AS library_name,
           f.folder_path, f.role, f.item_count, f.bytes
    FROM duplicate_job_result_folders f
    LEFT JOIN libraries lib ON lib.id = f.library_id
    WHERE f.result_id IN (${list})
    ORDER BY f.role DESC, f.folder_path
  `).all(...ids) as {
    id: string; result_id: string; library_id: string; library_name: string | null;
    folder_path: string; role: MemberRole; item_count: number; bytes: number;
  }[];

  const members = db.prepare(`
    SELECT m.id, m.result_id, m.item_id, m.folder_id, m.library_id, lib.name AS library_name, m.path,
           m.size_snapshot, m.distance, m.role, m.status, m.keeper_member_id, keeper.path AS keeper_path,
           im.cover_storage_key, gd.preview_storage_key, gd.width, gd.height
    FROM duplicate_job_result_members m
    LEFT JOIN libraries lib ON lib.id = m.library_id
    LEFT JOIN duplicate_job_result_members keeper ON keeper.id = m.keeper_member_id
    -- Left joins throughout: a member whose item has since been deleted keeps its row
    -- and simply has no picture to show.
    LEFT JOIN item_metadata im ON im.item_id = m.item_id
    LEFT JOIN gallery_details gd ON gd.item_id = m.item_id
    WHERE m.result_id IN (${list})
    ORDER BY m.role DESC, m.path
  `).all(...ids) as {
    id: string; result_id: string; item_id: string | null; folder_id: string | null;
    library_id: string; library_name: string | null; path: string; size_snapshot: number | null;
    distance: number; role: MemberRole; status: string;
    keeper_member_id: string | null; keeper_path: string | null;
    cover_storage_key: string | null; preview_storage_key: string | null;
    width: number | null; height: number | null;
  }[];

  const foldersBy = new Map<string, SnapshotFolder[]>();
  for (const row of folders) {
    const bucket = foldersBy.get(row.result_id) ?? [];
    bucket.push({
      id: row.id,
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
      folderId: row.folder_id,
      libraryId: row.library_id,
      libraryName: row.library_name ?? "(removed library)",
      path: row.path,
      size: row.size_snapshot,
      role: row.role,
      status: row.status,
      distance: row.distance,
      keeperPath: row.keeper_path,
      keeperMemberId: row.keeper_member_id,
      coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
      // The preview is the web-sized render; the cover is the grid thumbnail. Fall back
      // to the cover so a copy cataloged before previews existed still shows something.
      previewUrl: row.preview_storage_key
        ? `/api/library/covers/${row.preview_storage_key}`
        : row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
      fileUrl: row.item_id ? `/api/library/gallery/assets/${row.item_id}/file` : null,
      width: row.width,
      height: row.height
    });
    membersBy.set(row.result_id, bucket);
  }

  const coverRows = db.prepare(`
    SELECT result_id, cover FROM (
      SELECT m.result_id, im.cover_storage_key AS cover,
             ROW_NUMBER() OVER (
               PARTITION BY m.result_id
               ORDER BY CASE m.role WHEN 'delete' THEN 0 WHEN 'keep' THEN 1 ELSE 2 END, m.path
             ) AS rank
      FROM duplicate_job_result_members m
      JOIN item_metadata im ON im.item_id = m.item_id
      WHERE m.result_id IN (${list}) AND im.cover_storage_key IS NOT NULL
    )
    WHERE rank <= ?
    ORDER BY result_id, rank
  `).all(...ids, RESULT_COVER_LIMIT) as { result_id: string; cover: string }[];

  const coversBy = new Map<string, string[]>();
  for (const row of coverRows) {
    const bucket = coversBy.get(row.result_id) ?? [];
    bucket.push(`/api/library/covers/${row.cover}`);
    coversBy.set(row.result_id, bucket);
  }

  return results.map((row) => {
    const rowMembers = membersBy.get(row.id) ?? [];
    return {
      id: row.id,
      type: row.result_type,
      // Any member sitting off the keeper by a bit or more makes the whole set a
      // perceptual match. Read from the members so it cannot drift from them.
      tier: rowMembers.some((member) => member.distance > 0) ? "near" as const : "exact" as const,
      matchConfidence: row.match_confidence,
      keeperConfidence: keeperConfidenceOf(row.keeper_rank),
      status: row.status,
      reviewStatus: row.review_status,
      reclaimableBytes: row.reclaimable_bytes,
      keeperReason: row.keeper_reason,
      coverUrls: coversBy.get(row.id) ?? [],
      folders: foldersBy.get(row.id) ?? [],
      members: rowMembers
    };
  });
}

/** What a sweep would take, under the filters currently on screen.
 *
 *  TWO THINGS ARE FORCED HERE, and both are safety rules rather than defaults.
 *
 *  Tier 'exact'. A byte-identical copy is interchangeable with the one that survives
 *  it, so clearing a hundred at once loses nothing anybody could notice. A
 *  near-identical copy is a DIFFERENT FILE — different resolution, often different
 *  metadata, and sometimes not even the same photograph — so each one is a judgement,
 *  and a judgement is not something to make a hundred of with one button.
 *
 *  Type 'photo_set'. A sweep is for the many-small-decisions case, which is what a
 *  files cleanup is. A folder cleanup is the opposite by design — "a few decisions
 *  about a lot of photos" — so one press emptying four folders is not a faster way to
 *  do that work, it is a different and much larger act wearing the same button. The
 *  older folder pages have never offered one either. A folder cleanup therefore shows
 *  no sweep at all, which is the honest answer rather than a missing feature. */
function sweepScope(jobId: string, filter: ResultFilter): { where: string; args: unknown[] } {
  const scope = filterSql(jobId, { ...filter, type: "photo_set", tier: "exact" });
  return {
    where: `${scope.where} AND r.status = 'active' AND EXISTS (
      SELECT 1 FROM duplicate_job_result_members m
      WHERE m.result_id = r.id AND m.role = 'delete' AND m.status NOT IN ('deleted', 'skipped')
    )`,
    args: scope.args
  };
}

export interface SweepPreview {
  /** Sets the sweep would clear. */
  results: number;
  /** Copies it would move to the Recycle Bin. */
  copies: number;
  bytes: number;
}

/** Counted so the confirm can promise a real number rather than "these". Sent with
 *  every page of results, so it can never describe a different filter from the one on
 *  screen. */
export function sweepPreview(jobId: string, filter: ResultFilter = {}): SweepPreview {
  const scope = sweepScope(jobId, filter);
  const row = db.prepare(`
    SELECT COUNT(*) AS results,
      COALESCE((SELECT COUNT(*) FROM duplicate_job_result_members m
                WHERE m.result_id IN (SELECT r.id FROM duplicate_job_results r WHERE ${scope.where})
                  AND m.role = 'delete' AND m.status NOT IN ('deleted', 'skipped')), 0) AS copies,
      COALESCE((SELECT SUM(m.size_snapshot) FROM duplicate_job_result_members m
                WHERE m.result_id IN (SELECT r.id FROM duplicate_job_results r WHERE ${scope.where})
                  AND m.role = 'delete' AND m.status NOT IN ('deleted', 'skipped')), 0) AS bytes
    FROM duplicate_job_results r WHERE ${scope.where}
  `).get(...scope.args, ...scope.args, ...scope.args) as { results: number; copies: number; bytes: number };
  return row;
}

/** The ids a sweep will work through, in a stable order. */
export function sweepableResultIds(jobId: string, filter: ResultFilter = {}): string[] {
  const scope = sweepScope(jobId, filter);
  return (db.prepare(`SELECT r.id FROM duplicate_job_results r WHERE ${scope.where} ORDER BY r.id`)
    .all(...scope.args) as { id: string }[]).map((row) => row.id);
}

export function countJobResults(jobId: string, filter: ResultFilter = {}): number {
  const scope = filterSql(jobId, filter);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM duplicate_job_results r WHERE ${scope.where}`)
    .get(...scope.args) as { n: number };
  return row.n;
}
