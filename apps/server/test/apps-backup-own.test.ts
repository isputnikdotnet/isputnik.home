// One container's backups apart from Home's (modules/backups/app-backups.ts): back
// it up, download it, upload it, restore it from its own file or from the copy inside
// a zip, and undo that — against a stand-in container speaking the contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import multipart from "@fastify/multipart";
import { bootApp } from "./helpers/boot.js";
import { multipart as body } from "./helpers/multipart.js";

const ADMIN = "boss";
const SECRET = "apps-backup-secret-0123456789abcdef";

let workdir: string;
let backups: string;
let app: FastifyInstance;
let signIn: () => Promise<string>;
let closeDb: () => void;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let games: FastifyInstance;
/** What the stand-in was last sent to restore, and how it answers. */
let received: { bytes: Buffer; version: string | undefined; role: string | undefined } | null;
let restoreAnswer: "ok" | "too-old" | "refuse";
let undoHeld: { takenAt: string; version: string; bytes: number } | null;
let undone: number;

function database(id = "m1"): Buffer {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE matches (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO matches VALUES (?)").run(id);
  const bytes = db.serialize();
  db.close();
  return bytes;
}

beforeEach(async () => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-app-backups-"));
  backups = path.join(workdir, "backups");
  fs.mkdirSync(backups, { recursive: true });
  received = null;
  restoreAnswer = "ok";
  undoHeld = null;
  undone = 0;

  games = Fastify({ bodyLimit: 1024 * 1024 });
  games.addContentTypeParser("application/vnd.sqlite3", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  games.get("/games/api/admin/backup", async (_request, reply) =>
    reply.type("application/vnd.sqlite3").header("x-isputnik-backup-version", "0.21.0").send(database()));
  games.post("/games/api/admin/restore", async (request, reply) => {
    if (request.headers["x-isputnik-gateway"] !== SECRET) return reply.code(401).send({ error: "Not signed in" });
    if (restoreAnswer === "too-old") return reply.code(404).send({ error: "Not found" });
    if (restoreAnswer === "refuse") return reply.code(409).send({ error: "That backup is from a newer version. Update this container first." });
    received = {
      bytes: request.body as Buffer,
      version: request.headers["x-isputnik-backup-version"] as string | undefined,
      role: request.headers["x-isputnik-user-role"] as string | undefined
    };
    undoHeld = { takenAt: "2026-10-30T10:00:00.000Z", version: "0.21.0", bytes: 100 };
    return { restored: true, version: "0.21.0" };
  });
  games.get("/games/api/admin/restore/undo", async (_request, reply) =>
    (restoreAnswer === "too-old" ? reply.code(404).send({ error: "Not found" }) : { undo: undoHeld }));
  games.post("/games/api/admin/restore/undo", async () => {
    undone += 1;
    undoHeld = null;
    return { undone: true };
  });
  await games.listen({ host: "127.0.0.1", port: 0 });
  const address = games.server.address();

  process.env.DB_PATH = path.join(workdir, "app.sqlite");
  process.env.BACKUP_PATH = backups;
  process.env.THUMBNAIL_PATH = path.join(workdir, "thumbnails");
  process.env.GAMES_URL = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  process.env.GAMES_GATEWAY_SECRET = SECRET;
  delete process.env.MFA_ENCRYPTION_KEY;

  vi.resetModules();
  const { db } = await import("../src/db.js");
  const { backupsPlugin } = await import("../src/modules/backups/index.js");
  closeDb = () => db.close();
  // rescueStrandedBackups() MOVES anything under <cwd>/data/backups: keep it in the temp folder.
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workdir);
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, 'x', ?, 'admin')").run(ADMIN, "boss@test.local", "Boss");
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('kid', 'kid@test.local', 'x', 'Kid', 'member')").run();
  const booted = await bootApp({ plugins: [[multipart, { limits: { files: 1 } }], backupsPlugin] });
  app = booted.app;
  signIn = () => booted.signIn(ADMIN);
});

