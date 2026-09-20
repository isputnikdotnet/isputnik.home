// Whether a video starts with its index, and the job that moves one there.
//
// An MP4 keeps its table of contents in a `moov` box. Put after the picture data
// (`mdat`), as nearly every phone and desktop editor writes it, a player cannot
// decode a single frame until it has fetched the very end of the file: our stream
// route answers ranges, so it plays, but the start costs an extra round trip and a
// tail fetch, and anything in front of the server that handles ranges poorly stalls
// on it. "Faststart" is the same file with `moov` in front.
//
// Detection is a handful of 16-byte reads from the front of the file, whatever its
// size — cheap enough for the catalog scan to do on every video. The repair is a
// remux: ffmpeg copies both bitstreams verbatim and only rewrites the boxes, so it
// is lossless and I/O-bound rather than CPU-bound.
//
// Unlike transcode.ts, which writes its web copy BESIDE the original, this one
// replaces the original: a faststart copy is the same size, and keeping both would
// double the disk a video library needs to buy back a round trip. That is why
// nothing here runs on a schedule — an admin asks for it, file by file or in bulk,
// from Control panel → Maintenance → Videos. The library's own policy and any
// folder lock are honoured, and the new file is probed and compared before it is
// allowed to replace anything.
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { db } from "../../../db.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { libraryAllowsDelete } from "../shared/trash.js";
import { lockCovering } from "../shared/folder-locks.js";
import { libraryJobRunning } from "../shared/scan-lock.js";
import { requeueInterruptedJobs } from "../shared/job-recovery.js";
import { log } from "../../../core/logger.js";
import { registerJobHandler } from "../../../core/job-poller.js";
import type { GalleryDetailRow, JobRow, LibraryItemRow, LibraryRow } from "../../../db/rows.js";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";
const FFPROBE_BIN: string = ffprobeStatic?.path || "ffprobe";

export const FASTSTART_JOB_TYPE = "FASTSTART_GALLERY_VIDEO";

/** Containers built out of MP4 boxes. WebM/Matroska has no `moov` and is always
 *  streamable, so it is never a candidate — it reports null, not false. */
const BOX_CONTAINERS = new Set([".mp4", ".m4v", ".mov"]);

/** Boxes read before giving up looking for `moov`. A real file has it within the
 *  first two or three; a malformed one shouldn't cost a walk of the whole file. */
const MAX_BOXES = 12;

/**
 * Read the top-level box order: true when `moov` comes before the picture data,
 * false when it comes after, null when the question doesn't apply (not an MP4
 * container) or the file can't be read as one.
 */
