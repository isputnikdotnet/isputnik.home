// Duplicate photo detection — tier 1: byte-identical files.
//
// The catalog scan deliberately never reads a file it has already seen (scanner.ts
// skips on unchanged size + mtime), so hashing every asset during a scan would undo the
// one optimisation that keeps rescans cheap. This module avoids that entirely by
// exploiting the thing byte-identical files must share: `size`, which gallery_details
// already stores. Only assets whose size collides with another asset are ever hashed —
// in a real library that's a small fraction of the whole.
//
// Results in gallery_duplicate_groups/_members are a derived CACHE, rebuilt from scratch
// on every scan so they can never go stale. The only things that survive a rebuild are
// the admin's decisions: a hand-picked keeper, and gallery_duplicate_ignores ("not
// duplicates"), stored as PAIRS so the dismissal still holds when a third copy turns up
// and regroups everything.
//
// Nothing here deletes on its own. A scan only ever proposes; resolveDuplicateGroup is
// the single path that removes anything, it moves copies to the Recycle Bin (never a
// hard delete), and it merges the losers' tags/albums/people onto the kept copy first.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../../db.js";
import { validateLibrarySource } from "../../shared/library-source.js";
import { pathIsInside } from "../../shared/storage-roots.js";
import { libraryJobRunning } from "../../shared/scan-lock.js";
import { requeueInterruptedJobs } from "../../shared/job-recovery.js";
import { jobProgressWriter } from "../../shared/job-progress.js";
import { trashBook, libraryAllowsDelete } from "../../shared/trash.js";
import { allFolderLocks, lockCoveredIn } from "../../shared/folder-locks.js";
import { applyItemAlphaIndex } from "../../shared/alphabet-index.js";
import { recomputeFaceCount } from "../people.js";
// Same shape of mutual import, for the same reason: a cleanup job's scan is this
// module's hashing pass followed by that job's own snapshot, so the worker down at the
// bottom has to be able to reach jobs.ts and job-scan.ts. Both of those build on this
// one, and every reference across — in either direction — happens inside a function
// body, never while a module is being evaluated.
import { getJob, setJobStatus, setJobScanProgress } from "./jobs.js";
import { runJobScan } from "./job-scan.js";

export const DUPLICATE_SCAN_JOB_TYPE = "SCAN_GALLERY_DUPLICATES";

const LAST_SCAN_KEY = "gallery_duplicate_scan_at";

// SQLite's variable limit is ~32k; chunk any generated IN (…) list well under it.
const ID_CHUNK = 400;

// ────────────────────────────────────────────────────────────────────────────
//  Candidates — assets whose size collides with at least one other asset
// ────────────────────────────────────────────────────────────────────────────

// Byte sizes shared by two or more live assets, across EVERY gallery library. This
// stays global even when a scan is scoped to one library: the whole point of the size
// gate is to spot a file that matches something else, and the something else is very
// often in a different library (the same album imported twice, into two places).
const COLLIDING_SIZES_SQL = `
  SELECT gd2.size
  FROM gallery_details gd2
  JOIN library_items li2 ON li2.id = gd2.item_id AND li2.deleted_at IS NULL AND li2.status = 'ready'
  JOIN libraries lib2 ON lib2.id = li2.library_id AND lib2.type = 'gallery'
  WHERE gd2.size IS NOT NULL AND gd2.size > 0
  GROUP BY gd2.size
  HAVING COUNT(*) > 1
`;

// Live, ready gallery assets sharing a byte size with another live asset. Everything
// else is provably unique and never gets read from disk.
const CANDIDATE_SQL = `
  FROM gallery_details gd
  JOIN library_items li ON li.id = gd.item_id AND li.deleted_at IS NULL AND li.status = 'ready'
  JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
  WHERE gd.size IS NOT NULL AND gd.size > 0
    AND gd.size IN (${COLLIDING_SIZES_SQL})
`;

/** One library, several, or (omitted/empty) every gallery library. A cleanup job
 *  scans the several — the older pages only ever ask for one or all. */
export type LibraryScope = string | string[] | null | undefined;

// Narrows which assets a scan READS from disk — the expensive part, and the only reason
// to scope a scan at all. Grouping is never narrowed (see rebuildExactDuplicateGroups),
// and neither is the size gate above, so a digest computed for one library still matches
// against every other library's.
function libraryScope(scope: LibraryScope): { clause: string; params: string[] } {
  const ids = (typeof scope === "string" ? [scope] : scope ?? []).filter(Boolean);
  if (ids.length === 0) return { clause: "", params: [] };
  return { clause: ` AND li.library_id IN (${ids.map(() => "?").join(",")})`, params: ids };
}

export function duplicateCandidateCount(scope?: LibraryScope): number {
  const { clause, params } = libraryScope(scope);
  return (db.prepare(`SELECT COUNT(*) AS n ${CANDIDATE_SQL}${clause}`).get(...params) as { n: number }).n;
}

// A candidate whose digest is missing or stale — i.e. one this scan would actually open
// and read. Everything else was hashed by an earlier run and is reused for free.
const NEEDS_READING_SQL = "AND (gd.content_hash IS NULL OR gd.content_hash_at IS NOT gd.modified_at)";

// How many files a scan would read right now. Distinct from duplicateCandidateCount,
// which counts everything worth checking regardless of whether it's already hashed:
// after a scan the candidate count stays put while this drops to zero.
//
// An ESTIMATE, deliberately: it compares catalogued values rather than stat'ing every
// candidate, which would make loading the admin page as expensive as a scan. The scan
// itself checks the real files (hashDuplicateCandidates), so it may read a few more than
// this predicted — a file edited in place since the last catalog scan is invisible here.
export function duplicatePendingCount(scope?: LibraryScope): number {
  const { clause, params } = libraryScope(scope);
  return (db.prepare(`SELECT COUNT(*) AS n ${CANDIDATE_SQL} ${NEEDS_READING_SQL}${clause}`)
    .get(...params) as { n: number }).n;
}

interface CandidateRow {
  item_id: string;
  library_id: string;
  source_path: string;
  relative_path: string;
  size: number;
  content_hash: string | null;
  content_hash_at: string | null;
}

// EVERY candidate, already-hashed ones included. Freshness is decided against the file
// on disk (see hashDuplicateCandidates), not against the catalogue: `modified_at` only
// moves when a catalog scan notices, so a photo edited in place between scans would
// otherwise keep a digest of bytes that no longer exist. One stat per candidate is a
// cheap price for not depending on another job having run first.
function scanCandidates(scope?: LibraryScope): CandidateRow[] {
  const { clause, params } = libraryScope(scope);
  return db.prepare(`
    SELECT gd.item_id, li.library_id, lib.source_path, gd.relative_path,
           gd.size, gd.content_hash, gd.content_hash_at
    ${CANDIDATE_SQL}${clause}
    ORDER BY gd.size ASC
  `).all(...params) as CandidateRow[];
}

