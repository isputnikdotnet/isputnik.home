// The guard test/helpers/sandbox.ts puts around every test file: the working
// directory and the backup folder are the run's sandbox, never the checkout — so
// rescueStrandedBackups() (which moves <cwd>/data/backups into BACKUP_PATH) has
// nothing real to move, and nothing writes among the developer's own backups.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it, vi } from "vitest";
import { config } from "../src/config.js";
import { rescueStrandedBackups } from "../src/modules/backups/index.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = inject("testSandbox");
const inside = (child: string, parent: string) => !path.relative(parent, child).startsWith("..");

describe("the test sandbox", () => {
  it("is where the working directory points", () => {
    expect(process.cwd()).toBe(path.join(sandbox, "apps", "server"));
    expect(process.cwd()).not.toBe(serverDir);
  });

  it("holds the default backup folder", () => {
    expect(inside(path.resolve(config.backupPath), sandbox)).toBe(true);
  });

  it("still gives config the app's version", () => {
    const real = JSON.parse(fs.readFileSync(path.join(serverDir, "..", "..", "package.json"), "utf8")) as { version: string };
    expect(config.version).toBe(real.version);
  });

  it("gives the rescue nothing to move", () => {
    expect(rescueStrandedBackups()).toBe(0);
  });

  it("is put back after a test restores every mock", () => {
    vi.restoreAllMocks();
    expect(vi.isMockFunction(process.cwd)).toBe(false); // the real one, for the rest of this test
  });

  it("…before the next test starts", () => {
    expect(process.cwd()).toBe(path.join(sandbox, "apps", "server"));
  });
});
