import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));

// The whole schema lives in schema.sql and is idempotent (CREATE TABLE IF NOT
// EXISTS), so a fresh database is built in one pass with no migration history to
// replay. Version 2.0.0 folded migrations 2-22 back into schema.sql and reset
// the baseline; `migrations` is empty again and grows only when a released
// schema has to change in a way schema.sql alone can't apply to existing data
// (a new column on an existing table, or a widened CHECK).
const baseline = 23;

// Databases stamped below this were completed by the migrations that 2.0.0
// removed. 22 (the last 1.x version) is already fully migrated and adopts the
// new baseline untouched; anything older is missing columns nothing here can
// add back, so it stops the server instead of failing later at a query.
const LAST_LEGACY_VERSION = 22;

// ALTER TABLE ADD COLUMN is the one thing schema.sql can't do for an existing
// database — and schema.sql has already run by the time migrations replay, so a
// fresh file arrives here with the column present. Guard every add.
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
}

const migrations: { version: number; up: (db: Database.Database) => void }[] = [
  {
    // Email as an alternative second factor: which method a user chose, plus the
    // emailed code (hash + resend budget) carried on the challenge row.
    version: 24,
    up: (db) => {
      if (!hasColumn(db, "users", "mfa_method")) {
        db.exec(
          "ALTER TABLE users ADD COLUMN mfa_method TEXT NOT NULL DEFAULT 'totp' CHECK (mfa_method IN ('totp', 'email'))"
        );
      }
      // Pending challenges from before the upgrade have no purpose/code columns;
      // they're seconds-lived, so defaults are enough — nothing needs backfilling.
      if (!hasColumn(db, "mfa_challenges", "purpose")) {
        db.exec("ALTER TABLE mfa_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'");
      }
      if (!hasColumn(db, "mfa_challenges", "code_hash")) {
        db.exec("ALTER TABLE mfa_challenges ADD COLUMN code_hash TEXT");
      }
      if (!hasColumn(db, "mfa_challenges", "sends")) {
        db.exec("ALTER TABLE mfa_challenges ADD COLUMN sends INTEGER NOT NULL DEFAULT 0");
      }
      if (!hasColumn(db, "mfa_challenges", "last_sent_at")) {
        db.exec("ALTER TABLE mfa_challenges ADD COLUMN last_sent_at TEXT");
      }
    }
  }
];

function userVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

export function migrate(db: Database.Database): void {
  // 0 = a brand-new file; schema.sql below builds it complete. Anything from 1
  // to LAST_LEGACY_VERSION - 1 is a partially-migrated 1.x database whose
  // remaining steps no longer exist — refuse rather than stamp it current and
  // let it fail later on a missing column.
  const existing = userVersion(db);
  if (existing > 0 && existing < LAST_LEGACY_VERSION) {
    throw new Error(
      `This database is from an older version (schema ${existing}) and can't be upgraded directly to 2.x. ` +
      "Update to 1.16.0 first — it applies the remaining steps — then start this version again. " +
      "Alternatively, start from an empty database (libraries rescan; export the family tree as GEDCOM first)."
    );
  }

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
