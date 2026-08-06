import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));

// The whole schema lives in schema.sql and is idempotent (CREATE TABLE IF NOT
// EXISTS), so a database is built in one pass with no migration history to replay.
//
// `migrations` is empty, and has been reset twice now. 2.0.0 folded 2-22 back into
// schema.sql; 3.0.0 folds 24-31 the same way, because 3.0.0 does not upgrade an
// earlier database at all — it is a fresh install, so a chain of ALTER TABLEs against
// a 2.x file is code that can never run. It grows again only when a RELEASED 3.x
// schema has to change in a way schema.sql alone cannot apply to existing data: a new
// column on an existing table, or a widened CHECK.
const baseline = 32;

// 3.0.0 starts from an empty database. 31 is the last 2.x schema and is structurally
// identical to a fresh 3.0.0 one — every column and table matches — so it adopts the
// new baseline untouched. Anything older is missing columns nothing here can add back,
// so it stops the server rather than failing later at a query.
const LAST_LEGACY_VERSION = 31;

const migrations: { version: number; up: (db: Database.Database) => void }[] = [];

function userVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

export function migrate(db: Database.Database): void {
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

  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (userVersion(db) < m.version) {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
  }
}
