import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));

// Baseline schema (migration 0) lives in schema.sql; it is idempotent
// (CREATE TABLE IF NOT EXISTS). After it, `baseline` is the version a fresh DB
// is stamped with, and `migrations` are ordered, append-only forward changes
// applied to existing databases once there is data worth keeping.
const baseline = 1;
const migrations: { version: number; up: (db: Database.Database) => void }[] = [
  // Custom scan rules: items can be owned by a rule (NULL = the default scanner).
  // The library_scan_rules table is created by schema.sql before migrations run.
  { version: 2, up: (db) => db.exec("ALTER TABLE library_items ADD COLUMN scan_rule_id TEXT REFERENCES library_scan_rules(id) ON DELETE SET NULL") },
  // Per-user e-reader (Kindle/Kobo) delivery address for "Send to e-reader".
  { version: 3, up: (db) => db.exec("ALTER TABLE users ADD COLUMN ereader_email TEXT") },
  // Two-factor auth (TOTP): per-user enable flag, encrypted TOTP secret, and hashed
  // single-use backup codes (JSON array). Secret/code handling lives in core/mfa.ts.
  {
    version: 4,
    up: (db) => {
      db.exec("ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE users ADD COLUMN mfa_secret TEXT");
      db.exec("ALTER TABLE users ADD COLUMN mfa_backup_codes TEXT");
    }
  },
  // Gallery (photo/video) library type: per-asset detail table. schema.sql creates
  // it via CREATE TABLE IF NOT EXISTS on fresh databases; this applies it to
  // existing ones. Idempotent so it's safe to run after the baseline create.
  {
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS gallery_details (
          item_id             TEXT PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
          kind                TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'video')),
          relative_path       TEXT NOT NULL,
          mime_type           TEXT,
          size                INTEGER,
          width               INTEGER,
          height              INTEGER,
          orientation         INTEGER,
          duration_seconds    REAL,
          taken_at            TEXT,
          modified_at         TEXT,
          gps_lat             REAL,
          gps_lng             REAL,
          camera_make         TEXT,
          camera_model        TEXT,
          preview_storage_key TEXT,
          updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_gallery_taken_at ON gallery_details(taken_at)");
    }
  },
  // Manual-date protection: a user-set gallery date (edit modal) must survive
  // rescans. Existing rows default to 'scan'. Conditional because schema.sql (run
  // before migrations) already creates the column on fresh databases.
  {
    version: 6,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_details)") as { name: string }[];
      if (!columns.some((column) => column.name === "taken_at_source")) {
        db.exec("ALTER TABLE gallery_details ADD COLUMN taken_at_source TEXT NOT NULL DEFAULT 'scan'");
      }
    }
  },
  // Manual photo rotation: a user-applied clockwise angle (0/90/180/270) baked into
  // the regenerated thumbnails on top of EXIF orientation. Existing rows default to
  // 0. Conditional because schema.sql (run first) already adds it on fresh databases.
  {
    version: 7,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_details)") as { name: string }[];
      if (!columns.some((column) => column.name === "rotation")) {
        db.exec("ALTER TABLE gallery_details ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  // Editable schedule details for scheduled jobs: run time plus day-of-week (weekly)
  // and day-of-month (monthly). NULL = the job's built-in default. Conditional
  // because schema.sql (run first) already adds them on fresh databases.
  {
    version: 8,
    up: (db) => {
      const columns = db.pragma("table_info(scheduled_jobs)") as { name: string }[];
      const has = (name: string) => columns.some((column) => column.name === name);
      if (!has("run_time")) db.exec("ALTER TABLE scheduled_jobs ADD COLUMN run_time TEXT");
      if (!has("day_of_week")) db.exec("ALTER TABLE scheduled_jobs ADD COLUMN day_of_week INTEGER");
      if (!has("day_of_month")) db.exec("ALTER TABLE scheduled_jobs ADD COLUMN day_of_month INTEGER");
    }
  }
];

function userVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

export function migrate(db: Database.Database): void {
  const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  db.exec(schema);

  if (userVersion(db) < baseline) {
    db.pragma(`user_version = ${baseline}`);
  }

  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (userVersion(db) < m.version) {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
  }
}
