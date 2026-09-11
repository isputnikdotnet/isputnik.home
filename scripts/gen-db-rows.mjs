// Generates apps/server/src/db/rows.ts — one TypeScript interface per table,
// read from a database the real migrate path has just built:
//
//   npm run db:rows            (re)write the file
//   npm run db:rows -- --check exit 1 if it is out of date, write nothing
//
// It builds a fresh in-memory database with apps/server/src/db/migrate.ts (the
// same schema.sql + migrations every install runs), then reads each table back
// with PRAGMA table_xinfo and the CREATE TABLE text in sqlite_master. So the
// types describe the schema as it IS after the last migration — a widened CHECK
// or a column added by ALTER TABLE shows up without anyone restating it.
//
// Mapping (SQLite type affinity → TS):
//   INTEGER / NUMERIC / REAL → number      TEXT → string      BLOB → Buffer
//   no declared type → unknown             NULL allowed → `| null`
//   a column in the PRIMARY KEY is never null (a rowid alias can't be; a TEXT key
//     technically could be, but nothing here writes one)
//   CHECK (col IN ('a', 'b')) / CHECK (col IN (0, 1)) → 'a' | 'b' / 0 | 1, also
//     when the CHECK reads `col IS NULL OR col IN (...)`. Any other CHECK shape
//     leaves the plain type.
//
// test/db-rows.test.ts runs generateRowTypes() against a fresh database and fails
// when the committed file differs, so a schema change without `npm run db:rows`
// fails CI. The script runs under tsx (it imports migrate.ts); the test runs it
// under Vitest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ROWS_FILE = path.join(repoRoot, "apps", "server", "src", "db", "rows.ts");

// Interface names: the table name, singular, in PascalCase, + "Row". The last
// word is made singular by rule; these are the words a rule gets wrong.
const SINGULAR = {
  people: "person",
  children: "child",
  series: "series",
  aliases: "alias",
  details: "detail",
  progress: "progress",
  settings: "setting",
  news: "news"
};

function singular(word) {
  if (Object.hasOwn(SINGULAR, word)) return SINGULAR[word];
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(sses|uses|xes|ches|shes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export function rowTypeName(table) {
  const words = table.split("_");
  words[words.length - 1] = singular(words[words.length - 1]);
  return `${words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("")}Row`;
}

// SQLite's own affinity rules (https://sqlite.org/datatype3.html §3.1), in order.
function baseType(declared) {
  const t = declared.toUpperCase();
  if (t.includes("INT")) return "number";
  if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "string";
  if (t.includes("BLOB")) return "Buffer";
  if (t === "") return "unknown";
  return "number"; // REAL, FLOAT, DOUBLE, NUMERIC, DECIMAL, BOOLEAN, DATE…
}

// The CREATE TABLE text with comments blanked out, so a parenthesis or the word
// CHECK inside a `-- comment` can't derail the scan. String literals and quoted
// identifiers are kept as they are.
function stripComments(sql) {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Every CHECK ( … ) body in a comment-free CREATE TABLE, balanced over nested
// parentheses and blind to parentheses inside string literals.
function checkBodies(sql) {
  const bodies = [];
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    let quote = null;
    for (; i < sql.length && depth > 0; i++) {
      const c = sql[i];
      if (quote) {
        if (c === quote) {
          if (sql[i + 1] === quote) i++;
          else quote = null;
        }
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    bodies.push(sql.slice(start, i - 1));
    re.lastIndex = i;
  }
  return bodies;
}

const IDENT = String.raw`(?:"([^"]+)"|\`([^\`]+)\`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))`;
const SIMPLE_IN = new RegExp(String.raw`^${IDENT}\s+IN\s*\(([^()]*)\)$`, "i");
const NULL_OR_IN = new RegExp(String.raw`^${IDENT}\s+IS\s+NULL\s+OR\s+${IDENT}\s+IN\s*\(([^()]*)\)$`, "i");

// '1', 'a''b', 0, -3 — a list of literals all of one kind, or null.
function parseLiterals(list) {
  const items = [];
  const re = /\s*(?:'((?:[^']|'')*)'|(-?\d+))\s*(,|$)/y;
  let m;
  let pos = 0;
  while (pos < list.length && (m = re.exec(list))) {
    if (m[1] !== undefined) items.push({ kind: "string", value: m[1].replace(/''/g, "'") });
    else items.push({ kind: "number", value: Number(m[2]) });
    pos = re.lastIndex;
    if (m[3] === "") break;
  }
  if (pos !== list.length || items.length === 0) return null;
  if (!items.every((it) => it.kind === items[0].kind)) return null;
  return items;
}

// column name (lower-case) → the literal union its CHECK allows, from every
// `col IN (...)` / `col IS NULL OR col IN (...)` CHECK in the table.
function enumChecks(createSql) {
  const out = new Map();
  for (const raw of checkBodies(stripComments(createSql))) {
    const body = raw.replace(/\s+/g, " ").trim();
    let col;
    let list;
    const simple = SIMPLE_IN.exec(body);
    const nullOr = simple ? null : NULL_OR_IN.exec(body);
    if (simple) {
      col = simple[1] ?? simple[2] ?? simple[3] ?? simple[4];
      list = simple[5];
    } else if (nullOr) {
      const a = nullOr[1] ?? nullOr[2] ?? nullOr[3] ?? nullOr[4];
      const b = nullOr[5] ?? nullOr[6] ?? nullOr[7] ?? nullOr[8];
      if (a.toLowerCase() !== b.toLowerCase()) continue;
      col = a;
      list = nullOr[9];
    } else {
      continue;
    }
    const literals = parseLiterals(list);
    if (!literals || out.has(col.toLowerCase())) continue;
    out.set(
      col.toLowerCase(),
      literals.map((it) => (it.kind === "string" ? JSON.stringify(it.value) : String(it.value))).join(" | ")
    );
  }
  return out;
}

const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;
const propName = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));

