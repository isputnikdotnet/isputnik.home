// A cleanup job's snapshot, read back for the page: the results with their folders
// and members, the risk each one carries, the filters, and what a sweep would take.
import { db } from "../../../../db.js";
import { keeperRankIsDecision } from "./keeper.js";
import type { MemberRole } from "./snapshot.js";

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

// 'evidence' when the deciding rung was somebody's decision — the protected library,
// a folder instruction, hand-filed work, hand-edited details. The ladder itself says
// which those are (see KEEPER_CRITERIA's `decision` flags): this used to be a bare
// count of ranks here, which went quietly wrong the day a file-property criterion was
// inserted among the decisions. -1 means nothing separated the copies at all.
export const keeperConfidenceOf = (rank: number): KeeperConfidence =>
  rank < 0 ? "tossup" : keeperRankIsDecision(rank) ? "evidence" : "guess";

/** How carefully a person should look before letting a result go through, folded to a
 *  single reading for the card's gauge. The two confidence axes stay separate above —
 *  they answer different questions — but "how much attention does this deserve" is a
 *  third question with one answer, and leaving the fold to whoever reads the card
 *  means every reader folds it differently.
 *
 *  Severity is decided almost entirely by the MATCH. Byte-identical copies are risk 0
 *  whatever chose the keeper: the pixels are the same pixels, and everything attached
 *  to the losers is merged onto the survivor. Risk exists only where the copies merely
 *  look alike — deleting one then loses a real file — and grows when the keeper choice
 *  had nothing human behind it, and again when the match itself is doubtful. */
export interface ResultRisk {
  /** 0 = none, 1 = low, 2 = worth a look, 3 = check first. */
  severity: 0 | 1 | 2 | 3;
  label: string;
  /** One sentence for the tooltip: why this severity, in terms of what could be lost. */
  explanation: string;
}

export function assessResultRisk(tier: ResultTier, match: MatchConfidence, keeper: KeeperConfidence): ResultRisk {
  // The tier is derived from the members' distances, so it is the ground truth about
  // whether the files are the same bytes — ahead of the stored confidence column.
  if (tier === "exact") {
    return {
      severity: 0,
      label: "No risk",
      explanation: "The copies are identical, byte for byte. Whichever is kept, the picture is exactly the same — deleting the rest loses nothing."
    };
  }
  if (match === "unsure") {
    return {
      severity: 3,
      label: "Check first",
      explanation: "These may be two different photographs that merely look alike. Open them side by side before letting this one go through."
    };
  }
  // A likely match: almost certainly the same picture, but the files differ, so the
  // copies being deleted are not interchangeable with the keeper.
  return keeper === "evidence"
    ? {
        severity: 1,
        label: "Low risk",
        explanation: "The copies look like the same picture but are different files. The kept one was chosen on work you did — tags, albums, or a folder rule."
      }
    : {
        severity: 2,
        label: "Worth a look",
        explanation: "The copies look like the same picture but are different files, and nothing you did separated them — the choice came from the files themselves."
      };
}

export interface SnapshotResult {
  id: string;
  type: "photo_set" | "folder_set" | "contained" | "overlap";
  tier: ResultTier;
  matchConfidence: MatchConfidence;
  keeperConfidence: KeeperConfidence;
  risk: ResultRisk;
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

/** How the results are ordered within each section — the sections themselves
 *  (folders before files, certain before uncertain) hold whatever the sort, so the
 *  page's headings stay contiguous. 'size' is what the page has always done. */
export type ResultSort = "size" | "copies";

/** How the page narrows what it shows. */
export interface ResultFilter {
  /** Substring over folder paths, file paths and library names. */
  search?: string;
  sort?: ResultSort;
  type?: SnapshotResult["type"];
  /** Byte-identical sets or perceptual ones. A separate axis from `type`, so
   *  "single files I'm certain about" is expressible without a third result type. */
  tier?: ResultTier;
  review?: "unreviewed" | "reviewed" | "skipped";
  libraryId?: string;
  /** One result by id, for reading back a single card after it changed. Not something
   *  the page's filter bar offers — it exists so an edit can answer with the row it
   *  touched instead of a whole re-sorted page. */
  resultId?: string;
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

  if (filter.resultId) { clauses.push("r.id = ?"); args.push(filter.resultId); }
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
  // Within a section: most bytes back, or most copies in the set. Both descending —
  // the point of either is to surface the results worth doing first.
  const orderKey = filter.sort === "copies"
    ? "(SELECT COUNT(*) FROM duplicate_job_result_members mc WHERE mc.result_id = r.id) DESC"
    : "r.reclaimable_bytes DESC";
  const results = db.prepare(`
    SELECT r.id, r.result_type, r.status, r.review_status, r.reclaimable_bytes, r.keeper_reason,
           r.match_confidence, r.keeper_rank
    FROM duplicate_job_results r WHERE ${scope.where}
    ORDER BY
      CASE r.result_type WHEN 'folder_set' THEN 0 WHEN 'contained' THEN 1 WHEN 'overlap' THEN 2 ELSE 3 END,
      -- Certain before uncertain, so the page's headings stay contiguous and the sets
      -- that need no thought come first.
      ${NEAR_EXISTS},
      ${orderKey}, r.id
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
    // Any member sitting off the keeper by a bit or more makes the whole set a
    // perceptual match. Read from the members so it cannot drift from them.
    const tier = rowMembers.some((member) => member.distance > 0) ? "near" as const : "exact" as const;
    const keeperConfidence = keeperConfidenceOf(row.keeper_rank);
    return {
      id: row.id,
      type: row.result_type,
      tier,
      matchConfidence: row.match_confidence,
      keeperConfidence,
      risk: assessResultRisk(tier, row.match_confidence, keeperConfidence),
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
 *  no sweep at all, which is the honest answer rather than a missing feature.
 *
 *  And a THIRD, for the same reason as the first: the set must still keep something.
 *  A person may mark every copy of a set for deletion, and then removing them is not
 *  clearing redundancy — it is taking a photograph out of the library. That is a fine
 *  thing to ask for and a terrible thing to fold into a button labelled "delete N
 *  identical copies", whose whole promise is that each one has a survivor. Those sets
 *  are left for the card, where the decision is visible one at a time. */
function sweepScope(jobId: string, filter: ResultFilter): { where: string; args: unknown[] } {
  const scope = filterSql(jobId, { ...filter, type: "photo_set", tier: "exact" });
  return {
    where: `${scope.where} AND r.status = 'active' AND EXISTS (
      SELECT 1 FROM duplicate_job_result_members m
      WHERE m.result_id = r.id AND m.role = 'delete' AND m.status NOT IN ('deleted', 'skipped')
    ) AND EXISTS (
      SELECT 1 FROM duplicate_job_result_members m
      WHERE m.result_id = r.id AND m.role IN ('keep', 'protected')
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
