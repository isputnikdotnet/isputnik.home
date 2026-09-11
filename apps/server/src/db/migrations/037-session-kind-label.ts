import type Database from "better-sqlite3";

// 3.5.0 — link a device. A session now knows whether it was minted by someone
// typing a password or by a display being linked from a phone, and carries the
// name its owner gave it. New columns on an existing table, so schema.sql alone
// can't reach a database that already has one.
//
// Both land on every existing session as 'browser' with no label, which is
// exactly what those sessions are: the CHECK and the DEFAULT together mean an
// upgraded install has nothing to backfill.
export const version = 37;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("kind")) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser', 'device'))"
    );
  }
  if (!columns.has("label")) {
    db.exec("ALTER TABLE sessions ADD COLUMN label TEXT");
  }
}
