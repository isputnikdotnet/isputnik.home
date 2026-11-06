import type Database from "better-sqlite3";

// Live Photos (docs/photo-sync-plan.md, phase 5; gallery/live-photos.ts): a still and
// the short .mov beside it with the same name are one photo. The clip is recorded on
// the still's row, as a print's back is (migration 84), and is never an item of its own.
//
// • motion_relative_path / motion_size / motion_modified_at — the clip and its change
//   detection (a pair on record is taken as it stands; only a changed clip is probed)
// • motion_duration — its length, for the lightbox
// • motion_web_key — an H.264 copy in the thumbnail store when the clip is HEVC
//
// A clip already catalogued as a video leaves the grid on the next scan, the way a
// photo that became a back does (soft-deleted, not reported missing).
export const version = 90;

export function up(db: Database.Database): void {
  const details = new Set((db.prepare("PRAGMA table_info(gallery_details)").all() as { name: string }[]).map((c) => c.name));
  if (details.size === 0) return;
  if (!details.has("motion_relative_path")) db.exec("ALTER TABLE gallery_details ADD COLUMN motion_relative_path TEXT");
  if (!details.has("motion_size")) db.exec("ALTER TABLE gallery_details ADD COLUMN motion_size INTEGER");
  if (!details.has("motion_modified_at")) db.exec("ALTER TABLE gallery_details ADD COLUMN motion_modified_at TEXT");
  if (!details.has("motion_duration")) db.exec("ALTER TABLE gallery_details ADD COLUMN motion_duration REAL");
  if (!details.has("motion_web_key")) db.exec("ALTER TABLE gallery_details ADD COLUMN motion_web_key TEXT");
}
