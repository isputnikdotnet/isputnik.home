import type Database from "better-sqlite3";

// Photo Sync phase 5 (docs/photo-sync-plan.md): a phone's last problem is over once it
// backs up again. `resolved_at` is set by the first request that went well after it
// (any contact for a network refusal, a stored or already-held file for the rest) and
// cleared when a new problem is noted. The table is new in phase 4 (schema.sql), so
// only a database that already has it needs the column.
export const version = 89;

export function up(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(photo_sync_device_status)").all() as { name: string }[]).map((c) => c.name));
  if (columns.size > 0 && !columns.has("resolved_at")) db.exec("ALTER TABLE photo_sync_device_status ADD COLUMN resolved_at TEXT");
}
