// Duplicate cleanup JOBS — a cleanup someone owns, puts down, and comes back to.
//
// The existing duplicate pages work on caches: every list is rebuilt from the stored
// digests on demand, its rows carry ids that the next rebuild throws away, and each
// deletion prunes them further. That suits a page you open, act on, and leave. It
// cannot carry work across days, which is what this is for.
//
// So a job is the opposite kind of thing:
//
//   * It has an OWNER. Only they may change it or act on it; another admin sees the
//     job and its status and nothing else. An admin may cancel, delete, or take it
//     over — a family server where the one person who started a cleanup went on
//     holiday should not be stuck.
//   * There is at most ONE active job, enforced by a partial unique index rather than
//     by a check that two browser tabs can race.
//   * Its results are a SNAPSHOT, written by the scan into the job's own tables
//     (phase 2). It never points at a cache id, because the older pages remain
//     available and a Rebuild pressed on one of them would empty the job.
//   * Its folder preferences are COPIED from the global ones at creation and are its
//     own from then on. Two live sources of truth for "keep photos here" is how the
//     keeper choice started disagreeing with itself.
//
// Nothing in this file deletes anything or reads a file. Creating, scoping and
// retiring the job is all that lives here; the scan, the review and the removal are
// separate concerns in their own modules.
import { nanoid } from "nanoid";
import { db } from "../../../../db.js";
import { parsePolicy } from "../../../../core/permissions.js";
import {
  duplicateCandidateCount, duplicatePendingCount, type FolderPreferenceMode
} from "./items.js";

/** Where a job is in its life. The five ACTIVE ones block a second job; the rest
 *  are history and block nothing. */
export type JobStatus =
  | "draft" | "scanning" | "review" | "processing" | "paused"
  | "completed" | "failed" | "cancelled";

export const ACTIVE_STATUSES: JobStatus[] = ["draft", "scanning", "review", "processing", "paused"];

const isActive = (status: JobStatus): boolean => ACTIVE_STATUSES.includes(status);

/** A cleanup works on folders OR on single files, never both at once — see the
 *  column's own note in schema.sql. */
export type DuplicateTypeScope = "folders" | "files";
export type MediaTypeScope = "photo" | "video" | "both";

export interface JobLibrary {
  libraryId: string;
  name: string;
  included: boolean;
  /** What the library WAS when the job was created. A library that turns external
   *  mid-job must not quietly start offering its files for deletion, and one that
   *  turns internal must not either — the job was reviewed under the old answer. */
  mode: "managed" | "external";
  /** True when nothing may be deleted from it: external, or allowDelete turned off. */
  isProtected: boolean;
  /** The library as it stands NOW, so a job that no longer matches can say so. */
  currentMode: "managed" | "external";
  currentlyProtected: boolean;
  missing: boolean;
}

export interface JobFolderPreference {
  libraryId: string;
  folderPath: string;
  mode: FolderPreferenceMode;
}

export interface DuplicateJob {
  id: string;
  ownerUserId: string;
  ownerName: string;
  status: JobStatus;
  duplicateType: DuplicateTypeScope;
  mediaType: MediaTypeScope;
  currentStep: number;
  scanProgress: number;
  statusDetail: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  scanStartedAt: string | null;
  scanCompletedAt: string | null;
  completedAt: string | null;
  libraries: JobLibrary[];
  folderPreferences: JobFolderPreference[];
  /** Live counts over the snapshot. All zero until the scan runs (phase 2). */
  totals: JobTotals;
}

export interface JobTotals {
  results: number;
  reviewed: number;
  skipped: number;
  deleted: number;
  remaining: number;
  errors: number;
  reclaimableBytes: number;
  reclaimedBytes: number;
}

interface JobRow {
  id: string;
  owner_user_id: string;
  status: JobStatus;
  duplicate_type: DuplicateTypeScope;
  media_type: MediaTypeScope;
  current_step: number;
  scan_progress: number;
  status_detail: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  scan_started_at: string | null;
  scan_completed_at: string | null;
  completed_at: string | null;
}

const now = (): string => new Date().toISOString();

// ── Reading ─────────────────────────────────────────────────────────────────

