// This server's tests on Diagnostics › iSputnik (modules/diagnostics/tests.ts):
// checking the library folders, verifying the newest backup, and recording a
// speed result the browser measured. They change nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { diagnosticsPlugin } from "../src/modules/diagnostics/index.js";
import { checkFolders, testSettled } from "../src/modules/diagnostics/tests.js";
import { backupDir, ensureBackupDir, type BackupFile } from "../src/modules/backups/run.js";
import { verifyBackup } from "../src/modules/backups/verify.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let workdir: string;

beforeEach(() => {
  resetDb();
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-diag-tests-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

/** A backup zip in the backup folder, with a real database inside unless `database` is a string. */
async function makeBackup(name: string, database: "real" | string = "real"): Promise<BackupFile> {
  const dbFile = path.join(workdir, "database.sqlite");
  if (database === "real") {
    const made = new Database(dbFile);
    made.exec("CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER); INSERT INTO a VALUES (1);");
    made.close();
  }
  ensureBackupDir();
  const target = path.join(backupDir(), name);
  const out = fs.createWriteStream(target);
  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.pipe(out);
  if (database === "real") archive.file(dbFile, { name: "database.sqlite" });
  else archive.append(database, { name: "database.sqlite" });
  archive.append(JSON.stringify({ kind: "full", version: "4.90.0" }), { name: "backup.json" });
  archive.append("x".repeat(5000), { name: "thumbnails/a.jpg" });
  const done = new Promise<void>((resolve, reject) => { out.on("close", () => resolve()); archive.on("error", reject); });
  await archive.finalize();
  await done;
  const stat = fs.statSync(target);
  return { name, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), kind: "full" };
}

describe("verifying a backup", () => {
  it("reads every file through and checks the database inside is intact", async () => {
    const file = await makeBackup("isputnik-20261114-020000.zip");
    const result = await verifyBackup(file);
    expect(result).toMatchObject({ ok: true, files: 3, manifest: { kind: "full", version: "4.90.0" }, database: { found: true, integrity: "ok", tables: 2 }, error: null });
    expect(result.bytes).toBeGreaterThan(5000);
    fs.rmSync(path.join(backupDir(), file.name));
  });

  it("checks a database-only backup, which is the .sqlite itself", async () => {
    const made = new Database(path.join(backupDir(), "isputnik-20261114-050000.sqlite"));
    made.exec("CREATE TABLE a (id INTEGER);");
    made.close();
    const stat = fs.statSync(path.join(backupDir(), "isputnik-20261114-050000.sqlite"));
    const result = await verifyBackup({ name: "isputnik-20261114-050000.sqlite", sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), kind: "database" });
    expect(result).toMatchObject({ ok: true, files: 1, database: { found: true, integrity: "ok", tables: 1 } });
    fs.rmSync(path.join(backupDir(), "isputnik-20261114-050000.sqlite"));
  });

  it("says so when the database inside isn't one", async () => {
    const file = await makeBackup("isputnik-20261114-030000.zip", "not a database at all");
    const result = await verifyBackup(file);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a database|file is not a database/i);
    fs.rmSync(path.join(backupDir(), file.name));
  });
});

describe("checking the folders", () => {
  it("times each folder this server reads and its largest file, and skips video libraries", async () => {
    makeUser("admin", "admin");
    const photos = path.join(workdir, "photos");
    fs.mkdirSync(path.join(photos, "2024"), { recursive: true });
    fs.writeFileSync(path.join(photos, "2024", "big.jpg"), Buffer.alloc(6 * 1024 * 1024, 1));
    makeLibrary("lib-photos", { createdBy: "admin", type: "gallery" });
    db.prepare("UPDATE libraries SET name = 'Photos', source_path = ? WHERE id = 'lib-photos'").run(photos);
    makeLibrary("lib-gone", { createdBy: "admin", type: "ebook" });
    db.prepare("UPDATE libraries SET name = 'Gone', source_path = ? WHERE id = 'lib-gone'").run(path.join(workdir, "nowhere"));
    makeLibrary("lib-films", { createdBy: "admin", type: "video" });
    db.prepare("UPDATE libraries SET name = 'Films', source_path = 'Movies' WHERE id = 'lib-films'").run();

    const check = await checkFolders();
    expect(check.libraries.map((library) => library.name)).toEqual(["Gone", "Photos"]);
    const found = check.libraries.find((library) => library.name === "Photos")!;
    expect(found.verdict).toBe("ok");
    expect(found.read?.bytes).toBe(6 * 1024 * 1024);
    expect(found.read?.mbitPerSecond).toBeGreaterThan(0);
    expect(check.libraries.find((library) => library.name === "Gone")).toMatchObject({ verdict: "missing" });
  });
});

describe("the tests' routes", () => {
  let booted: BootedApp | null = null;
  beforeEach(async () => {
    makeUser("admin", "admin");
    makeUser("kid", "member");
    db.prepare("DELETE FROM app_settings WHERE key = 'diagnostics.tests'").run();
    booted = await bootApp({ plugins: [[diagnosticsPlugin, { settings: { video: { upstream: "", secret: "" }, games: { upstream: "", secret: "" }, faces: { upstream: "", secret: "" } } }]] });
  });
  afterEach(async () => {
    await testSettled();
    await booted?.app.close();
    booted = null;
  });

  const call = async (who: string, method: "GET" | "POST", url: string, payload?: object) =>
    booted!.app.inject({ method, url, payload, headers: { cookie: await booted!.signIn(who) } });

  it("are for an admin; a test runs in the background, one at a time, and lands in Recent runs", async () => {
    expect((await call("kid", "GET", "/api/admin/diagnostics/tests")).statusCode).toBe(403);
    const file = await makeBackup("isputnik-20261114-040000.zip");
    const started = await call("admin", "POST", "/api/admin/diagnostics/tests/backup");
    expect(started.statusCode).toBe(202);
    expect(started.json().running).toMatchObject({ kind: "backup" });
    expect((await call("admin", "POST", "/api/admin/diagnostics/tests/folders")).statusCode).toBe(409);
    await testSettled();
    const state = (await call("admin", "GET", "/api/admin/diagnostics/tests")).json();
    expect(state.running).toBeNull();
    expect(state.backup).toMatchObject({ ok: true, name: file.name });
    expect(state.runs[0]).toMatchObject({ kind: "backup", ok: true });
    expect((await call("admin", "POST", "/api/admin/diagnostics/tests/nonsense")).statusCode).toBe(404);
    fs.rmSync(path.join(backupDir(), file.name));
  });

  it("records the speed the browser measured", async () => {
    const response = await call("admin", "POST", "/api/admin/diagnostics/tests/speed", { downloadMbps: 212.4, replyMs: 4, bytes: 26214400 });
    expect(response.statusCode).toBe(200);
    expect(response.json().speed).toMatchObject({ downloadMbps: 212.4, replyMs: 4 });
    expect(response.json().runs[0]).toMatchObject({ kind: "speed", facts: { downloadMbps: 212.4 } });
    expect((await call("admin", "POST", "/api/admin/diagnostics/tests/speed", { downloadMbps: -1 })).statusCode).toBe(400);
  });
});
