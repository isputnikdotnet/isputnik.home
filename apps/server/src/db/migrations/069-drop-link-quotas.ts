import type Database from "better-sqlite3";

// Drop links (docs/photo-inbox-proposal.md, phase 3): a guest link that
// uploads into a Photo Inbox carries its own quota and may close itself
// after one delivery. The share_link_drops table comes from schema.sql.
export const version = 69;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(share_links)").all() as { name: string }[]).map((c) => c.name)
  );
  if (columns.size === 0) return;
  if (!columns.has("max_files")) db.exec("ALTER TABLE share_links ADD COLUMN max_files INTEGER");
  if (!columns.has("max_bytes")) db.exec("ALTER TABLE share_links ADD COLUMN max_bytes INTEGER");
  if (!columns.has("one_time")) db.exec("ALTER TABLE share_links ADD COLUMN one_time INTEGER NOT NULL DEFAULT 0");
}
