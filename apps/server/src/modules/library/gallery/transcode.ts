// Convert browser-undecodable videos (playable = 0 — legacy MPEG-4/AMR, etc.) to a
// web-playable H.264/AAC copy, stored in the thumbnail bucket beside the item's other
// derived files. The ORIGINAL is never touched, so this works on read-only media mounts
// and preserves the source; the stream route serves the copy for inline playback
// (?web=1) while downloads keep the original. Runs as background jobs on the shared
// `jobs` table (one at a time — CPU-heavy) enqueued by the weekly maintenance job.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import ffmpegStatic from "ffmpeg-static";
import { db } from "../../../db.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { libraryJobRunning } from "../shared/scan-lock.js";
import { jobProgressWriter } from "../shared/job-progress.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";

const FFMPEG_BIN: string = (ffmpegStatic as unknown as string | null) || "ffmpeg";

export const TRANSCODE_JOB_TYPE = "TRANSCODE_GALLERY_VIDEO";

// A file whose transcode keeps failing (truly corrupt / unsupported) is retried this
// many times, then left alone so it doesn't sit in every weekly batch forever.
export const MAX_TRANSCODE_ATTEMPTS = 3;

// Cap the long edge so an old HD clip doesn't take an age to encode or balloon on disk;
// the untouched original stays for a full-resolution download.
const MAX_WIDTH = 1280;

interface TranscodePayload { itemId: string; batch?: number; batches?: number }

interface BacklogItem {
  item_id: string;
  library_id: string;
  source_path: string;
  relative_path: string;
  duration_seconds: number | null;
}

// Videos that need (and can still get) a web copy: not browser-playable, none made yet,
// and under the retry cap. Shared by the count, the enqueue, and the tests.
const BACKLOG_SQL = `
  FROM gallery_details gd
  JOIN library_items li ON li.id = gd.item_id
  JOIN libraries lib ON lib.id = li.library_id
  WHERE gd.kind = 'video' AND gd.playable = 0
    AND gd.web_video_key IS NULL
    AND gd.web_video_attempts < ${MAX_TRANSCODE_ATTEMPTS}
    AND li.deleted_at IS NULL AND li.status = 'ready'
`;

