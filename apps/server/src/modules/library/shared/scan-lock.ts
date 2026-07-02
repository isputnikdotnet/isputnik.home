import { db } from "../../../db.js";

// Heavy library work — catalog scans and face recognition — is limited to ONE
// running job at a time server-wide, regardless of media type. Every scan worker
// calls libraryJobRunning() before claiming its next queued job; while any other
// library job is mid-run, the rest simply stay 'pending' and the 2-second pollers
// pick them up once the running job finishes. Claims happen synchronously right
// after this check (better-sqlite3, single process), so two workers cannot slip
// past it at the same time.
const LIBRARY_JOB_TYPES = [
  "SCAN_AUDIOBOOK_LIBRARY",
  "SCAN_EBOOK_LIBRARY",
  "SCAN_GALLERY_LIBRARY",
  "SCAN_GALLERY_FACES"
];

export function libraryJobRunning(): boolean {
  const placeholders = LIBRARY_JOB_TYPES.map(() => "?").join(", ");
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND type IN (${placeholders})`
  ).get(...LIBRARY_JOB_TYPES) as { n: number };
  return row.n > 0;
}
