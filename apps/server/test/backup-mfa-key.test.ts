// mfa.key is the only thing that can decrypt the TOTP secrets stored in the
// database, and it lives beside it as a file rather than inside it. A backup that
// carried the database but not the key restored an install whose two-factor users
// were all locked out — the failure only shows up on the host that restores, which
// is the worst possible moment to discover it.
//
// So the key travels in the zip, and a restore STAGES it: the running process is
// still serving the old database until the next start, and swapping the key out
// from under it would break TOTP in the meantime. db.ts moves the pair together.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBackupMfaKeyEntry } from "../src/modules/backups/zip-read.js";

const BACKUP = "isputnik-20260101-120000.zip";
const ADMIN = "boss";
const LIVE_KEY = "a".repeat(64);
const BACKED_UP_KEY = "b".repeat(64);

let workdir: string;
let dbPath: string;
let keyPath: string;
let cachePath: string;
let backupPath: string;
let app: FastifyInstance;
let signIn: () => Promise<string>;
let closeDb: () => void;
let cwdSpy: ReturnType<typeof vi.spyOn>;

function makeDatabaseFile(target: string): void {
  const handle = new Database(target);
  handle.exec("CREATE TABLE keepsake (id INTEGER PRIMARY KEY)");
  handle.close();
}

// `key` of null builds a backup written before this shipped — or by an install that
// sets MFA_ENCRYPTION_KEY and so has no file to carry.
async function makeBackupZip(target: string, key: string | null): Promise<void> {
  const dbFile = path.join(workdir, "inner.sqlite");
  makeDatabaseFile(dbFile);

  const out = fs.createWriteStream(target);
  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.pipe(out);
  archive.file(dbFile, { name: "database.sqlite" });
  if (key !== null) archive.append(key, { name: "mfa.key" });
  const done = new Promise<void>((resolve, reject) => {
    out.on("close", () => resolve());
    archive.on("error", reject);
  });
  await archive.finalize();
  await done;
}

function entryNames(zipPath: string): Promise<string[]> {
  return import("../src/modules/backups/zip-read.js").then(async ({ extractFromZip }) => {
    const seen: string[] = [];
    const sink = path.join(workdir, "sink");
    await extractFromZip(zipPath, (name) => {
      seen.push(name);
      return path.join(sink, path.basename(name));
    });
    return seen.sort();
  });
}

function restore(cookieHeader: string) {
  return app.inject({
    method: "POST",
    url: `/api/backups/${BACKUP}/restore`,
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    payload: { covers: false }
  });
}

async function bootWithPlugin(): Promise<void> {
  vi.resetModules();
  const { db } = await import("../src/db.js");
  const { registerAuthDecorators, issueSession } = await import("../src/auth.js");
  const { backupsPlugin } = await import("../src/modules/backups/index.js");
  closeDb = () => db.close();

  // Registering the plugin runs rescueStrandedBackups(), which MOVES anything that
  // looks like a backup out of <cwd>/data/backups into the configured folder. Under
  // vitest the working directory is the repo, so without this the suite eats the
  // developer's own backups. See backup-restore-covers.test.ts.
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workdir);

  db.prepare(
    "INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, 'x', ?, 'admin')"
  ).run(ADMIN, "boss@test.local", "Boss");

  app = Fastify();
  await app.register(cookie);
  await registerAuthDecorators(app);
  await app.register(backupsPlugin);
  app.post("/test/sign-in", async (request, reply) => {
    issueSession(reply, ADMIN, request);
    return reply.send({ ok: true });
  });
  await app.ready();

  signIn = async () => {
    const res = await app.inject({ method: "POST", url: "/test/sign-in" });
    const raw = res.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    const found = list.find((entry) => entry.startsWith("isputnik_sid="));
    if (!found) throw new Error("no session cookie was set");
    return found.split(";")[0];
  };
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-mfakey-"));
  dbPath = path.join(workdir, "app.sqlite");
  keyPath = path.join(workdir, "mfa.key");
  cachePath = path.join(workdir, "thumbnails");
  backupPath = path.join(workdir, "backups");
  fs.mkdirSync(cachePath, { recursive: true });
  fs.mkdirSync(backupPath, { recursive: true });

  process.env.DB_PATH = dbPath;
  process.env.THUMBNAIL_PATH = cachePath;
  process.env.BACKUP_PATH = backupPath;
  delete process.env.MFA_ENCRYPTION_KEY;
});