export function unplayableBacklogCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS n ${BACKLOG_SQL}`).get() as { n: number }).n;
}

// Item ids already lined up so a re-run doesn't double-queue the same video.
function queuedItemIds(): Set<string> {
  const rows = db.prepare(
    "SELECT json_extract(payload, '$.itemId') AS itemId FROM jobs WHERE type = ? AND status IN ('pending', 'running')"
  ).all(TRANSCODE_JOB_TYPE) as { itemId: string | null }[];
  return new Set(rows.map((r) => r.itemId).filter((id): id is string => Boolean(id)));
}

// Queue up to `limit` conversions as numbered batch jobs (so the Tasks page shows the
// backlog as "Video conversion · batch 2/20"). Returns how many were queued.
export function enqueueTranscodeBatch(limit: number): number {
  const alreadyQueued = queuedItemIds();
  const candidates = (db.prepare(`SELECT gd.item_id AS item_id ${BACKLOG_SQL} ORDER BY gd.size ASC`).all() as { item_id: string }[])
    .map((r) => r.item_id)
    .filter((id) => !alreadyQueued.has(id))
    .slice(0, Math.max(0, limit));
  const total = candidates.length;
  candidates.forEach((itemId, i) => {
    db.prepare("INSERT INTO jobs (id, type, payload, status, max_attempts) VALUES (?, ?, ?, 'pending', 2)")
      .run(nanoid(16), TRANSCODE_JOB_TYPE, JSON.stringify({ itemId, batch: i + 1, batches: total } satisfies TranscodePayload));
  });
  return total;
}

// The source file + where its web copy goes, or null if the item vanished / can't be read.
function resolveItem(itemId: string): { srcPath: string; storageKey: string; finalPath: string; duration: number | null } | null {
  const row = db.prepare(`
    SELECT gd.item_id, li.library_id, lib.source_path, gd.relative_path, gd.duration_seconds
    ${BACKLOG_SQL.replace("WHERE", "WHERE gd.item_id = ? AND")}
  `).get(itemId) as BacklogItem | undefined;
  if (!row) return null;
  const root = validateLibrarySource(row.source_path); // throws on an unusable mount
  const srcPath = path.join(root, ...row.relative_path.split("/"));
  if (!srcPath.startsWith(root) || !fs.existsSync(srcPath)) return null;
  const storageKey = thumbnailStorageKey(row.library_id, itemId, `${itemId}-web.mp4`);
  return { srcPath, storageKey, finalPath: thumbnailAbsolutePath(storageKey), duration: row.duration_seconds };
}

// Run ffmpeg, parsing -progress for elapsed seconds so the Tasks page can show a %.
// Resolves false on any non-zero exit / spawn failure.
function runTranscode(srcPath: string, outPath: string, durationSec: number, onProgress: (elapsed: number, total: number) => void): Promise<boolean> {
  const args = [
    "-v", "error", "-i", srcPath,
    "-vf", `scale='min(${MAX_WIDTH},iw)':-2`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats", "-y", outPath
  ];
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(FFMPEG_BIN, args, { windowsHide: true }); } catch { resolve(false); return; }
    const total = Math.max(1, Math.round(durationSec));
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const match = /^out_time_us=(\d+)/.exec(line);
        if (match) onProgress(Math.min(total, Math.round(Number(match[1]) / 1_000_000)), total);
      }
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// Bump the retry counter when a conversion fails, so a permanently-bad file eventually
// drops out of the weekly backlog.
export function recordTranscodeFailure(itemId: string): void {
  db.prepare("UPDATE gallery_details SET web_video_attempts = web_video_attempts + 1 WHERE item_id = ?").run(itemId);
}

let queueRunning = false;

export async function processTranscodeQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    // A conversion interrupted by a restart: re-queue it (idempotent — it re-encodes).
    db.prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE type = ? AND status = 'running'").run(TRANSCODE_JOB_TYPE);

    for (;;) {
      // Yield to catalog/face scans — this is the lowest-priority background task.
      if (libraryJobRunning()) break;

      const job = db.prepare(`
        SELECT id, payload FROM jobs
        WHERE type = ? AND status = 'pending' AND datetime(run_at) <= datetime('now')
        ORDER BY datetime(run_at) ASC LIMIT 1
      `).get(TRANSCODE_JOB_TYPE) as { id: string; payload: string } | undefined;
      if (!job) break;

      const claim = db.prepare(`
        UPDATE jobs SET status = 'running', attempts = attempts + 1,
          locked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_by = ?
        WHERE id = ? AND status = 'pending'
      `).run(process.pid.toString(), job.id);
      if (claim.changes === 0) continue;

      const payload = JSON.parse(job.payload) as TranscodePayload;
      const target = resolveItem(payload.itemId);
      if (!target) {
        // Item removed, no longer eligible, or its file is gone — nothing to do.
        db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?").run(job.id);
        continue;
      }

      fs.mkdirSync(path.dirname(target.finalPath), { recursive: true });
      // Sweep stale temp files from a conversion the restart interrupted.
      try {
        const dir = path.dirname(target.finalPath);
        const prefix = `${path.basename(target.finalPath)}.tmp-`;
        for (const entry of fs.readdirSync(dir)) if (entry.startsWith(prefix)) fs.rmSync(path.join(dir, entry), { force: true });
      } catch { /* best-effort */ }
      const tmpPath = `${target.finalPath}.tmp-${nanoid(6)}.mp4`;
      const writeProgress = jobProgressWriter(job.id, payload);

      const ok = await runTranscode(target.srcPath, tmpPath, target.duration ?? 1, writeProgress);
      if (!ok) {
        fs.rmSync(tmpPath, { force: true });
        recordTranscodeFailure(payload.itemId);
        const attempts = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(job.id) as { attempts: number; max_attempts: number };
        if (attempts.attempts < attempts.max_attempts) {
          db.prepare("UPDATE jobs SET status = 'pending', run_at = ?, locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run(new Date(Date.now() + 5000).toISOString(), "Conversion failed", job.id);
        } else {
          db.prepare("UPDATE jobs SET status = 'failed', failed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL, error = ? WHERE id = ?")
            .run("The video couldn't be converted.", job.id);
        }
        continue;
      }

      try { fs.renameSync(tmpPath, target.finalPath); } catch { fs.rmSync(tmpPath, { force: true }); recordTranscodeFailure(payload.itemId); continue; }
      const bytes = fs.statSync(target.finalPath).size;
      db.prepare("UPDATE gallery_details SET web_video_key = ? WHERE item_id = ?").run(target.storageKey, payload.itemId);
      writeResult(job.id, { bytes });
      db.prepare("UPDATE jobs SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), locked_at = NULL, locked_by = NULL WHERE id = ?").run(job.id);
    }
  } finally {
    queueRunning = false;
  }
}

// Merge a final result into the job payload (preserving progress) for the Tasks history.
function writeResult(jobId: string, result: Record<string, unknown>): void {
  const row = db.prepare("SELECT payload FROM jobs WHERE id = ?").get(jobId) as { payload: string } | undefined;
  let payload: Record<string, unknown> = {};
  try { payload = row ? JSON.parse(row.payload) : {}; } catch { /* start fresh on a bad payload */ }
  db.prepare("UPDATE jobs SET payload = ? WHERE id = ?").run(JSON.stringify({ ...payload, result }), jobId);
}

export function startTranscodeWorker(): () => void {
  const timer = setInterval(() => { void processTranscodeQueue().catch(() => { /* logged per-job */ }); }, 2000);
  return () => clearInterval(timer);
}