async function sha256File(absolutePath: string): Promise<string | null> {
  const hash = crypto.createHash("sha256");
  try {
    for await (const chunk of fs.createReadStream(absolutePath)) hash.update(chunk as Buffer);
  } catch {
    return null; // unreadable / vanished — a catalog scan will tombstone it
  }
  return hash.digest("hex");
}

export interface HashPassResult {
  /** Digests computed this run. */
  hashed: number;
  /** Files whose size on disk no longer matches the catalogue — a rescan is due. */
  stale: number;
}

// Bring every candidate's digest up to date with what is actually on disk.
//
// Each candidate is stat'd first — one syscall, no read — and that stat, not the
// catalogue, decides what happens:
//
//   size differs   the catalogue is out of date, and it's the catalogued size that put
//                  this file in the candidate set at all. Nothing here can be trusted,
//                  so any stored digest is dropped and the file is counted as stale
//                  rather than hashed; a library scan is what fixes it.
//   mtime differs  the bytes changed since the digest was taken — re-read.
//   otherwise      the stored digest still describes the file. Skip it, free.
//
// The digest is stamped with the file's REAL mtime, so this stays correct without any
// catalog scan having run in between. (That stamp matches what a catalog scan records
// for an untouched file, so upgrading doesn't invalidate existing digests.)
export async function hashDuplicateCandidates(
  onProgress?: (processed: number, total: number) => void,
  scope?: LibraryScope
): Promise<HashPassResult> {
  const rows = scanCandidates(scope);
  // A library whose mount is unavailable throws once and is then skipped wholesale
  // rather than throwing per file.
  const roots = new Map<string, string | null>();
  const setHash = db.prepare("UPDATE gallery_details SET content_hash = ?, content_hash_at = ? WHERE item_id = ?");
  let processed = 0;
  let hashed = 0;
  let stale = 0;

  for (const row of rows) {
    processed += 1;
    onProgress?.(processed, rows.length);

    if (!roots.has(row.library_id)) {
      try { roots.set(row.library_id, validateLibrarySource(row.source_path)); }
      catch { roots.set(row.library_id, null); }
    }
    const root = roots.get(row.library_id);
    if (!root) continue;

    const absolutePath = path.resolve(root, ...row.relative_path.split("/"));
    if (!pathIsInside(absolutePath, root)) continue;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      // Gone from disk; a catalog scan will tombstone it. Drop the digest meanwhile so
      // it can't hold a set together on its own.
      if (row.content_hash) setHash.run(null, null, row.item_id);
      continue;
    }

    if (stat.size !== row.size) {
      if (row.content_hash) setHash.run(null, null, row.item_id);
      stale += 1;
      continue;
    }

    const mtime = new Date(stat.mtimeMs).toISOString();
    if (row.content_hash && row.content_hash_at === mtime) continue;

    const digest = await sha256File(absolutePath);
    if (digest) {
      setHash.run(digest, mtime, row.item_id);
      hashed += 1;
    } else if (row.content_hash) {
      // Clear a digest we can no longer verify so it can't group anything.
      setHash.run(null, null, row.item_id);
    }
  }

  onProgress?.(rows.length, rows.length);
  return { hashed, stale };
}

// ────────────────────────────────────────────────────────────────────────────
//  Keeper scoring
// ────────────────────────────────────────────────────────────────────────────

export interface DetailRow {
  item_id: string;
  kind: string;
  library_id: string;
  library_name: string;
  relative_path: string;
  discovered_at: string;
  size: number | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  taken_at_source: string;
  gps_source: string;
  camera_make: string | null;
  camera_model: string | null;
  content_hash: string | null;
  title: string | null;
  metadata_source: string | null;
  cover_storage_key: string | null;
  preview_storage_key: string | null;
  face_count: number;
  album_count: number;
  slideshow_count: number;
  collection_count: number;
  tag_count: number;
  save_count: number;
  share_count: number;
  ft_person_count: number;
  ft_event_count: number;
}

const DETAIL_COLUMNS = `
  gd.item_id, gd.kind, li.library_id, lib.name AS library_name, gd.relative_path, li.discovered_at,
  gd.size, gd.width, gd.height, gd.taken_at, gd.taken_at_source, gd.gps_source,
  gd.camera_make, gd.camera_model, gd.content_hash,
  im.title, im.source AS metadata_source, im.cover_storage_key, gd.preview_storage_key
`;

// The hand-filed work on each copy, which decides which one the scan suggests keeping.
// These were nine correlated subqueries on DETAIL_COLUMNS, so SQLite ran nine lookups
// for EVERY copy on the page — and this page loads every set it found, then polls
// itself every three seconds while a scan runs. Nine grouped scans over a chunk of ids
// answer the same question once each instead of once per row.
const LINK_COUNTS: { field: keyof DetailRow; table: string; column: string; extra?: string }[] = [
  { field: "face_count", table: "gallery_faces", column: "item_id", extra: "assignment != 'rejected'" },
  { field: "album_count", table: "gallery_album_items", column: "item_id" },
  { field: "slideshow_count", table: "gallery_slideshow_items", column: "item_id" },
  { field: "collection_count", table: "collection_items", column: "entity_id", extra: "entity_type = 'library_item'" },
  { field: "tag_count", table: "taggables", column: "entity_id", extra: "entity_type = 'library_item'" },
  { field: "save_count", table: "item_saves", column: "item_id" },
  { field: "share_count", table: "shares", column: "resource_id", extra: "module = 'gallery' AND revoked_at IS NULL" },
  { field: "ft_person_count", table: "family_tree_photos", column: "item_id" },
  { field: "ft_event_count", table: "family_tree_event_photos", column: "item_id" }
];