afterEach(async () => {
  await app?.close();
  closeDb?.();
  cwdSpy?.mockRestore();
  app = undefined as never;
  closeDb = undefined as never;
  delete process.env.DB_PATH;
  delete process.env.THUMBNAIL_PATH;
  delete process.env.BACKUP_PATH;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("a backup carries the key that decrypts its secrets", () => {
  it("writes mfa.key into the archive beside the database", async () => {
    fs.writeFileSync(keyPath, LIVE_KEY);
    await bootWithPlugin();
    const { backupRunSettled } = await import("../src/modules/backups/index.js");

    const res = await app.inject({
      method: "POST",
      url: "/api/backups",
      headers: { cookie: await signIn(), "content-type": "application/json" },
      payload: {}
    });
    expect(res.statusCode).toBeLessThan(300);
    await backupRunSettled();

    const written = fs.readdirSync(backupPath).find((n) => n.endsWith(".zip"));
    expect(written).toBeDefined();
    expect(await entryNames(path.join(backupPath, written!))).toEqual(["database.sqlite", "mfa.key"]);
  });

  it("omits it when the install keeps no key file", async () => {
    // What an MFA_ENCRYPTION_KEY install looks like: the env key is expected to be
    // configured on whichever host restores, so absent is normal, not a fault.
    await bootWithPlugin();
    const { backupRunSettled } = await import("../src/modules/backups/index.js");

    await app.inject({
      method: "POST",
      url: "/api/backups",
      headers: { cookie: await signIn(), "content-type": "application/json" },
      payload: {}
    });
    await backupRunSettled();

    const written = fs.readdirSync(backupPath).find((n) => n.endsWith(".zip"));
    expect(await entryNames(path.join(backupPath, written!))).toEqual(["database.sqlite"]);
  });
});

describe("restoring stages the key rather than applying it", () => {
  it("stages it and leaves the live key untouched", async () => {
    // The live key must survive the request: this process still serves the CURRENT
    // database until it restarts, and that database's secrets need the current key.
    fs.writeFileSync(keyPath, LIVE_KEY);
    await makeBackupZip(path.join(backupPath, BACKUP), BACKED_UP_KEY);
    await bootWithPlugin();

    const res = await restore(await signIn());

    expect(res.json()).toMatchObject({ staged: true, mfaKeyStaged: true });
    expect(fs.readFileSync(`${keyPath}.restore`, "utf8")).toBe(BACKED_UP_KEY);
    expect(fs.readFileSync(keyPath, "utf8")).toBe(LIVE_KEY);
  });

  it("leaves the live key alone when the backup has none", async () => {
    fs.writeFileSync(keyPath, LIVE_KEY);
    await makeBackupZip(path.join(backupPath, BACKUP), null);
    await bootWithPlugin();

    const res = await restore(await signIn());

    expect(res.json()).toMatchObject({ staged: true, mfaKeyStaged: false });
    expect(fs.existsSync(`${keyPath}.restore`)).toBe(false);
    expect(fs.readFileSync(keyPath, "utf8")).toBe(LIVE_KEY);
  });

  it("does not strand the temp database's -wal/-shm siblings", async () => {
    // Validating the staged database opens it, and opening a WAL database writes
    // -shm/-wal beside it; the rename that follows moves only the main file. A real
    // install had a .restore.tmp-shm next to its database months after a restore.
    await makeBackupZip(path.join(backupPath, BACKUP), BACKED_UP_KEY);
    await bootWithPlugin();

    await restore(await signIn());

    expect(fs.readdirSync(workdir).filter((n) => n.includes(".restore.tmp"))).toEqual([]);
  });
});

describe("startup applies the staged pair together", () => {
  it("moves the key into place and keeps the outgoing one", async () => {
    // The safety snapshot db.ts takes is the OLD database, and reading its TOTP
    // secrets later needs the OLD key — so the outgoing key is kept, not discarded.
    makeDatabaseFile(dbPath);
    fs.writeFileSync(keyPath, LIVE_KEY);
    makeDatabaseFile(`${dbPath}.restore`);
    fs.writeFileSync(`${keyPath}.restore`, BACKED_UP_KEY);

    vi.resetModules();
    const { db } = await import("../src/db.js"); // applyPendingRestore runs on import
    closeDb = () => db.close();

    expect(fs.readFileSync(keyPath, "utf8")).toBe(BACKED_UP_KEY);
    expect(fs.readFileSync(`${keyPath}.previous`, "utf8")).toBe(LIVE_KEY);
    expect(fs.existsSync(`${keyPath}.restore`)).toBe(false);
  });

  it("leaves the key alone when a restore stages only a database", async () => {
    makeDatabaseFile(dbPath);
    fs.writeFileSync(keyPath, LIVE_KEY);
    makeDatabaseFile(`${dbPath}.restore`);

    vi.resetModules();
    const { db } = await import("../src/db.js");
    closeDb = () => db.close();

    expect(fs.readFileSync(keyPath, "utf8")).toBe(LIVE_KEY);
    expect(fs.existsSync(`${keyPath}.previous`)).toBe(false);
  });
});

describe("finding the key inside an archive", () => {
  it("matches at the root and under a wrapping folder, and nothing else", () => {
    expect(isBackupMfaKeyEntry("mfa.key")).toBe(true);
    expect(isBackupMfaKeyEntry("isputnik-20260101-120000/mfa.key")).toBe(true);
    expect(isBackupMfaKeyEntry("thumbnails/mfa.key.txt")).toBe(false);
    expect(isBackupMfaKeyEntry("notmfa.key")).toBe(false);
  });
});
