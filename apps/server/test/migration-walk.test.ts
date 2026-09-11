// The upgrade path, walked end to end.
//
// A fresh install is built from schema.sql in one pass; an upgraded install is
// whatever its first schema.sql left behind, plus every migration since. Nothing
// else checks that those two roads arrive at the same database — and a Beta is
// the point where real installs start taking the second one. So: build a database
// exactly as 3.0.0 left it (its schema.sql, snapshotted in fixtures/, at the
// baseline user_version 32 — the oldest schema migrate() will still upgrade), run
// today's migrate() over it, and compare it with a fresh build. Same tables, same
// columns (type, NOT NULL, default, primary key), same CHECK constraints, same
// foreign keys, same indexes (columns, uniqueness, partial WHERE).
//
// It compares two builds rather than a list, so it stays true while schema.sql and
// the migrations keep growing: a new migration that forgets the upgrade road (or a
// schema.sql edit with no migration behind it) is what fails here.
//
// The fixture is `git show v3.0.0:apps/server/src/db/schema.sql`, untouched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const V3_0_0_SCHEMA = fs.readFileSync(path.join(here, "fixtures", "schema-v3.0.0.sql"), "utf8");
const BASELINE_VERSION = 32;

// db.ts lends SQLite this function; lend it here too, in case a schema object ever
// names it (an expression index or a view would fail to build without it).
function open(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.function("lower_unicode", { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? value.toLowerCase() : value ?? null
  );
  return db;
}

function freshBuild(): Database.Database {
  const db = open();
  migrate(db);
  return db;
}

/** A database as 3.0.0 created it: its schema.sql at the baseline version. */
function v300Build(): Database.Database {
  const db = open();
  db.exec(V3_0_0_SCHEMA);
  db.pragma(`user_version = ${BASELINE_VERSION}`);
  return db;
}

// ── Reading a schema back as data ────────────────────────────────────────────

/** SQL with its comments removed. sqlite_master keeps a CREATE statement's text
 *  verbatim, comments included, and a comment is not part of the schema. */
function stripComments(sql: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Whitespace-insensitive, case-insensitive outside quotes: what `a IN ('x','y')`
 *  and `A in ( 'x', 'y' )` have in common. Formatting is not drift. */
function normalizeSql(sql: string | null): string | null {
  if (sql == null) return null;
  let out = "";
  let quote: string | null = null;
  for (const ch of stripComments(sql)) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    out += /\s/.test(ch) ? " " : ch.toLowerCase();
  }
  return out
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>])\s*/g, "$1")
    .trim();
}

/** Every CHECK (...) in a CREATE TABLE, parentheses balanced, normalised. */
function checkConstraints(rawSql: string): string[] {
  const tableSql = stripComments(rawSql);
  const found: string[] = [];
  const pattern = /\bcheck\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tableSql))) {
    let depth = 0;
    let quote: string | null = null;
    const start = match.index + match[0].length - 1;
    for (let i = start; i < tableSql.length; i += 1) {
      const ch = tableSql[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          found.push(normalizeSql(tableSql.slice(start, i + 1))!);
          break;
        }
      }
    }
  }
  return found.sort();
}

interface Shape {
  tables: Record<string, {
    columns: Record<string, { type: string; notnull: number; dflt: string | null; pk: number }>;
    checks: string[];
    foreignKeys: string[];
    uniqueConstraints: string[];
  }>;
  indexes: Record<string, { table: string; unique: number; columns: string[]; where: string | null }>;
  triggers: Record<string, string | null>;
  views: Record<string, string | null>;
}