export async function readFaststart(absolutePath: string, extension: string): Promise<boolean | null> {
  if (!BOX_CONTAINERS.has(extension.toLowerCase())) return null;
  let handle: fsp.FileHandle | undefined;
  try {
    const size = (await fsp.stat(absolutePath)).size;
    handle = await fsp.open(absolutePath, "r");
    const head = Buffer.alloc(16);
    let offset = 0;
    for (let i = 0; i < MAX_BOXES && offset + 8 <= size; i += 1) {
      const { bytesRead } = await handle.read(head, 0, 16, offset);
      if (bytesRead < 8) return null;
      const type = head.toString("latin1", 4, 8);
      // A 32-bit size of 1 means the real one is the 64 bits that follow; 0 means
      // "to the end of the file" and can only be the last box.
      let length = head.readUInt32BE(0);
      let header = 8;
      if (length === 1) {
        if (bytesRead < 16) return null;
        length = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (length === 0) {
        length = size - offset;
      }
      if (type === "moov") return true;
      // `mdat` before `moov` is the whole problem; it is also the box a walk would
      // otherwise skip gigabytes at a time, so stop at the first one.
      if (type === "mdat") return false;
      if (length < header) return null; // nonsense size — don't guess past it
      offset += length;
    }
    return null;
  } catch {
    return null; // unreadable / not an MP4 after all — leave it unflagged
  } finally {
    // Node 24+ makes an un-closed FileHandle fatal when it is collected.
    await handle?.close().catch(() => { /* already gone */ });
  }
}

// Videos that could be optimised: an MP4-family file whose index is at the back.
// `faststart = 1` (already in front) and NULL (webm, or never probed) are both out.
const CANDIDATE_WHERE = `
  gd.kind = 'video' AND gd.faststart = 0
    AND li.deleted_at IS NULL AND li.status = 'ready'
`;

export interface FaststartCandidate {
  itemId: string;
  libraryId: string;
  libraryName: string;
  title: string;
  relativePath: string;
  size: number | null;
  durationSeconds: number | null;
  /** Why this one can't be optimised, if it can't: the library is one the app only
   *  reads, or a folder lock covers it. Null means it is ready to go. */
  blocked: "library" | "locked" | null;
  queued: boolean;
}

type CandidateRow = Pick<GalleryDetailRow, "item_id" | "relative_path" | "size" | "duration_seconds">
  & Pick<LibraryItemRow, "library_id">
  & Pick<LibraryRow, "source_path">
  & { library_name: string; title: string | null };

/** Item ids already lined up, so a second press doesn't double-queue them. */
function queuedItemIds(): Set<string> {
  const rows = db.prepare(
    "SELECT json_extract(payload, '$.itemId') AS itemId FROM jobs WHERE type = ? AND status IN ('pending', 'running')"
  ).all(FASTSTART_JOB_TYPE) as { itemId: string | null }[];
  return new Set(rows.map((r) => r.itemId).filter((id): id is string => Boolean(id)));
}

export function faststartBacklogCount(): number {
  return (db.prepare(`
    SELECT COUNT(*) AS n
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    WHERE ${CANDIDATE_WHERE}
  `).get() as { n: number }).n;
}

/** The backlog, biggest first — the big ones are where the wait is worst. */
export function listFaststartCandidates(limit = 500): FaststartCandidate[] {
  const rows = db.prepare(`
    SELECT gd.item_id, gd.relative_path, gd.size, gd.duration_seconds,
           li.library_id, lib.source_path, lib.name AS library_name, im.title AS title
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    JOIN libraries lib ON lib.id = li.library_id
    LEFT JOIN item_metadata im ON im.item_id = gd.item_id
    WHERE ${CANDIDATE_WHERE}
    ORDER BY gd.size DESC
    LIMIT ?
  `).all(limit) as CandidateRow[];
  const queued = queuedItemIds();
  // The policy gate is per-library, so it is answered once per library, not per row.
  const allowed = new Map<string, boolean>();
  return rows.map((row) => {
    let mayWrite = allowed.get(row.library_id);
    if (mayWrite === undefined) {
      mayWrite = libraryAllowsDelete(row.library_id);
      allowed.set(row.library_id, mayWrite);
    }
    const locked = mayWrite ? lockCovering(row.library_id, row.relative_path) : null;
    return {
      itemId: row.item_id,
      libraryId: row.library_id,
      libraryName: row.library_name,
      title: row.title ?? row.relative_path.split("/").pop() ?? row.relative_path,
      relativePath: row.relative_path,
      size: row.size,
      durationSeconds: row.duration_seconds,
      blocked: !mayWrite ? "library" : locked ? "locked" : null,
      queued: queued.has(row.item_id)
    };
  });
}

/**
 * Queue the named items (or the whole backlog). Anything already queued, or held
 * back by its library's policy or a folder lock, is skipped. Returns how many jobs
 * were made.
 */
export function enqueueFaststartJobs(itemIds: string[] | "all"): number {
  const wanted = itemIds === "all" ? null : new Set(itemIds);
  const candidates = listFaststartCandidates(2000)
    .filter((c) => !c.queued && c.blocked === null && (wanted === null || wanted.has(c.itemId)));
  candidates.forEach((candidate, i) => {
    db.prepare("INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 2)")
      .run(nanoid(16), FASTSTART_JOB_TYPE, JSON.stringify({
        itemId: candidate.itemId,
        title: candidate.title,
        batch: i + 1,
        batches: candidates.length
      } satisfies FaststartPayload));
  });
  return candidates.length;
}

interface FaststartPayload { itemId: string; title?: string; batch?: number; batches?: number }

export interface FaststartTarget {
  itemId: string;
  srcPath: string;
}

/** The file to rewrite, or null when it is gone, no longer a candidate, or the
 *  library/lock says the app may not touch it. Re-checked here and not only at
 *  enqueue time: a lock can be added while the job waits in the queue. */
function resolveTarget(itemId: string): FaststartTarget | null {
  const row = db.prepare(`
    SELECT gd.item_id, gd.relative_path, li.library_id, lib.source_path
    FROM gallery_details gd
    JOIN library_items li ON li.id = gd.item_id
    JOIN libraries lib ON lib.id = li.library_id
    WHERE gd.item_id = ? AND ${CANDIDATE_WHERE}
  `).get(itemId) as CandidateRow | undefined;
  if (!row) return null;
  if (!libraryAllowsDelete(row.library_id)) return null;
  if (lockCovering(row.library_id, row.relative_path)) return null;
  const root = validateLibrarySource(row.source_path); // throws on an unusable mount
  const srcPath = path.join(root, ...row.relative_path.split("/"));
  if (!srcPath.startsWith(root) || !fs.existsSync(srcPath)) return null;
  return { itemId, srcPath };
}

/** Run a binary to completion, keeping stderr for the log. */
function run(bin: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: err instanceof Error ? err.message : "spawn failed" });
      return;
    }
    // Background housekeeping on somebody's NAS: below everything the box is for.
    try { if (child.pid !== undefined) os.setPriority(child.pid, 19); } catch { /* unsupported here */ }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (err) => resolve({ ok: false, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

interface Probe { duration: number | null; videoCodec: string | null; audioCodec: string | null }

async function probe(filePath: string): Promise<Probe | null> {
  const result = await run(FFPROBE_BIN, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name",
    "-print_format", "json", filePath
  ]);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; codec_name?: string }[];
    };
    const streams = parsed.streams ?? [];
    const duration = Number(parsed.format?.duration);
    return {
      duration: Number.isFinite(duration) ? duration : null,
      videoCodec: streams.find((s) => s.codec_type === "video")?.codec_name ?? null,
      audioCodec: streams.find((s) => s.codec_type === "audio")?.codec_name ?? null
    };
  } catch {
    return null;
  }
}

