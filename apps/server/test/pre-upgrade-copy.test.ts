// docs/rollback.md promises that an upgrade leaves the database as the previous
// version had it: db.ts takes a copy before the new version's migrations run, and the
// backups plugin files it on the Backup page. These boot the real db.ts against a
// file database twice — once as the "old" version, once as the new one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootApp } from "./helpers/boot.js";

let workdir: string;
let dbPath: string;
let backupPath: string;
let app: FastifyInstance | undefined;
let closeDb: (() => void) | undefined;
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

// One boot: fresh module graph (db.ts runs its top level again), then the backups
// plugin, which adopts any staged copy.
async function boot(): Promise<{ version: string }> {
  vi.resetModules();
  const { db } = await import("../src/db.js");
  const { config } = await import("../src/config.js");
  const { backupsPlugin } = await import("../src/modules/backups/index.js");
  closeDb = () => db.close();
  // rescueStrandedBackups() MOVES anything under <cwd>/data/backups (CLAUDE.md).
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workdir);
  ({ app } = await bootApp({ plugins: [backupsPlugin] }));
  return { version: config.version };
}

async function shutdown(): Promise<void> {
  await app?.close();
  closeDb?.();
  cwdSpy?.mockRestore();
  app = undefined;
  closeDb = undefined;
}

function setting(key: string): string | undefined {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return (raw.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  } finally {
    raw.close();
  }
}

// Pretend the database was last booted by another version, and leave a marker row
// that tells the pre-upgrade copy apart from the database after the upgrade.
function asIfLastBootedBy(version: string | null): void {
  const raw = new Database(dbPath);
  try {
    if (version === null) raw.prepare("DELETE FROM app_settings WHERE key = 'app.last_booted_version'").run();
    else raw.prepare("UPDATE app_settings SET value = ? WHERE key = 'app.last_booted_version'").run(version);
    raw.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('test.marker', 'before')").run();
  } finally {
    raw.close();
  }
}

function preUpgradeCopies(): string[] {
  return fs.readdirSync(backupPath).filter((name) => name.endsWith("-pre-upgrade.sqlite")).sort();
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-pre-upgrade-"));
  dbPath = path.join(workdir, "app.sqlite");
  backupPath = path.join(workdir, "backups");
  process.env.DB_PATH = dbPath;
  process.env.BACKUP_PATH = backupPath;
  process.env.THUMBNAIL_PATH = path.join(workdir, "thumbnails");
});

afterEach(async () => {
  await shutdown();
  delete process.env.DB_PATH;
  delete process.env.BACKUP_PATH;
  delete process.env.THUMBNAIL_PATH;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("the pre-upgrade database copy", () => {
  it("is not taken for a brand-new database, which records the version it booted", async () => {
    const { version } = await boot();
    await shutdown();
    expect(fs.existsSync(backupPath) ? preUpgradeCopies() : []).toEqual([]);
    expect(setting("app.last_booted_version")).toBe(version);
  });

  it("is not taken when the same version boots again", async () => {
    await boot();
    await shutdown();
    await boot();
    await shutdown();
    expect(fs.existsSync(backupPath) ? preUpgradeCopies() : []).toEqual([]);
  });

  it("holds the database as the previous version left it, and is filed on the Backup page", async () => {
    await boot();
    await shutdown();
    asIfLastBootedBy("3.0.0");

    const { version } = await boot();
    const { listBackupFiles } = await import("../src/modules/backups/run.js");
    const listed = listBackupFiles();
    await shutdown();

    const copies = preUpgradeCopies();
    expect(copies).toHaveLength(1);
    expect(listed.map((file) => file.name)).toContain(copies[0]);
    expect(listed.find((file) => file.name === copies[0])?.kind).toBe("database");
    // The copy is the database BEFORE this boot: it still says 3.0.0 booted it last.
    const copy = new Database(path.join(backupPath, copies[0]), { readonly: true });
    try {
      const last = copy.prepare("SELECT value FROM app_settings WHERE key = 'app.last_booted_version'").get() as { value: string };
      expect(last.value).toBe("3.0.0");
    } finally {
      copy.close();
    }
    expect(setting("app.last_booted_version")).toBe(version);
    // Nothing left staged beside the database.
    expect(fs.readdirSync(workdir).filter((name) => name.includes("pre-upgrade"))).toEqual([]);
  });

  it("covers an install from before versions were recorded", async () => {
    await boot();
    await shutdown();
    const raw = new Database(dbPath);
    raw.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('u1', 'a@b.c', 'x', 'A', 'admin')").run();
    raw.close();
    asIfLastBootedBy(null);

    await boot();
    await shutdown();
    expect(preUpgradeCopies()).toHaveLength(1);
  });

  it("keeps only the newest two, and never counts against the admin's own database copies", async () => {
    await boot();
    await shutdown();
    fs.mkdirSync(backupPath, { recursive: true });
    fs.writeFileSync(path.join(backupPath, "isputnik-20260101-010000-pre-upgrade.sqlite"), "old");
    fs.writeFileSync(path.join(backupPath, "isputnik-20260102-010000-pre-upgrade.sqlite"), "older");
    fs.writeFileSync(path.join(backupPath, "isputnik-20260103-010000.sqlite"), "an admin's copy");
    const past = new Date("2026-01-03T00:00:00Z");
    for (const name of fs.readdirSync(backupPath)) fs.utimesSync(path.join(backupPath, name), past, past);

    asIfLastBootedBy("3.0.0");
    await boot();
    await shutdown();

    const names = fs.readdirSync(backupPath).sort();
    expect(names.filter((name) => name.endsWith("-pre-upgrade.sqlite"))).toHaveLength(2);
    expect(names).toContain("isputnik-20260103-010000.sqlite");
  });

  it("is not taken when an older version starts (a rollback), so the copy it needs survives", async () => {
    await boot();
    await shutdown();
    asIfLastBootedBy("999.0.0");
    await boot();
    await shutdown();
    expect(fs.existsSync(backupPath) ? preUpgradeCopies() : []).toEqual([]);
  });

  it("is not replaced by a later boot while one is still waiting to be filed", async () => {
    await boot();
    await shutdown();
    asIfLastBootedBy("3.0.0");
    const staged = `${dbPath}.pre-upgrade`;
    fs.writeFileSync(staged, "the good copy from a boot that failed half-way");
    fs.writeFileSync(`${staged}.json`, JSON.stringify({ from: "3.0.0", to: "4.0.0", takenAt: new Date().toISOString() }));

    await boot();
    await shutdown();
    const copies = preUpgradeCopies();
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupPath, copies[0]), "utf8")).toBe("the good copy from a boot that failed half-way");
  });
});
