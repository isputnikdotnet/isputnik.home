// src/db/rows.ts is generated from the schema (npm run db:rows). A schema change
// committed without regenerating it would leave every query typed against the old
// columns — so regenerate it here, from a database the real migrate path builds,
// and fail when the committed file differs.
import fs from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
// @ts-expect-error — a plain .mjs script with no type declarations.
import { generateRowTypes, rowTypeName, ROWS_FILE } from "../../../scripts/gen-db-rows.mjs";

function freshSchema(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("db/rows.ts", () => {
  it("matches the schema (run npm run db:rows if this fails)", () => {
    const db = freshSchema();
    try {
      const committed = fs.readFileSync(ROWS_FILE, "utf8").replace(/\r\n/g, "\n");
      expect(committed === generateRowTypes(db), "src/db/rows.ts is stale — run npm run db:rows").toBe(true);
    } finally {
      db.close();
    }
  });

  it("names row types after the singular table name", () => {
    expect(rowTypeName("library_items")).toBe("LibraryItemRow");
    expect(rowTypeName("people")).toBe("PersonRow");
    expect(rowTypeName("categories")).toBe("CategoryRow");
    expect(rowTypeName("series")).toBe("SeriesRow");
    expect(rowTypeName("family_tree_children")).toBe("FamilyTreeChildRow");
  });

  it("maps nullability, affinity and simple IN checks", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE sample_things (
          id      TEXT PRIMARY KEY,
          n       INTEGER NOT NULL,
          r       REAL,
          b       BLOB,
          -- a comment with CHECK (n IN (7)) and a stray ( paren
          kind    TEXT NOT NULL CHECK (kind IN ('a', 'it''s')),
          flag    INTEGER NOT NULL DEFAULT 0 CHECK (flag IN (0, 1)),
          maybe   TEXT CHECK (maybe IS NULL OR maybe IN ('x', 'y')),
          ranged  INTEGER CHECK (ranged BETWEEN 1 AND 5)
        )
      `);
      const text = generateRowTypes(db) as string;
      expect(text).toContain(
        [
          "export interface SampleThingRow {",
          "  id: string;",
          "  n: number;",
          "  r: number | null;",
          "  b: Buffer | null;",
          '  kind: "a" | "it\'s";',
          "  flag: 0 | 1;",
          '  maybe: "x" | "y" | null;',
          "  ranged: number | null;",
          "}"
        ].join("\n")
      );
    } finally {
      db.close();
    }
  });
});