/** The text of rows.ts for the schema in `db` (a better-sqlite3 Database). */
export function generateRowTypes(db) {
  const tables = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        ORDER BY name`
    )
    .all();
  const lines = [
    "// generated — run npm run db:rows",
    "//",
    "// One interface per table, read from a database built by db/migrate.ts",
    "// (scripts/gen-db-rows.mjs). Do not edit by hand: change schema.sql or add a",
    "// migration, then regenerate. test/db-rows.test.ts fails when this file is stale.",
    "//",
    "// Use them for query results instead of restating a row's shape at the call",
    "// site: `.get(id) as LibraryItemRow | undefined`, `.all() as Pick<UserRow, \"id\" | \"email\">[]`.",
    "// A join is an intersection of Picks; a column renamed with AS is `ItemMetadataRow[\"title\"]`.",
    "",
    "/** A LEFT JOINed table's columns: with no match, every one of them comes back NULL. */",
    "export type Nullable<T> = { [K in keyof T]: T[K] | null };",
    "",
    "/** Columns the query itself keeps NULL out of (`WHERE col IS NOT NULL`, an inner join on it). */",
    "export type NonNull<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };",
    ""
  ];
  const names = [];
  for (const { name, sql } of tables) {
    const typeName = rowTypeName(name);
    if (names.some((n) => n.typeName === typeName)) {
      throw new Error(`Two tables map to ${typeName}; add an entry to SINGULAR in scripts/gen-db-rows.mjs.`);
    }
    names.push({ name, typeName });
    const enums = enumChecks(sql ?? "");
    const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdent(name)})`).all();
    lines.push(`/** \`${name}\` */`);
    lines.push(`export interface ${typeName} {`);
    for (const col of columns) {
      if (col.hidden === 1) continue; // a virtual table's hidden column
      const nullable = col.notnull === 0 && col.pk === 0;
      const type = enums.get(col.name.toLowerCase()) ?? baseType(col.type ?? "");
      lines.push(`  ${propName(col.name)}: ${type}${nullable && type !== "unknown" ? " | null" : ""};`);
    }
    lines.push("}", "");
  }
  lines.push("/** Every table's row type, by table name. */");
  lines.push("export interface TableRows {");
  for (const { name, typeName } of names) lines.push(`  ${propName(name)}: ${typeName};`);
  lines.push("}", "");
  return lines.join("\n");
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const { default: Database } = await import("better-sqlite3");
  const { migrate } = await import("../apps/server/src/db/migrate.ts");
  const db = new Database(":memory:");
  migrate(db);
  const text = generateRowTypes(db);
  db.close();
  const current = fs.existsSync(ROWS_FILE) ? fs.readFileSync(ROWS_FILE, "utf8").replace(/\r\n/g, "\n") : null;
  const rel = path.relative(repoRoot, ROWS_FILE).replace(/\\/g, "/");
  if (process.argv.includes("--check")) {
    if (current !== text) {
      console.error(`${rel} is out of date — run npm run db:rows`);
      process.exit(1);
    }
    console.log(`${rel} is current.`);
  } else if (current === text) {
    console.log(`${rel} is already current.`);
  } else {
    fs.writeFileSync(ROWS_FILE, text);
    console.log(`Wrote ${rel}.`);
  }
}
