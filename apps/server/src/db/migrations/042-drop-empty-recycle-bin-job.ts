import type Database from "better-sqlite3";

// 3.25.0 — the "Empty recycle bin" scheduled job is gone, replaced by
// "purge_expired_trash". It emptied the entire bin on a cadence regardless of
// retention, and it shipped enabled, so an install that never chose it lost
// hand-deleted items a week after deleting them — the 30-day window it sat
// beside was never reached. Drop the row: no definition answers to that key
// any more, and the enabled flag on it was seeded rather than asked for. An
// admin who genuinely wants the whole bin cleared still has the button on the
// Recycle Bin page. Not something schema.sql can do — it is stored state.
export const version = 42;

export function up(db: Database.Database): void {
  db.prepare("DELETE FROM scheduled_jobs WHERE key = 'empty_recycle_bin'").run();
}
