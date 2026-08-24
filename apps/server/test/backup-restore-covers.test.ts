// Restoring a backup puts two different things back: the database, staged for the
// next startup, and the cover cache, written live. Wanting only the first is the
// common case — the covers are the bulk of the archive and usually the ones already
// on disk — so the restore takes an option, and this holds it to it.
//
// The route reads config for the database, cache and backup folders, all of which
// are fixed when the modules first load. So each test builds its own config and
// imports the module graph fresh, rather than running against the shared in-memory
// database the rest of the suite uses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BACKUP = "isputnik-20260101-120000.zip";
const ADMIN = "boss";

let workdir: string;
let dbPath: string;
let cachePath: string;
let backupPath: string;
let app: FastifyInstance;
let signIn: () => Promise<string>;
let closeDb: () => void;
let cwdSpy: ReturnType<typeof vi.spyOn>;

// A real SQLite file, because the restore refuses anything that isn't one.
function makeDatabaseFile(target: string): void {
  const handle = new Database(target);
  handle.exec("CREATE TABLE keepsake (id INTEGER PRIMARY KEY)");
  handle.close();
}

async function makeBackupZip(target: string): Promise<void> {
  const dbFile = path.join(workdir, "inner.sqlite");
  makeDatabaseFile(dbFile);

  const out = fs.createWriteStream(target);
  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.pipe(out);
  archive.file(dbFile, { name: "database.sqlite" });
  archive.append("a cover", { name: "thumbnails/covers/one.jpg" });
  archive.append("another cover", { name: "thumbnails/covers/two.jpg" });
  const done = new Promise<void>((resolve, reject) => {
    out.on("close", () => resolve());
    archive.on("error", reject);
  });
  await archive.finalize();
  await done;
}

function restore(cookieHeader: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/backups/${BACKUP}/restore`,
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    payload: payload as never
  });
}

function coversOnDisk(): string[] {
  const dir = path.join(cachePath, "covers");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

beforeEach(async () => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-restore-"));
  dbPath = path.join(workdir, "app.sqlite");
  cachePath = path.join(workdir, "thumbnails");
  backupPath = path.join(workdir, "backups");
  fs.mkdirSync(cachePath, { recursive: true });
  fs.mkdirSync(backupPath, { recursive: true });
  await makeBackupZip(path.join(backupPath, BACKUP));

  process.env.DB_PATH = dbPath;
  process.env.THUMBNAIL_PATH = cachePath;
  process.env.BACKUP_PATH = backupPath;

  // Fresh graph so config.ts reads the folders above.
  vi.resetModules();
  const { db } = await import("../src/db.js");
  const { registerAuthDecorators, issueSession } = await import("../src/auth.js");
  const { backupsPlugin } = await import("../src/modules/backups/index.js");
  closeDb = () => db.close();

  // Registering the plugin runs rescueStrandedBackups(), which MOVES anything that
  // looks like a backup out of <cwd>/data/backups and into the configured folder.
  // Under vitest the working directory is the repo, so without this the suite eats
  // the developer's own backups — it has done exactly that once. The whole test must
  // therefore believe the working directory is this temp folder.
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
});

afterEach(async () => {
  await app?.close();
  closeDb?.();
  cwdSpy?.mockRestore();
  delete process.env.DB_PATH;
  delete process.env.THUMBNAIL_PATH;
  delete process.env.BACKUP_PATH;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("choosing what a restore puts back", () => {
  it("stages the database and leaves the covers alone when asked to", async () => {
    const res = await restore(await signIn(), { covers: false });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ staged: true, coversRestored: 0, coversSkipped: true });
    expect(fs.existsSync(`${dbPath}.restore`)).toBe(true);
    expect(coversOnDisk()).toEqual([]);
  });

  it("puts the covers back when asked for them", async () => {
    const res = await restore(await signIn(), { covers: true });

    expect(res.json()).toMatchObject({ staged: true, coversRestored: 2, coversSkipped: false });
    expect(coversOnDisk()).toEqual(["one.jpg", "two.jpg"]);
    expect(fs.readFileSync(path.join(cachePath, "covers", "one.jpg"), "utf8")).toBe("a cover");
  });

  it("restores everything when the caller says nothing", async () => {
    // What an older client sends. Saying nothing has always meant the whole backup,
    // and a restore that quietly dropped the covers would be the worse surprise.
    const res = await restore(await signIn(), {});

    expect(res.json()).toMatchObject({ staged: true, coversRestored: 2 });
    expect(coversOnDisk()).toEqual(["one.jpg", "two.jpg"]);
  });

  it("follows the thumbnail store the admin set, not the environment", async () => {
    // The store is an app setting that overrides THUMBNAIL_PATH, and the rest of the
    // app reads it that way. Reading only the environment here put the covers back
    // into a folder nothing looks at — and left them out of the backup to begin with.
    const chosen = path.join(workdir, "elsewhere");
    const { db } = await import("../src/db.js");
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('library.thumbnail_path', ?)").run(chosen);

    const res = await restore(await signIn(), { covers: true });

    expect(res.json()).toMatchObject({ coversRestored: 2 });
    expect(fs.readdirSync(path.join(chosen, "covers")).sort()).toEqual(["one.jpg", "two.jpg"]);
    expect(coversOnDisk()).toEqual([]); // …and nothing in the environment's folder
  });

  it("says in the log which kind of restore it was", async () => {
    const cookieHeader = await signIn();
    await restore(cookieHeader, { covers: false });

    const { db } = await import("../src/db.js");
    const row = db
      .prepare("SELECT detail FROM activity_logs WHERE event = 'backup.restore_staged' ORDER BY rowid DESC")
      .get() as { detail: string };
    expect(row.detail).toContain("database only");
  });
});
