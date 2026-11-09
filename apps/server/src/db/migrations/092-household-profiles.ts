import type Database from "better-sqlite3";

// Viewing profiles become the household's (docs/tv-profiles-plan.md). 4.73.1 shipped them
// per account (viewing_profiles.user_id, plus a sections column); they are now set up by
// an admin on the video page and offered to everyone, video only. Existing profiles are
// kept as household ones, in their order, and the TVs wearing them keep wearing them.
//
// The table is rebuilt because user_id is a foreign key (SQLite can't drop it): copy,
// drop, rename. Dropping the old table sets sessions.profile_id to NULL through its
// ON DELETE SET NULL, so the sessions' choices are put back once the new one has the name.
//
// viewing_profile_pins (one PIN per account) was never released; the household's PIN is
// viewing_profile_pin, from schema.sql.
export const version = 92;

export function up(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS viewing_profile_pins");
  const columns = new Set((db.prepare("PRAGMA table_info(viewing_profiles)").all() as { name: string }[]).map((c) => c.name));
  if (columns.size === 0 || !columns.has("user_id")) return;

  const worn = db.prepare("SELECT id, profile_id FROM sessions WHERE profile_id IS NOT NULL").all() as { id: string; profile_id: string }[];
  db.exec(`
    CREATE TABLE viewing_profiles_household (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      avatar      TEXT NOT NULL,
      position    INTEGER NOT NULL DEFAULT 0,
      restricted  INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
      libraries   TEXT,
      rows        TEXT,
      created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO viewing_profiles_household (id, name, avatar, position, restricted, libraries, rows, created_by, created_at, updated_at)
      SELECT id, name, avatar,
             ROW_NUMBER() OVER (ORDER BY position, created_at) - 1,
             restricted, libraries, rows, user_id, created_at, updated_at
      FROM viewing_profiles;
    DROP TABLE viewing_profiles;
    ALTER TABLE viewing_profiles_household RENAME TO viewing_profiles;
    DROP INDEX IF EXISTS idx_viewing_profiles_user;
  `);
  const restore = db.prepare("UPDATE sessions SET profile_id = ? WHERE id = ?");
  for (const row of worn) restore.run(row.profile_id, row.id);
}