function libraryProtection(policyJson: string | null): { mode: "managed" | "external"; isProtected: boolean } {
  const policy = parsePolicy(policyJson);
  const mode = (policy.mode ?? "managed") === "external" ? "external" as const : "managed" as const;
  // Same rule as libraryAllowsDelete, read here from a row already in hand rather
  // than re-queried per library.
  return { mode, isProtected: mode === "external" || policy.allowDelete === false };
}

export interface GalleryLibraryOption {
  id: string;
  name: string;
  sourcePath: string;
  mode: "managed" | "external";
  isProtected: boolean;
  /** Photos sharing a byte size with another photo — everything worth checking here. */
  candidateCount: number;
  /** Of those, how many the scan would have to open and read right now. Zero means the
   *  fingerprints are current and this library costs nothing to scan. */
  pendingCount: number;
}

/** Every gallery library, with what a job may do to it and what scanning it would cost.
 *  The wizard's step 1 list, and the counts its summary quotes before you press Run
 *  scan — pure SQL, no disk, so it is safe to compute on every page load. */
export function galleryLibraryOptions(): GalleryLibraryOption[] {
  const rows = db.prepare(`
    SELECT id, name, source_path, policy_json FROM libraries
    WHERE type = 'gallery' ORDER BY name COLLATE NOCASE
  `).all() as { id: string; name: string; source_path: string; policy_json: string }[];
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    sourcePath: row.source_path,
    ...libraryProtection(row.policy_json),
    candidateCount: duplicateCandidateCount(row.id),
    pendingCount: duplicatePendingCount(row.id)
  }));
}

export interface JobFolderOption {
  libraryId: string;
  libraryName: string;
  /** Relative to the library root; "" is the root itself. */
  folderPath: string;
  photoCount: number;
  /** A library the app may read but not delete from — "clear" is meaningless there. */
  isProtected: boolean;
}

/** The folders a cleanup's instructions can be attached to: every folder holding photos
 *  in the job's libraries.
 *
 *  Read from the CATALOGUE, not from a duplicate scan. The old pages listed only folders
 *  a scan had already found duplicates in, which cannot work here — instructions are set
 *  before the scan runs, precisely so the scan can honour them. */
