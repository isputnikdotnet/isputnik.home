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
  // { version: 2, up: (db) => db.exec("ALTER TABLE library_items ADD COLUMN ...") },
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
