import type Database from "better-sqlite3";
import { db } from "../db.js";

// Prepared statements compiled once and reused.
//
// better-sqlite3 compiles SQL on every db.prepare() and keeps no cache of its own,
// so a scanner that writes `db.prepare(sql).run(…)` inside its per-book function —
// or inside a loop over a book's files — recompiles the same dozen statements for
// every item: a 5 000-book scan paid for ~100 000 compilations. stmt(sql) compiles
// a statement the first time its SQL text is seen and hands back the same one after.
//
// Lazy on purpose. A statement prepared at import time compiles against whatever
// schema exists then — before a test's resetDb, before migrations on a fresh
// install — so hoisting `const x = db.prepare(…)` to module scope is the wrong fix.
// And the cache is per Database instance (a WeakMap keyed by it): a suite that
// swaps databases gets fresh statements for the new one, and a closed database's
// statements are dropped with it.
//
// A shared statement must stay stateless for the next caller: never call
// .pluck(), .raw(), .expand() or .safeIntegers() on one (they change the statement
// for everyone holding it), and don't use it with .iterate() where the loop could
// reach the same SQL again before it finishes. Use db.prepare() for those.
const caches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function stmt(sql: string, database: Database.Database = db): Database.Statement {
  let cache = caches.get(database);
  if (!cache) {
    cache = new Map();
    caches.set(database, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = database.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}
