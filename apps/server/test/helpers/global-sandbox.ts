// Runs once per vitest run, in the main process (vitest.config.ts → globalSetup).
// Builds the folder every test file treats as its working directory and backup
// folder — test/helpers/sandbox.ts pins process.cwd() and BACKUP_PATH to it — and
// removes it when the run ends.
//
// Why: backupsPlugin runs rescueStrandedBackups() on register, which MOVES every
// backup out of <process.cwd()>/data/backups into BACKUP_PATH. Launched from the
// repo root (`npx vitest --root apps/server`), that is the developer's own
// data/backups; a test that points BACKUP_PATH at a temp folder and deletes it
// afterwards then deletes those backups for good (this has happened). And with
// BACKUP_PATH unset, config falls back to <repo>/data/backups, so any test that
// writes a backup would write it among the real ones.
//
// The folder mirrors the layout the code expects of a working directory:
//   <sandbox>/package.json      copy of the repo's — config.ts reads the version there
//   <sandbox>/apps/server/      the pinned cwd (what `npm test --workspace` gives)
//   <sandbox>/apps/server/models → the real apps/server/models (a junction/symlink),
//                                 so the face tests still find the ONNX models
//   <sandbox>/backups/          BACKUP_PATH
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    testSandbox: string;
  }
}

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(serverDir, "..", "..");

export default function setup(project: TestProject): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-test-sandbox-"));
  const cwd = path.join(root, "apps", "server");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(root, "backups"));
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(root, "package.json"));

  const models = path.join(serverDir, "models");
  const link = path.join(cwd, "models");
  if (fs.existsSync(models)) fs.symlinkSync(models, link, "junction");

  project.provide("testSandbox", root);

  return () => {
    // Take the link away on its own first, so nothing below can walk through it
    // into the real models folder. If it won't go, leave the sandbox behind (it
    // is in the temp folder) rather than risk a recursive delete following it.
    try {
      if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.unlinkSync(link);
    } catch {
      try { fs.rmdirSync(link); } catch { /* checked below */ }
    }
    if (fs.lstatSync(link, { throwIfNoEntry: false })) return;
    fs.rmSync(root, { recursive: true, force: true });
  };
}