export function loadDetails(itemIds: string[]): Map<string, DetailRow> {
  const out = new Map<string, DetailRow>();
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const chunk = itemIds.slice(i, i + ID_CHUNK);
    const list = chunk.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT ${DETAIL_COLUMNS}
      FROM gallery_details gd
      JOIN library_items li ON li.id = gd.item_id
      JOIN libraries lib ON lib.id = li.library_id
      LEFT JOIN item_metadata im ON im.item_id = gd.item_id
      WHERE gd.item_id IN (${list})
    `).all(...chunk) as DetailRow[];

    for (const row of rows) {
      for (const source of LINK_COUNTS) (row[source.field] as number) = 0;
      out.set(row.item_id, row);
    }

    for (const source of LINK_COUNTS) {
      const counted = db.prepare(`
        SELECT ${source.column} AS item_id, COUNT(*) AS n FROM ${source.table}
        WHERE ${source.extra ? `${source.extra} AND ` : ""}${source.column} IN (${list})
        GROUP BY ${source.column}
      `).all(...chunk) as { item_id: string; n: number }[];
      for (const hit of counted) {
        const row = out.get(hit.item_id);
        if (row) (row[source.field] as number) = hit.n;
      }
    }
  }
  return out;
}

// Filename shapes a file manager or download produces for a second copy. Deliberately
// narrow: a trailing "-1"/"_1" is NOT included, because IMG_1234.jpg would match it.
// ── Folder preferences ──────────────────────────────────────────────────────
//
// Two standing instructions the admin can attach to a folder:
//
//   "keep"   when copies of a photo are in more than one place, keep the one here.
//   "clear"  keep the copies elsewhere and let this folder's go — the way you retire
//            a folder whose contents have already been filed properly somewhere else.
//
// Both outrank every heuristic below, because they are instructions rather than
// guesses, and neither costs anything: whatever a losing copy carries is merged onto
// the keeper before it goes.
//
// "clear" can never empty a folder on its own. A photo with no copy outside it is
// nobody's duplicate, so it is never in a set at all; and a set every one of whose
// copies is inside cleared folders has no preferred survivor, falls through to the
// ordinary criteria, and still keeps one. Retiring a folder means "these photos are
// safe elsewhere", not "delete these photos".
export type FolderPreferenceMode = "keep" | "clear";

export interface FolderPreference {
  libraryId: string;
  /** Relative to the library root. "" means the whole library. */
  folderPath: string;
  mode: FolderPreferenceMode;
}

export function preferenceFor(
  folders: FolderPreference[],
  libraryId: string,
  /** A file's path, or a folder's — both answer the same question. */
  path: string
): FolderPreferenceMode | null {
  let best: FolderPreference | null = null;
  for (const folder of folders) {
    if (folder.libraryId !== libraryId) continue;
    const covers = folder.folderPath === "" || path === folder.folderPath || path.startsWith(`${folder.folderPath}/`);
    if (!covers) continue;
    if (!best || folder.folderPath.length > best.folderPath.length) best = folder;
  }
  return best?.mode ?? null;
}

export const COPY_MARKERS = [/ \(\d+\)$/, /\bcopy\b/i, /^copy of /i, /[-_ ]duplicate$/i];

const baseNameOf = (relativePath: string): string =>
  (relativePath.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

// A name has to START one of these to count as an appended suffix, so "IMG_110" does
// not get read as the original of "IMG_1109" — that 9 is part of the frame number, not
// a counter somebody bolted on.
const APPENDED_SUFFIX = /^[-_ (]/;

/** Which copies in this set are named as copies OF another copy in it.
 *
 *  Relational on purpose, rather than another entry in COPY_MARKERS. The observed case
 *  is "Picture 071.jpg" beside "Picture 071-001.jpg", and no pattern reliably says
 *  which of those is the original: "-001" is a counter to scanner software and part of
 *  the name to anyone whose camera writes it. Set one name beside the other and it is
 *  obvious — one is the other with something stuck on the end — and it costs no
 *  guessing, catches every suffix convention at once, and cannot misfire on a lone file
 *  whose real name happens to look like a copy. */
function derivedCopyIds(rows: DetailRow[]): Set<string> {
  const stems = rows.map((row) => ({ id: row.item_id, stem: baseNameOf(row.relative_path) }));
  const derived = new Set<string>();
  for (const longer of stems) {
    for (const shorter of stems) {
      if (longer.id === shorter.id || longer.stem.length <= shorter.stem.length) continue;
      if (!longer.stem.startsWith(shorter.stem)) continue;
      if (!APPENDED_SUFFIX.test(longer.stem.slice(shorter.stem.length))) continue;
      derived.add(longer.id);
      break;
    }
  }
  return derived;
}

// Folders that hold received or derived copies rather than originals.
export const DERIVED_FOLDERS = /^(downloads?|whatsapp|telegram|viber|messenger|screenshots?|thumbnails?|cache|te?mp)\b|whatsapp|telegram/i;

/** Below this share of the set's best pixel count, a copy is a preview rather than a
 *  variant of it. A quarter of the pixels is half the width — well past anything a crop,
 *  a re-encode or a moderate downscale produces (4000×3000 beside 6000×4000 is half the
 *  pixels and still a photograph), and well above where thumbnails and index scans land:
 *  the Fuji index print below is an eighth. Deliberately generous to the small copy,
 *  because everything this criterion outranks is recoverable and a wrong call here is
 *  not. */
const PREVIEW_PIXEL_RATIO = 0.25;

/** Ids that are plainly a downscale of something else in the set.
 *
 *  Film scanners are the case that forced this: a Fuji Frontier writes FL000003.jpg at
 *  432×640 beside FH000003.jpg at 1215×1800, and it is the LOW-resolution index scan
 *  that carries the camera make and model. Judged on metadata the preview wins, and the
 *  set is resolved by deleting the only copy of the photo that has any detail in it.
 *
 *  Rows whose dimensions are unknown are never flagged: unknown is not small. */
function previewCopyIds(rows: DetailRow[]): Set<string> {
  const pixelsOf = (row: DetailRow) => (row.width ?? 0) * (row.height ?? 0);
  const best = Math.max(...rows.map(pixelsOf));
  if (best <= 0) return new Set();
  return new Set(rows.filter((row) => pixelsOf(row) > 0 && pixelsOf(row) < best * PREVIEW_PIXEL_RATIO).map((r) => r.item_id));
}

interface Scored extends DetailRow {
  linkCount: number;
  manualCount: number;
  exifCount: number;
  pixels: number;
  copyMarker: boolean;
  derivedFolder: boolean;
  /** A fraction of the best resolution in its set — a preview, not a candidate. */
  previewCopy: boolean;
  preference: FolderPreferenceMode | null;
  /** Its library forbids deleting — external, or deleting turned off. */
  protectedLibrary: boolean;
  /** A folder lock covers its path, so this copy can't be deleted. */
  lockedFolder: boolean;
}

// Which libraries refuse deletion, answered once and reused for every copy scored.
function protectedLibraries(): Set<string> {
  const rows = db.prepare("SELECT id FROM libraries WHERE type = 'gallery'").all() as { id: string }[];
  return new Set(rows.filter((row) => !libraryAllowsDelete(row.id)).map((row) => row.id));
}

function score(
  row: DetailRow,
  preferences: FolderPreference[] = [],
  protectedLibs: Set<string> = protectedLibraries(),
  locks: Map<string, string[]> = allFolderLocks(),
  /** Ids this set's own names give away as copies. Empty when a row is scored on its
   *  own — the read paths do that for display, and only read linkCount from it. */
  derived: Set<string> = new Set(),
  /** Ids the set's own resolutions give away as previews. Same story: empty when a row
   *  is scored alone, since "a fraction of the best" needs the rest of the set. */
  previews: Set<string> = new Set()
): Scored {
  const segments = row.relative_path.split("/");
  const baseName = baseNameOf(row.relative_path);
  return {
    ...row,
    preference: preferenceFor(preferences, row.library_id, row.relative_path),
    linkCount:
      row.face_count + row.album_count + row.slideshow_count + row.collection_count
      + row.tag_count + row.save_count + row.share_count + row.ft_person_count + row.ft_event_count,
    manualCount:
      (row.metadata_source === "manual" ? 1 : 0)
      + (row.taken_at_source === "manual" ? 1 : 0)
      + (row.gps_source === "manual" ? 1 : 0),
    exifCount:
      (row.taken_at && row.taken_at_source === "scan" ? 1 : 0)
      + (row.camera_make ? 1 : 0)
      + (row.camera_model ? 1 : 0),
    pixels: (row.width ?? 0) * (row.height ?? 0),
    copyMarker: derived.has(row.item_id) || COPY_MARKERS.some((re) => re.test(baseName)),
    derivedFolder: segments.slice(0, -1).some((seg) => DERIVED_FOLDERS.test(seg)),
    previewCopy: previews.has(row.item_id),
    protectedLibrary: protectedLibs.has(row.library_id),
    lockedFolder: lockCoveredIn(locks.get(row.library_id), row.relative_path)
  };
}

// Ordered, not weighted: the copies are compared criterion by criterion and the first
// difference decides. That keeps "which copy survives" explainable — the winning
// criterion IS the reason shown to the admin — and avoids the tuning problem a weighted
// sum creates. User work outranks everything, because it's the only thing that can't be
// recovered from the file itself.
// `decision` marks the criteria that are somebody's choice — a library made
// undeletable, a folder instruction, hand-filed work, hand-edited details — as opposed
// to properties read off the files. The confidence grading in job-scan.ts derives its
// evidence/guess boundary from these flags, so inserting a criterion here cannot
// silently shift what "chosen on evidence" means (it did once, when the preview rule
// landed above the boundary that was then a bare count).
const KEEPER_CRITERIA: { label: string; decision?: boolean; value: (row: Scored) => number }[] = [
  // Above even the explicit instructions, because this one is not a preference: a copy
  // in an external library CANNOT be deleted, so naming it the loser proposes an action
  // that will be refused. Where a photo sits in both an ordinary library and one the app
  // only reads, the readable one keeps its copy and the ordinary one gives its up — the
  // only outcome that is actually available.
  { label: "in a library its files can't be deleted from", decision: true, value: (r) => (r.protectedLibrary ? 1 : 0) },
  // The same fact one level down: a folder lock covers this copy, so naming it the
  // loser proposes an action trashBook will refuse. A lock is somebody's decision.
  { label: "in a locked folder", decision: true, value: (r) => (r.lockedFolder ? 1 : 0) },
  // Explicit instructions beat every guess below them, in both directions. Nothing is
  // lost by obeying them: the losing copies' tags and people are merged onto the
  // keeper either way. "Clearing out" ranks above hand-filed work for the same reason
  // — the work moves to the copy that survives.
  { label: "in a folder you chose to keep", decision: true, value: (r) => (r.preference === "keep" ? 1 : 0) },
  { label: "not in a folder you're clearing out", decision: true, value: (r) => (r.preference === "clear" ? 0 : 1) },
  // Above every guess below it, because it is the one difference nothing can undo. The
  // criteria that follow are all recoverable: tags, albums, people and hand-edited
  // details are merged onto the keeper, a copy marker and a folder name are inferences
  // about where a file came from, and camera info is metadata — donated below where the
  // keeper has none. Pixels are not recoverable from any other copy in the set, so a
  // preview must never win on metadata it happens to carry and the full-size copy
  // happens to lack. Explicit instructions still outrank it: an admin naming the folder
  // to keep is answering this question themselves.
  { label: "not a low-resolution copy", value: (r) => (r.previewCopy ? 0 : 1) },
  { label: "has tags, albums or people", decision: true, value: (r) => r.linkCount },
  { label: "has hand-edited details", decision: true, value: (r) => r.manualCount },
  { label: "not a copy", value: (r) => (r.copyMarker ? 0 : 1) },
  { label: "in an original folder", value: (r) => (r.derivedFolder ? 0 : 1) },
  { label: "has date and camera info", value: (r) => r.exifCount },
  { label: "highest resolution", value: (r) => r.pixels },
  { label: "largest file", value: (r) => r.size ?? 0 },
  {
    label: "added first",
    value: (r) => {
      const t = new Date(r.discovered_at).getTime();
      return Number.isFinite(t) ? -t : 0;
    }
  }
];

/** Whether the ladder rung a keeper choice was decided on is somebody's decision
 *  (true), or a property read off the files (false). Answered by the ladder itself, so
 *  it stays right when a criterion is added or moved. -1 — the tiebreak — is not a
 *  decision. */
export function keeperRankIsDecision(rank: number): boolean {
  return Boolean(KEEPER_CRITERIA[rank]?.decision);
}

function compareCandidates(a: Scored, b: Scored): number {
  for (const criterion of KEEPER_CRITERIA) {
    const diff = criterion.value(b) - criterion.value(a);
    if (diff !== 0) return diff; // descending — higher wins
  }
  return a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0;
}

export interface KeeperChoice {
  keeperId: string;
  reason: string | null;
  /** Where in KEEPER_CRITERIA the decision was actually made — 0 is the first and
   *  strongest, and -1 means nothing separated the copies and the stable tiebreak had
   *  to settle it.
   *
   *  Free, and worth having: because the ladder is ORDERED rather than weighted, the
   *  rank IS how confident the choice is. A keeper that won on "has tags, albums or
   *  people" was chosen on evidence a person created; one that fell through to "added
   *  first" won a coin toss, and a page that shows both the same way is overstating
   *  one of them. */
  rank: number;
}

// Pick the copy to keep, plus a short explanation naming the criteria on which it beat
// the runner-up. Identical copies (the normal case for byte-identical files with no
// links either side) fall through to the stable "added first" tiebreak.
export function pickKeeper(rows: DetailRow[], instructions?: FolderPreference[]): KeeperChoice | null {
  if (rows.length === 0) return null;
  // Read the preferences and the protected libraries once per set, not once per copy.
  // A cleanup job passes its OWN instructions here: they are seeded from the global
  // ones and diverge from then on, and a keeper picked under the wrong set is a
  // choice the page that set it would not recognise.
  const preferences = instructions ?? [];
  const protectedLibs = protectedLibraries();
  const locks = allFolderLocks();
  const derived = derivedCopyIds(rows);
  const previews = previewCopyIds(rows);
  const scored = rows.map((row) => score(row, preferences, protectedLibs, locks, derived, previews)).sort(compareCandidates);
  const winner = scored[0];
  const runnerUp = scored[1];
  if (!runnerUp) return { keeperId: winner.item_id, reason: null, rank: -1 };

  // Every copy is somewhere the admin asked to clear out. One is still kept — the
  // instruction says which copy survives, never whether one does — but keeping a copy
  // in a folder you told it to empty needs saying, or it reads as the setting being
  // ignored. It is usually a folder marked at the wrong level: mark the inner one.
  if (scored.every((row) => row.preference === "clear")) {
    return {
      keeperId: winner.item_id,
      reason: "every copy is in a folder you're clearing out, so one was kept anyway",
      // Decided by an explicit instruction, even though it reads as an apology.
      rank: KEEPER_CRITERIA.findIndex((c) => c.label.includes("clearing out"))
    };
  }

  const decided = KEEPER_CRITERIA.findIndex((c) => c.value(winner) > c.value(runnerUp));
  const reasons = KEEPER_CRITERIA
    .filter((c) => c.value(winner) > c.value(runnerUp))
    .map((c) => c.label)
    .slice(0, 2);
  return {
    keeperId: winner.item_id,
    reason: reasons.length > 0 ? reasons.join(", ") : "identical in every way — kept the one added first",
    rank: decided
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Grouping
// ────────────────────────────────────────────────────────────────────────────

function ignoredPairs(): Set<string> {
  const rows = db.prepare("SELECT item_a, item_b FROM gallery_duplicate_ignores").all() as { item_a: string; item_b: string }[];
  return new Set(rows.map((r) => `${r.item_a}|${r.item_b}`));
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ── Perceptual fingerprints (tier 2) ────────────────────────────────────────
//
// similarity.ts already has hex-dHash helpers, but its popcount walks bits on a BigInt.
// That is fine for the few hundred items the memory picker compares and far too slow for
// the millions of comparisons banding produces, so parse once into two 32-bit halves and
// use the SWAR popcount. similarity.ts is left alone — Memories depends on it.
interface Fingerprint { hi: number; lo: number }

function parseFingerprint(hex: string | null): Fingerprint | null {
  if (!hex || !/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
  const padded = hex.padStart(16, "0");
  const hi = Number.parseInt(padded.slice(0, 8), 16);
  const lo = Number.parseInt(padded.slice(8), 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

// Same picture, different file: a resized, re-compressed or re-exported copy. In
// practice those land 0–3 bits from the original.
//
// This is NOT similarity.ts's NEAR_DUPLICATE_DISTANCE (10/64). That one deliberately
// folds a whole burst into one representative for Memories — a different question, and
// far too loose to propose deleting anything.
export const NEAR_IDENTICAL_DISTANCE = 3;

// The 64-bit hash is split into 4 x 16-bit bands. Any two hashes differing by at most
// BAND_COUNT - 1 bits must, by pigeonhole, leave at least one band untouched — so
// comparing only within band buckets misses NOTHING at distance 3. Raising
// NEAR_IDENTICAL_DISTANCE without raising BAND_COUNT would silently start missing pairs.
const BAND_COUNT = 4;

/** Hamming distance between two fingerprints — how many of the 64 bits differ. */
function fingerprintDistance(a: Fingerprint, b: Fingerprint): number {
  return popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo);
}

function bandsOf(print: Fingerprint): number[] {
  return [print.hi >>> 16, print.hi & 0xffff, print.lo >>> 16, print.lo & 0xffff];
}

function withinNearDistance(a: string | null, b: string | null): boolean {
  const fa = parseFingerprint(a);
  const fb = parseFingerprint(b);
  if (!fa || !fb) return false;
  return fingerprintDistance(fa, fb) <= NEAR_IDENTICAL_DISTANCE;
}

// Components over an explicit edge list (tier 2 links specific pairs, rather than tier
// 1's "everything sharing a digest").
function componentsFromEdges(edges: [string, string][]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) { const next = parent.get(id)!; parent.set(id, root); id = next; }
    return root;
  };
  for (const [a, b] of edges) {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<string, string[]>();
  for (const id of [...parent.keys()]) {
    const root = find(id);
    const bucket = groups.get(root);
    if (bucket) bucket.push(id); else groups.set(root, [id]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

// Split a candidate set into components over the pairs that are NOT dismissed. For an
// exact group every pair matches, so one dismissal only breaks the set apart when it
// disconnects it — dismissing A/B in {A,B,C} still leaves all three linked through C,
// which is correct: they really are the same bytes.
export function connectedComponents(ids: string[], ignored: Set<string>): string[][] {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== root) { const next = parent.get(id)!; parent.set(id, root); id = next; }
    return root;
  };
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (ignored.has(pairKey(ids[i], ids[j]))) continue;
      const [ra, rb] = [find(ids[i]), find(ids[j])];
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const bucket = groups.get(root);
    if (bucket) bucket.push(id); else groups.set(root, [id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export interface NearGrouping {
  /** Sets of two or more ids that are all within the near distance of each other. */
  components: string[][];
  /** Bits between two of the fingerprints; 0 when either could not be parsed. */
  distance: (a: string, b: string) => number;
}

/** Group ids whose 64-bit fingerprints sit within NEAR_IDENTICAL_DISTANCE of each other.
 *
 *  Shared by the cache tier below and the cleanup job's snapshot, so there is exactly
 *  one banding implementation to keep in step with the threshold. That matters more than
 *  usual here: the bucketing is only lossless because 4 bands of 16 bits mean any pair
 *  within 3 bits must leave one band untouched, and a second copy of this loop would be
 *  a second place for that invariant to be broken quietly.
 *
 *  Rows with no fingerprint — every video, and photos the scan has not backfilled — are
 *  simply absent from the result rather than grouped on a guess. */
export function groupNearIdentical(
  rows: { itemId: string; phash: string | null }[],
  ignored: Set<string> = new Set(),
  /** A last say on whether a matching pair may actually be linked. The fingerprint
   *  says two pictures LOOK alike; a caller with more context — dimensions, when each
   *  was taken — can use this to refuse a pair it can tell apart. Defaults to
   *  accepting everything, which is what the cache tier wants. */
  linkable: (a: string, b: string) => boolean = () => true
): NearGrouping {
  const prints = new Map<string, Fingerprint>();
  for (const row of rows) {
    const print = parseFingerprint(row.phash);
    if (print) prints.set(row.itemId, print);
  }

  // Bucket by (band index, band value); only items sharing a bucket are ever compared.
  const buckets = new Map<string, string[]>();
  for (const [id, print] of prints) {
    bandsOf(print).forEach((band, index) => {
      const key = `${index}:${band}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(id); else buckets.set(key, [id]);
    });
  }

  const edges: [string, string][] = [];
  const compared = new Set<string>(); // a pair can share several bands
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const key = pairKey(bucket[i], bucket[j]);
        if (compared.has(key)) continue;
        compared.add(key);
        if (ignored.has(key)) continue;
        if (fingerprintDistance(prints.get(bucket[i])!, prints.get(bucket[j])!) > NEAR_IDENTICAL_DISTANCE) continue;
        if (!linkable(bucket[i], bucket[j])) continue;
        edges.push([bucket[i], bucket[j]]);
      }
    }
  }

  return {
    components: componentsFromEdges(edges),
    distance: (a, b) => {
      const fa = prints.get(a);
      const fb = prints.get(b);
      return fa && fb ? fingerprintDistance(fa, fb) : 0;
    }
  };
}

