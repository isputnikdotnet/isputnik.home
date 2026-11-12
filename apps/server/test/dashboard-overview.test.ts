import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { db } from "../src/db.js";
import { dashboardPlugin } from "../src/modules/dashboard/index.js";
import { groupByDisk } from "../src/modules/dashboard/overview.js";
import { bootApp } from "./helpers/boot.js";
import { makeUser, resetDb } from "./helpers/seed.js";

// Overview › Dashboard's extra figures: the disks Home's files sit on (grouped
// by device, video libraries left to the engine), and the last day's failed
// sign-ins and failed tasks.

let app: FastifyInstance;
let admin: string;
let signIn: (userId: string) => Promise<string>;
let tmp: string;

function library(id: string, name: string, type: string, sourcePath: string): void {
  db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by) VALUES (?, ?, ?, ?, ?)").run(id, name, type, sourcePath, admin);
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

beforeEach(async () => {
  resetDb();
  admin = makeUser("boss", "admin");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dash-overview-"));
  ({ app, signIn } = await bootApp({ plugins: [dashboardPlugin] }));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("groupByDisk", () => {
  it("puts places on one device together and measures a folder not made yet by its parent", () => {
    const disks = groupByDisk([
      { kind: "library", id: "lib-books", name: "Books", libraryType: "ebook", path: tmp },
      { kind: "backups", path: path.join(tmp, "not-yet", "backups") }
    ]);
    expect(disks).toHaveLength(1);
    expect(disks[0].holds.map((hold) => hold.kind)).toEqual(["library", "backups"]);
    expect(disks[0].totalBytes).toBeGreaterThan(0);
    expect(disks[0].freeBytes).toBeLessThanOrEqual(disks[0].totalBytes);
    // One mount: nothing else on its filesystem to name.
    expect(disks[0].sharesWith).toEqual([]);
    expect(disks[0].filesystem).toMatch(/^\d+$/);
  });
});

describe("GET /api/dashboard/overview", () => {
  it("lists Home's libraries on their disk and leaves video libraries out", async () => {
    library("lib-books", "Books", "ebook", tmp);
    library("lib-films", "Films", "video", "/movies/films");

    const session = await signIn(admin);
    const res = await app.inject({ method: "GET", url: "/api/dashboard/overview", headers: { cookie: session } });
    expect(res.statusCode).toBe(200);
    const holds = (res.json().disks as { holds: { kind: string; name?: string }[] }[]).flatMap((disk) => disk.holds);
    expect(holds.some((hold) => hold.kind === "database")).toBe(true);
    expect(holds.some((hold) => hold.kind === "library" && hold.name === "Books")).toBe(true);
    expect(holds.some((hold) => hold.name === "Films")).toBe(false);
    expect(res.json().home.port).toBeTypeOf("number");
    // Control panel v2: a library carries its id, so the page can match it to the
    // size its scans recorded; the database is measured as its own files.
    expect(holds.find((hold) => hold.kind === "library" && hold.name === "Books")).toMatchObject({ id: "lib-books" });
  });

  it("gives each folder place its size once the background count has run", async () => {
    const { measureHoldings } = await import("../src/modules/dashboard/overview.js");
    const folder = path.join(tmp, "measured");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "a.bin"), Buffer.alloc(1500));
    const holds = [{ kind: "backups" as const, path: folder }, { kind: "library" as const, id: "x", name: "X", libraryType: "ebook", path: folder }];
    // The first ask starts the count; it is not on the request's path.
    expect(measureHoldings(holds)[0]).toMatchObject({ bytes: null });
    await vi.waitFor(() => expect(measureHoldings(holds)[0]).toMatchObject({ bytes: 1500, partial: false }));
    // A library is sized from its scans, not by walking its folder here.
    expect(measureHoldings(holds)[1]).not.toHaveProperty("bytes");
  });

  it("counts failed sign-ins and failed tasks of the last day only", async () => {
    const insertLog = db.prepare("INSERT INTO activity_logs (id, event, actor_user_id, detail, created_at) VALUES (?, ?, NULL, 'test', ?)");
    insertLog.run("l1", "auth.login_failed", hoursAgo(2));
    insertLog.run("l2", "auth.login_failed", hoursAgo(5));
    insertLog.run("l3", "auth.login_failed", hoursAgo(30));
    insertLog.run("l4", "auth.login", hoursAgo(1));
    const insertJob = db.prepare("INSERT INTO jobs (id, type, payload, status, failed_at) VALUES (?, 'scan', '{}', ?, ?)");
    insertJob.run("j1", "failed", hoursAgo(3));
    insertJob.run("j2", "failed", hoursAgo(40));
    insertJob.run("j3", "completed", null);

    const session = await signIn(admin);
    const res = await app.inject({ method: "GET", url: "/api/dashboard/overview", headers: { cookie: session } });
    expect(res.json()).toMatchObject({ failedSignIns24h: 2, failedTasks24h: 1 });
  });

  it("is for admins only", async () => {
    const member = makeUser("kid", "member");
    const session = await signIn(member);
    const res = await app.inject({ method: "GET", url: "/api/dashboard/overview", headers: { cookie: session } });
    expect(res.statusCode).toBe(403);
  });
});
