// Duplicate FOLDERS — a whole folder whose contents match another folder's, file for
// file, whatever the two are called.
//
// This is a rollup of the byte-identical tier, not a new kind of detection. Two copies
// of a 400-photo holiday folder already produce 400 item-level sets; what was missing
// was the ability to see that as ONE thing and act on it once. So everything here is
// derived from the digests duplicates.ts has already computed — no file is opened, and
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
import { db, logActivity } from "../../../db.js";
import { trashBook, libraryAllowsDelete } from "../shared/trash.js";
import {
  absorbDuplicateMetadata, COPY_MARKERS, DERIVED_FOLDERS,
  folderPreferences, preferenceFor, type FolderPreference, type FolderPreferenceMode
} from "./duplicates.js";

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

const parentOf = (folderPath: string): string | null => {
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

// One folder's fingerprint, recomputed from the database as it stands right now. Used
// to re-validate a group at deletion time — the scan that built it may be days old.
export function fingerprintOf(ref: FolderRef): FolderFingerprint | null {
  const prefix = ref.folderPath === "" ? "" : `${ref.folderPath}/`;
  const rows = db.prepare(`
    SELECT li.id AS item_id, li.library_id, li.folder_path, li.discovered_at,
           gd.content_hash, gd.size
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
    WHERE li.deleted_at IS NULL AND li.status = 'ready'
      AND li.library_id = ?
      AND (? = '' OR li.folder_path LIKE ? ESCAPE '\\')
  `).all(
    ref.libraryId,
    ref.folderPath,
    `${prefix.replace(/[\\%_]/g, "\\$&")}%`
  ) as FileRow[];
  if (rows.length === 0) return null;
  return fingerprintFolders(rows).find((print) => print.folderPath === ref.folderPath) ?? null;
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
}

export function pickFolderKeeper(prints: FolderFingerprint[]): FolderKeeperChoice | null {
  if (prints.length === 0) return null;
  const preferences = folderPreferences();
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
  if (!runnerUp) return { keeper, reason: null };

  const reasons = FOLDER_CRITERIA
    .filter((criterion) => criterion.value(winner) > criterion.value(runnerUp))
    .map((criterion) => criterion.label)
    .slice(0, 2);
  return {
    keeper,
    reason: reasons.length > 0 ? reasons.join(", ") : "nothing to choose between them — kept the one added first"
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Grouping
// ────────────────────────────────────────────────────────────────────────────

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
function folderComponents(keys: string[], ignored: Set<string>): string[][] {
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

export interface FolderGroupTotals {
  groups: number;
  extraFolders: number;
  reclaimableBytes: number;
}

const folderSignature = (keys: string[]): string => [...keys].sort().join(",");

// Hand-picked keepers from the last rebuild, keyed on the member set they were chosen
// for: a different set is a different question, and the choice doesn't carry.
function manualFolderKeepers(): Map<string, FolderRef> {
  const out = new Map<string, FolderRef>();
  const groups = db.prepare(`
    SELECT id, keeper_library_id, keeper_folder_path FROM gallery_duplicate_folder_groups
    WHERE keeper_source = 'manual' AND keeper_library_id IS NOT NULL AND keeper_folder_path IS NOT NULL
  `).all() as { id: string; keeper_library_id: string; keeper_folder_path: string }[];
  const memberStmt = db.prepare(
    "SELECT library_id, folder_path FROM gallery_duplicate_folder_members WHERE group_id = ?"
  );
  for (const group of groups) {
    const keys = (memberStmt.all(group.id) as { library_id: string; folder_path: string }[])
      .map((row) => refKey({ libraryId: row.library_id, folderPath: row.folder_path }));
    out.set(folderSignature(keys), {
      libraryId: group.keeper_library_id,
      folderPath: group.keeper_folder_path
    });
  }
  return out;
}

// Rebuild every folder group from the digests currently in the database. Pure DB work,
// no disk access, so it is cheap to re-run and trivially testable.
export function rebuildDuplicateFolderGroups(): FolderGroupTotals {
  const prints = fingerprintFolders();
  const byKey = new Map(prints.map((print) => [refKey(print), print]));

  const byDigest = new Map<string, string[]>();
  for (const print of prints) {
    const bucket = byDigest.get(print.digest);
    if (bucket) bucket.push(refKey(print)); else byDigest.set(print.digest, [refKey(print)]);
  }

  const ignored = ignoredFolderPairs();
  const components = [...byDigest.values()]
    .filter((keys) => keys.length > 1)
    .flatMap((keys) => folderComponents(keys, ignored));

  // A duplicated folder duplicates everything inside it, so /Backup/Trip and
  // /Photos/Trip pair up exactly as their parents do. Only the topmost pairing is
  // worth showing: drop any set whose members ALL sit inside folders that are
  // themselves part of a set. Resolving the parent takes the children with it.
  const covered = new Set(components.flat());
  const topmost = components.filter((keys) => !keys.every((key) => {
    const ref = parseKey(key);
    const parent = parentOf(ref.folderPath);
    return parent !== null && covered.has(refKey({ libraryId: ref.libraryId, folderPath: parent }));
  }));

  const manual = manualFolderKeepers();
  let groups = 0;
  let extraFolders = 0;
  let reclaimableBytes = 0;

  db.transaction(() => {
    db.prepare("DELETE FROM gallery_duplicate_folder_groups").run();
    const insertGroup = db.prepare(`
      INSERT INTO gallery_duplicate_folder_groups
        (id, digest, item_count, copy_bytes, keeper_library_id, keeper_folder_path, keeper_source, keeper_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMember = db.prepare(
      "INSERT INTO gallery_duplicate_folder_members (group_id, library_id, folder_path) VALUES (?, ?, ?)"
    );

    for (const keys of topmost) {
      const members = keys.map((key) => byKey.get(key)).filter((print): print is FolderFingerprint => Boolean(print));
      if (members.length < 2) continue;

      const auto = pickFolderKeeper(members);
      if (!auto) continue;
      const hand = manual.get(folderSignature(keys));
      const handIsMember = hand ? keys.includes(refKey(hand)) : false;
      const keeper = handIsMember ? hand! : auto.keeper;
      const source = handIsMember ? "manual" : "auto";

      const groupId = nanoid(16);
      insertGroup.run(
        groupId, members[0].digest, members[0].itemCount, members[0].bytes,
        keeper.libraryId, keeper.folderPath, source, source === "manual" ? null : auto.reason
      );
      for (const member of members) insertMember.run(groupId, member.libraryId, member.folderPath);

      groups += 1;
      extraFolders += members.length - 1;
      reclaimableBytes += members
        .filter((member) => refKey(member) !== refKey(keeper))
        .reduce((sum, member) => sum + member.bytes, 0);
    }
  })();

  return { groups, extraFolders, reclaimableBytes };
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

/** How many of each digest a folder holds. */
type DigestCounts = Map<string, number>;

const isInside = (folder: FolderRef, filePath: string, libraryId: string): boolean =>
  libraryId === folder.libraryId
  && (folder.folderPath === "" || filePath.startsWith(`${folder.folderPath}/`));

function digestCountsOf(print: FolderFingerprint): DigestCounts {
  const counts: DigestCounts = new Map();
  const rows = db.prepare(`
    SELECT gd.content_hash AS hash FROM gallery_details gd
    WHERE gd.item_id IN (${print.itemIds.map(() => "?").join(",")}) AND gd.content_hash IS NOT NULL
  `).all(...print.itemIds) as { hash: string }[];
  for (const row of rows) counts.set(row.hash, (counts.get(row.hash) ?? 0) + 1);
  return counts;
}

interface ContainmentTarget extends FolderRef {
  /** Files below the target, ignoring anything inside the contained folder. */
  fileCount: number;
}

// Every folder holding a copy of everything in `print`, cheapest-first: the search
// starts from the files that could possibly be counterparts (same digest) rather than
// from the folder list, so it costs nothing on a library with no overlap at all.
function containersOf(print: FolderFingerprint): ContainmentTarget[] {
  const needed = digestCountsOf(print);
  if (needed.size === 0) return [];
  const digests = [...needed.keys()];

  const matches: { libraryId: string; filePath: string; hash: string }[] = [];
  for (let i = 0; i < digests.length; i += ID_CHUNK) {
    const chunk = digests.slice(i, i + ID_CHUNK);
    const rows = db.prepare(`
      SELECT li.library_id, li.folder_path, gd.content_hash AS hash
      FROM gallery_details gd
      JOIN library_items li ON li.id = gd.item_id AND li.deleted_at IS NULL AND li.status = 'ready'
      JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
      WHERE gd.content_hash IN (${chunk.map(() => "?").join(",")})
    `).all(...chunk) as { library_id: string; folder_path: string; hash: string }[];
    for (const row of rows) {
      // A file inside the folder itself is not a copy OF it.
      if (isInside(print, row.folder_path, row.library_id)) continue;
      matches.push({ libraryId: row.library_id, filePath: row.folder_path, hash: row.hash });
    }
  }
  if (matches.length === 0) return [];

  // Tally each candidate file against every folder that holds it.
  const held = new Map<string, DigestCounts>();
  for (const match of matches) {
    for (const folder of ancestorsOf(match.filePath)) {
      const key = refKey({ libraryId: match.libraryId, folderPath: folder });
      let counts = held.get(key);
      if (!counts) { counts = new Map(); held.set(key, counts); }
      counts.set(match.hash, (counts.get(match.hash) ?? 0) + 1);
    }
  }

  const out: ContainmentTarget[] = [];
  for (const [key, counts] of held) {
    const ref = parseKey(key);
    if (refKey(ref) === refKey(print)) continue;
    let covers = true;
    for (const [hash, count] of needed) {
      if ((counts.get(hash) ?? 0) < count) { covers = false; break; }
    }
    if (!covers) continue;
    // Files below the target, minus anything inside the folder being covered — the
    // number that decides which container is the tightest fit.
    const prefix = ref.folderPath === "" ? "" : `${ref.folderPath.replace(/[\\%_]/g, "\\$&")}/`;
    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM library_items li
      WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready'
        AND (? = '' OR li.folder_path LIKE ? ESCAPE '\\')
    `).get(ref.libraryId, ref.folderPath, `${prefix}%`) as { n: number };
    const inside = ref.libraryId === print.libraryId
      && (ref.folderPath === "" || print.folderPath.startsWith(`${ref.folderPath}/`))
      ? print.itemCount
      : 0;
    out.push({ ...ref, fileCount: total.n - inside });
  }
  // A folder the admin chose to keep is the natural home for these photos, whatever
  // its size. Otherwise tightest fit first: the folder that adds least beyond what it
  // covers is the one a person would name as "the same photos, and a few more".
  // On a tie, the DEEPEST container wins. Every ancestor of a covering folder covers
  // the same photos, so without this the answer is always "…and they're also in the
  // library root", which is true and useless — the smallest folder that holds them is
  // the one worth naming.
  // A folder chosen to keep is the natural home for these photos; one being cleared
  // out is the last place to point at, since it is on its way out itself.
  // A library's own top folder covers everything in it, so it always qualifies — and
  // naming it is almost never the useful answer. "These photos are also somewhere in
  // this library" sends you to a folder full of folders and no photos in it, which is
  // not a place you can go and check.
  //
  // It only wins when nothing narrower does, and that is exactly when it is the true
  // answer: copies sitting loose at the top level. Filtered here rather than sorted
  // lower, because the preference rank below outranks tightest-fit on purpose — a
  // library marked "keep here" would otherwise put its root ahead of the real folder
  // every time, which is how this went wrong.
  const named = out.filter((ref) => ref.folderPath !== "");
  const candidates = named.length > 0 ? named : out;

  const preferences = folderPreferences();
  const rank = (ref: FolderRef) => {
    const mode = preferenceFor(preferences, ref.libraryId, ref.folderPath);
    return mode === "keep" ? 0 : mode === "clear" ? 2 : 1;
  };
  const depth = (ref: FolderRef) => (ref.folderPath === "" ? 0 : ref.folderPath.split("/").length);
  return candidates.sort((a, b) =>
    rank(a) - rank(b)
    || a.fileCount - b.fileCount
    || depth(b) - depth(a)
    || (refKey(a) < refKey(b) ? -1 : 1));
}

export interface ContainedFolderTotals {
  folders: number;
  reclaimableBytes: number;
}

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

// Rebuild the contained-folder rows. Runs AFTER rebuildDuplicateFolderGroups: a folder
// that already has an equal-contents partner is offered there, with a keeper choice,
// and listing it twice would be two answers to one question.
export function rebuildContainedFolders(): ContainedFolderTotals {
  const prints = fingerprintFolders();
  const exactMembers = db.prepare(
    "SELECT library_id, folder_path FROM gallery_duplicate_folder_members"
  ).all() as { library_id: string; folder_path: string }[];
  const ignored = containedIgnores();

  const preferences = folderPreferences();
  const found = new Map<string, { print: FolderFingerprint; target: ContainmentTarget }>();
  for (const print of prints) {
    if (ignored.has(refKey(print))) continue;
    const mode = preferenceFor(preferences, print.libraryId, print.folderPath);
    // Never propose removing a folder the admin said to keep photos in.
    if (mode === "keep") continue;
    // A folder with an equal-contents partner ANYWHERE BELOW IT is already answered by
    // that set, which offers a keeper choice as well. Listing it here too would be a
    // second, weaker answer to a question already on the page — and the two rows read
    // as the same pair twice, because that is what they are.
    //
    // This holds for a folder being cleared out as well. It used to be exempt, on the
    // reasoning that "all of it is safe elsewhere" is the more direct answer — but the
    // equal-contents set says the same thing AND honours the instruction in its keeper
    // choice, so the exemption bought nothing and cost a duplicate row.
    const answeredExactly = exactMembers.some((member) =>
      member.library_id === print.libraryId
      && (member.folder_path === print.folderPath || member.folder_path.startsWith(`${print.folderPath === "" ? "" : `${print.folderPath}/`}`)));
    if (answeredExactly) continue;
    const target = containersOf(print)[0];
    if (target) found.set(refKey(print), { print, target });
  }

  // Two folders holding the same pictures in a different LAYOUT cover each other —
  // and would each be offered for removal, which taken together deletes every copy.
  // Keep one: the same keeper scoring the equal-contents sets use, so the answer
  // doesn't depend on which folder happened to be examined first.
  const dropped = new Set<string>();
  for (const [key, { print, target }] of found) {
    if (dropped.has(key)) continue;
    const mirror = found.get(refKey(target));
    if (!mirror || refKey(mirror.target) !== key) continue;
    const winner = pickFolderKeeper([print, mirror.print]);
    if (winner) dropped.add(refKey(winner.keeper));
  }
  for (const key of dropped) found.delete(key);

  // Topmost only, as with the equal-contents sets: if a folder's parent is covered
  // too, removing the parent takes this one with it.
  //
  // The library's OWN root is the exception, both ways round. It covers everything in
  // the library, so it qualifies whenever the library's whole contents are duplicated
  // somewhere — and offering it means "empty this library", which is never what "this
  // folder is redundant" is meant to say. Worse, it suppressed the real folders
  // underneath it, so the only thing on offer was a row whose name is a dot and whose
  // link opens a folder full of folders and no photos.
  //
  // So: a root never suppresses a folder inside it, and is itself offered only when
  // nothing narrower is — which is exactly when it's the honest answer, the photos
  // being loose at the top level.
  const covered = new Set(found.keys());
  const rows = [...found.values()].filter(({ print }) => {
    if (print.folderPath === "") {
      return ![...covered].some((key) => {
        const ref = parseKey(key);
        return ref.libraryId === print.libraryId && ref.folderPath !== "";
      });
    }
    const parent = parentOf(print.folderPath);
    if (parent === null || parent === "") return true;
    return !covered.has(refKey({ libraryId: print.libraryId, folderPath: parent }));
  });

  let reclaimableBytes = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM gallery_duplicate_contained_folders").run();
    const insert = db.prepare(`
      INSERT INTO gallery_duplicate_contained_folders
        (id, library_id, folder_path, target_library_id, target_folder_path, item_count, bytes, extra_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const { print, target } of rows) {
      insert.run(
        nanoid(16), print.libraryId, print.folderPath, target.libraryId, target.folderPath,
        print.itemCount, print.bytes, Math.max(target.fileCount - print.itemCount, 0)
      );
      reclaimableBytes += print.bytes;
    }
  })();

  return { folders: rows.length, reclaimableBytes };
}

export interface ContainedFolder {
  id: string;
  /** The folder that can go — the same card shape an equal-contents member gets. */
  folder: FolderDetail;
  /** The folder that keeps its photos. */
  target: FolderDetail;
  itemCount: number;
  bytes: number;
  /** Photos the target holds on top of the ones it covers. */
  extraCount: number;
  /** The target is an ancestor of the folder — the copied-into-itself shape, where
   *  the kept folder's own counts include the photos about to go. */
  encloses: boolean;
  /** The folders inside the target that actually hold the copies, at most three of
   *  them. What to name when the target itself is a whole library. */
  targetFolders: string[];
  /** How many there are in total, so the card can say "and N more". */
  targetFolderCount: number;
  coverUrls: string[];
  linkCount: number;
}

interface LeanContained {
  id: string;
  libraryId: string;
  folderPath: string;
  libraryName: string;
  targetLibraryId: string;
  targetFolderPath: string;
  targetLibraryName: string;
  totals: FolderTotals;
  targetTotals: FolderTotals;
}

function containedRows(): LeanContained[] {
  // The NOT EXISTS is the same rule rebuildContainedFolders applies when it writes
  // these rows: a folder already answered by an equal-contents set is not reported
  // here as well. It is repeated at READ time because these are two caches that are
  // rebuilt together but persist independently — a row written before that rule
  // existed (or by an older version) would otherwise show the same pair of folders
  // twice, in two sections, until something happened to rebuild.
  const rows = db.prepare(`
    SELECT c.id, c.library_id, c.folder_path, c.target_library_id, c.target_folder_path,
           c.item_count, c.bytes, c.extra_count,
           lib.name AS library_name, tlib.name AS target_library_name
    FROM gallery_duplicate_contained_folders c
    JOIN libraries lib ON lib.id = c.library_id
    JOIN libraries tlib ON tlib.id = c.target_library_id
    WHERE NOT EXISTS (
      SELECT 1 FROM gallery_duplicate_folder_members m
      WHERE m.library_id = c.library_id
        AND (c.folder_path = ''
             OR m.folder_path = c.folder_path
             OR m.folder_path LIKE c.folder_path || '/%')
    )
    ORDER BY c.bytes DESC, c.id
  `).all() as {
    id: string; library_id: string; folder_path: string;
    target_library_id: string; target_folder_path: string;
    item_count: number; bytes: number; extra_count: number;
    library_name: string; target_library_name: string;
  }[];

  return rows.map((row) => ({
    id: row.id,
    libraryId: row.library_id,
    folderPath: row.folder_path,
    libraryName: row.library_name,
    targetLibraryId: row.target_library_id,
    targetFolderPath: row.target_folder_path,
    targetLibraryName: row.target_library_name,
    // Every number is re-derived from the library as it stands, never read back from
    // the columns the scan wrote. Photos leave — deleted here, deleted from the
    // gallery, emptied out of the Recycle Bin — and a card mixing a stale count with
    // a live one states two different facts about one folder.
    totals: folderTotals({ libraryId: row.library_id, folderPath: row.folder_path }),
    targetTotals: folderTotals({ libraryId: row.target_library_id, folderPath: row.target_folder_path })
  })).filter((row) =>
    // A folder holding fewer than two photos is not a duplicate folder — that is the
    // gate it had to pass to get here. Emptied since the scan, it can only mislead:
    // the offer is impossible to carry out and every action on it fails.
    row.totals.itemCount >= MIN_FOLDER_FILES && row.targetTotals.itemCount > 0);
}

// The expensive half of a contained row: covers, link counts and where the copies
// really sit. Only for the rows on screen.
function hydrateContained(row: LeanContained): ContainedFolder {
  const folderRef = { libraryId: row.libraryId, folderPath: row.folderPath };
  const targetRef = { libraryId: row.targetLibraryId, folderPath: row.targetFolderPath };
  const folder = folderDetail(folderRef, row.libraryName, row.totals);
  const target = folderDetail(targetRef, row.targetLibraryName, row.targetTotals);
  const encloses = isInside(target, folder.folderPath, folder.libraryId);
  const counterparts = counterpartFolders(folderRef, targetRef);
  return {
    id: row.id,
    folder,
    target,
    targetFolders: counterparts.paths,
    targetFolderCount: counterparts.total,
    itemCount: folder.itemCount,
    bytes: folder.bytes,
    // What the keeper holds beyond the copies it covers. When it ENCLOSES the doomed
    // folder its own count includes those photos twice over: once inside, once as the
    // counterparts outside.
    extraCount: Math.max(target.itemCount - folder.itemCount * (encloses ? 2 : 1), 0),
    encloses,
    coverUrls: folder.coverUrls,
    linkCount: folder.linkCount
  };
}

/** Every contained row, fully built. Kept for callers that genuinely want them all. */
export function listContainedFolders(): ContainedFolder[] {
  return containedRows().map(hydrateContained);
}

// Drop every cached row that named a folder whose photos have just gone to the Recycle
// Bin. Both lists are caches over one scan, and a removal invalidates more of them than
// the row it was started from:
//
//   * a row offering the emptied folder is now impossible to carry out;
//   * a row pointing AT it promises copies that are in the Recycle Bin — the dangerous
//     one, since acting on it would bin the last copies of those photos;
//   * an equal-contents set holding it no longer holds identical folders.
//
// All three still refuse safely at confirm time, because every removal re-derives the
// fingerprints first. This is about not OFFERING work that is certain to fail — the
// state that put a dead folder on the page with a live-looking button.
function forgetFolder(ref: FolderRef): void {
  const prefix = ref.folderPath === "" ? "" : `${ref.folderPath.replace(/[\\%_]/g, "\\$&")}/`;
  // The folder itself or anything below it. A library root ("") covers everything.
  const covers = (column: string) => `(? = '' OR ${column} = ? OR ${column} LIKE ? ESCAPE '\\')`;
  const args = [ref.folderPath, ref.folderPath, `${prefix}%`];

  db.prepare(`
    DELETE FROM gallery_duplicate_contained_folders
    WHERE (library_id = ? AND ${covers("folder_path")})
       OR (target_library_id = ? AND ${covers("target_folder_path")})
  `).run(ref.libraryId, ...args, ref.libraryId, ...args);

  // Whole groups, not single members: the members cascade, and a set is only a set
  // while every folder in it holds the same photos.
  db.prepare(`
    DELETE FROM gallery_duplicate_folder_groups WHERE id IN (
      SELECT group_id FROM gallery_duplicate_folder_members
      WHERE library_id = ? AND ${covers("folder_path")}
    )
  `).run(ref.libraryId, ...args);
}

export function ignoreContainedFolder(id: string): boolean {
  const row = db.prepare(
    "SELECT library_id, folder_path, target_library_id, target_folder_path FROM gallery_duplicate_contained_folders WHERE id = ?"
  ).get(id) as { library_id: string; folder_path: string; target_library_id: string; target_folder_path: string } | undefined;
  if (!row) return false;
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO gallery_duplicate_contained_ignores
        (library_id, folder_path, target_library_id, target_folder_path)
      VALUES (?, ?, ?, ?)
    `).run(row.library_id, row.folder_path, row.target_library_id, row.target_folder_path);
    db.prepare("DELETE FROM gallery_duplicate_contained_folders WHERE id = ?").run(id);
  })();
  return true;
}

export interface ContainedResolution {
  removed: FolderRef;
  keptIn: FolderRef;
  deletedItemIds: string[];
  failed: { itemId: string; error: string }[];
}

/** Why a removal was refused. Three different things go wrong here and they call for
 *  three different answers — reporting "the copies are gone" for a folder that is
 *  simply already empty sends someone looking for a problem that isn't there. */
export type ContainedRefusal =
  /** No such row: already resolved, or dismissed in another tab. */
  | "missing"
  /** The folder holds no photos any more, so there is nothing left to remove. */
  | "empty"
  /** Coverage no longer holds — at least one photo here has no copy over there. */
  | "uncovered";

export type ContainedOutcome =
  | { ok: true; resolution: ContainedResolution }
  | { ok: false; refused: ContainedRefusal };

// Remove a folder whose every photo lives elsewhere too.
//
// Containment is re-derived from the database first, exactly as the equal-contents
// path re-derives fingerprints: if one photo here no longer has a counterpart, nothing
// is deleted at all. Each photo hands its tags, albums and people to a counterpart in
// the covering folder — preferring the file at the same relative path, and otherwise
// any copy with the same digest, which is equally valid because the bytes are identical
// (so tagged faces still land where they belong).
export function resolveContainedFolder(id: string, userId: string): ContainedOutcome {
  const row = db.prepare(
    "SELECT library_id, folder_path, target_library_id, target_folder_path FROM gallery_duplicate_contained_folders WHERE id = ?"
  ).get(id) as { library_id: string; folder_path: string; target_library_id: string; target_folder_path: string } | undefined;
  if (!row) return { ok: false, refused: "missing" };

  const folder: FolderRef = { libraryId: row.library_id, folderPath: row.folder_path };
  const target: FolderRef = { libraryId: row.target_library_id, folderPath: row.target_folder_path };
  const print = fingerprintOf(folder);
  // No fingerprint means the folder can't be compared at all — almost always because
  // its photos have already gone (deleted here, deleted from the gallery, or emptied
  // out of the Recycle Bin) and the row outlived them. Say that, and drop the row: it
  // describes a folder that no longer exists as far as the library is concerned.
  if (!print) {
    if (folderItemIds(folder).length === 0) {
      db.prepare("DELETE FROM gallery_duplicate_contained_folders WHERE id = ?").run(id);
      return { ok: false, refused: "empty" };
    }
    return { ok: false, refused: "uncovered" };
  }

  const stillCovered = containersOf(print).some((candidate) => refKey(candidate) === refKey(target));
  if (!stillCovered) return { ok: false, refused: "uncovered" };

  // Counterparts in the covering folder, by digest, with the same-relative-path copy
  // preferred so the obvious pairing wins when there is one.
  const prefix = target.folderPath === "" ? "" : `${target.folderPath.replace(/[\\%_]/g, "\\$&")}/`;
  const targetFiles = db.prepare(`
    SELECT li.id, li.folder_path, gd.content_hash AS hash
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready'
      AND (? = '' OR li.folder_path LIKE ? ESCAPE '\\')
      AND gd.content_hash IS NOT NULL
  `).all(target.libraryId, target.folderPath, `${prefix}%`) as
    { id: string; folder_path: string; hash: string }[];

  const byDigest = new Map<string, { id: string; folder_path: string }[]>();
  for (const file of targetFiles) {
    if (isInside(folder, file.folder_path, target.libraryId)) continue;
    const bucket = byDigest.get(file.hash);
    if (bucket) bucket.push(file); else byDigest.set(file.hash, [file]);
  }

  const doomed = db.prepare(`
    SELECT li.id, li.folder_path, gd.content_hash AS hash
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.id IN (${print.itemIds.map(() => "?").join(",")})
  `).all(...print.itemIds) as { id: string; folder_path: string; hash: string | null }[];

  const deletedItemIds: string[] = [];
  const failed: { itemId: string; error: string }[] = [];
  // Each counterpart may only stand in for one photo, so a folder holding the same
  // picture twice can't have both copies inherit from a single file.
  const claimed = new Set<string>();

  for (const item of doomed) {
    const candidates = item.hash ? byDigest.get(item.hash) ?? [] : [];
    const samePath = below(folder.folderPath, item.folder_path);
    const counterpart = candidates.find((file) =>
      !claimed.has(file.id) && below(target.folderPath, file.folder_path) === samePath)
      ?? candidates.find((file) => !claimed.has(file.id));
    if (!counterpart) {
      failed.push({ itemId: item.id, error: "No copy of this photo in the folder being kept." });
      continue;
    }
    claimed.add(counterpart.id);
    absorbDuplicateMetadata(counterpart.id, [item.id]);
    try {
      trashBook(item.id, userId);
      deletedItemIds.push(item.id);
    } catch (err) {
      failed.push({ itemId: item.id, error: err instanceof Error ? err.message : "Could not move the photo to the Recycle Bin." });
    }
  }

  db.prepare("DELETE FROM gallery_duplicate_contained_folders WHERE id = ?").run(id);
  // Cache invalidation follows the ACTION, not its tally — exactly as the row above is
  // dropped whether or not every photo made it to the bin. What these rows describe has
  // changed either way, and the next rebuild re-derives whatever is still true.
  forgetFolder(folder);

  if (deletedItemIds.length > 0) {
    logActivity({
      event: "library.gallery.contained_folder_removed",
      actorUserId: userId,
      targetType: "library",
      targetId: folder.libraryId,
      detail: `Moved ${deletedItemIds.length} photo${deletedItemIds.length === 1 ? "" : "s"} from "${folder.folderPath || "the library root"}" to the Recycle Bin — every one of them also sits in "${target.folderPath || "the library root"}".`,
      ipAddress: null
    });
  }

  return { ok: true, resolution: { removed: folder, keptIn: target, deletedItemIds, failed } };
}

// ────────────────────────────────────────────────────────────────────────────
//  Reading groups
// ────────────────────────────────────────────────────────────────────────────

/** Everything a folder card shows about one folder. Both folder answers render the
 *  same card, so both sides of a stored-elsewhere row carry this too — the two pages
 *  differ in what you may DO with a folder, not in what is known about it. */
export interface FolderDetail extends FolderRef {
  libraryName: string;
  /** Just the folder's own name — what tells two folders apart at a glance. */
  name: string;
  itemCount: number;
  bytes: number;
  linkCount: number;
  /** A few thumbnails, so a folder can be recognised without opening it. */
  coverUrls: string[];
  /** When its oldest photo was catalogued — how a person dates a folder. */
  addedAt: string | null;
}

export interface DuplicateFolderMember extends FolderDetail {
  isKeeper: boolean;
}

export interface DuplicateFolderGroup {
  id: string;
  itemCount: number;
  copyBytes: number;
  reclaimableBytes: number;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  members: DuplicateFolderMember[];
}

// Items directly below a folder, for the counts and covers a member card shows.
function folderItemIds(ref: FolderRef): string[] {
  const prefix = ref.folderPath === "" ? "" : `${ref.folderPath.replace(/[\\%_]/g, "\\$&")}/`;
  return (db.prepare(`
    SELECT li.id FROM library_items li
    WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready'
      AND (? = '' OR li.folder_path LIKE ? ESCAPE '\\')
    ORDER BY li.folder_path
  `).all(ref.libraryId, ref.folderPath, `${prefix}%`) as { id: string }[]).map((row) => row.id);
}

// Everything below a folder, as a SQL condition — the way to ask about a folder
// without first pulling every id in it into JavaScript.
//
// This matters more than it looks. A folder here is routinely a whole LIBRARY: the
// covering folder on the stored-elsewhere tab is often the library root, and that
// side of the card is drawn on every load of a page that polls every three seconds
// during a scan. Materialising 12,000 ids and then asking about them 400 at a time,
// across nine link tables, is tens of thousands of rows of synchronous work per
// poll — and better-sqlite3 is synchronous, so that is the whole server stopped.
// A RANGE, not a LIKE. SQLite's LIKE is case-insensitive by default and so cannot
// use an index on a plain TEXT column — the prefix scan everywhere else in this file
// therefore reads the whole library and filters row by row. "path/" ≤ x < "path0"
// asks the same question ("/" is 0x2F, so "0" is the character straight after it)
// and reads only the matching slice of idx_items_library_folder.
//
// It also stops "Photos" matching "photos/holiday.jpg", which LIKE was doing.
function folderScope(ref: FolderRef): { where: string; args: string[] } {
  const base = "li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready'";
  if (ref.folderPath === "") return { where: base, args: [ref.libraryId] };
  return {
    where: `${base} AND li.folder_path >= ? AND li.folder_path < ?`,
    args: [ref.libraryId, `${ref.folderPath}/`, `${ref.folderPath}0`]
  };
}

// The hand-filed work on the photos below a folder: tags, albums, collections,
// saves, shares, tagged people. Nine tables, one query, each joined against the
// folder scope rather than against a list of ids.
const LINK_SOURCES: { table: string; column: string; extra?: string }[] = [
  { table: "taggables", column: "entity_id", extra: "x.entity_type = 'library_item'" },
  { table: "gallery_album_items", column: "item_id" },
  { table: "gallery_slideshow_items", column: "item_id" },
  { table: "collection_items", column: "entity_id", extra: "x.entity_type = 'library_item'" },
  { table: "item_saves", column: "item_id" },
  { table: "shares", column: "resource_id", extra: "x.module = 'gallery' AND x.revoked_at IS NULL" },
  { table: "family_tree_photos", column: "item_id" },
  { table: "family_tree_event_photos", column: "item_id" },
  { table: "gallery_faces", column: "item_id", extra: "x.assignment != 'rejected' AND x.person_id IS NOT NULL" }
];

function folderLinkCount(ref: FolderRef): number {
  const scope = folderScope(ref);
  const parts = LINK_SOURCES.map((source) => `
    (SELECT COUNT(*) FROM ${source.table} x
     JOIN library_items li ON li.id = x.${source.column}
     WHERE ${source.extra ? `${source.extra} AND ` : ""}${scope.where})`);
  const row = db.prepare(`SELECT ${parts.join(" + ")} AS n`)
    .get(...LINK_SOURCES.flatMap(() => scope.args)) as { n: number };
  return row.n;
}

/** What a folder holds, in one query — enough to filter, sort and count by, and
 *  cheap enough to ask about every folder in both lists. */
export interface FolderTotals {
  itemCount: number;
  bytes: number;
  addedAt: string | null;
}

function folderTotals(ref: FolderRef): FolderTotals {
  const scope = folderScope(ref);
  const row = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(gd.size), 0) AS bytes, MIN(li.discovered_at) AS added
    FROM library_items li
    JOIN gallery_details gd ON gd.item_id = li.id
    WHERE ${scope.where}
  `).get(...scope.args) as { n: number; bytes: number; added: string | null };
  return { itemCount: row.n, bytes: row.bytes, addedAt: row.added };
}

// The rest of a card: thumbnails and the hand-filed work. Split from the totals
// above because it is the expensive half — folderLinkCount alone is nine scans, and
// the folder it is asked about is routinely an entire library. Both lists page now,
// so this runs for the ten folders on screen rather than for every folder found.
function folderDetail(ref: FolderRef, libraryName: string, totals = folderTotals(ref)): FolderDetail {
  const scope = folderScope(ref);
  const covers = db.prepare(`
    SELECT im.cover_storage_key AS cover
    FROM library_items li
    JOIN item_metadata im ON im.item_id = li.id
    WHERE ${scope.where} AND im.cover_storage_key IS NOT NULL
    ORDER BY li.folder_path
    LIMIT ?
  `).all(...scope.args, COVER_LIMIT) as { cover: string }[];

  return {
    ...ref,
    libraryName,
    name: folderName(ref.folderPath),
    itemCount: totals.itemCount,
    bytes: totals.bytes,
    linkCount: totals.itemCount === 0 ? 0 : folderLinkCount(ref),
    coverUrls: covers.map((row) => `/api/library/covers/${row.cover}`),
    addedAt: totals.addedAt
  };
}

/** At most this many counterpart folders are named before the card falls back to
 *  counting them. Three is enough to recognise a pattern, short enough to read. */
const COUNTERPART_FOLDER_LIMIT = 3;

// WHERE the copies actually sit inside the covering folder.
//
// The covering folder is often the whole library — because the copies are spread
// across several of its folders, or because someone marked that library "keep here",
// which outranks the tightest-fit rule on purpose. Naming it is then true and
// useless: "every photo is also in ." tells you nothing you can go and look at.
// These are the folders a person would actually open.
function counterpartFolders(folder: FolderRef, target: FolderRef): { paths: string[]; total: number } {
  const ids = folderItemIds(folder);
  if (ids.length === 0) return { paths: [], total: 0 };

  const digests = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const rows = db.prepare(`
      SELECT DISTINCT content_hash AS hash FROM gallery_details
      WHERE item_id IN (${chunk.map(() => "?").join(",")}) AND content_hash IS NOT NULL
    `).all(...chunk) as { hash: string }[];
    for (const row of rows) digests.add(row.hash);
  }
  if (digests.size === 0) return { paths: [], total: 0 };

  const scope = folderScope(target);
  const counts = new Map<string, number>();
  const list = [...digests];
  for (let i = 0; i < list.length; i += ID_CHUNK) {
    const chunk = list.slice(i, i + ID_CHUNK);
    const rows = db.prepare(`
      SELECT li.folder_path FROM library_items li
      JOIN gallery_details gd ON gd.item_id = li.id
      WHERE ${scope.where}
        AND gd.content_hash IN (${chunk.map(() => "?").join(",")})
    `).all(...scope.args, ...chunk) as { folder_path: string }[];
    for (const row of rows) {
      // A file inside the folder being removed is not a copy OF it.
      if (isInside(folder, row.folder_path, target.libraryId)) continue;
      const cut = row.folder_path.lastIndexOf("/");
      counts.set(cut === -1 ? "" : row.folder_path.slice(0, cut), 1);
    }
  }

  const sorted = [...counts.keys()].sort();
  return { paths: sorted.slice(0, COUNTERPART_FOLDER_LIMIT), total: sorted.length };
}

const COVER_LIMIT = 4;

// ── Searching and paging the folder answers ─────────────────────────────────
//
// Same split as the photo sets: the cheap half (what a folder holds) runs over every
// folder to decide what matches and in what order, and the expensive half — covers,
// and the nine-scan link count over what may be an entire library — runs only for
// the folders on screen. The filtering is the page's own, moved rather than rewritten.

export interface FolderSearch {
  libraryId?: string | null;
  folders?: FolderRef[];
  search?: string;
  sort?: "newest" | "photos" | "size" | "name";
  page?: number;
  /** 0 means every match. */
  perPage?: number;
}

interface LeanFolderMember extends FolderRef, FolderTotals {
  libraryName: string;
  name: string;
  isKeeper: boolean;
}

interface LeanFolderGroup {
  id: string;
  itemCount: number;
  copyBytes: number;
  reclaimableBytes: number;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  members: LeanFolderMember[];
}

/** A folder covers itself and everything below it. */
const folderChosen = (chosen: FolderRef[], libraryId: string, folderPath: string): boolean =>
  chosen.length === 0 || chosen.some((folder) =>
    folder.libraryId === libraryId
    && (folder.folderPath === "" || folderPath === folder.folderPath || folderPath.startsWith(`${folder.folderPath}/`)));

function paginate<T>(list: T[], query: FolderSearch): { items: T[]; page: number } {
  const perPage = query.perPage && query.perPage > 0 ? query.perPage : list.length || 1;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const page = Math.min(Math.max(query.page ?? 1, 1), totalPages);
  return { items: list.slice((page - 1) * perPage, page * perPage), page };
}

function leanFolderGroups(): LeanFolderGroup[] {
  const groups = db.prepare(`
    SELECT id, item_count, copy_bytes, keeper_library_id, keeper_folder_path, keeper_source, keeper_reason
    FROM gallery_duplicate_folder_groups ORDER BY copy_bytes DESC, id
  `).all() as {
    id: string; item_count: number; copy_bytes: number;
    keeper_library_id: string | null; keeper_folder_path: string | null;
    keeper_source: "auto" | "manual"; keeper_reason: string | null;
  }[];
  if (groups.length === 0) return [];

  const memberRows = db.prepare(`
    SELECT m.group_id, m.library_id, m.folder_path, lib.name AS library_name
    FROM gallery_duplicate_folder_members m
    JOIN libraries lib ON lib.id = m.library_id
  `).all() as { group_id: string; library_id: string; folder_path: string; library_name: string }[];

  const byGroup = new Map<string, typeof memberRows>();
  for (const row of memberRows) {
    const bucket = byGroup.get(row.group_id);
    if (bucket) bucket.push(row); else byGroup.set(row.group_id, [row]);
  }

  return groups.map((group) => {
    const members = (byGroup.get(group.id) ?? []).map((row) => ({
      libraryId: row.library_id,
      folderPath: row.folder_path,
      libraryName: row.library_name,
      name: folderName(row.folder_path),
      isKeeper: row.library_id === group.keeper_library_id && row.folder_path === group.keeper_folder_path,
      ...folderTotals({ libraryId: row.library_id, folderPath: row.folder_path })
    // A member emptied since the scan holds nothing to keep or delete.
    })).filter((member) => member.itemCount > 0)
      .sort((a, b) => Number(b.isKeeper) - Number(a.isKeeper)
        || a.libraryName.localeCompare(b.libraryName)
        || a.folderPath.localeCompare(b.folderPath));

    return {
      id: group.id,
      itemCount: group.item_count,
      copyBytes: group.copy_bytes,
      reclaimableBytes: members.filter((m) => !m.isKeeper).reduce((sum, m) => sum + m.bytes, 0),
      keeperSource: group.keeper_source,
      keeperReason: group.keeper_reason,
      members
    };
  }).filter((group) => group.members.length > 1);
}

/** Only folders inside the chosen library are compared; a set left with fewer than
 *  two of them isn't a duplicate there. */
function scopeFolderGroup(group: LeanFolderGroup, libraryId: string): LeanFolderGroup | null {
  if (!libraryId) return group;
  const mine = group.members.filter((member) => member.libraryId === libraryId);
  if (mine.length < 2) return null;
  const keeper = mine.find((member) => member.isKeeper) ?? mine[0];
  const members = mine.map((member) => ({ ...member, isKeeper: member === keeper }));
  return {
    ...group,
    members,
    reclaimableBytes: members.filter((m) => !m.isKeeper).reduce((sum, m) => sum + m.bytes, 0)
  };
}

const newestMember = (group: LeanFolderGroup): string =>
  group.members.reduce((latest, m) => (m.addedAt && m.addedAt > latest ? m.addedAt : latest), "");

/** Every folder the two folder answers name, for the filter box's vocabulary — and
 *  how many of each answer there are, for the counts the photo page links with. Both
 *  without building a single card. */
export function folderAnswerSummary(): {
  folders: { libraryId: string; libraryName: string; folderPath: string }[];
  folderSets: number;
  containedRowCount: number;
} {
  const members = db.prepare(`
    SELECT m.library_id AS libraryId, lib.name AS libraryName, m.folder_path AS folderPath
    FROM gallery_duplicate_folder_members m
    JOIN libraries lib ON lib.id = m.library_id
  `).all() as { libraryId: string; libraryName: string; folderPath: string }[];

  const contained = containedRows();
  const folders = [...members];
  for (const row of contained) {
    folders.push({ libraryId: row.libraryId, libraryName: row.libraryName, folderPath: row.folderPath });
    folders.push({ libraryId: row.targetLibraryId, libraryName: row.targetLibraryName, folderPath: row.targetFolderPath });
  }

  return {
    folders,
    folderSets: (db.prepare("SELECT COUNT(*) AS n FROM gallery_duplicate_folder_groups").get() as { n: number }).n,
    containedRowCount: contained.length
  };
}

export interface DuplicateFolderPage {
  groups: DuplicateFolderGroup[];
  total: number;
  allSets: number;
  page: number;
  reclaimableBytes: number;
}

export function searchDuplicateFolderGroups(query: FolderSearch): DuplicateFolderPage {
  const all = leanFolderGroups();
  const needle = (query.search ?? "").trim().toLowerCase();
  const chosen = query.folders ?? [];

  const matched = all
    .map((group) => scopeFolderGroup(group, query.libraryId ?? ""))
    .filter((group): group is LeanFolderGroup => group !== null)
    .filter((group) => group.members.some((member) =>
      (!needle || member.folderPath.toLowerCase().includes(needle) || member.libraryName.toLowerCase().includes(needle))
      && folderChosen(chosen, member.libraryId, member.folderPath)));

  const sort = query.sort ?? "newest";
  const ordered = [...matched].sort((a, b) => {
    if (sort === "photos") return b.itemCount - a.itemCount;
    if (sort === "size") return b.copyBytes - a.copyBytes;
    if (sort === "name") return (a.members[0]?.name ?? "").localeCompare(b.members[0]?.name ?? "");
    return newestMember(b).localeCompare(newestMember(a));
  });

  const { items, page } = paginate(ordered, query);
  return {
    groups: items.map((group) => ({
      id: group.id,
      itemCount: group.itemCount,
      copyBytes: group.copyBytes,
      reclaimableBytes: group.reclaimableBytes,
      keeperSource: group.keeperSource,
      keeperReason: group.keeperReason,
      members: group.members.map((member) => ({
        ...folderDetail({ libraryId: member.libraryId, folderPath: member.folderPath }, member.libraryName, member),
        isKeeper: member.isKeeper
      }))
    })),
    total: ordered.length,
    allSets: all.length,
    page,
    reclaimableBytes: matched.reduce((sum, group) => sum + group.reclaimableBytes, 0)
  };
}

export interface ContainedFolderPage {
  rows: ContainedFolder[];
  total: number;
  allRows: number;
  page: number;
  reclaimableBytes: number;
}

export function searchContainedFolders(query: FolderSearch): ContainedFolderPage {
  const all = containedRows();
  const needle = (query.search ?? "").trim().toLowerCase();
  const chosen = query.folders ?? [];
  const libraryId = query.libraryId ?? "";

  // With one library chosen, only rows where BOTH sides live there make sense.
  const matched = all.filter((row) =>
    (!libraryId || (row.libraryId === libraryId && row.targetLibraryId === libraryId))
    && (!needle
      || row.folderPath.toLowerCase().includes(needle)
      || row.targetFolderPath.toLowerCase().includes(needle)
      || row.libraryName.toLowerCase().includes(needle))
    && (folderChosen(chosen, row.libraryId, row.folderPath)
      || folderChosen(chosen, row.targetLibraryId, row.targetFolderPath)));

  const sort = query.sort ?? "newest";
  const ordered = [...matched].sort((a, b) => {
    if (sort === "photos") return b.totals.itemCount - a.totals.itemCount;
    if (sort === "size") return b.totals.bytes - a.totals.bytes;
    if (sort === "name") return folderName(a.folderPath).localeCompare(folderName(b.folderPath));
    return (b.totals.addedAt ?? "").localeCompare(a.totals.addedAt ?? "");
  });

  const { items, page } = paginate(ordered, query);
  return {
    rows: items.map(hydrateContained),
    total: ordered.length,
    allRows: all.length,
    page,
    reclaimableBytes: matched.reduce((sum, row) => sum + row.totals.bytes, 0)
  };
}

export function listDuplicateFolderGroups(): DuplicateFolderGroup[] {
  const groups = db.prepare(`
    SELECT id, item_count, copy_bytes, keeper_library_id, keeper_folder_path, keeper_source, keeper_reason
    FROM gallery_duplicate_folder_groups ORDER BY copy_bytes DESC, id
  `).all() as {
    id: string; item_count: number; copy_bytes: number;
    keeper_library_id: string | null; keeper_folder_path: string | null;
    keeper_source: "auto" | "manual"; keeper_reason: string | null;
  }[];
  if (groups.length === 0) return [];

  const memberRows = db.prepare(`
    SELECT m.group_id, m.library_id, m.folder_path, lib.name AS library_name
    FROM gallery_duplicate_folder_members m
    JOIN libraries lib ON lib.id = m.library_id
  `).all() as { group_id: string; library_id: string; folder_path: string; library_name: string }[];

  const byGroup = new Map<string, typeof memberRows>();
  for (const row of memberRows) {
    const bucket = byGroup.get(row.group_id);
    if (bucket) bucket.push(row); else byGroup.set(row.group_id, [row]);
  }

  return groups.map((group) => {
    const rows = byGroup.get(group.id) ?? [];
    const members = rows.map((row) => ({
      ...folderDetail({ libraryId: row.library_id, folderPath: row.folder_path }, row.library_name),
      isKeeper: row.library_id === group.keeper_library_id && row.folder_path === group.keeper_folder_path
    // A member emptied since the scan holds nothing to keep or delete. Dropping it
    // here is what leaves a one-folder set to be filtered out below, rather than
    // offering a set whose second folder has no photos in it.
    })).filter((member) => member.itemCount > 0)
      .sort((a, b) => Number(b.isKeeper) - Number(a.isKeeper)
      || a.libraryName.localeCompare(b.libraryName)
      || a.folderPath.localeCompare(b.folderPath));

    return {
      id: group.id,
      itemCount: group.item_count,
      copyBytes: group.copy_bytes,
      reclaimableBytes: members.filter((member) => !member.isKeeper).reduce((sum, member) => sum + member.bytes, 0),
      keeperSource: group.keeper_source,
      keeperReason: group.keeper_reason,
      members
    };
  }).filter((group) => group.members.length > 1);
}

// ────────────────────────────────────────────────────────────────────────────
//  Admin actions
// ────────────────────────────────────────────────────────────────────────────

export function setDuplicateFolderKeeper(groupId: string, ref: FolderRef): boolean {
  const member = db.prepare(
    "SELECT 1 FROM gallery_duplicate_folder_members WHERE group_id = ? AND library_id = ? AND folder_path = ?"
  ).get(groupId, ref.libraryId, ref.folderPath);
  if (!member) return false;
  db.prepare(`
    UPDATE gallery_duplicate_folder_groups
    SET keeper_library_id = ?, keeper_folder_path = ?, keeper_source = 'manual', keeper_reason = NULL
    WHERE id = ?
  `).run(ref.libraryId, ref.folderPath, groupId);
  return true;
}

// "Not the same folder" — record every pair so no future scan can reassemble the set,
// then drop it.
export function ignoreDuplicateFolderGroup(groupId: string): boolean {
  const rows = db.prepare(
    "SELECT library_id, folder_path FROM gallery_duplicate_folder_members WHERE group_id = ?"
  ).all(groupId) as { library_id: string; folder_path: string }[];
  if (rows.length === 0) return false;
  const keys = rows.map((row) => refKey({ libraryId: row.library_id, folderPath: row.folder_path })).sort();
  db.transaction(() => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO gallery_duplicate_folder_ignores (library_a, path_a, library_b, path_b)
      VALUES (?, ?, ?, ?)
    `);
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const a = parseKey(keys[i]);
        const b = parseKey(keys[j]);
        insert.run(a.libraryId, a.folderPath, b.libraryId, b.folderPath);
      }
    }
    db.prepare("DELETE FROM gallery_duplicate_folder_groups WHERE id = ?").run(groupId);
  })();
  return true;
}

