// Three kinds of backup, told apart by the file name: a full zip (database, key and
// the whole thumbnail store), a minimal zip (database, key and the pictures a rescan
// could not put back — the things that cannot be recreated), and a quick .sqlite
// copy of the database alone. Each kind keeps its own newest N, set per kind, so a
// nightly minimal backup never pushes the weekly full ones out. The schedule lives
// on the Scheduled jobs page as two jobs; the module's own daily timer from before
// 3.89.0 becomes the matching job on the first start.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootApp } from "./helpers/boot.js";
import { multipart as body } from "./helpers/multipart.js";

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
  const { backupsPlugin } = await import("../src/modules/backups/index.js");
  closeDb = () => db.close();

  // rescueStrandedBackups() MOVES anything under <cwd>/data/backups; keep it inside
  // the temp folder (see backup-restore-covers.test.ts).
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workdir);

  db.prepare(
    "INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, 'x', ?, 'admin')"
  ).run(ADMIN, "boss@test.local", "Boss");
  const booted = await bootApp({
    plugins: [backupsPlugin],
    // The upload route reads a file part, as index.ts lets it.
    beforeRegister: async (app) => {
      await app.register(multipart, { limits: { files: 1 } });
      beforeRegister?.(db);
    }
  });
  app = booted.app;
  signIn = () => booted.signIn(ADMIN);
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
  return res.json() as {
    backups: { name: string; kind: string }[];
    settings: { retention: { full: number; minimal: number; database: number } };
  };
}

// The thumbnail store as it looks when both kinds of picture are in it: a book
// cover (which may have been uploaded or fetched, so nothing can put it back) and
// an author portrait beside a gallery preview (rendered from the photo, so a scan
// makes it again). Keys are the real sharded shape thumbnailStorageKey writes.
const BOOK_COVER = "libbooks00000001/bo/ok/book1-cover.webp";
const BOOK_COVER_LARGE = "libbooks00000001/bo/ok/book1-cover-large.webp";
const PHOTO_PREVIEW = "libphotos0000001/ph/ot/photo1-cover.webp";
const AUTHOR_PORTRAIT = "people/au/th/author1-photo.webp";