export function jobFolderOptions(libraryIds: string[]): JobFolderOption[] {
  if (libraryIds.length === 0) return [];
  const placeholders = libraryIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT li.library_id, lib.name AS library_name, lib.policy_json, gd.relative_path
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    JOIN libraries lib ON lib.id = li.library_id
    WHERE li.library_id IN (${placeholders}) AND li.deleted_at IS NULL
  `).all(...libraryIds) as {
    library_id: string; library_name: string; policy_json: string; relative_path: string;
  }[];

  const options = new Map<string, JobFolderOption>();
  for (const row of rows) {
    const cut = row.relative_path.lastIndexOf("/");
    const folderPath = cut === -1 ? "" : row.relative_path.slice(0, cut);
    const key = `${row.library_id} ${folderPath}`;
    const existing = options.get(key);
    if (existing) {
      existing.photoCount += 1;
      continue;
    }
    options.set(key, {
      libraryId: row.library_id,
      libraryName: row.library_name,
      folderPath,
      photoCount: 1,
      isProtected: libraryProtection(row.policy_json).isProtected
    });
  }

  return [...options.values()].sort((a, b) =>
    a.libraryName.localeCompare(b.libraryName) || a.folderPath.localeCompare(b.folderPath));
}

function jobLibraries(jobId: string): JobLibrary[] {
  const rows = db.prepare(`
    SELECT jl.library_id, jl.included, jl.library_type_snapshot, jl.protected_snapshot,
           lib.name, lib.policy_json
    FROM duplicate_job_libraries jl
    LEFT JOIN libraries lib ON lib.id = jl.library_id
    WHERE jl.job_id = ?
    ORDER BY lib.name COLLATE NOCASE, jl.library_id
  `).all(jobId) as {
    library_id: string; included: number; library_type_snapshot: string; protected_snapshot: number;
    name: string | null; policy_json: string | null;
  }[];

  return rows.map((row) => {
    const current = libraryProtection(row.policy_json);
    return {
      libraryId: row.library_id,
      name: row.name ?? "(removed library)",
      included: row.included === 1,
      mode: row.library_type_snapshot === "external" ? "external" : "managed",
      isProtected: row.protected_snapshot === 1,
      currentMode: current.mode,
      currentlyProtected: current.isProtected,
      missing: row.name === null
    };
  });
}

function jobPreferences(jobId: string): JobFolderPreference[] {
  const rows = db.prepare(`
    SELECT library_id, folder_path, preference FROM duplicate_job_folder_preferences
    WHERE job_id = ? ORDER BY library_id, folder_path
  `).all(jobId) as { library_id: string; folder_path: string; preference: FolderPreferenceMode }[];
  return rows.map((row) => ({
    libraryId: row.library_id,
    folderPath: row.folder_path,
    mode: row.preference
  }));
}

// Counted over the snapshot rather than stored on the job: a total kept in a column
// is a second answer to a question the rows already answer, and the two drift the
// first time anything fails half-way.
export function jobTotals(jobId: string): JobTotals {
  const results = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(review_status = 'reviewed'), 0) AS reviewed,
      COALESCE(SUM(review_status = 'skipped'), 0) AS skipped,
      COALESCE(SUM(status = 'active'), 0) AS remaining,
      COALESCE(SUM(status = 'error'), 0) AS errors,
      COALESCE(SUM(CASE WHEN status = 'active' THEN reclaimable_bytes ELSE 0 END), 0) AS reclaimable
    FROM duplicate_job_results WHERE job_id = ?
  `).get(jobId) as {
    total: number; reviewed: number; skipped: number; remaining: number; errors: number; reclaimable: number;
  };

  const members = db.prepare(`
    SELECT COUNT(*) AS deleted, COALESCE(SUM(size_snapshot), 0) AS bytes
    FROM duplicate_job_result_members WHERE job_id = ? AND status = 'deleted'
  `).get(jobId) as { deleted: number; bytes: number };

  return {
    results: results.total,
    reviewed: results.reviewed,
    skipped: results.skipped,
    deleted: members.deleted,
    remaining: results.remaining,
    errors: results.errors,
    reclaimableBytes: results.reclaimable,
    reclaimedBytes: members.bytes
  };
}

function hydrate(row: JobRow): DuplicateJob {
  const owner = db.prepare("SELECT display_name FROM users WHERE id = ?").get(row.owner_user_id) as
    | { display_name: string }
    | undefined;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerName: owner?.display_name ?? "(removed user)",
    status: row.status,
    duplicateType: row.duplicate_type,
    mediaType: row.media_type,
    currentStep: row.current_step,
    scanProgress: row.scan_progress,
    statusDetail: row.status_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    scanStartedAt: row.scan_started_at,
    scanCompletedAt: row.scan_completed_at,
    completedAt: row.completed_at,
    libraries: jobLibraries(row.id),
    folderPreferences: jobPreferences(row.id),
    totals: jobTotals(row.id)
  };
}

const jobRow = (id: string): JobRow | undefined =>
  db.prepare("SELECT * FROM duplicate_jobs WHERE id = ?").get(id) as JobRow | undefined;

export function getJob(id: string): DuplicateJob | null {
  const row = jobRow(id);
  return row ? hydrate(row) : null;
}

/** The one active job, whoever owns it — what the page opens on. */
export function activeJob(): DuplicateJob | null {
  const row = db.prepare(`
    SELECT * FROM duplicate_jobs
    WHERE status IN ('draft', 'scanning', 'review', 'processing', 'paused')
    LIMIT 1
  `).get() as JobRow | undefined;
  return row ? hydrate(row) : null;
}

/** Finished jobs, newest first — the history strip under the active-job card. */
export function recentJobs(limit = 10): DuplicateJob[] {
  const rows = db.prepare(`
    SELECT * FROM duplicate_jobs
    WHERE status IN ('completed', 'failed', 'cancelled')
    ORDER BY COALESCE(completed_at, updated_at) DESC
    LIMIT ?
  `).all(limit) as JobRow[];
  return rows.map(hydrate);
}

