// Creating a backup is start-and-poll: the POST answers as soon as the run is
// going (a real backup outlives any proxy's patience for an open request), the
// GET reports the run, and one run at a time is the rule. These tests hold the
// run open by gating db.backup, so "while it's running" is a fact and not a race.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootApp } from "./helpers/boot.js";

const ADMIN = "boss";

let workdir: string;
let dbPath: string;
let cachePath: string;
let backupPath: string;
let app: FastifyInstance;
let signIn: () => Promise<string>;
let closeDb: () => void;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let db: typeof import("../src/db.js")["db"];
let backupRunSettled: () => Promise<void>;

function makeDatabaseFile(target: string): void {
  const handle = new Database(target);
  handle.exec("CREATE TABLE keepsake (id INTEGER PRIMARY KEY)");
  handle.close();
}

// Replace the database snapshot step with one that waits until told to finish,
// so a test can look around (or fail the run) while the backup is in flight.
function gateBackup(): { release: () => void; fail: (err: Error) => void } {
  let release!: () => void;
  let fail!: (err: Error) => void;
  const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  vi.spyOn(db, "backup").mockImplementation(((destination: string) =>
    gate.then(() => { makeDatabaseFile(destination); return {} as never; })) as never);
  return { release, fail };
}

function createBackup(cookieHeader: string) {
  return app.inject({
    method: "POST",
    url: "/api/backups",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    payload: {}
  });
}

function listBackups(cookieHeader: string) {
  return app.inject({ method: "GET", url: "/api/backups", headers: { cookie: cookieHeader } });
}

beforeEach(async () => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-backup-async-"));
  dbPath = path.join(workdir, "app.sqlite");
  cachePath = path.join(workdir, "thumbnails");
  backupPath = path.join(workdir, "backups");
  fs.mkdirSync(cachePath, { recursive: true });
  fs.mkdirSync(backupPath, { recursive: true });

  process.env.DB_PATH = dbPath;
  process.env.THUMBNAIL_PATH = cachePath;
  process.env.BACKUP_PATH = backupPath;

  // Fresh graph so config.ts reads the folders above.
  vi.resetModules();
  const dbModule = await import("../src/db.js");
  const backups = await import("../src/modules/backups/index.js");
  db = dbModule.db;
  backupRunSettled = backups.backupRunSettled;
  closeDb = () => db.close();

  // Registering the plugin runs rescueStrandedBackups(), which MOVES anything that
  // looks like a backup out of <cwd>/data/backups into the configured folder. Under
  // vitest the working directory is the repo, so the whole test must believe the
  // working directory is this temp folder — see backup-restore-covers.test.ts.
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workdir);

  db.prepare(
    "INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, 'x', ?, 'admin')"
  ).run(ADMIN, "boss@test.local", "Boss");

  const booted = await bootApp({ plugins: [backups.backupsPlugin] });
  app = booted.app;
  signIn = () => booted.signIn(ADMIN);
});

afterEach(async () => {
  await backupRunSettled?.();
  await app?.close();
  closeDb?.();
  cwdSpy?.mockRestore();
  vi.restoreAllMocks();
  delete process.env.DB_PATH;
  delete process.env.THUMBNAIL_PATH;
  delete process.env.BACKUP_PATH;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("starting a backup", () => {
  it("answers at once, reports the run, and the finished file appears", async () => {
    const cookieHeader = await signIn();
    const gate = gateBackup();

    const started = await createBackup(cookieHeader);
    expect(started.statusCode).toBe(202);
    expect(typeof started.json().startedAt).toBe("string");

    const during = (await listBackups(cookieHeader)).json();
    expect(during.runningSince).toBe(started.json().startedAt);
    expect(during.lastError).toBeNull();

    gate.release();
    await backupRunSettled();

    const after = (await listBackups(cookieHeader)).json();
    expect(after.runningSince).toBeNull();
    expect(after.lastError).toBeNull();
    expect(after.backups).toHaveLength(1);
    expect(after.backups[0].name).toMatch(/\.zip$/);
    expect(after.backups[0].sizeBytes).toBeGreaterThan(0);
  });

  it("refuses a second start while one is running", async () => {
    const cookieHeader = await signIn();
    const gate = gateBackup();

    expect((await createBackup(cookieHeader)).statusCode).toBe(202);
    const second = await createBackup(cookieHeader);
    expect(second.statusCode).toBe(409);

    gate.release();
    await backupRunSettled();
    // And once it's done, starting again is allowed.
    expect((await createBackup(cookieHeader)).statusCode).toBe(202);
    await backupRunSettled();
  });

  it("surfaces a failed run and doesn't stay stuck", async () => {
    const cookieHeader = await signIn();
    const gate = gateBackup();

    await createBackup(cookieHeader);
    gate.fail(new Error("disk full"));
    await backupRunSettled();

    const after = (await listBackups(cookieHeader)).json();
    expect(after.runningSince).toBeNull();
    expect(after.lastError).toContain("disk full");
    expect(after.backups).toHaveLength(0);

    const logged = db.prepare("SELECT COUNT(*) AS count FROM activity_logs WHERE event = 'backup.failed'").get() as { count: number };
    expect(logged.count).toBe(1);

    // A failure releases the lock: the next start is accepted.
    expect((await createBackup(cookieHeader)).statusCode).toBe(202);
    await backupRunSettled();
  });
});
