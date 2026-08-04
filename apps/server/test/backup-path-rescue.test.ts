// Backups written before 2.15.1 landed in <app>/data/backups, because the Docker
// image named DB_PATH, THUMBNAIL_PATH and METADATA_PATH but not BACKUP_PATH. In a
// container that folder is invisible from the host and is discarded whenever the
// container is recreated — so on startup they are moved into the configured folder.
//
// This moves a user's only copy of their data, so it is tested on real files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NAME = "isputnik-20260101-120000.sqlite";
const OTHER = "isputnik-20260102-120000.zip";

let workdir: string;
let legacy: string;
let target: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

// Drives the real config, not a stub of it: BACKUP_PATH is exactly the knob the
// Docker image was missing, so the wiring is part of what's under test.
//
// The working directory is only faked around the CALL. Faking it across the import
// would send config.ts looking for package.json in the temp folder — the rescue reads
// cwd when it runs, which is the moment that matters.
async function loadRescue(backupPath: string) {
  process.env.BACKUP_PATH = backupPath;
  vi.resetModules();
  const mod = await import("../src/modules/backups/index.js");
  return () => {
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workdir);
    try {
      return mod.rescueStrandedBackups();
    } finally {
      cwdSpy.mockRestore();
    }
  };
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-backup-"));
  legacy = path.join(workdir, "data", "backups");
  target = path.join(workdir, "config", "backups");
  fs.mkdirSync(legacy, { recursive: true });
});

afterEach(() => {
  delete process.env.BACKUP_PATH;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("stranded backups", () => {
  it("moves them into the configured folder", async () => {
    fs.writeFileSync(path.join(legacy, NAME), "one");
    fs.writeFileSync(path.join(legacy, OTHER), "two");

    const rescue = await loadRescue(target);
    expect(rescue()).toBe(2);
    expect(fs.readdirSync(target).sort()).toEqual([NAME, OTHER].sort());
    expect(fs.readdirSync(legacy)).toEqual([]);
  });

  it("leaves anything that isn't a backup where it is", async () => {
    fs.writeFileSync(path.join(legacy, NAME), "one");
    fs.writeFileSync(path.join(legacy, "notes.txt"), "mine");

    const rescue = await loadRescue(target);
    expect(rescue()).toBe(1);
    expect(fs.readdirSync(legacy)).toEqual(["notes.txt"]);
  });

  it("never overwrites a backup already in the destination", async () => {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, NAME), "old");
    fs.writeFileSync(path.join(target, NAME), "current");

    const rescue = await loadRescue(target);
    expect(rescue()).toBe(0);
    expect(fs.readFileSync(path.join(target, NAME), "utf8")).toBe("current");
  });

  it("does nothing when the two folders are the same — every non-container install", async () => {
    fs.writeFileSync(path.join(legacy, NAME), "one");

    const rescue = await loadRescue(legacy);
    expect(rescue()).toBe(0);
    expect(fs.readdirSync(legacy)).toEqual([NAME]);
  });

  it("does nothing when there is no legacy folder at all", async () => {
    fs.rmSync(legacy, { recursive: true, force: true });
    const rescue = await loadRescue(target);
    expect(rescue()).toBe(0);
  });
});
