import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { db } from "../src/db.js";
import { hashPassword } from "../src/crypto.js";
import { registerAuthDecorators } from "../src/auth.js";
import { trashBook, TrashError } from "../src/modules/library/shared/trash.js";
import { registerTrashRoutes } from "../src/modules/library/shared/trash-routes.js";
import { folderLocksPlugin } from "../src/modules/library/shared/folder-locks-routes.js";
import {
  listFolderLocks, lockCovering, lockIntersecting, normaliseLockPath, setFolderLock
} from "../src/modules/library/shared/folder-locks.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// A folder lock is an admin's "nothing under here may be deleted from the app".
// Like the external-library rule it is enforced inside trashBook — the one funnel
// every deletion passes through — so a hand delete, a bulk selection and a
// duplicate cleanup all hit the same refusal.

let sourceRoot = "";

function makePhoto(id: string, relPath: string): string {
  const abs = path.join(sourceRoot, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "JPEGBYTES");
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'GAL', 'gallery', ?, 'ready')"
  ).run(id, relPath.replace(/\\/g, "/"));
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  return id;
}

beforeEach(() => {
  resetDb();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "folder-locks-"));
  sourceRoot = path.join(base, "library");
  const thumbRoot = path.join(base, "thumbs");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(thumbRoot);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'GAL'").run(sourceRoot);
});

describe("normaliseLockPath", () => {
  it("trims slashes and normalises backslashes", () => {
    expect(normaliseLockPath("/2004/wedding/")).toBe("2004/wedding");
    expect(normaliseLockPath("2004\\wedding")).toBe("2004/wedding");
    expect(normaliseLockPath("a//b")).toBe("a/b");
  });

  it("rejects what a lock may not name", () => {
    expect(normaliseLockPath("")).toBeNull();      // whole library = the library policy's job
    expect(normaliseLockPath("/")).toBeNull();
    expect(normaliseLockPath(".")).toBeNull();
    expect(normaliseLockPath("a/../b")).toBeNull();
    expect(normaliseLockPath("a/./b")).toBeNull();
  });
});

describe("the lock itself", () => {
  it("sets, lists and clears idempotently", () => {
    expect(setFolderLock("GAL", "sub", true, "u1")).toBe(true);
    expect(setFolderLock("GAL", "sub", true, "u1")).toBe(false); // already locked
    expect(listFolderLocks("GAL").map((lock) => lock.folderPath)).toEqual(["sub"]);
    expect(setFolderLock("GAL", "sub", false, "u1")).toBe(true);
    expect(setFolderLock("GAL", "sub", false, "u1")).toBe(false); // already unlocked
    expect(listFolderLocks("GAL")).toEqual([]);
  });

  it("covers exactly the subtree — no sibling-prefix bleed", () => {
    setFolderLock("GAL", "sub", true, "u1");
    expect(lockCovering("GAL", "sub")).toBe("sub");
    expect(lockCovering("GAL", "sub/a.jpg")).toBe("sub");
    expect(lockCovering("GAL", "sub/deep/a.jpg")).toBe("sub");
    expect(lockCovering("GAL", "subX/a.jpg")).toBeNull();
    expect(lockCovering("GAL", "other/a.jpg")).toBeNull();
    expect(lockCovering("OTHER", "sub/a.jpg")).toBeNull();
  });

  it("intersects when the lock sits INSIDE the folder asked about", () => {
    setFolderLock("GAL", "a/b/locked", true, "u1");
    expect(lockIntersecting("GAL", "a/b")).toBe("a/b/locked");   // clearing a/b would delete the locked part
    expect(lockIntersecting("GAL", "a/b/locked/deep")).toBe("a/b/locked"); // covered
    expect(lockIntersecting("GAL", "a/other")).toBeNull();
    expect(lockIntersecting("GAL", "")).toBe("a/b/locked");      // the root holds everything
  });
});