afterEach(async () => {
  await app?.close();
  closeDb?.();
  cwdSpy?.mockRestore();
  await games.close();
  for (const key of ["DB_PATH", "BACKUP_PATH", "THUMBNAIL_PATH", "GAMES_URL", "GAMES_GATEWAY_SECRET"]) delete process.env[key];
  fs.rmSync(workdir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { cookie: await signIn(), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    ...(payload === undefined ? {} : { payload: payload as object })
  });

const list = async () => (await call("GET", "/api/backups/apps")).json().apps as {
  id: string;
  configured: boolean;
  include: boolean;
  keep: number;
  restoreSupported: boolean | null;
  undo: unknown;
  files: { name: string; source: string; version: string | null; sizeBytes: number }[];
}[];
const gamesView = async () => (await list()).find((entry) => entry.id === "games")!;

const backUp = async () => {
  const res = await call("POST", "/api/backups/apps/games");
  expect(res.statusCode).toBe(201);
  return res.json().backup.name as string;
};

describe("a container's own backups", () => {
  it("are an admin's", async () => {
    expect((await app.inject({ method: "GET", url: "/api/backups/apps" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/backups/apps/games" })).statusCode).toBeGreaterThanOrEqual(401);
  });

  it("are one file named for the container and its version, and Home's list stays Home's", async () => {
    const name = await backUp();
    expect(name).toMatch(/^isputnik-games-\d{8}-\d{6}-v0\.21\.0\.sqlite$/);
    const view = await gamesView();
    expect(view.files).toEqual([expect.objectContaining({ name, source: "own", version: "0.21.0" })]);
    expect(view.configured).toBe(true);
    expect((await call("GET", "/api/backups")).json().backups).toEqual([]);
    expect(fs.readdirSync(backups).filter((file) => file.startsWith(".tmp"))).toEqual([]);
  });

  it("keep the newest N, and only of their own", async () => {
    await call("PATCH", "/api/backups/apps/games/settings", { keep: 2 });
    const names = [await backUp(), await backUp(), await backUp()];
    const kept = (await gamesView()).files.map((file) => file.name);
    expect(kept).toHaveLength(2);
    expect(kept).toContain(names[2]);
  });

  it("download as the database itself", async () => {
    const name = await backUp();
    const res = await call("GET", `/api/backups/apps/games/files/${name}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.sqlite3");
    expect(res.headers["content-disposition"]).toContain(name);
    expect(res.rawPayload.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
  });

  it("delete, but never a name that is not one of its own", async () => {
    const name = await backUp();
    expect((await call("DELETE", `/api/backups/apps/video/files/${name}`)).statusCode).toBe(404);
    expect((await call("DELETE", `/api/backups/apps/games/files/${encodeURIComponent("../app.sqlite")}`)).statusCode).toBe(404);
    expect((await call("DELETE", `/api/backups/apps/games/files/${name}`)).statusCode).toBe(200);
    expect((await gamesView()).files).toEqual([]);
  });

  it("answer 404 for a container this release does not know", async () => {
    expect((await call("POST", "/api/backups/apps/chess")).statusCode).toBe(404);
  });
});

describe("restoring a container", () => {
  it("sends its own file as the admin, with its version, and undoes", async () => {
    const name = await backUp();
    const res = await call("POST", `/api/backups/apps/games/files/${name}/restore`, {});
    expect(res.statusCode).toBe(200);
    expect(received?.version).toBe("0.21.0");
    expect(received?.role).toBe("admin");
    expect(received?.bytes.equals(fs.readFileSync(path.join(backups, name)))).toBe(true);
    expect((await gamesView()).undo).toMatchObject({ version: "0.21.0" });

    expect((await call("POST", "/api/backups/apps/games/undo", {})).statusCode).toBe(200);
    expect(undone).toBe(1);
    expect((await gamesView()).undo).toBeNull();

    const { db } = await import("../src/db.js");
    const events = (db.prepare("SELECT event FROM activity_logs WHERE event LIKE 'backup.app_%'").all() as { event: string }[]).map((row) => row.event);
    expect(events).toEqual(expect.arrayContaining(["backup.app_created", "backup.app_restored", "backup.app_restore_undone"]));
  });

  it("finds the copy inside a full or minimal backup, and restores and downloads it", async () => {
    const started = await call("POST", "/api/backups", { kind: "minimal" });
    expect(started.statusCode).toBe(202);
    const { backupRunSettled } = await import("../src/modules/backups/index.js");
    await backupRunSettled();

    const [file] = (await gamesView()).files;
    expect(file).toMatchObject({ source: "minimal", version: "0.21.0" });
    expect(file.name.endsWith("-minimal.zip")).toBe(true);

    const download = await call("GET", `/api/backups/apps/games/files/${file.name}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toMatch(/isputnik-games-\d{8}-\d{6}-v0\.21\.0\.sqlite/);

    expect((await call("POST", `/api/backups/apps/games/files/${file.name}/restore`, {})).statusCode).toBe(200);
    expect(received?.bytes.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
    expect(received?.version).toBe("0.21.0");
    expect(fs.readdirSync(backups).filter((name) => name.startsWith(".tmp"))).toEqual([]);

    // The zip is Home's: it is not deleted from a container's card.
    expect((await call("DELETE", `/api/backups/apps/games/files/${file.name}`)).statusCode).toBe(404);
  });

  it("says when a backup does not hold this container, or does not exist", async () => {
    await call("POST", "/api/backups", { kind: "minimal" });
    const { backupRunSettled } = await import("../src/modules/backups/index.js");
    await backupRunSettled();
    const zip = fs.readdirSync(backups).find((name) => name.endsWith(".zip"))!;
    expect((await call("POST", `/api/backups/apps/video/files/${zip}/restore`, {})).statusCode).toBeGreaterThanOrEqual(404);
    expect((await call("POST", "/api/backups/apps/games/files/isputnik-games-20260101-000000.sqlite/restore", {})).statusCode).toBe(404);
  });

  it("passes on what the container refuses, in its words", async () => {
    const name = await backUp();
    restoreAnswer = "refuse";
    const res = await call("POST", `/api/backups/apps/games/files/${name}/restore`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/newer version/);
  });

  it("tells an older container's admin to update it", async () => {
    const name = await backUp();
    restoreAnswer = "too-old";
    expect((await gamesView()).restoreSupported).toBe(false);
    const res = await call("POST", `/api/backups/apps/games/files/${name}/restore`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/too old/);
  });

  it("says so when the container is not there", async () => {
    const name = await backUp();
    await games.close();
    expect((await gamesView()).restoreSupported).toBeNull();
    const res = await call("POST", `/api/backups/apps/games/files/${name}/restore`, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/did not answer/);
    // The stand-in is closed once already; a second close in afterEach is harmless.
  });
});

describe("the include switch", () => {
  it("leaves the container out of Full and Minimal, and its card still works", async () => {
    expect((await call("PATCH", "/api/backups/apps/games/settings", { include: false })).json().settings).toEqual({ include: false, keep: 10 });
    await call("POST", "/api/backups", { kind: "minimal" });
    const { backupRunSettled } = await import("../src/modules/backups/index.js");
    await backupRunSettled();
    expect((await gamesView()).files).toEqual([]);
    expect((await gamesView()).include).toBe(false);
    await backUp();
    expect((await gamesView()).files).toHaveLength(1);
  });

  it("refuses an empty change", async () => {
    expect((await call("PATCH", "/api/backups/apps/games/settings", {})).statusCode).toBe(400);
  });
});

describe("uploading a container's backup", () => {
  const upload = async (filename: string, content: Buffer) => {
    const form = body([{ name: "file", filename, data: content }]);
    return app.inject({
      method: "POST",
      url: "/api/backups/apps/games/upload",
      headers: { cookie: await signIn(), ...form.headers },
      payload: form.payload
    });
  };

  it("joins the list with the version its name carries", async () => {
    const res = await upload("isputnik-games-20260101-000000-v0.19.0.sqlite", database());
    expect(res.statusCode).toBe(201);
    expect((await gamesView()).files[0]).toMatchObject({ source: "own", version: "0.19.0" });
  });

  it("does not read the -v of a container's own name as a version", async () => {
    const uploadVideo = async (filename: string) => {
      const form = body([{ name: "file", filename, data: database() }]);
      const res = await app.inject({
        method: "POST",
        url: "/api/backups/apps/video/upload",
        headers: { cookie: await signIn(), ...form.headers },
        payload: form.payload
      });
      expect(res.statusCode).toBe(201);
    };
    const videoFiles = async () => (await list()).find((entry) => entry.id === "video")!.files;

    await uploadVideo("isputnik-video-20260101-000000.sqlite");
    expect((await videoFiles())[0].version).toBeNull();
    await uploadVideo("isputnik-video-20260101-000000-v0.10.0.sqlite");
    expect((await videoFiles()).map((file) => file.version)).toContain("0.10.0");
  });

  it("takes a file renamed by someone, without a version", async () => {
    expect((await upload("my games.sqlite", database())).statusCode).toBe(201);
    expect((await gamesView()).files[0]).toMatchObject({ source: "own", version: null });
  });

  it("refuses what is not a database, or another container's by name", async () => {
    expect((await upload("x.sqlite", Buffer.from("<html>not a database</html>"))).statusCode).toBe(400);
    expect((await upload("isputnik-video-20260101-000000.sqlite", database())).statusCode).toBe(400);
    expect((await gamesView()).files).toEqual([]);
    expect(fs.readdirSync(backups)).toEqual([]);
  });
});