/** "These two are not duplicates", as pairs. Exported so the cleanup job's snapshot
 *  honours the same standing decisions this module's tiers do. */
export const duplicateIgnorePairs = (): Set<string> => ignoredPairs();

// ────────────────────────────────────────────────────────────────────────────
//  Reading groups
// ────────────────────────────────────────────────────────────────────────────

// ── Searching and paging the sets ───────────────────────────────────────────
//
// The page used to receive every set it had found and do the filtering, sorting and
// paging itself. On a library with thousands of duplicates that is a response
// describing tens of thousands of photos, rebuilt on every load and every three
// seconds during a scan, to show twenty-five of them.
//
// The work splits in two. Deciding WHICH sets match and in what order needs only a
// handful of cheap columns per copy — path, title, library, kind, size, keeper. What
// a card actually renders — covers, dimensions, EXIF, the nine link counts — is
// needed for one page. So the lean pass runs over everything and the expensive one
// runs over twenty-five.
//
// The filtering and scoping below is a straight port of what the page did, kept
// deliberately as the same shape of code rather than rewritten into SQL: this is what
// decides which sets a bulk delete touches, and a clever rewrite that drifts by one
// set is a photo nobody meant to delete.

// ────────────────────────────────────────────────────────────────────────────
//  Admin actions
// ────────────────────────────────────────────────────────────────────────────

