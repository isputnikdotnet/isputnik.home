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
import { db, logActivity } from "../../../db.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { pathIsInside } from "../shared/storage-roots.js";
import { libraryJobRunning } from "../shared/scan-lock.js";
import { jobProgressWriter } from "../shared/job-progress.js";
import { trashBook } from "../shared/trash.js";
import { recomputeFaceCount } from "./people.js";

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

// `libraryId` narrows which assets a scan READS from disk — the expensive part, and the
// only reason to scope a scan at all. Grouping is never narrowed (see
// rebuildExactDuplicateGroups), so a digest computed for one library still matches
// against every other library's.
export function duplicateCandidateCount(libraryId?: string | null): number {
  const scope = libraryId ? " AND li.library_id = ?" : "";
  const params = libraryId ? [libraryId] : [];
  return (db.prepare(`SELECT COUNT(*) AS n ${CANDIDATE_SQL}${scope}`).get(...params) as { n: number }).n;
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
export function duplicatePendingCount(libraryId?: string | null): number {
  const scope = libraryId ? " AND li.library_id = ?" : "";
  const params = libraryId ? [libraryId] : [];
  return (db.prepare(`SELECT COUNT(*) AS n ${CANDIDATE_SQL} ${NEEDS_READING_SQL}${scope}`)
    .get(...params) as { n: number }).n;
}

export interface DuplicateLibraryOption {
  id: string;
  name: string;
  /** Photos sharing a byte size with another photo — everything worth checking. */
  candidateCount: number;
  /** Of those, how many a scan would have to read from disk right now. */
  pendingCount: number;
}

// Every gallery library with both counts, so the picker can show the cost of choosing
// it ("4 to check") or that there's nothing to do ("up to date").
export function duplicateLibraryOptions(): DuplicateLibraryOption[] {
  const perLibrary = `
       FROM gallery_details gd
       JOIN library_items li ON li.id = gd.item_id AND li.deleted_at IS NULL AND li.status = 'ready'
       WHERE li.library_id = lib.id
         AND gd.size IS NOT NULL AND gd.size > 0
         AND gd.size IN (${COLLIDING_SIZES_SQL})
  `;
  return db.prepare(`
    SELECT lib.id, lib.name,
      (SELECT COUNT(*) ${perLibrary}) AS candidateCount,
      (SELECT COUNT(*) ${perLibrary} ${NEEDS_READING_SQL}) AS pendingCount
    FROM libraries lib
    WHERE lib.type = 'gallery'
    ORDER BY lib.name COLLATE NOCASE, lib.id
  `).all() as DuplicateLibraryOption[];
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
function scanCandidates(libraryId?: string | null): CandidateRow[] {
  const scope = libraryId ? " AND li.library_id = ?" : "";
  const params = libraryId ? [libraryId] : [];
  return db.prepare(`
    SELECT gd.item_id, li.library_id, lib.source_path, gd.relative_path,
           gd.size, gd.content_hash, gd.content_hash_at
    ${CANDIDATE_SQL}${scope}
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
  libraryId?: string | null
): Promise<HashPassResult> {
  const rows = scanCandidates(libraryId);
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

interface DetailRow {
  item_id: string;
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
  gd.item_id, li.library_id, lib.name AS library_name, gd.relative_path, li.discovered_at,
  gd.size, gd.width, gd.height, gd.taken_at, gd.taken_at_source, gd.gps_source,
  gd.camera_make, gd.camera_model, gd.content_hash,
  im.title, im.source AS metadata_source, im.cover_storage_key, gd.preview_storage_key,
  (SELECT COUNT(*) FROM gallery_faces f WHERE f.item_id = gd.item_id AND f.assignment != 'rejected') AS face_count,
  (SELECT COUNT(*) FROM gallery_album_items a WHERE a.item_id = gd.item_id) AS album_count,
  (SELECT COUNT(*) FROM gallery_slideshow_items s WHERE s.item_id = gd.item_id) AS slideshow_count,
  (SELECT COUNT(*) FROM collection_items c WHERE c.entity_type = 'library_item' AND c.entity_id = gd.item_id) AS collection_count,
  (SELECT COUNT(*) FROM taggables t WHERE t.entity_type = 'library_item' AND t.entity_id = gd.item_id) AS tag_count,
  (SELECT COUNT(*) FROM item_saves sv WHERE sv.item_id = gd.item_id) AS save_count,
  (SELECT COUNT(*) FROM shares sh WHERE sh.module = 'gallery' AND sh.resource_id = gd.item_id AND sh.revoked_at IS NULL) AS share_count,
  (SELECT COUNT(*) FROM family_tree_photos fp WHERE fp.item_id = gd.item_id) AS ft_person_count,
  (SELECT COUNT(*) FROM family_tree_event_photos fe WHERE fe.item_id = gd.item_id) AS ft_event_count
`;

function loadDetails(itemIds: string[]): Map<string, DetailRow> {
  const out = new Map<string, DetailRow>();
  for (let i = 0; i < itemIds.length; i += ID_CHUNK) {
    const chunk = itemIds.slice(i, i + ID_CHUNK);
    const rows = db.prepare(`
      SELECT ${DETAIL_COLUMNS}
      FROM gallery_details gd
      JOIN library_items li ON li.id = gd.item_id
      JOIN libraries lib ON lib.id = li.library_id
      LEFT JOIN item_metadata im ON im.item_id = gd.item_id
      WHERE gd.item_id IN (${chunk.map(() => "?").join(",")})
    `).all(...chunk) as DetailRow[];
    for (const row of rows) out.set(row.item_id, row);
  }
  return out;
}

// Filename shapes a file manager or download produces for a second copy. Deliberately
// narrow: a trailing "-1"/"_1" is NOT included, because IMG_1234.jpg would match it.
const COPY_MARKERS = [/ \(\d+\)$/, /\bcopy\b/i, /^copy of /i, /[-_ ]duplicate$/i];

// Folders that hold received or derived copies rather than originals.
const DERIVED_FOLDERS = /^(downloads?|whatsapp|telegram|viber|messenger|screenshots?|thumbnails?|cache|te?mp)\b|whatsapp|telegram/i;

interface Scored extends DetailRow {
  linkCount: number;
  manualCount: number;
  exifCount: number;
  pixels: number;
  copyMarker: boolean;
  derivedFolder: boolean;
}

function score(row: DetailRow): Scored {
  const segments = row.relative_path.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  const baseName = fileName.replace(/\.[^.]+$/, "");
  return {
    ...row,
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
    copyMarker: COPY_MARKERS.some((re) => re.test(baseName)),
    derivedFolder: segments.slice(0, -1).some((seg) => DERIVED_FOLDERS.test(seg))
  };
}

// Ordered, not weighted: the copies are compared criterion by criterion and the first
// difference decides. That keeps "which copy survives" explainable — the winning
// criterion IS the reason shown to the admin — and avoids the tuning problem a weighted
// sum creates. User work outranks everything, because it's the only thing that can't be
// recovered from the file itself.
const KEEPER_CRITERIA: { label: string; value: (row: Scored) => number }[] = [
  { label: "has tags, albums or people", value: (r) => r.linkCount },
  { label: "has hand-edited details", value: (r) => r.manualCount },
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
}

// Pick the copy to keep, plus a short explanation naming the criteria on which it beat
// the runner-up. Identical copies (the normal case for byte-identical files with no
// links either side) fall through to the stable "added first" tiebreak.
export function pickKeeper(rows: DetailRow[]): KeeperChoice | null {
  if (rows.length === 0) return null;
  const scored = rows.map(score).sort(compareCandidates);
  const winner = scored[0];
  const runnerUp = scored[1];
  if (!runnerUp) return { keeperId: winner.item_id, reason: null };

  const reasons = KEEPER_CRITERIA
    .filter((c) => c.value(winner) > c.value(runnerUp))
    .map((c) => c.label)
    .slice(0, 2);
  return {
    keeperId: winner.item_id,
    reason: reasons.length > 0 ? reasons.join(", ") : "identical in every way — kept the one added first"
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

export function fingerprintDistance(a: Fingerprint, b: Fingerprint): number {
  return popcount32((a.hi ^ b.hi) >>> 0) + popcount32((a.lo ^ b.lo) >>> 0);
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
function connectedComponents(ids: string[], ignored: Set<string>): string[][] {
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

export interface DuplicateScanSummary {
  hashed: number;
  stale: number;
  groups: number;
  extraCopies: number;
  reclaimableBytes: number;
}

const memberSignature = (ids: string[]): string => [...ids].sort().join(",");

export type GroupTotals = Omit<DuplicateScanSummary, "hashed" | "stale">;

// Hand-picked keepers from the previous rebuild, keyed on the member set they were
// chosen for: if the set changes, the choice was made about a different question.
function manualKeepersFor(kind: "exact" | "near"): Map<string, string> {
  const keepers = new Map<string, string>();
  const priorGroups = db.prepare(`
    SELECT g.id, g.keeper_item_id FROM gallery_duplicate_groups g
    WHERE g.kind = ? AND g.keeper_source = 'manual' AND g.keeper_item_id IS NOT NULL
  `).all(kind) as { id: string; keeper_item_id: string }[];
  const memberStmt = db.prepare("SELECT item_id FROM gallery_duplicate_members WHERE group_id = ?");
  for (const group of priorGroups) {
    const ids = (memberStmt.all(group.id) as { item_id: string }[]).map((r) => r.item_id);
    keepers.set(memberSignature(ids), group.keeper_item_id);
  }
  return keepers;
}

// Replace one tier's groups wholesale. Shared by both tiers so keeper choice, manual
// carry-over and the totals can't drift apart between them; only how the components are
// derived, and what "distance" means, differ.
function writeGroups(
  kind: "exact" | "near",
  components: string[][],
  distanceFor: (keeperId: string, memberId: string) => number
): GroupTotals {
  const manualKeepers = manualKeepersFor(kind);
  const details = loadDetails(components.flat());

  let groups = 0;
  let extraCopies = 0;
  let reclaimableBytes = 0;

  db.transaction(() => {
    db.prepare("DELETE FROM gallery_duplicate_groups WHERE kind = ?").run(kind);
    const insertGroup = db.prepare(
      "INSERT INTO gallery_duplicate_groups (id, kind, keeper_item_id, keeper_source, keeper_reason) VALUES (?, ?, ?, ?, ?)"
    );
    const insertMember = db.prepare(
      "INSERT INTO gallery_duplicate_members (group_id, item_id, distance) VALUES (?, ?, ?)"
    );

    for (const ids of components) {
      // An id with no detail row lost its item between grouping and writing; dropping it
      // here also keeps the member insert from violating its foreign key.
      const rows = ids.map((id) => details.get(id)).filter((r): r is DetailRow => Boolean(r));
      if (rows.length < 2) continue;
      const memberIds = rows.map((r) => r.item_id);

      const auto = pickKeeper(rows);
      if (!auto) continue;
      const manual = manualKeepers.get(memberSignature(memberIds));
      const keeperId = manual && memberIds.includes(manual) ? manual : auto.keeperId;
      const source = keeperId === manual ? "manual" : "auto";

      const groupId = nanoid(16);
      insertGroup.run(groupId, kind, keeperId, source, source === "manual" ? null : auto.reason);
      for (const id of memberIds) insertMember.run(groupId, id, distanceFor(keeperId, id));

      groups += 1;
      extraCopies += rows.length - 1;
      reclaimableBytes += rows.filter((r) => r.item_id !== keeperId).reduce((sum, r) => sum + (r.size ?? 0), 0);
    }
  })();

  return { groups, extraCopies, reclaimableBytes };
}

// Rebuild the 'exact' groups from the digests currently on disk. Pure DB work — no file
// access — so it is cheap to re-run and trivially testable.
export function rebuildExactDuplicateGroups(): GroupTotals {
  const hashGroups = db.prepare(`
    SELECT gd.content_hash AS hash, gd.item_id
    ${CANDIDATE_SQL}
      AND gd.content_hash IS NOT NULL
      AND gd.content_hash IN (
        SELECT gd3.content_hash
        FROM gallery_details gd3
        JOIN library_items li3 ON li3.id = gd3.item_id AND li3.deleted_at IS NULL AND li3.status = 'ready'
        WHERE gd3.content_hash IS NOT NULL
        GROUP BY gd3.content_hash
        HAVING COUNT(*) > 1
      )
    ORDER BY gd.content_hash, gd.item_id
  `).all() as { hash: string; item_id: string }[];

  const byHash = new Map<string, string[]>();
  for (const row of hashGroups) {
    const bucket = byHash.get(row.hash);
    if (bucket) bucket.push(row.item_id); else byHash.set(row.hash, [row.item_id]);
  }

  const ignored = ignoredPairs();
  const components = [...byHash.values()].flatMap((ids) => connectedComponents(ids, ignored));
  return writeGroups("exact", components, () => 0);
}

// Rebuild the 'near' groups: same picture, different file — a resized or re-compressed
// copy. Runs over the dHash the catalog scan already computed for every photo, so this
// costs no disk access at all.
//
// Must run AFTER rebuildExactDuplicateGroups: an identical set is already presented as
// one row, so only its keeper takes part here. Otherwise every byte-identical copy would
// reappear inside the near set sitting beside it.
export function rebuildNearDuplicateGroups(): GroupTotals {
  const suppressed = new Set(
    (db.prepare(`
      SELECT m.item_id FROM gallery_duplicate_members m
      JOIN gallery_duplicate_groups g ON g.id = m.group_id AND g.kind = 'exact'
      WHERE m.item_id IS NOT g.keeper_item_id
    `).all() as { item_id: string }[]).map((r) => r.item_id)
  );

  const rows = db.prepare(`
    SELECT gd.item_id, gd.phash
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id AND li.deleted_at IS NULL AND li.status = 'ready'
    JOIN libraries lib ON lib.id = li.library_id AND lib.type = 'gallery'
    WHERE gd.kind = 'photo' AND gd.phash IS NOT NULL
    ORDER BY gd.item_id
  `).all() as { item_id: string; phash: string }[];

  const prints = new Map<string, Fingerprint>();
  for (const row of rows) {
    if (suppressed.has(row.item_id)) continue;
    const print = parseFingerprint(row.phash);
    if (print) prints.set(row.item_id, print);
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

  const ignored = ignoredPairs();
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
        edges.push([bucket[i], bucket[j]]);
      }
    }
  }

  const components = componentsFromEdges(edges);
  return writeGroups("near", components, (keeperId, memberId) => {
    const keeper = prints.get(keeperId);
    const member = prints.get(memberId);
    return keeper && member ? fingerprintDistance(keeper, member) : 0;
  });
}

// Both tiers, in the order they depend on, plus the "last scanned" stamp.
export function rebuildDuplicateGroups(): GroupTotals {
  const exact = rebuildExactDuplicateGroups();
  const near = rebuildNearDuplicateGroups();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(LAST_SCAN_KEY);
  return {
    groups: exact.groups + near.groups,
    extraCopies: exact.extraCopies + near.extraCopies,
    reclaimableBytes: exact.reclaimableBytes + near.reclaimableBytes
  };
}

// `libraryId` limits the disk reads to one library. Grouping still runs over every
// digest in the database afterwards, so a scoped scan can still surface a set whose
// other copies live elsewhere — as long as those were hashed by an earlier scan.
export async function runDuplicateScan(
  onProgress?: (processed: number, total: number) => void,
  libraryId?: string | null
): Promise<DuplicateScanSummary> {
  const pass = await hashDuplicateCandidates(onProgress, libraryId);
  return { ...pass, ...rebuildDuplicateGroups() };
}

export function lastDuplicateScanAt(): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(LAST_SCAN_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

// Files the last scan found changed on disk but not yet re-catalogued. Read back off
// the job record rather than stored separately — it's a transient observation about the
// last run, and it correctly disappears once job history is cleaned up.
function lastScanStaleCount(): number {
  const row = db.prepare(`
    SELECT payload FROM jobs
    WHERE type = ? AND status = 'completed'
    ORDER BY datetime(completed_at) DESC LIMIT 1
  `).get(DUPLICATE_SCAN_JOB_TYPE) as { payload: string } | undefined;
  if (!row) return 0;
  try {
    const stale = (JSON.parse(row.payload) as { result?: { stale?: number } }).result?.stale;
    return typeof stale === "number" ? stale : 0;
  } catch {
    return 0;
  }
}

export interface DuplicateScanStatus {
  lastScanAt: string | null;
  candidateCount: number;
  pendingCount: number;
  staleCount: number;
  scanning: boolean;
  libraries: DuplicateLibraryOption[];
}

// What the admin page needs above the results: when this last ran, how many assets a
// full run would have to read, whether one is in flight, and the per-library costs that
// drive the scope picker.
export function duplicateScanStatus(): DuplicateScanStatus {
  const inFlight = db.prepare(
    "SELECT 1 FROM jobs WHERE type = ? AND status IN ('pending', 'running')"
  ).get(DUPLICATE_SCAN_JOB_TYPE);
  return {
    lastScanAt: lastDuplicateScanAt(),
    candidateCount: duplicateCandidateCount(),
    pendingCount: duplicatePendingCount(),
    staleCount: lastScanStaleCount(),
    scanning: Boolean(inFlight),
    libraries: duplicateLibraryOptions()
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Reading groups
// ────────────────────────────────────────────────────────────────────────────

export interface DuplicateMember {
  itemId: string;
  libraryId: string;
  libraryName: string;
  path: string;
  title: string;
  coverUrl: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  takenAt: string | null;
  camera: string | null;
  linkCount: number;
  isKeeper: boolean;
}

export interface DuplicateGroup {
  id: string;
  kind: "exact" | "near";
  keeperItemId: string | null;
  keeperSource: "auto" | "manual";
  keeperReason: string | null;
  reclaimableBytes: number;
  members: DuplicateMember[];
}

export function listDuplicateGroups(): DuplicateGroup[] {
  const groups = db.prepare(`
    SELECT id, kind, keeper_item_id, keeper_source, keeper_reason
    FROM gallery_duplicate_groups ORDER BY datetime(created_at) DESC, id
  `).all() as {
    id: string; kind: "exact" | "near"; keeper_item_id: string | null;
    keeper_source: "auto" | "manual"; keeper_reason: string | null;
  }[];
  if (groups.length === 0) return [];

  const memberRows = db.prepare(
    "SELECT group_id, item_id FROM gallery_duplicate_members"
  ).all() as { group_id: string; item_id: string }[];
  const details = loadDetails(memberRows.map((r) => r.item_id));

  const byGroup = new Map<string, string[]>();
  for (const row of memberRows) {
    const bucket = byGroup.get(row.group_id);
    if (bucket) bucket.push(row.item_id); else byGroup.set(row.group_id, [row.item_id]);
  }

  return groups.map((group) => {
    const ids = byGroup.get(group.id) ?? [];
    const members = ids
      .map((id) => details.get(id))
      .filter((row): row is DetailRow => Boolean(row))
      .map((row) => {
        const scored = score(row);
        const camera = [row.camera_make, row.camera_model].filter(Boolean).join(" ") || null;
        return {
          itemId: row.item_id,
          libraryId: row.library_id,
          libraryName: row.library_name,
          path: row.relative_path,
          title: row.title ?? row.relative_path,
          coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
          // The web-sized preview, for viewing a copy large without pulling the
          // original down; `fileUrl` is the original itself.
          previewUrl: row.preview_storage_key
            ? `/api/library/covers/${row.preview_storage_key}`
            : row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
          fileUrl: `/api/library/gallery/assets/${row.item_id}/file`,
          width: row.width,
          height: row.height,
          size: row.size,
          takenAt: row.taken_at,
          camera,
          linkCount: scored.linkCount,
          isKeeper: row.item_id === group.keeper_item_id
        };
      })
      .sort((a, b) => Number(b.isKeeper) - Number(a.isKeeper) || a.path.localeCompare(b.path));

    return {
      id: group.id,
      kind: group.kind,
      keeperItemId: group.keeper_item_id,
      keeperSource: group.keeper_source,
      keeperReason: group.keeper_reason,
      reclaimableBytes: members.filter((m) => !m.isKeeper).reduce((sum, m) => sum + (m.size ?? 0), 0),
      members
    };
  }).filter((group) => group.members.length > 1);
}

// ────────────────────────────────────────────────────────────────────────────
//  Admin actions
// ────────────────────────────────────────────────────────────────────────────

export function setDuplicateKeeper(groupId: string, itemId: string): boolean {
  const member = db.prepare(
    "SELECT 1 FROM gallery_duplicate_members WHERE group_id = ? AND item_id = ?"
  ).get(groupId, itemId);
  if (!member) return false;
  db.prepare(
    "UPDATE gallery_duplicate_groups SET keeper_item_id = ?, keeper_source = 'manual', keeper_reason = NULL WHERE id = ?"
  ).run(itemId, groupId);
  return true;
}

// "Not duplicates" — record every pair in the group as dismissed so no future scan can
// reassemble it, then drop the group.
export function ignoreDuplicateGroup(groupId: string): boolean {
  const ids = (db.prepare("SELECT item_id FROM gallery_duplicate_members WHERE group_id = ?")
    .all(groupId) as { item_id: string }[]).map((r) => r.item_id);
  if (ids.length === 0) return false;
  db.transaction(() => {
    const insert = db.prepare("INSERT OR IGNORE INTO gallery_duplicate_ignores (item_a, item_b) VALUES (?, ?)");
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        insert.run(a, b);
      }
    }
    db.prepare("DELETE FROM gallery_duplicate_groups WHERE id = ?").run(groupId);
  })();
  return true;
}

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

export interface DuplicateResolution {
  keptItemId: string;
  deletedItemIds: string[];
  failed: { itemId: string; error: string }[];
}

// Absorb, then move every non-keeper copy to the Recycle Bin. Re-validates from scratch
// rather than trusting the group: a scan result can be minutes or days old, and by now a
// member may have been edited, removed, or gone missing from disk.
export function resolveDuplicateGroup(groupId: string, userId: string): DuplicateResolution | null {
  const group = db.prepare(
    "SELECT id, kind, keeper_item_id FROM gallery_duplicate_groups WHERE id = ?"
  ).get(groupId) as { id: string; kind: string; keeper_item_id: string | null } | undefined;
  if (!group?.keeper_item_id) return null;

  const members = db.prepare(`
    SELECT m.item_id, gd.content_hash, gd.phash
    FROM gallery_duplicate_members m
    JOIN gallery_details gd ON gd.item_id = m.item_id
    JOIN library_items li ON li.id = m.item_id AND li.deleted_at IS NULL AND li.status = 'ready'
    WHERE m.group_id = ?
  `).all(groupId) as { item_id: string; content_hash: string | null; phash: string | null }[];

  const keeper = members.find((m) => m.item_id === group.keeper_item_id);
  if (!keeper) return null; // the copy we meant to keep is gone — never guess a new one

  // Re-check the relationship the set was built on, per tier: identical digests, or a
  // fingerprint still inside the near window. A mismatch means a file changed under us
  // and these are no longer provably the same picture.
  const losers = members.filter((m) => m.item_id !== keeper.item_id);
  const stillGrouped = group.kind === "exact"
    ? losers.filter((m) => m.content_hash != null && m.content_hash === keeper.content_hash)
    : losers.filter((m) => withinNearDistance(keeper.phash, m.phash));
  if (stillGrouped.length === 0) return null;

  const loserIds = stillGrouped.map((m) => m.item_id);
  absorbDuplicateMetadata(keeper.item_id, loserIds, { moveFaces: group.kind === "exact" });

  const deletedItemIds: string[] = [];
  const failed: { itemId: string; error: string }[] = [];
  for (const itemId of loserIds) {
    try {
      trashBook(itemId, userId);
      deletedItemIds.push(itemId);
    } catch (err) {
      failed.push({ itemId, error: err instanceof Error ? err.message : "Could not move the copy to the Recycle Bin." });
    }
  }

  // trashBook hard-deletes the library_items row, so the member rows cascade away; the
  // group is only meaningful while at least two copies remain.
  const remaining = (db.prepare(
    "SELECT COUNT(*) AS n FROM gallery_duplicate_members WHERE group_id = ?"
  ).get(groupId) as { n: number }).n;
  if (remaining < 2) db.prepare("DELETE FROM gallery_duplicate_groups WHERE id = ?").run(groupId);

  if (deletedItemIds.length > 0) {
    logActivity({
      event: "library.gallery.duplicates_removed",
      actorUserId: userId,
      targetType: "library",
      targetId: null,
      detail: `Moved ${deletedItemIds.length} duplicate cop${deletedItemIds.length === 1 ? "y" : "ies"} to the Recycle Bin, keeping ${keeper.item_id}.`,
      ipAddress: null
    });
  }

  return { keptItemId: keeper.item_id, deletedItemIds, failed };
}

export interface SelectionResolution {
  keptItemIds: string[];
  deletedItemIds: string[];
  failed: { itemId: string; error: string }[];
}

// Delete an explicit set of copies, rather than "everything except the keeper".
// Lets an admin keep two of three, or clear a whole set out.
//
// The pairwise re-check only applies when something survives: it exists to stop a copy
// being deleted as a duplicate of a photo it no longer matches. Deleting every copy is
// a deliberate "remove this picture entirely", so there is nothing to be a duplicate OF
// and nothing to re-check against.
export function resolveDuplicateSelection(
  groupId: string,
  deleteItemIds: string[],
  userId: string
): SelectionResolution | null {
  const group = db.prepare(
    "SELECT id, kind, keeper_item_id FROM gallery_duplicate_groups WHERE id = ?"
  ).get(groupId) as { id: string; kind: string; keeper_item_id: string | null } | undefined;
  if (!group) return null;

  const members = db.prepare(`
    SELECT m.item_id, gd.content_hash, gd.phash
    FROM gallery_duplicate_members m
    JOIN gallery_details gd ON gd.item_id = m.item_id
    JOIN library_items li ON li.id = m.item_id AND li.deleted_at IS NULL AND li.status = 'ready'
    WHERE m.group_id = ?
  `).all(groupId) as { item_id: string; content_hash: string | null; phash: string | null }[];

  const wanted = new Set(deleteItemIds);
  // Only ever act on ids that are live members of THIS set — never delete on the
  // strength of an id the caller supplied out of the blue.
  const targets = members.filter((m) => wanted.has(m.item_id));
  if (targets.length === 0 || targets.length !== wanted.size) return null;

  const kept = members.filter((m) => !wanted.has(m.item_id));

  let doomed = targets;
  let absorbInto: string | null = null;
  if (kept.length > 0) {
    // The set's own keeper absorbs when it is one of the survivors; otherwise the
    // first surviving copy does, so the deleted copies' tags and albums land
    // somewhere rather than being dropped.
    const keeper = kept.find((m) => m.item_id === group.keeper_item_id) ?? kept[0];
    absorbInto = keeper.item_id;
    doomed = group.kind === "exact"
      ? targets.filter((m) => m.content_hash != null && m.content_hash === keeper.content_hash)
      : targets.filter((m) => withinNearDistance(keeper.phash, m.phash));
    if (doomed.length === 0) return null;
  }

  const doomedIds = doomed.map((m) => m.item_id);
  if (absorbInto) {
    absorbDuplicateMetadata(absorbInto, doomedIds, { moveFaces: group.kind === "exact" });
  }

  const deletedItemIds: string[] = [];
  const failed: { itemId: string; error: string }[] = [];
  for (const itemId of doomedIds) {
    try {
      trashBook(itemId, userId);
      deletedItemIds.push(itemId);
    } catch (err) {
      failed.push({ itemId, error: err instanceof Error ? err.message : "Could not move the copy to the Recycle Bin." });
    }
  }

  // trashBook hard-deletes the library_items row, so member rows cascade away; a set
  // only means anything while two copies remain.
  const remaining = (db.prepare(
    "SELECT COUNT(*) AS n FROM gallery_duplicate_members WHERE group_id = ?"
  ).get(groupId) as { n: number }).n;
  if (remaining < 2) {
    db.prepare("DELETE FROM gallery_duplicate_groups WHERE id = ?").run(groupId);
  } else if (absorbInto) {
    // The admin may have deleted the keeper itself and kept a different copy; the FK
    // is ON DELETE SET NULL, so the set would be left with no keeper at all — which
    // reads as "every copy is up for deletion" next time and blocks the bulk sweep.
    // Promote the survivor that absorbed the metadata.
    db.prepare(
      "UPDATE gallery_duplicate_groups SET keeper_item_id = ? WHERE id = ? AND keeper_item_id IS NULL"
    ).run(absorbInto, groupId);
  }

  if (deletedItemIds.length > 0) {
    logActivity({
      event: "library.gallery.duplicates_removed",
      actorUserId: userId,
      targetType: "library",
      targetId: null,
      detail: absorbInto
        ? `Moved ${deletedItemIds.length} selected cop${deletedItemIds.length === 1 ? "y" : "ies"} to the Recycle Bin, keeping ${kept.length}.`
        : `Moved all ${deletedItemIds.length} copies of a duplicate set to the Recycle Bin — no copy was kept.`,
      ipAddress: null
    });
  }

  return { keptItemIds: kept.map((m) => m.item_id), deletedItemIds, failed };
}

export interface BulkResolution {
  groups: number;
  deleted: number;
  failed: number;
  skipped: number;
}

// "Delete all extra copies", restricted to byte-identical groups. Near-identical
// groups are never swept in bulk — they're a judgement call, one set at a time.
export function resolveAllExactGroups(userId: string): BulkResolution {
  const ids = (db.prepare("SELECT id FROM gallery_duplicate_groups WHERE kind = 'exact' ORDER BY id")
    .all() as { id: string }[]).map((r) => r.id);

  const totals: BulkResolution = { groups: 0, deleted: 0, failed: 0, skipped: 0 };
  for (const id of ids) {
    const result = resolveDuplicateGroup(id, userId);
    // null = the group failed re-validation (a copy changed or vanished since the
    // scan). Leave it in place so the admin sees it on the next load.
    if (!result) { totals.skipped += 1; continue; }
    totals.groups += 1;
    totals.deleted += result.deletedItemIds.length;
    totals.failed += result.failed.length;
  }
  return totals;
}

// ────────────────────────────────────────────────────────────────────────────
//  Background job
// ────────────────────────────────────────────────────────────────────────────

interface DuplicateScanPayload { libraryId?: string | null }

// Queue a scan unless one is already waiting or running. Returns false when a scan was
// already pending, so callers can say so rather than silently doing nothing.
// `libraryId` null/omitted = read every gallery library.
export function enqueueDuplicateScan(libraryId?: string | null): boolean {
  const existing = db.prepare(
    "SELECT 1 FROM jobs WHERE type = ? AND status IN ('pending', 'running')"
  ).get(DUPLICATE_SCAN_JOB_TYPE);
  if (existing) return false;
  db.prepare("INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 2)")
    .run(nanoid(16), DUPLICATE_SCAN_JOB_TYPE, JSON.stringify({ libraryId: libraryId ?? null } satisfies DuplicateScanPayload));
  return true;
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
    // A scan interrupted by a restart: re-queue it (it recomputes from scratch).
    db.prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE type = ? AND status = 'running'")
      .run(DUPLICATE_SCAN_JOB_TYPE);

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

      let scope: string | null = null;
      try { scope = (JSON.parse(job.payload) as DuplicateScanPayload).libraryId ?? null; } catch { /* scan everything */ }

      const writeProgress = jobProgressWriter(job.id, { libraryId: scope });
      try {
        const summary = await runDuplicateScan(writeProgress, scope);
        writeResult(job.id, summary as unknown as Record<string, unknown>);
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