/**
 * Rewrite one video with its index in front. Nothing replaces the original until
 * the new file has been probed and matched against it — a remux that quietly
 * dropped the audio track or half the running time must not be allowed to land on
 * top of a family video. Returns null on success, or why it didn't happen.
 */
export async function remuxInPlace(target: FaststartTarget): Promise<string | null> {
  const before = await probe(target.srcPath);
  if (!before) return "The video could not be read before rewriting it.";

  // Beside the original, so the replacement is a rename within one filesystem —
  // never a copy across devices that could be interrupted half-written. It keeps
  // the source's extension, because that is how ffmpeg picks the output container
  // (a plain .tmp is "Unable to choose an output format"), and it is dot-prefixed,
  // which is what stops a scan running alongside from cataloguing it as a video.
  const tmpPath = path.join(
    path.dirname(target.srcPath),
    `.${path.basename(target.srcPath)}.faststart-${nanoid(6)}${path.extname(target.srcPath)}`
  );
  try {
    const remux = await run(FFMPEG_BIN, [
      "-v", "error", "-i", target.srcPath,
      // Every track, copied verbatim; only the boxes are rewritten.
      "-map", "0", "-c", "copy", "-movflags", "+faststart",
      "-y", tmpPath
    ]);
    if (!remux.ok) {
      log.error(`faststart: ffmpeg failed for ${target.srcPath}\n${remux.stderr.trim() || "(no stderr)"}`);
      return "The video could not be rewritten.";
    }

    const after = await probe(tmpPath);
    if (!after) return "The rewritten video could not be read back, so the original was kept.";
    if (after.videoCodec !== before.videoCodec || after.audioCodec !== before.audioCodec) {
      return "The rewritten video did not carry the same tracks, so the original was kept.";
    }
    if (before.duration != null && after.duration != null && Math.abs(before.duration - after.duration) > 1) {
      return "The rewritten video did not run for the same time, so the original was kept.";
    }
    if (await readFaststart(tmpPath, path.extname(target.srcPath)) !== true) {
      return "The rewritten video still had its index at the end, so the original was kept.";
    }
    if (fs.statSync(tmpPath).size <= 0) return "The rewritten video was empty, so the original was kept.";

    // Everything checks out. The rename is the only moment the original is at risk,
    // and within one filesystem it is atomic.
    fs.renameSync(tmpPath, target.srcPath);
    const replaced = fs.statSync(target.srcPath);
    db.prepare(`
      UPDATE gallery_details
      SET faststart = 1, size = ?, modified_at = ?,
          -- The bytes moved, so a hash taken from them is stale; the duplicate scan
          -- re-takes it when it next needs one.
          content_hash = NULL, content_hash_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE item_id = ?
    `).run(replaced.size, replaced.mtime.toISOString(), target.itemId);
    return null;
  } finally {
    // A failed or abandoned attempt never leaves its temp file behind.
    fs.rmSync(tmpPath, { force: true });
  }
}

let queueRunning = false;

export async function processFaststartQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // A rewrite interrupted by a restart is safe to redo: the original is only
    // replaced at the very end, so an interrupted run left it as it was.
    requeueInterruptedJobs(FASTSTART_JOB_TYPE);

    for (;;) {
      // Yield to catalog/face scans — this is background housekeeping.
      if (libraryJobRunning()) break;

      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND run_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        ORDER BY run_at ASC LIMIT 1
      `).get(FASTSTART_JOB_TYPE) as Pick<JobRow, "id" | "payload"> | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1,
          locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as FaststartPayload;
      let target: FaststartTarget | null = null;
      try {
        target = resolveTarget(payload.itemId);
      } catch (err) {
        finishJob(job.id, err instanceof Error ? err.message : "The library could not be reached.");
        continue;
      }
      if (!target) {
        // Gone, already optimised, or now protected — nothing left to do.
        finishJob(job.id, null);
        continue;
      }

      let failure: string | null;
      try {
        failure = await remuxInPlace(target);
      } catch (err) {
        failure = err instanceof Error ? err.message : "The video could not be rewritten.";
      }
      finishJob(job.id, failure);
    }
  } finally {
    queueRunning = false;
  }
}

/** Complete a job, or retry/fail it with a reason the Tasks page can show. */
function finishJob(jobId: string, failure: string | null): void {
  if (!failure) {
    db.prepare(
      "UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?"
    ).run(jobId);
    return;
  }
  const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?")
    .get(jobId) as Pick<JobRow, "attempts" | "max_attempts">;
  if (attempts.attempts < attempts.max_attempts) {
    db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
      .run(new Date(Date.now() + 5000).toISOString(), failure, jobId);
  } else {
    db.prepare(
      "UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?"
    ).run(failure, jobId);
  }
}

// On the shared job poller (core/job-poller.ts).
export function startFaststartWorker(): () => void {
  return registerJobHandler({ name: "video streaming fix", types: [FASTSTART_JOB_TYPE], run: processFaststartQueue });
}