function shapeOf(db: Database.Database): Shape {
  const objects = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];

  const shape: Shape = { tables: {}, indexes: {}, triggers: {}, views: {} };
  for (const object of objects) {
    if (object.type === "table") {
      const columns: Shape["tables"][string]["columns"] = {};
      const info = db.prepare(`PRAGMA table_xinfo("${object.name}")`).all() as {
        name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
      }[];
      // By name, not position: ALTER TABLE ADD COLUMN always appends, so an upgraded
      // table legitimately holds its columns in a different order.
      for (const column of info) {
        columns[column.name] = {
          type: column.type.toUpperCase(),
          notnull: column.notnull,
          dflt: normalizeSql(column.dflt_value),
          pk: column.pk
        };
      }
      const foreignKeys = (db.prepare(`PRAGMA foreign_key_list("${object.name}")`).all() as {
        table: string; from: string; to: string | null; on_update: string; on_delete: string;
      }[]).map((fk) => `${fk.from} -> ${fk.table}(${fk.to ?? ""}) on delete ${fk.on_delete} on update ${fk.on_update}`).sort();
      // UNIQUE / PRIMARY KEY constraints surface as automatic indexes whose names
      // depend on declaration order; identify them by their columns instead.
      const uniqueConstraints = (db.prepare(`PRAGMA index_list("${object.name}")`).all() as {
        name: string; unique: number; origin: string;
      }[])
        .filter((index) => index.origin !== "c")
        .map((index) => {
          const cols = (db.prepare(`PRAGMA index_info("${index.name}")`).all() as { name: string }[]).map((c) => c.name);
          return `${index.origin}:${cols.join(",")}`;
        })
        .sort();
      shape.tables[object.name] = {
        columns,
        checks: checkConstraints(object.sql ?? ""),
        foreignKeys,
        uniqueConstraints
      };
    } else if (object.type === "index" && object.sql) {
      const list = db.prepare(`PRAGMA index_list("${object.tbl_name}")`).all() as {
        name: string; unique: number; partial: number;
      }[];
      const entry = list.find((index) => index.name === object.name);
      const columns = (db.prepare(`PRAGMA index_xinfo("${object.name}")`).all() as {
        name: string | null; desc: number; coll: string; key: number;
      }[])
        .filter((column) => column.key === 1)
        .map((column) => `${column.name ?? "<expr>"}${column.desc ? " desc" : ""}${column.coll !== "BINARY" ? ` collate ${column.coll}` : ""}`);
      const whereAt = object.sql.search(/\bwhere\b/i);
      shape.indexes[object.name] = {
        table: object.tbl_name,
        unique: entry?.unique ?? 0,
        columns,
        where: whereAt >= 0 ? normalizeSql(object.sql.slice(whereAt)) : null
      };
    } else if (object.type === "trigger") {
      shape.triggers[object.name] = normalizeSql(object.sql);
    } else if (object.type === "view") {
      shape.views[object.name] = normalizeSql(object.sql);
    }
  }
  return shape;
}

/** Every difference between two shapes, one readable line each. */
function diffShapes(fresh: Shape, upgraded: Shape): string[] {
  const out: string[] = [];
  const keys = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

  for (const table of keys(fresh.tables, upgraded.tables)) {
    const f = fresh.tables[table];
    const u = upgraded.tables[table];
    if (!f) { out.push(`table ${table}: only on the upgraded database`); continue; }
    if (!u) { out.push(`table ${table}: missing on the upgraded database`); continue; }
    for (const column of keys(f.columns, u.columns)) {
      const fc = f.columns[column];
      const uc = u.columns[column];
      if (!fc) { out.push(`column ${table}.${column}: only on the upgraded database`); continue; }
      if (!uc) { out.push(`column ${table}.${column}: missing on the upgraded database`); continue; }
      for (const field of ["type", "notnull", "dflt", "pk"] as const) {
        if (fc[field] !== uc[field]) {
          out.push(`column ${table}.${column}.${field}: fresh ${JSON.stringify(fc[field])}, upgraded ${JSON.stringify(uc[field])}`);
        }
      }
    }
    for (const field of ["checks", "foreignKeys", "uniqueConstraints"] as const) {
      const onlyFresh = f[field].filter((entry) => !u[field].includes(entry));
      const onlyUpgraded = u[field].filter((entry) => !f[field].includes(entry));
      for (const entry of onlyFresh) out.push(`${field} ${table}: missing on the upgraded database: ${entry}`);
      for (const entry of onlyUpgraded) out.push(`${field} ${table}: only on the upgraded database: ${entry}`);
    }
  }

  for (const index of keys(fresh.indexes, upgraded.indexes)) {
    const f = fresh.indexes[index];
    const u = upgraded.indexes[index];
    if (!f) { out.push(`index ${index}: only on the upgraded database`); continue; }
    if (!u) { out.push(`index ${index} ON ${f.table}(${f.columns.join(", ")}): missing on the upgraded database`); continue; }
    if (JSON.stringify(f) !== JSON.stringify(u)) {
      out.push(`index ${index}: fresh ${JSON.stringify(f)}, upgraded ${JSON.stringify(u)}`);
    }
  }

  for (const kind of ["triggers", "views"] as const) {
    for (const name of keys(fresh[kind], upgraded[kind])) {
      if (fresh[kind][name] !== upgraded[kind][name]) {
        out.push(`${kind.slice(0, -1)} ${name}: ${fresh[kind][name] == null ? "only on the upgraded database"
          : upgraded[kind][name] == null ? "missing on the upgraded database" : "differs"}`);
      }
    }
  }
  return out;
}

// ── The walk ─────────────────────────────────────────────────────────────────

// Differences the walk has found and that are understood, each with why it is
// harmless. The list is exact on purpose: a NEW difference fails the test, and so
// does fixing one of these — delete its line when a migration closes it.
const KNOWN_DRIFT: string[] = [
  // 3.30.0 ("Minimalist by default") changed the column default in schema.sql with
  // no migration — SQLite can't alter a default without rebuilding the table. Dead
  // in practice: every INSERT INTO users (setup.ts, users.ts, invites.ts) names
  // its theme, so the default is never what a new account gets.
  "column users.theme.dflt: fresh \"'minimalist'\", upgraded \"'dark'\""
];