const inList = (ids: string[]): string => ids.map(() => "?").join(",");

// Which of the losers' face rows should move to the keeper. Identical copies were each
// face-scanned independently, so moving every row would leave the keeper with the same
// face two or three times over — visible as repeated entries on a People page.
//
//  - keeper has no faces yet → take the richest single donor's rows wholesale, so the
//    keeper ends up exactly as one scanned copy was.
//  - keeper already has faces → take only rows naming a person the keeper doesn't
//    already have, one row per person. Everything else is a redundant detection and is
//    left to cascade away with the copy.
function pickFaceRowsToMove(keeperId: string, loserIds: string[]): string[] {
  const rows = db.prepare(
    `SELECT id, item_id, person_id FROM gallery_faces WHERE item_id IN (${inList(loserIds)}) ORDER BY item_id, id`
  ).all(...loserIds) as { id: string; item_id: string; person_id: string | null }[];
  if (rows.length === 0) return [];

  const keeperFaces = db.prepare(
    "SELECT person_id FROM gallery_faces WHERE item_id = ?"
  ).all(keeperId) as { person_id: string | null }[];

  if (keeperFaces.length === 0) {
    const byItem = new Map<string, string[]>();
    for (const row of rows) {
      const bucket = byItem.get(row.item_id);
      if (bucket) bucket.push(row.id); else byItem.set(row.item_id, [row.id]);
    }
    return [...byItem.values()].reduce((best, ids) => (ids.length > best.length ? ids : best), [] as string[]);
  }

  const seen = new Set(keeperFaces.map((f) => f.person_id).filter((id): id is string => Boolean(id)));
  const move: string[] = [];
  for (const row of rows) {
    if (!row.person_id || seen.has(row.person_id)) continue;
    seen.add(row.person_id);
    move.push(row.id);
  }
  return move;
}

