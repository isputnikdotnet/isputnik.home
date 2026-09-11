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
    // The 5 s default is too tight under full-suite CPU contention: a test that
    // takes 2.6 s alone (backup-kinds' zip writes) crossed it and failed at random.
    testTimeout: 15000,
    // Every file runs with process.cwd() and BACKUP_PATH pinned to a throwaway
    // sandbox, so rescueStrandedBackups() and the default backup folder can never
    // reach the developer's own data/backups (test/helpers/global-sandbox.ts).
    globalSetup: ["./test/helpers/global-sandbox.ts"],
    setupFiles: [
      // Only when hunting a worker that dies mid-run: CRASH_LOG=path npm test
      // (test/helpers/crash-probe.ts). Off by default so an ordinary run loads
      // nothing extra into all 160-odd of its workers. First, so it is watching
      // before anything else loads.
      ...(process.env.CRASH_LOG ? ["./test/helpers/crash-probe.ts"] : []),
      "./test/helpers/sandbox.ts"
    ],
    // In-memory SQLite: importing src/db.ts builds the full, freshly-migrated
    // schema in a throwaway database, never touching the real data/ files.
    env: { DB_PATH: ":memory:", MFA_ENCRYPTION_KEY: "test-mfa-key" }
  }
});
