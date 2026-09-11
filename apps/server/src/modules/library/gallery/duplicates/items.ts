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
import { db } from "../../../../db.js";
import { validateLibrarySource } from "../../shared/library-source.js";
import { pathIsInside } from "../../shared/storage-roots.js";
import type { GalleryDetailRow, JobRow, LibraryItemRow, LibraryRow, NonNull } from "../../../../db/rows.js";

export const DUPLICATE_SCAN_JOB_TYPE = "SCAN_GALLERY_DUPLICATES";

// SQLite's variable limit is ~32k; chunk any generated IN (…) list well under it.
export const ID_CHUNK = 400;

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

// CANDIDATE_SQL keeps size non-NULL (`gd.size IS NOT NULL AND gd.size > 0`).
type CandidateRow = NonNull<Pick<GalleryDetailRow, "item_id" | "relative_path" | "size" | "content_hash" | "content_hash_at">, "size">
  & Pick<LibraryItemRow, "library_id">
  & Pick<LibraryRow, "source_path">;

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
//  Background job
// ────────────────────────────────────────────────────────────────────────────

export interface DuplicateScanPayload {
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
  ).all(DUPLICATE_SCAN_JOB_TYPE) as Pick<JobRow, "payload">[];
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
