import type Database from "better-sqlite3";

// 3.6.0 — linking a device from outside the house, during a registration
// window an admin opens for one person (device_link_windows, which schema.sql
// creates on its own). A request now remembers whether it came from outside,
// because the approval step can't work it out later: by then the caller is the
// phone, not the display. New column on an existing table.
//
// Existing rows default to 0 — not remote — which is what every request made
// before 3.6.0 was: 3.5.0 refused them all.
export const version = 38;

export function up(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(device_link_requests)").all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("remote")) {
    db.exec("ALTER TABLE device_link_requests ADD COLUMN remote INTEGER NOT NULL DEFAULT 0 CHECK (remote IN (0, 1))");
  }
}
