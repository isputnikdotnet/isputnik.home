import type Database from "better-sqlite3";

// Photo review (docs/photo-review-plan.md, phase 1): approximate dates
// ("about 1962"), a place as a person wrote it, and who went through the
// photo in Review mode. All manual-only; the scan UPSERT never touches them.
export const version = 70;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(gallery_details)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("taken_precision")) {
    db.exec("ALTER TABLE gallery_details ADD COLUMN taken_precision TEXT NOT NULL DEFAULT 'time' CHECK (taken_precision IN ('time', 'day', 'month', 'year', 'decade'))");
  }
  if (!columns.has("taken_approx")) db.exec("ALTER TABLE gallery_details ADD COLUMN taken_approx INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("place_text")) db.exec("ALTER TABLE gallery_details ADD COLUMN place_text TEXT");
  if (!columns.has("reviewed_at")) db.exec("ALTER TABLE gallery_details ADD COLUMN reviewed_at TEXT");
  if (!columns.has("reviewed_by")) db.exec("ALTER TABLE gallery_details ADD COLUMN reviewed_by TEXT");
}