describe("enforcement in trashBook", () => {
  it("refuses an item under a locked folder with 423, and changes nothing", () => {
    const id = makePhoto("p1", "sub/p1.jpg");
    setFolderLock("GAL", "sub", true, "u1");

    let caught: unknown;
    try { trashBook(id, "u1"); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(TrashError);
    expect((caught as TrashError).statusCode).toBe(423);
    expect((caught as TrashError).message).toMatch(/locked/i);

    expect(db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE id = ? AND deleted_at IS NULL").get(id))
      .toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(sourceRoot, "sub", "p1.jpg"))).toBe(true);
  });

  it("still deletes a sibling outside the lock", () => {
    setFolderLock("GAL", "sub", true, "u1");
    const outside = makePhoto("p2", "elsewhere/p2.jpg");
    expect(() => trashBook(outside, "u1")).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 1 });
  });

  it("deletes normally once the folder is unlocked", () => {
    const id = makePhoto("p3", "sub/p3.jpg");
    setFolderLock("GAL", "sub", true, "u1");
    expect(() => trashBook(id, "u1")).toThrowError(/locked/i);
    setFolderLock("GAL", "sub", false, "u1");
    expect(() => trashBook(id, "u1")).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 1 });
  });
});

describe("the routes", () => {
  let app: FastifyInstance;
  const PASSWORD = "correct-horse-battery";

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify();
    await instance.register(cookie);
    await registerAuthDecorators(instance);
    await instance.register(folderLocksPlugin);
    registerTrashRoutes(instance);
    instance.post("/test/sign-in/:userId", async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const { issueSession } = await import("../src/auth.js");
      issueSession(reply, userId, request);
      return reply.send({ ok: true });
    });
    await instance.ready();
    return instance;
  }

  async function makeMember(id: string, role: "admin" | "member"): Promise<string> {
    db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)")
      .run(id, `${id}@test.local`, await hashPassword(PASSWORD), id, role);
    return id;
  }

  async function signIn(userId: string): Promise<string> {
    const response = await app.inject({ method: "POST", url: `/test/sign-in/${userId}` });
    const raw = response.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : [String(raw)];
    const found = list.find((entry) => entry.startsWith("isputnik_sid="));
    if (!found) throw new Error("no session cookie was set");
    return found.split(";")[0];
  }

  beforeEach(async () => {
    app = await buildApp();
  });

  it("locking and unlocking is admin-only", async () => {
    await makeMember("member1", "member");
    const session = await signIn("member1");
    const put = await app.inject({
      method: "PUT", url: "/api/library/libraries/GAL/folder-locks",
      headers: { cookie: session }, payload: { folderPath: "sub", locked: true }
    });
    expect(put.statusCode).toBe(403);
    const get = await app.inject({
      method: "GET", url: "/api/library/libraries/GAL/folder-locks", headers: { cookie: session }
    });
    expect(get.statusCode).toBe(403);
  });

  it("an admin round-trips a lock, and bad paths are refused", async () => {
    await makeMember("admin1", "admin");
    const session = await signIn("admin1");

    const put = await app.inject({
      method: "PUT", url: "/api/library/libraries/GAL/folder-locks",
      headers: { cookie: session }, payload: { folderPath: "/sub/wedding/", locked: true }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ folderPath: "sub/wedding", locked: true });

    const listed = await app.inject({
      method: "GET", url: "/api/library/libraries/GAL/folder-locks", headers: { cookie: session }
    });
    expect(listed.json().locks.map((lock: { folderPath: string }) => lock.folderPath)).toEqual(["sub/wedding"]);

    const bad = await app.inject({
      method: "PUT", url: "/api/library/libraries/GAL/folder-locks",
      headers: { cookie: session }, payload: { folderPath: "a/../b", locked: true }
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PUT", url: "/api/library/libraries/nope/folder-locks",
      headers: { cookie: session }, payload: { folderPath: "sub", locked: true }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("bulk delete counts locked refusals apart, and is 423 when everything is locked", async () => {
    await makeMember("admin1", "admin");
    grant("user", "admin1", "GAL", "manager");
    const session = await signIn("admin1");
    const a = makePhoto("pa", "sub/pa.jpg");
    const b = makePhoto("pb", "sub/pb.jpg");
    const free = makePhoto("pc", "open/pc.jpg");
    setFolderLock("GAL", "sub", true, "u1");

    const mixed = await app.inject({
      method: "POST", url: "/api/library/books/bulk-delete",
      headers: { cookie: session }, payload: { bookIds: [a, b, free] }
    });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json()).toMatchObject({ deleted: 1, locked: 2, forbidden: 0, failed: 0 });

    const allLocked = await app.inject({
      method: "POST", url: "/api/library/books/bulk-delete",
      headers: { cookie: session }, payload: { bookIds: [a, b] }
    });
    expect(allLocked.statusCode).toBe(423);
    expect(allLocked.json().error).toMatch(/locked/i);
  });
});
