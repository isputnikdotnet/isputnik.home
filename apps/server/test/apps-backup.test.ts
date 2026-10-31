// The containers' databases in this server's backups (modules/apps/backup.ts):
// a full or minimal zip carries apps/<id>.sqlite and says so in backup.json; a
// container that does not answer is left out and named, and the backup still
// finishes. The quick database copy stays this server's alone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootApp } from "./helpers/boot.js";

const ADMIN = "boss";
const SECRET = "apps-backup-secret-0123456789abcdef";

let workdir: string;
let app: FastifyInstance;
let signIn: () => Promise<string>;
let closeDb: () => void;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let games: FastifyInstance;
/** How the stand-in games server answers the backup call. */
let answer: "database" | "missing" | "garbage";
let seenRole: string | undefined;

/** A real, small SQLite database, as better-sqlite3's serialize() hands one over. */
function gamesDatabase(): Buffer {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE matches (id TEXT PRIMARY KEY); INSERT INTO matches VALUES ('m1')");
  const bytes = db.serialize();
  db.close();
  return bytes;
}

beforeEach(async () => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-apps-backup-"));
  fs.mkdirSync(path.join(workdir, "backups"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "mfa.key"), "k".repeat(64));
  answer = "database";
  seenRole = undefined;

  games = Fastify();
  games.get("/games/api/admin/backup", async (request, reply) => {
    if (request.headers["x-isputnik-gateway"] !== SECRET) return reply.code(401).send({ error: "Not signed in" });
    seenRole = request.headers["x-isputnik-user-role"] as string;
    if (answer === "missing") return reply.code(404).send({ error: "Not found" });
    if (answer === "garbage") return reply.type("text/html").send("<html>oops</html>");
    return reply.type("application/vnd.sqlite3").header("x-isputnik-backup-version", "0.18.0").send(gamesDatabase());
  });
  await games.listen({ host: "127.0.0.1", port: 0 });
  const address = games.server.address();

  process.env.DB_PATH = path.join(workdir, "app.sqlite");
  process.env.BACKUP_PATH = path.join(workdir, "backups");
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
  const booted = await bootApp({ plugins: [backupsPlugin] });
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

async function backup(kind: "full" | "minimal" | "database"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/backups",
    headers: { cookie: await signIn(), "content-type": "application/json" },
    payload: { kind }
  });
  expect(res.statusCode).toBe(202);
  const { backupRunSettled } = await import("../src/modules/backups/index.js");
  await backupRunSettled();
  const files = fs.readdirSync(path.join(workdir, "backups")).filter((name) => name.startsWith("isputnik-"));
  expect(files).toHaveLength(1);
  return path.join(workdir, "backups", files[0]);
}

async function entries(zip: string): Promise<string[]> {
  const { extractFromZip } = await import("../src/modules/backups/zip-read.js");
  const seen: string[] = [];
  await extractFromZip(zip, (name) => {
    seen.push(name);
    return path.join(workdir, "sink", name);
  });
  return seen.sort();
}

async function manifest(zip: string): Promise<Record<string, unknown>> {
  const { readZipEntryText, isBackupManifestEntry } = await import("../src/modules/backups/zip-read.js");
  return JSON.parse((await readZipEntryText(zip, isBackupManifestEntry)) ?? "{}");
}

async function lastBackupLog(): Promise<string> {
  const { db } = await import("../src/db.js");
  return (db.prepare("SELECT detail FROM activity_logs WHERE event = 'backup.created' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }).detail;
}

describe("the containers' databases in a backup", () => {
  it("carries the games database in a minimal zip, asked for as the admin who started it", async () => {
    const zip = await backup("minimal");
    expect(await entries(zip)).toContain("apps/games.sqlite");
    expect(seenRole).toBe("admin");
    // What went in is a real database, the one the container handed over.
    const restored = new Database(path.join(workdir, "sink", "apps", "games.sqlite"), { readonly: true });
    expect(restored.prepare("SELECT id FROM matches").all()).toEqual([{ id: "m1" }]);
    restored.close();
    expect((await manifest(zip)).apps).toEqual({ games: { included: true, bytes: expect.any(Number), version: "0.18.0" } });
    expect(await lastBackupLog()).toContain("with the games database");
    // No snapshot is left lying in the backup folder.
    expect(fs.readdirSync(path.join(workdir, "backups")).filter((name) => name.startsWith(".tmp"))).toEqual([]);
  });

  it("still finishes when the container cannot hand its database over, and says why", async () => {
    answer = "missing";
    const zip = await backup("full");
    expect(await entries(zip)).not.toContain("apps/games.sqlite");
    expect((await manifest(zip)).apps).toEqual({ games: { included: false, reason: "the container is too old to hand over its database" } });
    expect(await lastBackupLog()).toContain("without games: the container is too old");
  });

  it("never stores an answer that is not a database", async () => {
    answer = "garbage";
    const zip = await backup("minimal");
    expect(await entries(zip)).not.toContain("apps/games.sqlite");
    expect((await manifest(zip)).apps).toMatchObject({ games: { included: false, reason: "the container's answer was not a database" } });
  });

  it("leaves the quick database copy as this server's alone", async () => {
    const file = await backup("database");
    expect(file.endsWith(".sqlite")).toBe(true);
    expect(seenRole).toBeUndefined();
  });
});
