// Loaded before every test file (vitest.config.ts → setupFiles). Pins
// process.cwd() and BACKUP_PATH to the run's sandbox folder, built by
// test/helpers/global-sandbox.ts — which says why. Nothing a test does can then
// reach the developer's own data/backups through rescueStrandedBackups() or the
// config's default backup folder.
//
// A test may still point either somewhere of its own (the backup suites give each
// test a fresh temp folder): its own vi.spyOn(process, "cwd") takes over the pin,
// and its own BACKUP_PATH wins over this one. When a test restores its mocks, the
// pin is put back before the next test starts.
import path from "node:path";
import { beforeEach, inject, vi } from "vitest";

const root = inject("testSandbox");
const cwd = path.join(root, "apps", "server");
const backups = path.join(root, "backups");

function pin(): void {
  if (!vi.isMockFunction(process.cwd)) vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.env.BACKUP_PATH ??= backups;
}

// Unconditionally at load: a BACKUP_PATH exported in the developer's shell is a
// real folder, and config.ts reads it the moment the test file imports it.
process.env.BACKUP_PATH = backups;
pin();
beforeEach(pin);
