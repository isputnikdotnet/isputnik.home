// Three kinds of backup, told apart by the file name: a full zip (database, key,
// covers), a minimal zip (database and key — the two things that cannot be
// recreated), and a quick .sqlite copy of the database alone. Each kind keeps its
// own newest N, so a nightly minimal backup never pushes the weekly full ones out.
// The schedule lives on the Scheduled jobs page as two jobs; the module's own
// daily timer from before 3.89.0 becomes the matching job on the first start.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = "boss";

let workdir: string;
let dbPath: string;
let cachePath: string;
let backupPath: string;
let app: FastifyInstance;
let signIn: () => Promise<string>;
let closeDb: () => void;
let cwdSpy: ReturnType<typeof vi.spyOn>;

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

async function bootWithPlugin(beforeRegister?: (db: import("better-sqlite3").Database) => void): Promise<void> {
  vi.resetModules();
  const { db } = await import("../src/db.js");
  const { registerAuthDecorators, issueSession } = await import("../src/auth.js");
  const { backupsPlugin } = await import("../src/modules/backups/index.js");
  closeDb = () => db.close();

  // rescueStrandedBackups() MOVES anything under <cwd>/data/backups; keep it inside
  // the temp folder (see backup-restore-covers.test.ts).
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workdir);

  db.prepare(
    "INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, 'x', ?, 'admin')"
  ).run(ADMIN, "boss@test.local", "Boss");
  beforeRegister?.(db);

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

async function create(kind?: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/backups",
    headers: { cookie: await signIn(), "content-type": "application/json" },
    payload: kind ? { kind } : {}
  });
  const { backupRunSettled } = await import("../src/modules/backups/index.js");
  await backupRunSettled();
  return res;
}

async function list() {
  const res = await app.inject({ method: "GET", url: "/api/backups", headers: { cookie: await signIn() } });
  return res.json() as { backups: { name: string; kind: string }[]; settings: { retention: number } };
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-backup-kinds-"));
  dbPath = path.join(workdir, "app.sqlite");
  cachePath = path.join(workdir, "thumbnails");
  backupPath = path.join(workdir, "backups");
  fs.mkdirSync(path.join(cachePath, "covers"), { recursive: true });
  fs.writeFileSync(path.join(cachePath, "covers", "one.jpg"), "jpeg-ish");
  fs.mkdirSync(backupPath, { recursive: true });
  fs.writeFileSync(path.join(workdir, "mfa.key"), "k".repeat(64));

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

describe("the three kinds", () => {
  it("a full backup carries database, key and covers, and is the default kind", async () => {
    await bootWithPlugin();
    const res = await create();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ kind: "full" });

    const { backups } = await list();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ kind: "full" });
    expect(backups[0].name).toMatch(/^isputnik-\d{8}-\d{6}\.zip$/);
    expect(await entryNames(path.join(backupPath, backups[0].name))).toEqual(["database.sqlite", "mfa.key", "thumbnails/covers/one.jpg"]);
  });

  it("a minimal backup is the database and the key alone, named so", async () => {
    await bootWithPlugin();
    await create("minimal");

    const { backups } = await list();
    expect(backups[0]).toMatchObject({ kind: "minimal" });
    expect(backups[0].name).toMatch(/^isputnik-\d{8}-\d{6}-minimal\.zip$/);
    expect(await entryNames(path.join(backupPath, backups[0].name))).toEqual(["database.sqlite", "mfa.key"]);
  });

  it("a database copy is a bare, valid .sqlite file", async () => {
    await bootWithPlugin();
    await create("database");

    const { backups } = await list();
    expect(backups[0]).toMatchObject({ kind: "database" });
    expect(backups[0].name).toMatch(/^isputnik-\d{8}-\d{6}\.sqlite$/);
    const copy = new Database(path.join(backupPath, backups[0].name), { readonly: true });
    try {
      expect(copy.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    } finally {
      copy.close();
    }
    expect(fs.readdirSync(backupPath).filter((n) => n.startsWith(".tmp"))).toEqual([]);
  });

  it("refuses a kind it does not know", async () => {
    await bootWithPlugin();
    const res = await create("covers");
    expect(res.statusCode).toBe(400);
  });
});