// ── Permission ──────────────────────────────────────────────────────────────
//
// Two different questions, deliberately not one. The OWNER may work the job. An
// admin may retire it — cancel, delete, hand it over — but may not quietly review
// and delete photos inside someone else's cleanup, which would leave the owner's
// job showing decisions they never made.

export const mayWork = (job: DuplicateJob, userId: string): boolean => job.ownerUserId === userId;

/** Every route in this module is admin-only already, so "may retire" is: the owner,
 *  or any other admin stepping in. Kept as a function so the rule has one home. */
export const mayRetire = (job: DuplicateJob, userId: string, isAdmin: boolean): boolean =>
  job.ownerUserId === userId || isAdmin;

// ── Writing ─────────────────────────────────────────────────────────────────

export type JobRefusal =
  | "already_active"
  | "not_found"
  | "not_owner"
  | "locked"
  | "no_libraries"
  | "not_reviewable"
  // The scan itself broke. Its own refusal, because it was folded into
  // not_reviewable once and a crashed scan then reported "this cleanup is already
  // finished" — which is not merely unhelpful, it points at the wrong thing
  // entirely and buries the real message in a field nothing displayed.
  | "scan_failed";

export type JobOutcome<T> = { ok: true; job: T } | { ok: false; refused: JobRefusal; detail?: string };

