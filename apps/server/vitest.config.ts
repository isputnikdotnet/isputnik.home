import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// The source uses NodeNext-style explicit ".js" import specifiers that actually
// point at ".ts" files. Vite's resolver doesn't rewrite those by default, so map
// any relative "*.js" import to its sibling "*.ts" when one exists.
const resolveJsAsTs = {
  name: "resolve-js-as-ts",
  enforce: "pre" as const,
  resolveId(source: string, importer: string | undefined) {
    if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
    const candidate = path.resolve(path.dirname(importer), `${source.slice(0, -3)}.ts`);
    return fs.existsSync(candidate) ? candidate : null;
  }
};

export default defineConfig({
  plugins: [resolveJsAsTs],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // In-memory SQLite: importing src/db.ts builds the full, freshly-migrated
    // schema in a throwaway database, never touching the real data/ files.
    env: { DB_PATH: ":memory:", MFA_ENCRYPTION_KEY: "test-mfa-key" }
  }
});
