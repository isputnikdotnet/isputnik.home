// The migrations live one per file in src/db/migrations/, and the runner only
// knows the ones db/migrations/index.ts lists. A file left out of that list never
// runs — and for a migration that changes data rather than columns, nothing else
// would notice (migration-walk compares schemas, not rows). So: every file is
// listed, every listed version is its file's number, and nothing is listed twice.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/db/migrations/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "src", "db", "migrations");
const files = fs.readdirSync(dir).filter((name) => name !== "index.ts" && name.endsWith(".ts")).sort();

describe("db/migrations", () => {
  it("names every file NNN-short-name.ts", () => {
    expect(files.filter((name) => !/^\d{3}-[a-z0-9-]+\.ts$/.test(name))).toEqual([]);
  });

  it("lists every file, in order, once", () => {
    expect(migrations.map((m) => m.version)).toEqual(files.map((name) => Number(name.slice(0, 3))));
  });

  it("gives each file the version its name says", () => {
    for (const name of files) {
      const source = fs.readFileSync(path.join(dir, name), "utf8");
      expect(/^export const version = (\d+);$/m.exec(source)?.[1], name).toBe(String(Number(name.slice(0, 3))));
    }
  });
});