describe("retention is per kind", () => {
  it("keeps the newest N of each kind, never one kind at another's expense", async () => {
    await bootWithPlugin();
    const cookieHeader = await signIn();
    await app.inject({
      method: "PATCH",
      url: "/api/backups/settings",
      headers: { cookie: cookieHeader, "content-type": "application/json" },
      payload: { retention: 1 }
    });
    // Older files of every kind, dated so the freshly made one is the newest.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const name of ["isputnik-20260101-010000.zip", "isputnik-20260101-010000-minimal.zip", "isputnik-20260101-010000.sqlite"]) {
      fs.writeFileSync(path.join(backupPath, name), "x");
      fs.utimesSync(path.join(backupPath, name), old, old);
    }

    await create("minimal");

    const names = (await list()).backups.map((b) => b.name).sort();
    // The old minimal one went; the old full backup and database copy are untouched.
    expect(names.filter((n) => n.endsWith("-minimal.zip"))).toHaveLength(1);
    expect(names.filter((n) => n.endsWith("-minimal.zip"))[0]).not.toBe("isputnik-20260101-010000-minimal.zip");
    expect(names).toContain("isputnik-20260101-010000.zip");
    expect(names).toContain("isputnik-20260101-010000.sqlite");
  });
});

describe("the schedule moved to the Scheduled jobs page", () => {
  it("an install with the old daily timer on wakes up with the matching job enabled", async () => {
    await bootWithPlugin((db) => {
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('backup_schedule', ?)")
        .run(JSON.stringify({ enabled: true, time: "04:15", retention: 2, includeCovers: true }));
    });
    const { listScheduledJobs } = await import("../src/modules/maintenance/index.js");
    const byKey = Object.fromEntries(listScheduledJobs().map((j) => [j.key, j]));
    expect(byKey.backup_full).toMatchObject({ enabled: true, frequency: "daily", time: "04:15" });
    expect(byKey.backup_minimal).toMatchObject({ enabled: false });
    // The retention survives; the rest of the old blob is gone, so this runs once.
    expect((await list()).settings).toEqual({ retention: 2 });
    const { db } = await import("../src/db.js");
    const stored = db.prepare("SELECT value FROM app_settings WHERE key = 'backup_schedule'").get() as { value: string };
    expect(JSON.parse(stored.value)).toEqual({ retention: 2 });
  });

  it("covers off meant the minimal job", async () => {
    await bootWithPlugin((db) => {
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('backup_schedule', ?)")
        .run(JSON.stringify({ enabled: true, time: "02:00", retention: 5, includeCovers: false }));
    });
    const { listScheduledJobs } = await import("../src/modules/maintenance/index.js");
    const byKey = Object.fromEntries(listScheduledJobs().map((j) => [j.key, j]));
    expect(byKey.backup_minimal).toMatchObject({ enabled: true, frequency: "daily", time: "02:00" });
    expect(byKey.backup_full).toMatchObject({ enabled: false });
  });

  it("a timer that was off enables nothing", async () => {
    await bootWithPlugin((db) => {
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('backup_schedule', ?)")
        .run(JSON.stringify({ enabled: false, time: "02:00", retention: 5, includeCovers: false }));
    });
    const { listScheduledJobs } = await import("../src/modules/maintenance/index.js");
    const byKey = Object.fromEntries(listScheduledJobs().map((j) => [j.key, j]));
    expect(byKey.backup_minimal).toMatchObject({ enabled: false });
    expect(byKey.backup_full).toMatchObject({ enabled: false });
    expect((await list()).settings).toEqual({ retention: 5 });
  });

  it("running the job takes a backup of its kind in the background", async () => {
    await bootWithPlugin();
    const { runScheduledJob } = await import("../src/modules/maintenance/index.js");
    const { backupRunSettled } = await import("../src/modules/backups/index.js");

    const view = runScheduledJob("backup_minimal", null);
    expect(view?.lastStatus).toBe("success");
    expect(view?.lastMessage).toMatch(/Started a minimal backup/);
    await backupRunSettled();

    const { backups } = await list();
    expect(backups.map((b) => b.kind)).toEqual(["minimal"]);
  });
});
