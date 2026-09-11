import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { migrations, type Migration } from "./migrations/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// The whole schema lives in schema.sql and is idempotent (CREATE TABLE IF NOT
// EXISTS), so a database is built in one pass with no migration history to replay.
// It is re-run on every boot, before the migrations, which is why a new table or a
// new index needs no migration at all.
//
// The migrations themselves live one per file in ./migrations/ (NNN-short-name.ts,
// each exporting `version` and `up(db)`), listed in order by ./migrations/index.ts.
// This file is only the runner.
//
// The list has been reset twice. 2.0.0 folded 2-22 back into schema.sql; 3.0.0
// folded 24-31 the same way, because 3.0.0 does not upgrade an earlier database at
// all — it is a fresh install, so a chain of ALTER TABLEs against a 2.x file is code
// that can never run. Since then it has grown again, one migration per RELEASED 3.x
// schema change that schema.sql alone cannot apply to existing data: a new column on
// an existing table, a widened CHECK, a table rebuild. Every one of them still runs
// on an install upgrading from any 3.x release, so none is folded back: each `up`
// checks table_info (or sqlite_master) itself and leaves alone what is already there.
const baseline = 32;

// 3.0.0 starts from an empty database. 31 is the last 2.x schema and is structurally
// identical to a fresh 3.0.0 one — every column and table matches — so it adopts the
// new baseline untouched. Anything older is missing columns nothing here can add back,
// so it stops the server rather than failing later at a query.
const LAST_LEGACY_VERSION = 31;

function userVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

// A slip in the index — a number used twice, one listed out of place, one at or
// below the baseline — would silently skip a step on every real database (a run
// stamps user_version as it goes), so it stops the boot instead, before any SQL.
function inOrder(list: readonly Migration[]): readonly Migration[] {
  let previous = baseline;
  for (const m of list) {
    if (!Number.isInteger(m.version) || m.version <= previous) {
      throw new Error(
        `db/migrations/index.ts: migration ${m.version} is listed after ${previous}. ` +
        `Versions must be whole numbers above the baseline (${baseline}), each higher than the one before it.`
      );
    }
    previous = m.version;
  }
  return list;
}

// Each migration runs in its own transaction and stamps its own version, so a
// failure leaves the database at the last step that completed and the next boot
// resumes from there.
function apply(db: Database.Database, m: Migration): void {
  db.transaction(() => {
    m.up(db);
    db.pragma(`user_version = ${m.version}`);
  })();
}

export function migrate(db: Database.Database): void {
  const ordered = inOrder(migrations);

  // 0 = a brand-new file; schema.sql below builds it complete.
  const existing = userVersion(db);
  if (existing > 0 && existing < LAST_LEGACY_VERSION) {
    throw new Error(
      `This database is from an older version (schema ${existing}). 3.0.0 is a new install rather than an upgrade, ` +
      "so it cannot be carried across. Start from an empty database — libraries rescan from their files. " +
      "Export the family tree as GEDCOM first: it is the one thing that cannot be rebuilt from disk."
    );
  }

  const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
  db.exec(schema);

  if (userVersion(db) < baseline) {
    db.pragma(`user_version = ${baseline}`);
  }

  for (const m of ordered) {
    if (userVersion(db) < m.version) apply(db, m);
  }
}

// Test hook: apply every migration above `fromVersion` to a database that was NOT
// built from schema.sql — a hand-made copy of an older shape — so a migration can
// be exercised against the columns it is meant to find.
export function runMigrationsFrom(db: Database.Database, fromVersion: number): void {
  const ordered = inOrder(migrations);
  db.pragma(`user_version = ${fromVersion}`);
  for (const m of ordered) {
    if (m.version > fromVersion) apply(db, m);
  }
}