// Move everything the losing copies carry onto the copy being kept, BEFORE they are
// trashed (trashing hard-deletes the row and cascades these links away). Only ever
// additive: a value already on the keeper is never overwritten.
//
// Face rows move too (see pickFaceRowsToMove), which is safe here precisely because
// tier 1 groups are byte-identical — the normalised boxes describe the same pixels
// either way. Their crop files stay where they are and remain referenced by the moved
// row; because the row is no longer attached to the loser, trashBook's face-crop cleanup
// correctly leaves them alone. (This does NOT generalise to the near-identical tier,
// where a resized copy's boxes would not transfer.)
export function absorbDuplicateMetadata(
  keeperId: string,
  loserIds: string[],
  // Only ever true for tier 1. A near-identical copy is a DIFFERENT image — resized or
  // re-cropped — so its normalised face boxes describe the wrong pixels on the keeper.
  options: { moveFaces?: boolean } = {}
): void {
  if (loserIds.length === 0) return;
  const { moveFaces = true } = options;
  const losers = inList(loserIds);
  const args = [keeperId, ...loserIds];

  const affectedPeople = (db.prepare(
    `SELECT DISTINCT person_id FROM gallery_faces
     WHERE person_id IS NOT NULL AND item_id IN (${losers}, ?)`
  ).all(...loserIds, keeperId) as { person_id: string }[]).map((r) => r.person_id);
  const faceIdsToMove = moveFaces ? pickFaceRowsToMove(keeperId, loserIds) : [];

  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO taggables (tag_id, entity_type, entity_id)
       SELECT tag_id, 'library_item', ? FROM taggables
       WHERE entity_type = 'library_item' AND entity_id IN (${losers})`
    ).run(...args);

    db.prepare(
      `INSERT OR IGNORE INTO gallery_album_items (album_id, item_id, position)
       SELECT album_id, ?, position FROM gallery_album_items WHERE item_id IN (${losers})`
    ).run(...args);

    db.prepare(
      `INSERT OR IGNORE INTO gallery_slideshow_items (slideshow_id, item_id, position, dwell_seconds)
       SELECT slideshow_id, ?, position, dwell_seconds FROM gallery_slideshow_items WHERE item_id IN (${losers})`
    ).run(...args);

    db.prepare(
      `INSERT OR IGNORE INTO family_tree_photos (person_id, item_id, position, added_by)
       SELECT person_id, ?, position, added_by FROM family_tree_photos WHERE item_id IN (${losers})`
    ).run(...args);

    db.prepare(
      `INSERT OR IGNORE INTO family_tree_event_photos (event_id, item_id, position, added_by)
       SELECT event_id, ?, position, added_by FROM family_tree_event_photos WHERE item_id IN (${losers})`
    ).run(...args);

    // Tables with their own id column need a fresh id per row, so they're copied in JS.
    const collections = db.prepare(
      `SELECT collection_id, position FROM collection_items
       WHERE entity_type = 'library_item' AND entity_id IN (${losers})`
    ).all(...loserIds) as { collection_id: string; position: number }[];
    const insertCollection = db.prepare(
      "INSERT OR IGNORE INTO collection_items (id, collection_id, entity_type, entity_id, position) VALUES (?, ?, 'library_item', ?, ?)"
    );
    for (const row of collections) insertCollection.run(nanoid(16), row.collection_id, keeperId, row.position);

    const saves = db.prepare(
      `SELECT user_id, note FROM item_saves WHERE item_id IN (${losers})`
    ).all(...loserIds) as { user_id: string; note: string | null }[];
    const insertSave = db.prepare("INSERT OR IGNORE INTO item_saves (id, user_id, item_id, note) VALUES (?, ?, ?, ?)");
    for (const row of saves) insertSave.run(nanoid(16), row.user_id, keeperId, row.note);

    const shares = db.prepare(
      `SELECT user_id, permission, created_by, expires_at FROM shares
       WHERE module = 'gallery' AND revoked_at IS NULL AND resource_id IN (${losers})`
    ).all(...loserIds) as { user_id: string; permission: string; created_by: string; expires_at: string | null }[];
    const insertShare = db.prepare(
      "INSERT OR IGNORE INTO shares (id, module, resource_id, user_id, permission, created_by, expires_at) VALUES (?, 'gallery', ?, ?, ?, ?, ?)"
    );
    for (const row of shares) insertShare.run(nanoid(16), keeperId, row.user_id, row.permission, row.created_by, row.expires_at);

    for (let i = 0; i < faceIdsToMove.length; i += ID_CHUNK) {
      const chunk = faceIdsToMove.slice(i, i + ID_CHUNK);
      db.prepare(`UPDATE gallery_faces SET item_id = ? WHERE id IN (${inList(chunk)})`).run(keeperId, ...chunk);
    }

    // An album whose cover was a losing copy would otherwise be left coverless by the
    // ON DELETE SET NULL.
    db.prepare(`UPDATE gallery_albums SET cover_item_id = ? WHERE cover_item_id IN (${losers})`).run(...args);

    // Hand-edited values, taken from the best-scoring loser that has them and only
    // where the keeper has none of its own.
    const keeperMeta = db.prepare(
      "SELECT source, title, sort_title, description FROM item_metadata WHERE item_id = ?"
    ).get(keeperId) as { source: string; title: string | null; sort_title: string | null; description: string | null } | undefined;
    if (keeperMeta?.source !== "manual") {
      const donor = db.prepare(
        `SELECT title, sort_title, description FROM item_metadata
         WHERE source = 'manual' AND item_id IN (${losers}) LIMIT 1`
      ).get(...loserIds) as { title: string | null; sort_title: string | null; description: string | null } | undefined;
      if (donor) {
        db.prepare(`
          INSERT INTO item_metadata (item_id, source, title, sort_title, description)
          VALUES (?, 'manual', ?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET
            source = 'manual', title = excluded.title,
            sort_title = excluded.sort_title, description = excluded.description,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        `).run(keeperId, donor.title, donor.sort_title, donor.description);
        applyItemAlphaIndex(keeperId);
      }
    }

    const keeperDetails = db.prepare(
      "SELECT taken_at_source, gps_source FROM gallery_details WHERE item_id = ?"
    ).get(keeperId) as { taken_at_source: string; gps_source: string } | undefined;

    if (keeperDetails && keeperDetails.taken_at_source !== "manual") {
      const donor = db.prepare(
        `SELECT taken_at FROM gallery_details WHERE taken_at_source = 'manual' AND item_id IN (${losers}) LIMIT 1`
      ).get(...loserIds) as { taken_at: string | null } | undefined;
      if (donor) {
        db.prepare("UPDATE gallery_details SET taken_at = ?, taken_at_source = 'manual' WHERE item_id = ?")
          .run(donor.taken_at, keeperId);
      }
    }

    // Scanned camera info, where the keeper has none. A film scanner writes the make and
    // model onto its low-resolution index scan and not onto the full-size one, so the
    // copy worth keeping is routinely the copy without them — and losing the camera with
    // the preview would be a real, if small, loss for nothing.
    const keeperCamera = db.prepare(
      "SELECT camera_make, camera_model, taken_at FROM gallery_details WHERE item_id = ?"
    ).get(keeperId) as { camera_make: string | null; camera_model: string | null; taken_at: string | null } | undefined;
    if (keeperCamera && !keeperCamera.camera_make && !keeperCamera.camera_model) {
      const donor = db.prepare(
        `SELECT camera_make, camera_model FROM gallery_details
         WHERE item_id IN (${losers}) AND (camera_make IS NOT NULL OR camera_model IS NOT NULL) LIMIT 1`
      ).get(...loserIds) as { camera_make: string | null; camera_model: string | null } | undefined;
      if (donor) {
        db.prepare("UPDATE gallery_details SET camera_make = ?, camera_model = ? WHERE item_id = ?")
          .run(donor.camera_make, donor.camera_model, keeperId);
      }
    }
    // Likewise a taken-at the keeper simply doesn't have. Only when it has none: a
    // scanned date it does have is its own, and 'manual' is handled above.
    if (keeperCamera && !keeperCamera.taken_at) {
      const donor = db.prepare(
        `SELECT taken_at FROM gallery_details WHERE item_id IN (${losers}) AND taken_at IS NOT NULL LIMIT 1`
      ).get(...loserIds) as { taken_at: string | null } | undefined;
      if (donor) {
        db.prepare("UPDATE gallery_details SET taken_at = ? WHERE item_id = ?").run(donor.taken_at, keeperId);
      }
    }

    if (keeperDetails && keeperDetails.gps_source !== "manual") {
      const donor = db.prepare(
        `SELECT gps_lat, gps_lng FROM gallery_details WHERE gps_source = 'manual' AND item_id IN (${losers}) LIMIT 1`
      ).get(...loserIds) as { gps_lat: number | null; gps_lng: number | null } | undefined;
      if (donor) {
        db.prepare("UPDATE gallery_details SET gps_lat = ?, gps_lng = ?, gps_source = 'manual' WHERE item_id = ?")
          .run(donor.gps_lat, donor.gps_lng, keeperId);
      }
    }
  })();

  // Two items collapsing into one changes each person's distinct-item tally.
  for (const personId of affectedPeople) recomputeFaceCount(personId);
}

// ────────────────────────────────────────────────────────────────────────────
//  Background job
// ────────────────────────────────────────────────────────────────────────────

interface DuplicateScanPayload {
  /** One library, or null for every one. Written by the older pages and the scheduled job. */
  libraryId?: string | null;
  /** Several libraries — what a cleanup job asks for. Wins over `libraryId` when present. */
  libraryIds?: string[] | null;
  /** Set when this scan exists to feed ONE cleanup job. The hashing pass is then
   *  followed by that job's own snapshot instead of the install-wide cache rebuild:
   *  the scan was asked for by one cleanup, over that cleanup's libraries, so
   *  rebuilding the shared cache here would be global work for a scoped request. The
   *  older pages keep their own Scan and Rebuild buttons for that. */
  cleanupJobId?: string | null;
}

const insertScanJob = (payload: DuplicateScanPayload): void => {
  db.prepare("INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 2)")
    .run(nanoid(16), DUPLICATE_SCAN_JOB_TYPE, JSON.stringify(payload));
};

function pendingScanPayloads(): DuplicateScanPayload[] {
  const rows = db.prepare(
    "SELECT payload FROM jobs WHERE type = ? AND status IN ('pending', 'running')"
  ).all(DUPLICATE_SCAN_JOB_TYPE) as { payload: string }[];
  return rows.flatMap((row) => {
    try { return [JSON.parse(row.payload) as DuplicateScanPayload]; } catch { return []; }
  });
}

// Queue the fingerprint pass a cleanup job needs before it can snapshot anything.
//
// Refuses only a scan for THIS cleanup — pressing Run scan twice should not queue the
// same work twice — and never because some other scan is in flight: that would leave
// this cleanup with no scan at all, and the pass already running may well cover
// different libraries. The worker takes one job at a time, so a second entry simply
// runs after the first.
export function enqueueJobScan(cleanupJobId: string, libraryIds: string[]): boolean {
  if (pendingScanPayloads().some((payload) => payload.cleanupJobId === cleanupJobId)) return false;
  insertScanJob({ libraryIds, cleanupJobId });
  return true;
}

// ── Phase 2, when the scan belongs to a cleanup job ─────────────────────────

/** Mark a cleanup as stopped, when the pass it was waiting on can no longer deliver.
 *  Guarded on 'scanning' so it can't overwrite a verdict something else already
 *  reached — runJobScan sets 'failed' itself when the snapshot throws. */
function failCleanupJob(cleanupJobId: string | null, message: string): void {
  if (!cleanupJobId) return;
  const cleanup = getJob(cleanupJobId);
  if (!cleanup || cleanup.status !== "scanning") return;
  setJobStatus(cleanupJobId, cleanup.ownerUserId, "failed", message);
}

/** Take the cleanup's snapshot now the digests are in place. Never throws: the hashing
 *  pass succeeded and that work is worth recording whatever happens here, so a refusal
 *  is reported on the CLEANUP rather than by failing the queue entry. */
function runCleanupSnapshot(cleanupJobId: string | null): Record<string, unknown> {
  const cleanup = cleanupJobId ? getJob(cleanupJobId) : null;
  // Deleted or cancelled while its scan sat in the queue. The digests are still worth
  // having, so this is not an error — there is simply nothing left to snapshot.
  if (!cleanup || !cleanupJobId) return { cleanupJobId, skipped: "the cleanup was gone by the time its scan finished" };

  const outcome = runJobScan(cleanupJobId, cleanup.ownerUserId);
  if (outcome.ok) return { cleanupJobId, ...outcome.summary };
  failCleanupJob(cleanupJobId, outcome.detail ?? outcome.refused);
  return { cleanupJobId, refused: outcome.refused };
}

function writeResult(jobId: string, result: Record<string, unknown>): void {
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string } | undefined;
  let payload: Record<string, unknown> = {};
  try { payload = row ? JSON.parse(row.payload) : {}; } catch { /* start fresh on a bad payload */ }
  db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(JSON.stringify({ ...payload, result }), jobId);
}

let queueRunning = false;

export async function processDuplicateScanQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // A scan interrupted by a restart: re-queue it (it recomputes from scratch) —
    // bounded by its attempts, so a scan that keeps killing the process stops.
    requeueInterruptedJobs(DUPLICATE_SCAN_JOB_TYPE);

    for (;;) {
      // Yield to catalog/face scans — this is background housekeeping.
      if (libraryJobRunning()) break;

      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(run_at) ASC LIMIT 1
      `).get(DUPLICATE_SCAN_JOB_TYPE) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1,
          locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      let payload: DuplicateScanPayload = {};
      try { payload = JSON.parse(job.payload) as DuplicateScanPayload; } catch { /* scan everything */ }
      const scope: LibraryScope = payload.libraryIds ?? null;
      // Null only for a queue row written by a version that still had install-wide
      // scans; runCleanupSnapshot answers that with "nothing to snapshot".
      const cleanupJobId = payload.cleanupJobId ?? null;

      const writeProgress = jobProgressWriter(job.id, { libraryId: null });
      // A cleanup job shows this as a progress bar on its card, so it needs the percentage
      // on duplicate_jobs too — but only when the rounded value actually moves. Writing per
      // file would be one UPDATE per candidate, and a big library has hundreds of thousands.
      let lastPercent = -1;
      const onProgress = cleanupJobId
        ? (processed: number, total: number) => {
          writeProgress(processed, total);
          const percent = total === 0 ? 100 : Math.round((processed / total) * 100);
          if (percent !== lastPercent) { lastPercent = percent; setJobScanProgress(cleanupJobId, percent); }
        }
        : writeProgress;

      try {
        const pass = await hashDuplicateCandidates(onProgress, scope);
        // Every pass belongs to a cleanup. There used to be a second branch here that
        // rebuilt the install-wide cache the older pages read; both are gone.
        writeResult(job.id, { ...pass, ...runCleanupSnapshot(cleanupJobId) });
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?")
          .run(job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "The duplicate scan failed.";
        const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number };
        if (attempts.attempts < attempts.max_attempts) {
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(new Date(Date.now() + 5000).toISOString(), message, job.id);
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(message, job.id);
          // Out of retries. Say so on the cleanup, or it sits in 'scanning' for ever
          // waiting on a pass that is never going to run.
          failCleanupJob(cleanupJobId, message);
        }
      }
    }
  } finally {
    queueRunning = false;
  }
}

export function startDuplicateScanWorker(): () => void {
  const timer = setInterval(() => { void processDuplicateScanQueue().catch(() => { /* logged per-job */ }); }, 2000);
  return () => clearInterval(timer);
}
