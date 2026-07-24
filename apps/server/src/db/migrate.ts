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
  },
  // Curated gallery people: a face-group the user has merged into keeps its identity
  // across reclustering, like a named person. Conditional because schema.sql (run
  // first) already adds the column on fresh databases.
  {
    version: 9,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_people)") as { name: string }[];
      if (!columns.some((column) => column.name === "curated")) {
        db.exec("ALTER TABLE gallery_people ADD COLUMN curated INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  // jobs.started_at: when the worker began RUNNING a job, so finished-task duration
  // measures run time rather than queue-wait time. Conditional because schema.sql
  // (run first) already adds it on fresh databases.
  {
    version: 10,
    up: (db) => {
      const columns = db.pragma("table_info(jobs)") as { name: string }[];
      if (!columns.some((column) => column.name === "started_at")) {
        db.exec("ALTER TABLE jobs ADD COLUMN started_at TEXT");
      }
    }
  },
  // Manual-location protection: a user-set gallery GPS point (Info panel) must
  // survive rescans, like taken_at_source does for the date. Existing rows default
  // to 'scan'. Conditional because schema.sql (run first) already adds it on fresh
  // databases.
  {
    version: 11,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_details)") as { name: string }[];
      if (!columns.some((column) => column.name === "gps_source")) {
        db.exec("ALTER TABLE gallery_details ADD COLUMN gps_source TEXT NOT NULL DEFAULT 'scan'");
      }
    }
  },
  // Browser-playability flag for videos (1/0/NULL). Existing video rows stay NULL
  // until a rescan re-probes them (the scanner backfills NULL-playable videos even
  // on an unchanged pass). Conditional because schema.sql (run first) already adds
  // the column on fresh databases.
  {
    version: 12,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_details)") as { name: string }[];
      if (!columns.some((column) => column.name === "playable")) {
        db.exec("ALTER TABLE gallery_details ADD COLUMN playable INTEGER");
      }
    }
  },
  // Auto-save a rendered slideshow movie into a gallery library: record which library
  // the latest render was saved to, the stable path under its root (so a re-render
  // overwrites in place), and the cataloged item's id. Conditional because schema.sql
  // (run first) already adds the columns on fresh databases.
  {
    version: 13,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_slideshows)") as { name: string }[];
      const has = (name: string) => columns.some((column) => column.name === name);
      if (!has("movie_library_id")) db.exec("ALTER TABLE gallery_slideshows ADD COLUMN movie_library_id TEXT REFERENCES libraries(id) ON DELETE SET NULL");
      if (!has("movie_relative_path")) db.exec("ALTER TABLE gallery_slideshows ADD COLUMN movie_relative_path TEXT");
      if (!has("movie_item_id")) db.exec("ALTER TABLE gallery_slideshows ADD COLUMN movie_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL");
    }
  },
  // 'random' slideshow transition: widen the transition CHECK. SQLite can't alter a
  // CHECK in place, so existing databases rebuild the table. NO renames: with
  // foreign_keys=ON a RENAME rewrites gallery_slideshow_items' REFERENCES clause to
  // follow the renamed table (even under legacy_alter_table — measured), which would
  // strand the child on the dropped copy and cascade its rows away. Instead both
  // tables are backed up, dropped (child first), recreated verbatim from schema.sql
  // with the widened CHECK, and restored — the whole rebuild is inside this
  // migration's transaction. Skipped when the CHECK already allows 'random' (fresh
  // DBs get it from schema.sql, which runs before migrations).
  {
    version: 14,
    up: (db) => {
      const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gallery_slideshows'")
        .get() as { sql: string } | undefined;
      if (!master || master.sql.includes("'random'")) return;
      db.exec(`
        CREATE TABLE gallery_slideshows_backup AS SELECT * FROM gallery_slideshows;
        CREATE TABLE gallery_slideshow_items_backup AS SELECT * FROM gallery_slideshow_items;
        DROP TABLE gallery_slideshow_items;
        DROP TABLE gallery_slideshows;
        CREATE TABLE gallery_slideshows (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          source_kind    TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'memory', 'album')),
          source_ref     TEXT,
          music_track_id TEXT REFERENCES gallery_music_tracks(id) ON DELETE SET NULL,
          transition     TEXT NOT NULL DEFAULT 'crossfade'
                           CHECK (transition IN ('none', 'crossfade', 'fade', 'slide', 'kenburns', 'random')),
          slide_seconds  REAL NOT NULL DEFAULT 4,
          render_status  TEXT NOT NULL DEFAULT 'draft'
                           CHECK (render_status IN ('draft', 'queued', 'rendering', 'ready', 'failed')),
          render_job_id  TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          output_storage_key TEXT,
          output_bytes   INTEGER,
          rendered_at    TEXT,
          render_error   TEXT,
          movie_library_id    TEXT REFERENCES libraries(id) ON DELETE SET NULL,
          movie_relative_path TEXT,
          movie_item_id       TEXT REFERENCES library_items(id) ON DELETE SET NULL,
          created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE gallery_slideshow_items (
          slideshow_id  TEXT NOT NULL REFERENCES gallery_slideshows(id) ON DELETE CASCADE,
          item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
          position      REAL NOT NULL,
          dwell_seconds REAL,
          added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (slideshow_id, item_id)
        );
        CREATE INDEX idx_gallery_slideshow_items_item ON gallery_slideshow_items (item_id);
        INSERT INTO gallery_slideshows
          SELECT id, name, source_kind, source_ref, music_track_id, transition, slide_seconds,
                 render_status, render_job_id, output_storage_key, output_bytes, rendered_at,
                 render_error, movie_library_id, movie_relative_path, movie_item_id,
                 created_by, created_at, updated_at
          FROM gallery_slideshows_backup;
        INSERT INTO gallery_slideshow_items
          SELECT slideshow_id, item_id, position, dwell_seconds, added_at
          FROM gallery_slideshow_items_backup;
        DROP TABLE gallery_slideshows_backup;
        DROP TABLE gallery_slideshow_items_backup;
      `);
    }
  },
  // Repair for databases hit by v14's first, flawed rebuild (renamed the parent with
  // foreign_keys ON, which rewrote gallery_slideshow_items' REFERENCES clause to the
  // dropped "gallery_slideshows_old" — leaving every item insert failing with "no such
  // table" and the membership rows cascade-deleted). Rebuilds the child table pointing
  // at gallery_slideshows again. No-op unless the dangling reference is present.
  {
    version: 15,
    up: (db) => {
      const child = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gallery_slideshow_items'")
        .get() as { sql: string } | undefined;
      if (!child || !child.sql.includes("gallery_slideshows_old")) return;
      db.exec(`
        CREATE TABLE gallery_slideshow_items_repair AS SELECT * FROM gallery_slideshow_items;
        DROP TABLE gallery_slideshow_items;
        CREATE TABLE gallery_slideshow_items (
          slideshow_id  TEXT NOT NULL REFERENCES gallery_slideshows(id) ON DELETE CASCADE,
          item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
          position      REAL NOT NULL,
          dwell_seconds REAL,
          added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (slideshow_id, item_id)
        );
        CREATE INDEX idx_gallery_slideshow_items_item ON gallery_slideshow_items (item_id);
        INSERT INTO gallery_slideshow_items
          SELECT slideshow_id, item_id, position, dwell_seconds, added_at
          FROM gallery_slideshow_items_repair;
        DROP TABLE gallery_slideshow_items_repair;
      `);
    }
  },
  // Per-slideshow transition length (seconds), driving both the live player and the
  // rendered movie's xfade. Existing slideshows keep the previous fixed 2s. Conditional
  // because schema.sql (run first) already adds the column on fresh databases.
  {
    version: 16,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_slideshows)") as { name: string }[];
      if (!columns.some((column) => column.name === "transition_seconds")) {
        db.exec("ALTER TABLE gallery_slideshows ADD COLUMN transition_seconds REAL NOT NULL DEFAULT 2");
      }
    }
  },
  // Perceptual fingerprint (dHash) for photos, so memory suggestions can skip
  // near-duplicate shots. NULL until the next gallery scan backfills it from the
  // cached preview thumbnail. Conditional because schema.sql (run first) already
  // adds the column on fresh databases.
  {
    version: 17,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_details)") as { name: string }[];
      if (!columns.some((column) => column.name === "phash")) {
        db.exec("ALTER TABLE gallery_details ADD COLUMN phash TEXT");
      }
    }
  },
  // 'dipblack' slideshow transition (dip to black): widen the transition CHECK again.
  // Same no-rename rebuild as v14 — with foreign_keys=ON a RENAME rewrites the child's
  // REFERENCES clause even under legacy_alter_table (measured), so both tables are
  // backed up, dropped (child first), recreated verbatim from schema.sql, and restored.
  // Skipped when the CHECK already allows 'dipblack' (fresh DBs get it from schema.sql).
  {
    version: 18,
    up: (db) => {
      const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gallery_slideshows'")
        .get() as { sql: string } | undefined;
      if (!master || master.sql.includes("'dipblack'")) return;
      db.exec(`
        CREATE TABLE gallery_slideshows_backup AS SELECT * FROM gallery_slideshows;
        CREATE TABLE gallery_slideshow_items_backup AS SELECT * FROM gallery_slideshow_items;
        DROP TABLE gallery_slideshow_items;
        DROP TABLE gallery_slideshows;
        CREATE TABLE gallery_slideshows (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          source_kind    TEXT NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual', 'memory', 'album')),
          source_ref     TEXT,
          music_track_id TEXT REFERENCES gallery_music_tracks(id) ON DELETE SET NULL,
          transition     TEXT NOT NULL DEFAULT 'crossfade'
                           CHECK (transition IN ('none', 'crossfade', 'fade', 'slide', 'kenburns', 'dipblack', 'random')),
          slide_seconds  REAL NOT NULL DEFAULT 4,
          transition_seconds REAL NOT NULL DEFAULT 2,
          render_status  TEXT NOT NULL DEFAULT 'draft'
                           CHECK (render_status IN ('draft', 'queued', 'rendering', 'ready', 'failed')),
          render_job_id  TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          output_storage_key TEXT,
          output_bytes   INTEGER,
          rendered_at    TEXT,
          render_error   TEXT,
          movie_library_id    TEXT REFERENCES libraries(id) ON DELETE SET NULL,
          movie_relative_path TEXT,
          movie_item_id       TEXT REFERENCES library_items(id) ON DELETE SET NULL,
          created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE gallery_slideshow_items (
          slideshow_id  TEXT NOT NULL REFERENCES gallery_slideshows(id) ON DELETE CASCADE,
          item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
          position      REAL NOT NULL,
          dwell_seconds REAL,
          added_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (slideshow_id, item_id)
        );
        CREATE INDEX idx_gallery_slideshow_items_item ON gallery_slideshow_items (item_id);
        INSERT INTO gallery_slideshows
          SELECT id, name, source_kind, source_ref, music_track_id, transition, slide_seconds,
                 transition_seconds, render_status, render_job_id, output_storage_key, output_bytes,
                 rendered_at, render_error, movie_library_id, movie_relative_path, movie_item_id,
                 created_by, created_at, updated_at
          FROM gallery_slideshows_backup;
        INSERT INTO gallery_slideshow_items
          SELECT slideshow_id, item_id, position, dwell_seconds, added_at
          FROM gallery_slideshow_items_backup;
        DROP TABLE gallery_slideshows_backup;
        DROP TABLE gallery_slideshow_items_backup;
      `);
    }
  },
  // render_stale: a rendered movie now stays visible after an edit but is flagged out
  // of date (instead of the render dropping back to 'draft' and vanishing). Conditional
  // because schema.sql (run first) already adds the column on fresh databases.
  {
    version: 19,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_slideshows)") as { name: string }[];
      if (!columns.some((column) => column.name === "render_stale")) {
        db.exec("ALTER TABLE gallery_slideshows ADD COLUMN render_stale INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  // Web-playable transcode of a browser-undecodable video: the store key of the H.264
  // copy + an attempt counter. Conditional because schema.sql (run first) already adds
  // the columns on fresh databases.
  {
    version: 20,
    up: (db) => {
      const columns = db.pragma("table_info(gallery_details)") as { name: string }[];
      const has = (name: string) => columns.some((column) => column.name === name);
      if (!has("web_video_key")) db.exec("ALTER TABLE gallery_details ADD COLUMN web_video_key TEXT");
      if (!has("web_video_attempts")) db.exec("ALTER TABLE gallery_details ADD COLUMN web_video_attempts INTEGER NOT NULL DEFAULT 0");
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