describe("upgrading a 3.0.0 database", () => {
  it("starts from a real 3.0.0 schema", () => {
    // Guard the fixture itself: a v3.0.0 database has none of the later tables and
    // none of the later columns, or this test is comparing a fresh build with itself.
    const old = shapeOf(v300Build());
    const fresh = shapeOf(freshBuild());
    expect(Object.keys(old.tables).length).toBeGreaterThan(50);
    expect(old.tables.gallery_slideshows?.columns.title_enabled).toBeUndefined(); // migration 33
    expect(old.tables.share_links?.columns.max_files).toBeUndefined(); // migration 69
    expect(Object.keys(fresh.tables).length).toBeGreaterThan(Object.keys(old.tables).length);
  });

  it("migrates to the same user_version as a fresh install", () => {
    const upgraded = v300Build();
    migrate(upgraded);
    const fresh = freshBuild();
    expect(upgraded.pragma("user_version", { simple: true })).toBe(fresh.pragma("user_version", { simple: true }));
    expect(fresh.pragma("user_version", { simple: true })).toBeGreaterThan(BASELINE_VERSION);
  });

  it("arrives at the same schema as a fresh install on its first boot", () => {
    const upgraded = v300Build();
    migrate(upgraded);

    expect(diffShapes(shapeOf(freshBuild()), shapeOf(upgraded))).toEqual(KNOWN_DRIFT);
  });

  it("notices what it is meant to notice", () => {
    // The comparison proves nothing if it cannot fail: take a fresh build, knock
    // out an index, add a column and loosen a default the way a forgotten migration
    // would, and every one of them must show up.
    const fresh = shapeOf(freshBuild());
    const broken = freshBuild();
    const someIndex = Object.keys(fresh.indexes)[0];
    broken.exec(`DROP INDEX "${someIndex}"`);
    broken.exec("ALTER TABLE users ADD COLUMN leftover TEXT");
    broken.exec("CREATE TABLE forgotten (id TEXT PRIMARY KEY)");

    const diff = diffShapes(fresh, shapeOf(broken));
    expect(diff).toContain("column users.leftover: only on the upgraded database");
    expect(diff).toContain("table forgotten: only on the upgraded database");
    expect(diff.some((line) => line.startsWith(`index ${someIndex} `) && line.endsWith("missing on the upgraded database"))).toBe(true);
    expect(diff).toHaveLength(3);
  });

  it("stays put on the next boot, and so does a fresh install", () => {
    // migrate() runs on every start. A second pass must change nothing — on either
    // road — or something in schema.sql or a migration is not idempotent.
    const upgraded = v300Build();
    migrate(upgraded);
    const once = shapeOf(upgraded);
    migrate(upgraded);
    expect(diffShapes(once, shapeOf(upgraded))).toEqual([]);

    const fresh = freshBuild();
    const freshOnce = shapeOf(fresh);
    migrate(fresh);
    expect(diffShapes(freshOnce, shapeOf(fresh))).toEqual([]);
  });

  it("carries existing rows through the table rebuilds, with every foreign key intact", () => {
    // Migration 55 rebuilds gallery_details (a widened CHECK); others backfill from
    // rows that are there. An empty database proves only the DDL — put a little of
    // everything those migrations read in first.
    const upgraded = v300Build();
    upgraded.exec(`
      INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('u1', 'u1@test.local', 'x', 'U1', 'admin');
      INSERT INTO libraries (id, name, type, source_path, created_by) VALUES ('gal', 'Photos', 'gallery', '/media/photos', 'u1');
      INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('p1', 'gal', 'gallery', 'a/p1.jpg', 'ready');
      INSERT INTO gallery_details (item_id, kind, relative_path, size, taken_at) VALUES ('p1', 'photo', 'a/p1.jpg', 1234, '2020-05-01T10:00:00.000Z');
      INSERT INTO gallery_slideshows (id, name, created_by) VALUES ('s1', 'Summer', 'u1');
    `);

    migrate(upgraded);

    expect(upgraded.prepare("SELECT kind, relative_path, size, taken_at FROM gallery_details WHERE item_id = 'p1'").get())
      .toEqual({ kind: "photo", relative_path: "a/p1.jpg", size: 1234, taken_at: "2020-05-01T10:00:00.000Z" });
    // Migration 33's defaults are the card 3.1.x rendered, so an old slideshow keeps
    // its movie until someone changes something.
    expect(upgraded.prepare("SELECT title_enabled, title_seconds FROM gallery_slideshows WHERE id = 's1'").get())
      .toEqual({ title_enabled: 1, title_seconds: 3 });
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
    // The widened CHECK is live, not just written down.
    expect(() => upgraded.prepare(
      "INSERT INTO gallery_details (item_id, kind, relative_path) VALUES ('p1b', 'audio', 'a/n.m4a')"
    ).run()).toThrow(/FOREIGN KEY/); // the CHECK passed; only the missing item stops it
  });
});