function touch(id: string, patch: Partial<Record<string, unknown>> = {}): void {
  const stamp = now();
  const sets = ["updated_at = ?", "last_activity_at = ?"];
  const args: unknown[] = [stamp, stamp];
  for (const [column, value] of Object.entries(patch)) {
    sets.push(`${column} = ?`);
    args.push(value);
  }
  args.push(id);
  db.prepare(`UPDATE duplicate_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
}

export function recordAction(input: {
  jobId: string;
  userId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  status?: string;
  details?: string | null;
}): void {
  db.prepare(`
    INSERT INTO duplicate_job_actions (id, job_id, user_id, action, target_type, target_id, status, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(16), input.jobId, input.userId, input.action,
    input.targetType ?? null, input.targetId ?? null, input.status ?? "ok", input.details ?? null
  );
}

export interface CreateJobInput {
  ownerUserId: string;
  libraryIds: string[];
  duplicateType?: DuplicateTypeScope;
  mediaType?: MediaTypeScope;
}

/** Start a draft. Its folder instructions start empty and are set in the wizard's
 *  second step: they belong to this cleanup and nothing else. */
export function createJob(input: CreateJobInput): JobOutcome<DuplicateJob> {
  const existing = activeJob();
  if (existing) return { ok: false, refused: "already_active", detail: existing.id };

  const available = new Map(galleryLibraryOptions().map((library) => [library.id, library]));
  const chosen = input.libraryIds.filter((id) => available.has(id));
  if (chosen.length === 0) return { ok: false, refused: "no_libraries" };

  const id = nanoid(16);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO duplicate_jobs (id, owner_user_id, status, duplicate_type, media_type, current_step)
      VALUES (?, ?, 'draft', ?, ?, 1)
    `).run(id, input.ownerUserId, input.duplicateType ?? "folders", input.mediaType ?? "both");

    const addLibrary = db.prepare(`
      INSERT INTO duplicate_job_libraries (job_id, library_id, included, library_type_snapshot, protected_snapshot)
      VALUES (?, ?, 1, ?, ?)
    `);
    for (const libraryId of chosen) {
      const library = available.get(libraryId)!;
      addLibrary.run(id, libraryId, library.mode, library.isProtected ? 1 : 0);
    }

  })();

  recordAction({ jobId: id, userId: input.ownerUserId, action: "job.created", details: `${chosen.length} libraries` });
  return { ok: true, job: getJob(id)! };
}

/** The wizard's scope, changeable only while the job is a draft — everything after
 *  a scan was snapshotted under these answers. */
export interface UpdateScopeInput {
  libraryIds?: string[];
  duplicateType?: DuplicateTypeScope;
  mediaType?: MediaTypeScope;
  currentStep?: number;
}

export function updateJobScope(id: string, userId: string, input: UpdateScopeInput): JobOutcome<DuplicateJob> {
  const job = getJob(id);
  if (!job) return { ok: false, refused: "not_found" };
  if (!mayWork(job, userId)) return { ok: false, refused: "not_owner" };
  if (job.status !== "draft") return { ok: false, refused: "locked" };

  const available = new Map(galleryLibraryOptions().map((library) => [library.id, library]));
  let chosen: string[] | null = null;
  if (input.libraryIds) {
    chosen = input.libraryIds.filter((libraryId) => available.has(libraryId));
    if (chosen.length === 0) return { ok: false, refused: "no_libraries" };
  }

  db.transaction(() => {
    if (chosen) {
      db.prepare("DELETE FROM duplicate_job_libraries WHERE job_id = ?").run(id);
      const addLibrary = db.prepare(`
        INSERT INTO duplicate_job_libraries (job_id, library_id, included, library_type_snapshot, protected_snapshot)
        VALUES (?, ?, 1, ?, ?)
      `);
      for (const libraryId of chosen) {
        const library = available.get(libraryId)!;
        addLibrary.run(id, libraryId, library.mode, library.isProtected ? 1 : 0);
      }
      // A preference for a library just dropped from the job has nothing left to
      // apply to; keeping it would resurrect silently if the library came back.
      db.prepare(`
        DELETE FROM duplicate_job_folder_preferences
        WHERE job_id = ? AND library_id NOT IN (SELECT library_id FROM duplicate_job_libraries WHERE job_id = ?)
      `).run(id, id);
    }
    const patch: Record<string, unknown> = {};
    if (input.duplicateType) patch.duplicate_type = input.duplicateType;
    if (input.mediaType) patch.media_type = input.mediaType;
    if (input.currentStep !== undefined) patch.current_step = Math.min(Math.max(input.currentStep, 1), 3);
    touch(id, patch);
  })();

  return { ok: true, job: getJob(id)! };
}

/** Move the job to a new state. The scan and the delete queue drive this; it lives
 *  here so every status change stamps activity the same way and one place knows
 *  which transitions are legal. */
export function setJobStatus(
  id: string,
  userId: string,
  status: JobStatus,
  detail?: string | null
): JobOutcome<DuplicateJob> {
  const job = getJob(id);
  if (!job) return { ok: false, refused: "not_found" };

  const patch: Record<string, unknown> = { status, status_detail: detail ?? null };
  // Only on ENTERING the state, not on re-asserting it. A two-phase scan says "scanning"
  // twice — once when the fingerprint pass is queued, once when runJobScan starts the
  // snapshot — and resetting on the second would wipe the progress the first just filled
  // and restart the clock that says how long this has been running.
  if (status === "scanning" && job.status !== "scanning") { patch.scan_started_at = now(); patch.scan_progress = 0; }
  if (status === "review" && job.status === "scanning") patch.scan_completed_at = now();
  if (status === "completed" || status === "cancelled" || status === "failed") patch.completed_at = now();
  // A finished job releases the lock, so leaving it on a wizard step it can never
  // reopen at would misreport where it stopped.
  if (!isActive(status) && job.status === "draft") patch.current_step = job.currentStep;

  touch(id, patch);
  recordAction({ jobId: id, userId, action: `job.${status}`, details: detail ?? null });
  return { ok: true, job: getJob(id)! };
}

/** How far through the fingerprint pass the job is, 0–100, for the progress bar on its
 *  card. Deliberately NOT touch(): progress is not activity, and stamping
 *  last_activity_at every time it moved would make a long unattended scan read as
 *  somebody working on the job. Guarded on 'scanning' so a late callback from a pass
 *  that has already finished can't reanimate a finished job's bar. */
export function setJobScanProgress(id: string, percent: number): void {
  db.prepare("UPDATE duplicate_jobs SET scan_progress = ?, updated_at = ? WHERE id = ? AND status = 'scanning'")
    .run(Math.max(0, Math.min(100, Math.round(percent))), now(), id);
}

/** Finish the job: history and audit stay, nothing more may be cleaned, and the lock
 *  is released so the next job can start. */
export function completeJob(id: string, userId: string, isAdmin: boolean): JobOutcome<DuplicateJob> {
  const job = getJob(id);
  if (!job) return { ok: false, refused: "not_found" };
  if (!mayRetire(job, userId, isAdmin)) return { ok: false, refused: "not_owner" };
  if (!isActive(job.status)) return { ok: false, refused: "not_reviewable", detail: job.status };
  return setJobStatus(id, userId, "completed");
}

export function cancelJob(id: string, userId: string, isAdmin: boolean, reason?: string): JobOutcome<DuplicateJob> {
  const job = getJob(id);
  if (!job) return { ok: false, refused: "not_found" };
  if (!mayRetire(job, userId, isAdmin)) return { ok: false, refused: "not_owner" };
  if (!isActive(job.status)) return { ok: false, refused: "not_reviewable", detail: job.status };
  return setJobStatus(id, userId, "cancelled", reason ?? null);
}

/** Hand the job to someone else. For the case the lock is really there to survive:
 *  the person who started the cleanup isn't coming back to it. */
export function reassignJob(id: string, toUserId: string, byUserId: string): JobOutcome<DuplicateJob> {
  const job = getJob(id);
  if (!job) return { ok: false, refused: "not_found" };
  const target = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1")
    .get(toUserId) as { id: string } | undefined;
  if (!target) return { ok: false, refused: "not_found", detail: "user" };

  touch(id, { owner_user_id: toUserId });
  recordAction({ jobId: id, userId: byUserId, action: "job.reassigned", targetType: "user", targetId: toUserId });
  return { ok: true, job: getJob(id)! };
}

/** Remove the job and everything it held. Files already in the Recycle Bin stay
 *  there — deleting the paperwork does not undo the work. The activity log keeps its
 *  own record; only the job's private history goes. */
export function deleteJob(id: string, userId: string, isAdmin: boolean): JobOutcome<{ id: string }> {
  const job = getJob(id);
  if (!job) return { ok: false, refused: "not_found" };
  if (!mayRetire(job, userId, isAdmin)) return { ok: false, refused: "not_owner" };
  db.prepare("DELETE FROM duplicate_jobs WHERE id = ?").run(id);
  return { ok: true, job: { id } };
}

// ── The job's folder preferences ────────────────────────────────────────────

/** Replace the job's instructions wholesale, as the picker sends them. External
 *  libraries can't be cleared out — the files are not ours to remove — so a "clear"
 *  aimed at one is dropped rather than stored and ignored later. */
export function setJobFolderPreferences(
  id: string,
  userId: string,
  folders: JobFolderPreference[]
): JobOutcome<DuplicateJob> {
  const job = getJob(id);
  if (!job) return { ok: false, refused: "not_found" };
  if (!mayWork(job, userId)) return { ok: false, refused: "not_owner" };

  const known = new Map(job.libraries.map((library) => [library.libraryId, library]));

  db.transaction(() => {
    db.prepare("DELETE FROM duplicate_job_folder_preferences WHERE job_id = ?").run(id);
    const add = db.prepare(`
      INSERT INTO duplicate_job_folder_preferences (job_id, library_id, folder_path, preference, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (job_id, library_id, folder_path) DO UPDATE
        SET preference = excluded.preference, updated_by = excluded.updated_by,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `);
    for (const folder of folders) {
      const library = known.get(folder.libraryId);
      if (!library) continue;
      if (folder.mode === "clear" && library.isProtected) continue;
      add.run(id, folder.libraryId, folder.folderPath, folder.mode, userId);
    }
    touch(id);
  })();

  return { ok: true, job: getJob(id)! };
}

/** The instruction that applies to a path within this job, most specific first —
 *  the same rule the global preferences use, so "keep everything in Photos except
 *  Photos/Unsorted" reads the way it is written. Inheritance is this function; it is
 *  never stored. */
export function jobPreferenceFor(
  preferences: JobFolderPreference[],
  libraryId: string,
  path: string
): FolderPreferenceMode | null {
  let best: JobFolderPreference | null = null;
  for (const folder of preferences) {
    if (folder.libraryId !== libraryId) continue;
    const covers = folder.folderPath === ""
      || path === folder.folderPath
      || path.startsWith(`${folder.folderPath}/`);
    if (!covers) continue;
    if (!best || folder.folderPath.length > best.folderPath.length) best = folder;
  }
  return best?.mode ?? null;
}