function seedArt(db: import("better-sqlite3").Database): void {
  const library = db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by) VALUES (?, ?, ?, ?, ?)");
  library.run("libbooks00000001", "Books", "ebook", "/media/books", ADMIN);
  library.run("libphotos0000001", "Photos", "gallery", "/media/photos", ADMIN);
  const item = db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, ?, ?)");
  item.run("book1", "libbooks00000001", "ebook", "One");
  item.run("photo1", "libphotos0000001", "gallery", "2026/one.jpg");
  const metadata = db.prepare("INSERT INTO item_metadata (item_id, cover_storage_key) VALUES (?, ?)");
  metadata.run("book1", BOOK_COVER);
  metadata.run("photo1", PHOTO_PREVIEW);
  db.prepare("INSERT INTO people (id, name, image_storage_key) VALUES (?, ?, ?)").run("author1", "Some Author", AUTHOR_PORTRAIT);

  for (const key of [BOOK_COVER, BOOK_COVER_LARGE, PHOTO_PREVIEW, AUTHOR_PORTRAIT]) {
    const file = path.join(cachePath, ...key.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `webp-ish ${key}`);
  }
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
    expect(await entryNames(path.join(backupPath, backups[0].name)))
      .toEqual(["backup.json", "database.sqlite", "mfa.key", "thumbnails/covers/one.jpg"]);
  });

  it("a minimal backup is the database, the key and nothing else when there is no art", async () => {
    await bootWithPlugin();
    await create("minimal");

    const { backups } = await list();
    expect(backups[0]).toMatchObject({ kind: "minimal" });
    expect(backups[0].name).toMatch(/^isputnik-\d{8}-\d{6}-minimal\.zip$/);
    expect(await entryNames(path.join(backupPath, backups[0].name))).toEqual(["backup.json", "database.sqlite", "mfa.key"]);
  });

  it("a minimal backup carries the pictures a rescan could not put back, and no derived ones", async () => {
    await bootWithPlugin(seedArt);
    await create("minimal");

    const { backups } = await list();
    const entries = await entryNames(path.join(backupPath, backups[0].name));
    // The book cover (both sizes) and the author portrait: nothing on disk can
    // recreate either. The gallery preview is rendered from the photo, so it stays
    // out — that is the whole difference between the two zips.
    expect(entries).toEqual([
      "backup.json",
      "database.sqlite",
      "mfa.key",
      `thumbnails/${AUTHOR_PORTRAIT}`,
      `thumbnails/${BOOK_COVER_LARGE}`,
      `thumbnails/${BOOK_COVER}`
    ].sort());
    expect(entries).not.toContain(`thumbnails/${PHOTO_PREVIEW}`);
  });

  it("a full backup takes the store whole, derived previews included", async () => {
    await bootWithPlugin(seedArt);
    await create("full");

    const { backups } = await list();
    const entries = await entryNames(path.join(backupPath, backups[0].name));
    expect(entries).toContain(`thumbnails/${PHOTO_PREVIEW}`);
    expect(entries).toContain(`thumbnails/${BOOK_COVER}`);
  });

  it("the zip says which kind it is, so an uploaded minimal one is not filed as full", async () => {
    await bootWithPlugin(seedArt);
    await create("minimal");
    const { backups } = await list();
    const zip = path.join(backupPath, backups[0].name);

    const { readZipEntryText, isBackupManifestEntry } = await import("../src/modules/backups/zip-read.js");
    const manifest = JSON.parse((await readZipEntryText(zip, isBackupManifestEntry))!) as {
      kind: string; art: string; artFiles: number;
    };
    expect(manifest).toMatchObject({ kind: "minimal", art: "irreplaceable", artFiles: 3 });

    // Uploaded under any name, it comes back as minimal — the pictures inside it
    // would once have made it look like a full backup.
    const form = body([{ filename: "somebody-renamed-this.zip", data: fs.readFileSync(zip) }]);
    const res = await app.inject({
      method: "POST",
      url: "/api/backups/upload",
      headers: { cookie: await signIn(), ...form.headers },
      payload: form.payload
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().backup).toMatchObject({ kind: "minimal" });
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
  async function saveRetention(payload: unknown) {
    return app.inject({
      method: "PATCH",
      url: "/api/backups/settings",
      headers: { cookie: await signIn(), "content-type": "application/json" },
      payload
    });
  }

  it("each kind has its own count", async () => {
    await bootWithPlugin();
    const res = await saveRetention({ retention: { full: 2, minimal: 14, database: 5 } });
    expect(res.statusCode).toBe(200);
    expect((await list()).settings.retention).toEqual({ full: 2, minimal: 14, database: 5 });

    // Only the kinds named change; the others stay as they were.
    await saveRetention({ retention: { minimal: 7 } });
    expect((await list()).settings.retention).toEqual({ full: 2, minimal: 7, database: 5 });
  });

  it("a bare number still means the same for every kind, as older clients sent", async () => {
    await bootWithPlugin();
    await saveRetention({ retention: 3 });
    expect((await list()).settings.retention).toEqual({ full: 3, minimal: 3, database: 3 });
  });

  it("keeps the newest N of each kind, never one kind at another's expense", async () => {
    await bootWithPlugin();
    await saveRetention({ retention: 1 });
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
    const { listScheduledJobs } = await import("../src/modules/maintenance/scheduler.js");
    const byKey = Object.fromEntries(listScheduledJobs().map((j) => [j.key, j]));
    expect(byKey.backup_full).toMatchObject({ enabled: true, frequency: "daily", time: "04:15" });
    expect(byKey.backup_minimal).toMatchObject({ enabled: false });
    // The retention survives; the rest of the old blob is gone, so this runs once.
    expect((await list()).settings).toEqual({ retention: { full: 2, minimal: 2, database: 2 } });
    const { db } = await import("../src/db.js");
    const stored = db.prepare("SELECT value FROM app_settings WHERE key = 'backup_schedule'").get() as { value: string };
    expect(JSON.parse(stored.value)).toEqual({ retention: { full: 2, minimal: 2, database: 2 } });
  });

  it("covers off meant the minimal job", async () => {
    await bootWithPlugin((db) => {
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('backup_schedule', ?)")
        .run(JSON.stringify({ enabled: true, time: "02:00", retention: 5, includeCovers: false }));
    });
    const { listScheduledJobs } = await import("../src/modules/maintenance/scheduler.js");
    const byKey = Object.fromEntries(listScheduledJobs().map((j) => [j.key, j]));
    expect(byKey.backup_minimal).toMatchObject({ enabled: true, frequency: "daily", time: "02:00" });
    expect(byKey.backup_full).toMatchObject({ enabled: false });
  });

  it("a timer that was off enables nothing", async () => {
    await bootWithPlugin((db) => {
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('backup_schedule', ?)")
        .run(JSON.stringify({ enabled: false, time: "02:00", retention: 5, includeCovers: false }));
    });
    const { listScheduledJobs } = await import("../src/modules/maintenance/scheduler.js");
    const byKey = Object.fromEntries(listScheduledJobs().map((j) => [j.key, j]));
    expect(byKey.backup_minimal).toMatchObject({ enabled: false });
    expect(byKey.backup_full).toMatchObject({ enabled: false });
    expect((await list()).settings).toEqual({ retention: { full: 5, minimal: 5, database: 5 } });
  });

  it("running the job takes a backup of its kind in the background", async () => {
    await bootWithPlugin();
    const { runScheduledJob } = await import("../src/modules/maintenance/scheduler.js");
    const { backupRunSettled } = await import("../src/modules/backups/index.js");

    const view = runScheduledJob("backup_minimal", null);
    expect(view?.lastStatus).toBe("success");
    expect(view?.lastMessage).toMatch(/Started a minimal backup/);
    await backupRunSettled();

    const { backups } = await list();
    expect(backups.map((b) => b.kind)).toEqual(["minimal"]);
  });
});
