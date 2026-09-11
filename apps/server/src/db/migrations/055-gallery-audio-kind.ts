import type Database from "better-sqlite3";

// 3.44.0 — gallery audio assets (voice recordings / narration). Widens the
// gallery_details.kind CHECK to admit 'audio'. SQLite cannot alter a CHECK,
// so the table is rebuilt: stage the rows, drop, recreate with the widened
// constraint, restore. No RENAME anywhere (ALTER TABLE RENAME rewrites
// referencing FKs and has corrupted a dev database before). Nothing
// references gallery_details, so drop/recreate is FK-safe, and the insert
// uses an explicit column list read from the staged table — upgraded
// databases can carry these columns in a different order than schema.sql.
export const version = 55;

export function up(db: Database.Database): void {
  const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gallery_details'")
    .get() as { sql: string } | undefined)?.sql ?? "";
  if (ddl.includes("'audio'")) return; // fresh DB built from the current schema.sql

  db.exec("CREATE TABLE gallery_details_migr AS SELECT * FROM gallery_details");
  db.exec("DROP TABLE gallery_details");
  db.exec(`
        CREATE TABLE gallery_details (
          item_id             TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
          kind                TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'video', 'audio')),
          relative_path       TEXT NOT NULL,
          mime_type           TEXT,
          size                INTEGER,
          width               INTEGER,
          height              INTEGER,
          orientation         INTEGER,
          rotation            INTEGER NOT NULL DEFAULT 0,
          duration_seconds    REAL,
          taken_at            TEXT,
          taken_at_source     TEXT NOT NULL DEFAULT 'scan' CHECK (taken_at_source IN ('scan', 'manual')),
          modified_at         TEXT,
          gps_lat             REAL,
          gps_lng             REAL,
          gps_source          TEXT NOT NULL DEFAULT 'scan' CHECK (gps_source IN ('scan', 'manual')),
          camera_make         TEXT,
          camera_model        TEXT,
          preview_storage_key TEXT,
          playable            INTEGER,
          phash               TEXT,
          content_hash        TEXT,
          content_hash_at     TEXT,
          web_video_key       TEXT,
          web_video_attempts  INTEGER NOT NULL DEFAULT 0,
          updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
      `);
  const staged = (db.prepare("PRAGMA table_info(gallery_details_migr)").all() as { name: string }[])
    .map((c) => c.name);
  const rebuilt = new Set(
    (db.prepare("PRAGMA table_info(gallery_details)").all() as { name: string }[]).map((c) => c.name)
  );
  const cols = staged.filter((name) => rebuilt.has(name)).map((name) => `"${name}"`).join(", ");
  db.exec(`INSERT INTO gallery_details (${cols}) SELECT ${cols} FROM gallery_details_migr`);
  db.exec("DROP TABLE gallery_details_migr");
  db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_taken_at ON gallery_details(taken_at)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_size ON gallery_details(size)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_content_hash ON gallery_details(content_hash) WHERE content_hash IS NOT NULL");
}
