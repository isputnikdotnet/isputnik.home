import type Database from "better-sqlite3";

// 4.48.0: why a video's rewrite left it as it was. The reason only lived on the job,
// which is pruned, so Maintenance -> Videos kept offering "Optimise" on a file that
// had already said no. It now stays on the video (gallery/faststart.ts).
//
// Videos that have failed already are picked up from the jobs still on record: the
// newest job per video, when it failed over the file itself. A library that could
// not be reached is not a verdict on the file, and has its own wording.
export const version = 86;

const FILE_FAILURES = /^(Left as it is|The video could not be|The rewritten video)/;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_details)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("faststart_error")) {
    db.exec("ALTER TABLE gallery_details ADD COLUMN faststart_error TEXT");
  }

  const jobs = db.prepare(`
    SELECT json_extract(payload, '$.itemId') AS itemId, status, error
    FROM jobs WHERE type = 'FASTSTART_GALLERY_VIDEO'
    ORDER BY created_at ASC
  `).all() as { itemId: string | null; status: string; error: string | null }[];

  const newest = new Map(jobs.map((job) => [job.itemId, job]));
  const record = db.prepare("UPDATE gallery_details SET faststart_error = ? WHERE item_id = ? AND faststart = 0");
  for (const [itemId, job] of newest) {
    if (itemId && job.status === "failed" && job.error && FILE_FAILURES.test(job.error)) record.run(job.error, itemId);
  }
}
