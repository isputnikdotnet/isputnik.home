// Duplicate FOLDERS — a whole folder whose contents match another folder's, file for
// file, whatever the two are called.
//
// This is a rollup of the byte-identical tier, not a new kind of detection. Two copies
// of a 400-photo holiday folder already produce 400 item-level sets; what was missing
// was the ability to see that as ONE thing and act on it once. So everything here is
// derived from the digests items.ts has already computed — no file is opened, and
// a folder is only ever compared when every file below it is hashed.
//
// That last condition is free rather than restrictive: a file is only hashed when its
// byte size collides with another file's, and if two folders really are identical then
// every file in one has a same-size twin in the other. A folder holding anything
// unhashed therefore cannot be a duplicate of anything, and is skipped without a
// second thought.
//
// A folder's fingerprint is every file below it as "<path below this folder>\0<digest>",
// sorted, hashed. The folder's own name is not part of it — different names, same
// contents is the case worth catching. Subfolder names ARE part of it, because a tree
// that arranges the same photos differently is not the same tree.
//
// Nothing here deletes on its own. resolveDuplicateFolderGroup is the single removal
// path, it re-derives every fingerprint before touching anything, it merges each
// removed photo's tags/albums/people onto its counterpart in the kept folder, and the
// files go to the Recycle Bin.
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../../db.js";
import { trashBook, libraryAllowsDelete } from "../../shared/trash.js";
import { lockIntersecting } from "../../shared/folder-locks.js";
import {
  absorbDuplicateMetadata, COPY_MARKERS, DERIVED_FOLDERS, preferenceFor, type FolderPreference, type FolderPreferenceMode
} from "./items.js";

// A folder holding a single photo is a duplicate photo, not a duplicate folder — the
// item tier says that better, and one-file folders would flood this list.
const MIN_FOLDER_FILES = 2;

// SQLite's variable limit is ~32k; keep any generated IN (…) well under it.
const ID_CHUNK = 400;

/** A folder's identity: it has no row of its own, only a library and a path. */
export interface FolderRef {
  libraryId: string;
  /** Relative to the library root. "" is the root itself. */
  folderPath: string;
}

const refKey = (ref: FolderRef): string => `${ref.libraryId}\u0000${ref.folderPath}`;
const parseKey = (key: string): FolderRef => {
  const cut = key.indexOf("\u0000");
  return { libraryId: key.slice(0, cut), folderPath: key.slice(cut + 1) };
};

// Every ancestor of a file's directory, nearest first, ending with the library root.
// "a/b/c.jpg" → ["a/b", "a", ""].
function ancestorsOf(filePath: string): string[] {
  const out: string[] = [];
  let cut = filePath.lastIndexOf("/");
  while (cut > 0) {
    out.push(filePath.slice(0, cut));
    cut = filePath.lastIndexOf("/", cut - 1);
  }
  out.push("");
  return out;
}

/** The folder one level up, or null for the library root itself. Shared with the
 *  snapshot, which uses it to drop a pairing whose parents already pair up. */
export const parentOf = (folderPath: string): string | null => {
  if (folderPath === "") return null;
  const cut = folderPath.lastIndexOf("/");
  return cut === -1 ? "" : folderPath.slice(0, cut);
};

// A folder's own name. The library's top folder has none — it is the root of the
// relative paths, not a folder someone named — so it gets the shell's name for
// exactly that, ".". Calling it "Library root" made it look like a folder you could
// go and open, and on a card next to a real folder name it read as one.
const folderName = (folderPath: string): string =>
  folderPath === "" ? "." : folderPath.slice(folderPath.lastIndexOf("/") + 1);

// The path of `filePath` relative to the folder `base`. base "" gives the path back.
const below = (base: string, filePath: string): string =>
  base === "" ? filePath : filePath.slice(base.length + 1);

// ────────────────────────────────────────────────────────────────────────────
//  Fingerprinting
// ────────────────────────────────────────────────────────────────────────────

interface FileRow {
  item_id: string;
  library_id: string;
  folder_path: string;
  content_hash: string | null;
  size: number | null;
  discovered_at: string;
}