export interface FolderResolution {
  keptFolder: FolderRef;
  deletedFolders: FolderRef[];
  deletedItemIds: string[];
  failed: { itemId: string; error: string }[];
}

// Remove whole folders, keeping one.
//
// Re-derives every fingerprint involved before touching anything: a scan result can be
// days old, and a folder that has gained, lost or changed a single file is no longer
// provably the same folder. A mismatch aborts the whole thing rather than deleting the
// part that still matches — "these folders are the same" is the claim the admin acted
// on, and it is no longer true.
//
// Each removed photo hands its tags, albums, collections and tagged people to the file
// at the SAME relative path inside the kept folder. That mapping is exact because the
// fingerprint covers paths as well as contents, and the counterpart is byte-identical,
// so faces transfer too.
export function resolveDuplicateFolderGroup(
  groupId: string,
  deleteFolders: FolderRef[],
  userId: string
): FolderResolution | null {
  const group = db.prepare(
    "SELECT id, keeper_library_id, keeper_folder_path FROM gallery_duplicate_folder_groups WHERE id = ?"
  ).get(groupId) as { id: string; keeper_library_id: string | null; keeper_folder_path: string | null } | undefined;
  if (!group?.keeper_library_id || group.keeper_folder_path === null) return null;

  const memberRows = db.prepare(
    "SELECT library_id, folder_path FROM gallery_duplicate_folder_members WHERE group_id = ?"
  ).all(groupId) as { library_id: string; folder_path: string }[];
  const memberKeys = new Set(memberRows.map((row) =>
    refKey({ libraryId: row.library_id, folderPath: row.folder_path })));

  const keeper: FolderRef = { libraryId: group.keeper_library_id, folderPath: group.keeper_folder_path };
  // Never act on a folder the caller invented, and never delete the folder being kept.
  const doomed = deleteFolders.filter((ref) =>
    memberKeys.has(refKey(ref)) && refKey(ref) !== refKey(keeper));
  if (doomed.length === 0 || doomed.length !== deleteFolders.length) return null;

  const keeperPrint = fingerprintOf(keeper);
  if (!keeperPrint) return null;
  for (const ref of doomed) {
    const print = fingerprintOf(ref);
    if (!print || print.digest !== keeperPrint.digest) return null;
  }

  // path-below-the-folder → the keeper's file at that path.
  const keeperByPath = new Map(
    (db.prepare(`
      SELECT li.id, li.folder_path FROM library_items li
      WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready'
        AND (? = '' OR li.folder_path LIKE ? ESCAPE '\\')
    `).all(
      keeper.libraryId,
      keeper.folderPath,
      `${keeper.folderPath === "" ? "" : `${keeper.folderPath.replace(/[\\%_]/g, "\\$&")}/`}%`
    ) as { id: string; folder_path: string }[])
      .map((row) => [below(keeper.folderPath, row.folder_path), row.id])
  );

  const deletedItemIds: string[] = [];
  const failed: { itemId: string; error: string }[] = [];
  const deletedFolders: FolderRef[] = [];

  for (const ref of doomed) {
    const rows = db.prepare(`
      SELECT li.id, li.folder_path FROM library_items li
      WHERE li.library_id = ? AND li.deleted_at IS NULL AND li.status = 'ready'
        AND (? = '' OR li.folder_path LIKE ? ESCAPE '\\')
    `).all(
      ref.libraryId,
      ref.folderPath,
      `${ref.folderPath === "" ? "" : `${ref.folderPath.replace(/[\\%_]/g, "\\$&")}/`}%`
    ) as { id: string; folder_path: string }[];

    for (const row of rows) {
      const counterpart = keeperByPath.get(below(ref.folderPath, row.folder_path));
      if (!counterpart) {
        // The fingerprints matched, so this cannot happen — but a missing counterpart
        // would mean deleting a photo with nothing to inherit it, so refuse.
        failed.push({ itemId: row.id, error: "No matching photo in the folder being kept." });
        continue;
      }
      absorbDuplicateMetadata(counterpart, [row.id]);
      try {
        trashBook(row.id, userId);
        deletedItemIds.push(row.id);
      } catch (err) {
        failed.push({ itemId: row.id, error: err instanceof Error ? err.message : "Could not move the photo to the Recycle Bin." });
      }
    }
    deletedFolders.push(ref);
  }

  // The set is only meaningful while two folders remain; a partial removal leaves the
  // rest for the next scan to re-derive.
  const remaining = memberRows.length - deletedFolders.length;
  if (remaining < 2) db.prepare("DELETE FROM gallery_duplicate_folder_groups WHERE id = ?").run(groupId);
  else {
    const list = doomed.map(() => "(library_id = ? AND folder_path = ?)").join(" OR ");
    db.prepare(`DELETE FROM gallery_duplicate_folder_members WHERE group_id = ? AND (${list})`)
      .run(groupId, ...doomed.flatMap((ref) => [ref.libraryId, ref.folderPath]));
  }

  // These folders are empty now, so every other row that named them is stale — most of
  // all a stored-elsewhere row pointing at one, which would offer to bin the last copy
  // of a photo. Runs after the group is trimmed, so it only removes what this set left.
  for (const ref of deletedFolders) forgetFolder(ref);

  if (deletedItemIds.length > 0) {
    logActivity({
      event: "library.gallery.duplicate_folders_removed",
      actorUserId: userId,
      targetType: "library",
      targetId: keeper.libraryId,
      detail: `Moved ${deletedItemIds.length} photo${deletedItemIds.length === 1 ? "" : "s"} from ${deletedFolders.length} duplicate folder${deletedFolders.length === 1 ? "" : "s"} to the Recycle Bin, keeping "${keeper.folderPath || "the library root"}".`,
      ipAddress: null
    });
  }

  return { keptFolder: keeper, deletedFolders, deletedItemIds, failed };
}