// Every live gallery file, hashed or not. The unhashed ones matter as much as the
// rest: one of them is what disqualifies a folder from being compared at all.
function liveGalleryFiles(): FileRow[] {
  return db.prepare(`
    SELECT li.id AS item_id, li.library_id, li.folder_path, li.discovered_at,
           gd.content_hash, gd.size
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
    WHERE li.deleted_at IS NULL AND li.status = 'ready'
    ORDER BY li.library_id, li.folder_path
  `).all() as FileRow[];
}

interface FolderStats {
  files: number;
  hashed: number;
  bytes: number;
  /** Earliest discovery among the files below — the folder's "added" date. */
  firstSeen: string;
}

export interface FolderFingerprint extends FolderRef {
  digest: string;
  itemCount: number;
  bytes: number;
  firstSeen: string;
  itemIds: string[];
}

// Fingerprint every folder that CAN be fingerprinted, in two passes over the file list:
// cheap counters first to find the folders whose whole subtree is hashed, then the
// digest strings for those alone. The gate is what keeps this affordable — in a library
// of unique photos almost nothing survives it, and the second pass does almost no work.
export function fingerprintFolders(rows: FileRow[] = liveGalleryFiles()): FolderFingerprint[] {
  const stats = new Map<string, FolderStats>();
  for (const row of rows) {
    for (const folder of ancestorsOf(row.folder_path)) {
      const key = refKey({ libraryId: row.library_id, folderPath: folder });
      const current = stats.get(key);
      if (current) {
        current.files += 1;
        if (row.content_hash) current.hashed += 1;
        current.bytes += row.size ?? 0;
        if (row.discovered_at < current.firstSeen) current.firstSeen = row.discovered_at;
      } else {
        stats.set(key, {
          files: 1,
          hashed: row.content_hash ? 1 : 0,
          bytes: row.size ?? 0,
          firstSeen: row.discovered_at
        });
      }
    }
  }

  const eligible = new Set<string>();
  for (const [key, stat] of stats) {
    if (stat.files >= MIN_FOLDER_FILES && stat.files === stat.hashed) eligible.add(key);
  }
  if (eligible.size === 0) return [];

  // Second pass: "<path below the folder>\0<digest>" for each file, per eligible
  // ancestor. Sorted before hashing so the order files come back in can't matter.
  const lines = new Map<string, string[]>();
  const members = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.content_hash) continue;
    for (const folder of ancestorsOf(row.folder_path)) {
      const key = refKey({ libraryId: row.library_id, folderPath: folder });
      if (!eligible.has(key)) continue;
      const line = `${below(folder, row.folder_path)}\u0000${row.content_hash}`;
      const bucket = lines.get(key);
      if (bucket) bucket.push(line); else lines.set(key, [line]);
      const ids = members.get(key);
      if (ids) ids.push(row.item_id); else members.set(key, [row.item_id]);
    }
  }

  const out: FolderFingerprint[] = [];
  for (const [key, list] of lines) {
    const stat = stats.get(key)!;
    const hash = crypto.createHash("sha256");
    for (const line of [...list].sort()) hash.update(line, "utf8").update("\n");
    out.push({
      ...parseKey(key),
      digest: hash.digest("hex"),
      itemCount: stat.files,
      bytes: stat.bytes,
      firstSeen: stat.firstSeen,
      itemIds: (members.get(key) ?? []).sort()
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
//  Keeper scoring
// ────────────────────────────────────────────────────────────────────────────

interface ScoredFolder extends FolderFingerprint {
  linkCount: number;
  depth: number;
  copyMarker: boolean;
  derivedFolder: boolean;
  preference: FolderPreferenceMode | null;
  /** Its library forbids deleting — external, or deleting turned off. */
  protectedLibrary: boolean;
  /** A folder lock covers it or sits inside it, so it can't be cleared out. */
  lockedFolder: boolean;
}

// Tags, albums, collections, saves, shares and tagged people on the photos below a
// folder — the work a person put in, which is the only thing here that can't be
// recovered from the files.
function linkCountFor(itemIds: string[]): number {
  let total = 0;
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const chunk = itemIds.slice(i, i + ID_CHUNK);
    const list = chunk.map(() => "?").join(",");
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM taggables WHERE entity_type = 'library_item' AND entity_id IN (${list}))
        + (SELECT COUNT(*) FROM gallery_album_items WHERE item_id IN (${list}))
        + (SELECT COUNT(*) FROM gallery_slideshow_items WHERE item_id IN (${list}))
        + (SELECT COUNT(*) FROM collection_items WHERE entity_type = 'library_item' AND entity_id IN (${list}))
        + (SELECT COUNT(*) FROM item_saves WHERE item_id IN (${list}))
        + (SELECT COUNT(*) FROM shares WHERE module = 'gallery' AND revoked_at IS NULL AND resource_id IN (${list}))
        + (SELECT COUNT(*) FROM family_tree_photos WHERE item_id IN (${list}))
        + (SELECT COUNT(*) FROM family_tree_event_photos WHERE item_id IN (${list}))
        + (SELECT COUNT(*) FROM gallery_faces WHERE assignment != 'rejected' AND person_id IS NOT NULL AND item_id IN (${list}))
        AS n
    `).get(...Array.from({ length: 9 }, () => chunk).flat()) as { n: number };
    total += row.n;
  }
  return total;
}

// Folder names that announce a copy. Kept separate from the item tier's COPY_MARKERS,
// which read a FILE name: "Backup" says nothing much about one photo and a great deal
// about a folder full of them.
const COPY_FOLDER_NAMES = /^(backups?|copies|duplicates?)$|[-_ ]copy$|^copy of /i;

function scoreFolder(print: FolderFingerprint, preferences: FolderPreference[]): ScoredFolder {
  const segments = print.folderPath === "" ? [] : print.folderPath.split("/");
  const name = segments[segments.length - 1] ?? "";
  return {
    ...print,
    preference: preferenceFor(preferences, print.libraryId, print.folderPath),
    protectedLibrary: !libraryAllowsDelete(print.libraryId),
    lockedFolder: lockIntersecting(print.libraryId, print.folderPath) !== null,
    linkCount: linkCountFor(print.itemIds),
    depth: segments.length,
    // Any segment, not just the folder's own name: everything under "Backups/" is a
    // copy of something, however it is named itself.
    copyMarker: COPY_MARKERS.some((re) => re.test(name))
      || segments.some((segment) => COPY_FOLDER_NAMES.test(segment)),
    // Likewise for received/derived folders: "Downloads/Holiday" is a copy of
    // "Holiday" however deep the folder itself sits.
    derivedFolder: segments.some((segment) => DERIVED_FOLDERS.test(segment))
  };
}

// Ordered, not weighted — the same contract as the item tier: compare criterion by
// criterion, first difference wins, and the winning criterion IS the reason shown.
const FOLDER_CRITERIA: { label: string; value: (row: ScoredFolder) => number }[] = [
  // Not a preference — a fact about the library. Its files cannot be deleted, so
  // choosing it as the one to remove proposes work that will be refused. See the
  // item tier's criterion of the same name.
  { label: "in a library its files can't be deleted from", value: (r) => (r.protectedLibrary ? 1 : 0) },
  // Same fact one level down: a folder lock covers it (or a locked folder sits
  // inside it), so proposing its removal proposes work trashBook will refuse.
  { label: "in a locked folder", value: (r) => (r.lockedFolder ? 1 : 0) },
  { label: "a folder you chose to keep", value: (r) => (r.preference === "keep" ? 1 : 0) },
  { label: "not a folder you're clearing out", value: (r) => (r.preference === "clear" ? 0 : 1) },
  { label: "its photos carry tags, albums or people", value: (r) => r.linkCount },
  { label: "not named like a copy", value: (r) => (r.copyMarker ? 0 : 1) },
  { label: "not in a downloads or app folder", value: (r) => (r.derivedFolder ? 0 : 1) },
  { label: "closer to the top of the library", value: (r) => -r.depth },
  {
    label: "added first",
    value: (r) => {
      const t = new Date(r.firstSeen).getTime();
      return Number.isFinite(t) ? -t : 0;
    }
  }
];

export interface FolderKeeperChoice {
  keeper: FolderRef;
  reason: string | null;
  /** Which criterion decided, 0 first; -1 when nothing separated them. Same meaning as
   *  KeeperChoice.rank — the ladder is ordered, so the rank is the confidence. */
  rank: number;
}

export function pickFolderKeeper(
  prints: FolderFingerprint[],
  /** The cleanup's own instructions. There is no install-wide set any more: a
   *  standing rule nobody could edit is worse than no standing rule. */
  instructions?: FolderPreference[]
): FolderKeeperChoice | null {
  if (prints.length === 0) return null;
  const preferences = instructions ?? [];
  const scored = prints.map((print) => scoreFolder(print, preferences)).sort((a, b) => {
    for (const criterion of FOLDER_CRITERIA) {
      const diff = criterion.value(b) - criterion.value(a);
      if (diff !== 0) return diff;
    }
    return refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0;
  });
  const winner = scored[0];
  const runnerUp = scored[1];
  const keeper: FolderRef = { libraryId: winner.libraryId, folderPath: winner.folderPath };
  if (!runnerUp) return { keeper, reason: null, rank: -1 };

  const decided = FOLDER_CRITERIA.findIndex((c) => c.value(winner) > c.value(runnerUp));
  const reasons = FOLDER_CRITERIA
    .filter((criterion) => criterion.value(winner) > criterion.value(runnerUp))
    .map((criterion) => criterion.label)
    .slice(0, 2);
  return {
    keeper,
    reason: reasons.length > 0 ? reasons.join(", ") : "nothing to choose between them — kept the one added first",
    rank: decided
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Grouping
// ────────────────────────────────────────────────────────────────────────────

/** "These two folders are not duplicates", as pairs. Exported so a cleanup job's
 *  snapshot honours the same standing decisions this module's tiers do. */
export const folderIgnorePairs = (): Set<string> => ignoredFolderPairs();

/** "Leave this one alone", by FOLDER rather than by pair — the same reading the
 *  contained tier uses, and for the same reason: matching on the pair would bring a
 *  dismissed folder straight back under whichever folder covers it next. */
export const containedIgnoreKeys = (): Set<string> => containedIgnores();

function ignoredFolderPairs(): Set<string> {
  const rows = db.prepare(
    "SELECT library_a, path_a, library_b, path_b FROM gallery_duplicate_folder_ignores"
  ).all() as { library_a: string; path_a: string; library_b: string; path_b: string }[];
  return new Set(rows.map((r) =>
    `${refKey({ libraryId: r.library_a, folderPath: r.path_a })}|${refKey({ libraryId: r.library_b, folderPath: r.path_b })}`));
}

const folderPairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Components over the pairs that are NOT dismissed — identical to the item tier's
// rule, and for the same reason: dismissing A/B in {A,B,C} leaves all three linked
// through C, which is right, because they really do hold the same files.
export function folderComponents(keys: string[], ignored: Set<string>): string[][] {
  const parent = new Map<string, string>(keys.map((key) => [key, key]));
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(key) !== root) { const next = parent.get(key)!; parent.set(key, root); key = next; }
    return root;
  };
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (ignored.has(folderPairKey(keys[i], keys[j]))) continue;
      const [ra, rb] = [find(keys[i]), find(keys[j])];
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const root = find(key);
    const bucket = groups.get(root);
    if (bucket) bucket.push(key); else groups.set(root, [key]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

// ────────────────────────────────────────────────────────────────────────────
//  Contained folders — everything in here is also somewhere else
// ────────────────────────────────────────────────────────────────────────────
//
// The equal-contents test above cannot see a folder copied INTO ITSELF, which is the
// commonest mess of all (sync clients and photo managers produce it constantly): a
// parent's fingerprint counts its child's files too, so it always holds strictly more
// and the two can never match. What matters there isn't equality but coverage — every
// photo in the inner folder already sits in the outer one, so the inner folder can go.
//
// So this asks a different question: is every file below A also below B, by content?
// Multiplicity is respected (a folder holding one picture twice needs two copies in
// the target), and when B encloses A the comparison runs against B WITHOUT A's own
// subtree — otherwise every folder would trivially "contain" its children.
//
// Only A must be fully hashed. B needs no such gate: an unhashed file is one whose
// byte size is unique, which cannot be a twin of anything, so no counterpart is missed
// by ignoring them.

// Dismissals are read by FOLDER, not by folder-and-target. "Leave this one alone" is
// a statement about the folder: matching on the pair would bring it straight back
// under whichever folder covers it next, which is the same suggestion again wearing a
// different label. The target is still recorded, so the row says what was dismissed.
function containedIgnores(): Set<string> {
  const rows = db.prepare(
    "SELECT library_id, folder_path FROM gallery_duplicate_contained_ignores"
  ).all() as { library_id: string; folder_path: string }[];
  return new Set(rows.map((r) => refKey({ libraryId: r.library_id, folderPath: r.folder_path })));
}

// ────────────────────────────────────────────────────────────────────────────
//  Reading groups
// ────────────────────────────────────────────────────────────────────────────

// ── Searching and paging the folder answers ─────────────────────────────────
//
// Same split as the photo sets: the cheap half (what a folder holds) runs over every
// folder to decide what matches and in what order, and the expensive half — covers,
// and the nine-scan link count over what may be an entire library — runs only for
// the folders on screen. The filtering is the page's own, moved rather than rewritten.

// ── Overlapping folders — SOME photos identical between two folders ─────────
//
// The third folder-shaped answer, for the common partial mess: half a card
// re-imported into a new folder, a "best of" pulled from several trips. Neither
// folder equals nor contains the other, so the first two tiers say nothing — yet the
// pair may share hundreds of byte-identical photos. The action is narrower than the
// other tiers': only the shared copies on the losing side go, never the unique ones,
// and both folders remain.
//
// A folder here means the photos DIRECTLY in it, not its subtree. Subtree overlap
// would pair every ancestor with every counterpart's ancestor — an explosion of
// rows all restating one fact — and the subtree-shaped statements are exactly what
// the identical and stored-elsewhere tiers already make.

const sameOrInside = (libA: string, pathA: string, libB: string, pathB: string): boolean =>
  libA === libB && (pathB === "" || pathA === pathB || pathA.startsWith(`${pathB}/`));

function overlapIgnores(): Set<string> {
  const rows = db.prepare(
    "SELECT library_a, path_a, library_b, path_b FROM gallery_duplicate_folder_overlap_ignores"
  ).all() as { library_a: string; path_a: string; library_b: string; path_b: string }[];
  return new Set(rows.map((r) =>
    `${refKey({ libraryId: r.library_a, folderPath: r.path_a })}|${refKey({ libraryId: r.library_b, folderPath: r.path_b })}`));
}

/** "These two just share some photos — stop pairing them", as `<refKey>|<refKey>` with
 *  the lexically smaller side first. Exported so a cleanup job's snapshot honours the
 *  same standing decisions this module's tier does. */
export const folderOverlapIgnores = (): Set<string> => overlapIgnores();

/** Whether A is B, or sits inside it. Exported alongside the ignores because any tier
 *  comparing two folders needs the same answer to "is this pair really two places?" */
export const folderSameOrInside = (
  a: { libraryId: string; folderPath: string },
  b: { libraryId: string; folderPath: string }
): boolean => sameOrInside(a.libraryId, a.folderPath, b.libraryId, b.folderPath);

// ── One page over all three answers ─────────────────────────────────────────
//
// Identical folders, folders wholly stored elsewhere, and folders that merely
// overlap are three strengths of the same relationship, and they were three
// lists on two tabs. One search now, one pager: strongest statement first, so a
// page can straddle the boundaries with each kind under its own heading.

// ────────────────────────────────────────────────────────────────────────────
//  Admin actions
// ────────────────────────────────────────────────────────────────────────────
