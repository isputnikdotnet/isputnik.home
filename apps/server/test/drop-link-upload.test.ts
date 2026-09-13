// The public drop link (gallery/drop-links.ts + drop-routes.ts), over HTTP.
//
// It is the one path in the app where someone with NO account writes files to
// disk, so every bound it claims is checked here from the outside, with real
// multipart bodies: the token (unknown, expired, revoked, another module's), the
// Inbox it points at (still an Inbox?), the allow-list, the per-file cap, the
// link's life-long quota of files and bytes (migration 69's share_links columns,
// enforced on every batch against what already landed — the number on the page is
// only advice), a one-time link closing itself, and a filename or label that tries
// to climb out of the Inbox's folder. And the happy path: the photo lands in
// <label>/<date>/, is catalogued, is counted against the link, and queues the
// Inbox's duplicate check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const queueInboxCheck = vi.hoisted(() => vi.fn());
// A delivery queues the Inbox's duplicate check in the background; here it is
// only recorded, so nothing keeps running after a test has reset the database.
vi.mock("../src/modules/library/gallery/duplicates/inbox-check.js", () => ({ queueInboxCheck }));

import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { galleryDropRoutesPlugin } from "../src/modules/library/gallery/drop-routes.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { bootApp } from "./helpers/boot.js";
import { resetDb, makeUser, makeLibrary, grant, futureIso, pastIso } from "./helpers/seed.js";
import { multipart as body, type Part } from "./helpers/multipart.js";

const INBOX_POLICY = { mode: "managed" };
let base = "";
let app: FastifyInstance;
let red: Buffer;
let blue: Buffer;

const inboxRoot = () => path.join(base, "INBOX");
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  // Real JPEGs, rendered one after the other (never two sharp pipelines at once).
  red = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
  blue = await sharp({ create: { width: 30, height: 40, channels: 3, background: { r: 20, g: 40, b: 220 } } }).jpeg().toBuffer();
});

function makeGallery(id: string, policy: object, role?: "inbox" | "app-files"): void {
  makeLibrary(id, { createdBy: "owner", type: "gallery", policyJson: JSON.stringify(policy), role });
  fs.mkdirSync(path.join(base, id), { recursive: true });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = ?").run(path.join(base, id), id);
  grant("group", EVERYONE_GROUP_ID, id, "member");
}

/** A drop link written straight into share_links, for the states the create
 *  route can't produce (expired, revoked, a tiny byte quota). */
function makeLink(token: string, opts: {
  libraryId?: string; label?: string | null; maxFiles?: number | null; maxBytes?: number | null;
  oneTime?: boolean; expiresAt?: string; revoked?: boolean; module?: string;
} = {}): string {
  const id = `link-${token}`;
  db.prepare(`
    INSERT INTO share_links
      (id, module, resource_id, token_hash, permission, label, expires_at, created_by, max_files, max_bytes, one_time, revoked_at)
    VALUES (?, ?, ?, ?, 'edit', ?, ?, 'owner', ?, ?, ?, ?)
  `).run(
    id, opts.module ?? "gallery-inbox", opts.libraryId ?? "INBOX", sha256(token), opts.label ?? null,
    opts.expiresAt ?? futureIso(), opts.maxFiles ?? null, opts.maxBytes ?? null, opts.oneTime ? 1 : 0,
    opts.revoked ? new Date().toISOString() : null
  );
  return id;
}

function signIn(userId: string): string {
  const token = `session-${userId}`;
  db.prepare("INSERT OR IGNORE INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)")
    .run(`s-${userId}`, sha256(token), userId, futureIso());
  return `isputnik_sid=${token}`;
}

const upload = (token: string, parts: Part[]) => {
  const { payload, headers } = body(parts);
  return app.inject({ method: "POST", url: `/api/drop/${token}/upload`, payload, headers, remoteAddress: "203.0.113.50" });
};

const jpeg = (filename: string, data: Buffer = red): Part => ({ filename, contentType: "image/jpeg", data });

/** Every file under the temp root, relative, forward slashes — thumbnails aside. */
function filesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "thumbs") walk(full); }
      else out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  };
  walk(base);
  return out.sort();
}

const drops = (linkId: string) =>
  db.prepare("SELECT file_name, size_bytes FROM share_link_drops WHERE share_link_id = ? ORDER BY file_name").all(linkId) as
    { file_name: string; size_bytes: number }[];

beforeEach(async () => {
  resetDb();
  db.prepare("DELETE FROM share_link_drops").run(); // not in resetDb's list
  db.prepare("DELETE FROM storage_roots").run();
  queueInboxCheck.mockReset();

  base = fs.mkdtempSync(path.join(os.tmpdir(), "drop-link-"));
  fs.mkdirSync(path.join(base, "thumbs"));
  makeUser("owner", "admin");
  makeUser("cousin", "member");
  db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'owner')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, path.join(base, "thumbs"));
  makeGallery("INBOX", INBOX_POLICY, "inbox");
  makeGallery("PHOTOS", { mode: "managed" });

  ({ app } = await bootApp({
    plugins: [[multipart, { limits: { files: 1, fields: 10, fieldSize: 100 * 1024 } }], galleryDropRoutesPlugin]
  }));
});

afterEach(async () => {
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});

// ── Handing out a link ───────────────────────────────────────────────────────

describe("minting a drop link", () => {
  const mint = (payload: object, cookieHeader = signIn("owner"), library = "INBOX") =>
    app.inject({
      method: "POST",
      url: `/api/library/gallery/inbox/${library}/drop-links`,
      headers: { cookie: cookieHeader },
      payload
    });

  it("stores the quota and only the token's hash", async () => {
    const res = await mint({ label: "Aunt Olga", maxFiles: 3, maxMB: 2, oneTime: false });

    expect(res.statusCode).toBe(201);
    const { link, url } = res.json() as { link: { id: string; status: string }; url: string };
    const token = url.split("/drop/")[1];
    expect(token.length).toBeGreaterThanOrEqual(36);
    expect(link.status).toBe("active");
    const row = db.prepare("SELECT * FROM share_links WHERE id = ?").get(link.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      module: "gallery-inbox", resource_id: "INBOX", label: "Aunt Olga",
      max_files: 3, max_bytes: 2 * 1024 * 1024, one_time: 0, token_hash: sha256(token)
    });
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("is for signed-in reviewers of a real Inbox only", async () => {
    expect((await app.inject({ method: "POST", url: "/api/library/gallery/inbox/INBOX/drop-links", payload: {} })).statusCode).toBe(401);
    expect((await mint({}, signIn("cousin"))).statusCode).toBe(403); // can see it, may not empty it
    expect((await mint({}, signIn("owner"), "PHOTOS")).statusCode).toBe(404); // not an Inbox
    expect((await mint({ expiresInDays: 365 })).statusCode).toBe(400); // past the 90-day ceiling
  });
});

// ── The guest's side ─────────────────────────────────────────────────────────

describe("a delivery that goes through", () => {
  it("lands in <label>/<date>, is catalogued and counted, and queues the duplicate check", async () => {
    const linkId = makeLink("good-token", { label: "Aunt Olga", maxFiles: 5, maxBytes: 10 * 1024 * 1024 });

    const res = await upload("good-token", [jpeg("beach.jpg"), jpeg("Dacha.JPG", blue)]);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true, received: 2, remainingFiles: 3,
      remainingBytes: 10 * 1024 * 1024 - red.length - blue.length, closed: false
    });
    expect(filesOnDisk()).toEqual([`INBOX/Aunt Olga/${today()}/Dacha.JPG`, `INBOX/Aunt Olga/${today()}/beach.jpg`]);
    const items = db.prepare("SELECT folder_path FROM library_items WHERE library_id = 'INBOX' ORDER BY folder_path").all();
    expect(items).toEqual([{ folder_path: `Aunt Olga/${today()}/Dacha.JPG` }, { folder_path: `Aunt Olga/${today()}/beach.jpg` }]);
    expect(drops(linkId)).toEqual([
      { file_name: "Dacha.JPG", size_bytes: blue.length },
      { file_name: "beach.jpg", size_bytes: red.length }
    ]);
    // Anonymous in the log, but with the address it came from.
    const log = db.prepare("SELECT actor_user_id, ip_address FROM activity_logs WHERE event = 'library.gallery.drop_received'").get();
    expect(log).toEqual({ actor_user_id: null, ip_address: "203.0.113.50" });
    await vi.waitFor(() => expect(queueInboxCheck).toHaveBeenCalledWith("INBOX", "owner"));
  });

  it("tells the page what is left, and says nothing about the library beyond that", async () => {
    makeLink("view-token", { label: "Box of prints", maxFiles: 10, maxBytes: 5000 });

    const res = await app.inject({ method: "GET", url: "/api/drop/view-token" });

    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view).toMatchObject({
      label: "Box of prints", inboxName: "INBOX", remainingFiles: 10, remainingBytes: 5000,
      maxFileBytes: 5000, oneTime: false, open: true, received: { files: 0, bytes: 0 }
    });
    expect(view.accept).toContain("jpg");
    expect(JSON.stringify(view)).not.toContain(base); // no server paths
  });
});

describe("where a file may land", () => {
  it.each([
    ["../../../../evil.jpg"],
    ["..\\..\\..\\evil.jpg"],
    ["/etc/evil.jpg"],
    ["C:\\Users\\Public\\evil.jpg"]
  ])("keeps %s inside the delivery folder", async (filename) => {
    makeLink("t", { label: "Cousin" });

    const res = await upload("t", [jpeg(filename)]);

    expect(res.statusCode).toBe(201);
    expect(filesOnDisk()).toEqual([`INBOX/Cousin/${today()}/evil.jpg`]);
  });

  it("files a delivery under a safe folder when the label tries to climb out", async () => {
    makeLink("t", { label: "../../../outside" });

    const res = await upload("t", [jpeg("a.jpg")]);

    expect(res.statusCode).toBe(201);
    expect(filesOnDisk()).toEqual([`INBOX/Dropped/${today()}/a.jpg`]);
  });

  it("never overwrites a photo already there", async () => {
    makeLink("t", { label: "Cousin" });

    await upload("t", [jpeg("same.jpg")]);
    await upload("t", [jpeg("same.jpg", blue)]);

    expect(filesOnDisk()).toEqual([`INBOX/Cousin/${today()}/same (2).jpg`, `INBOX/Cousin/${today()}/same.jpg`]);
    expect(fs.readFileSync(path.join(inboxRoot(), "Cousin", today(), "same.jpg"))).toEqual(red);
  });
});

describe("what a delivery may contain", () => {
  it.each([["virus.exe"], ["notes.txt"], ["page.html"], ["photo.jpg.php"]])("refuses %s and keeps nothing", async (filename) => {
    const linkId = makeLink("t");

    const res = await upload("t", [jpeg("fine.jpg"), { filename, data: "MZ" }]);

    expect(res.statusCode).toBe(415);
    expect(filesOnDisk()).toEqual([]); // not the good one either, and no staging folder
    expect(fs.readdirSync(inboxRoot())).toEqual([]);
    expect(drops(linkId)).toEqual([]);
  });

  it("holds each file to the Inbox's upload size", async () => {
    db.prepare("UPDATE libraries SET policy_json = ? WHERE id = 'INBOX'").run(JSON.stringify({ ...INBOX_POLICY, maxUploadMB: 1 }));
    makeLink("t");

    const res = await upload("t", [jpeg("huge.jpg", Buffer.alloc(1024 * 1024 + 1, 0xff))]);

    expect(res.statusCode).toBe(413);
    expect(filesOnDisk()).toEqual([]);
  });

  it("refuses a request that isn't an upload", async () => {
    makeLink("t");

    const res = await app.inject({ method: "POST", url: "/api/drop/t/upload", payload: { file: "x" } });

    expect(res.statusCode).toBe(415);
  });
});

describe("the link's quota", () => {
  it("caps a single file at what the link may still receive", async () => {
    makeLink("t", { maxBytes: red.length - 1 });

    const res = await upload("t", [jpeg("a.jpg")]);

    expect(res.statusCode).toBe(413);
    expect(filesOnDisk()).toEqual([]);
  });

  it("caps the batch as a whole, not just each file in it", async () => {
    // Each file fits on its own; together they don't.
    const linkId = makeLink("t", { maxBytes: red.length + Math.floor(blue.length / 2) });

    const res = await upload("t", [jpeg("a.jpg"), jpeg("b.jpg", blue)]);

    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatch(/add up to more than this link may still receive/);
    expect(filesOnDisk()).toEqual([]);
    expect(drops(linkId)).toEqual([]);
  });

  it("counts files across batches and refuses once it is used up", async () => {
    makeLink("t", { maxFiles: 2 });

    const tooMany = await upload("t", [jpeg("1.jpg"), jpeg("2.jpg", blue), jpeg("3.jpg")]);
    expect(tooMany.statusCode).toBe(413);
    expect(filesOnDisk()).toEqual([]);

    const first = await upload("t", [jpeg("1.jpg")]);
    expect(first.json()).toMatchObject({ received: 1, remainingFiles: 1 });
    const overflow = await upload("t", [jpeg("2.jpg", blue), jpeg("3.jpg")]);
    expect(overflow.statusCode).toBe(413); // one left, two offered
    const last = await upload("t", [jpeg("2.jpg", blue)]);
    expect(last.json()).toMatchObject({ received: 1, remainingFiles: 0 });

    const after = await upload("t", [jpeg("4.jpg")]);
    expect(after.statusCode).toBe(410);
    expect((await app.inject({ method: "GET", url: "/api/drop/t" })).json()).toMatchObject({ open: false, remainingFiles: 0 });
  });

  it("closes a one-time link with its first delivery", async () => {
    const linkId = makeLink("once", { oneTime: true });

    const res = await upload("once", [jpeg("a.jpg")]);

    expect(res.json()).toMatchObject({ received: 1, closed: true, remainingFiles: 0, remainingBytes: 0 });
    expect((db.prepare("SELECT revoked_at FROM share_links WHERE id = ?").get(linkId) as { revoked_at: string | null }).revoked_at)
      .not.toBeNull();
    expect((await upload("once", [jpeg("b.jpg")])).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/drop/once" })).statusCode).toBe(404);
  });
});

describe("a link that no longer works", () => {
  it.each([
    ["an unknown token", () => undefined],
    ["an expired link", () => { makeLink("t", { expiresAt: pastIso() }); }],
    ["a revoked link", () => { makeLink("t", { revoked: true }); }],
    ["a guest link from another module", () => { makeLink("t", { module: "audiobook", libraryId: "some-book" }); }],
    ["a link to a library that is no longer an Inbox", () => {
      makeLink("t");
      db.prepare("UPDATE libraries SET role = NULL WHERE id = 'INBOX'").run();
    }],
    ["a link to a library that isn't a photo library", () => {
      makeLibrary("BOOKS", { createdBy: "owner", type: "audiobook", policyJson: JSON.stringify(INBOX_POLICY) });
      makeLink("t", { libraryId: "BOOKS" });
    }]
  ])("is refused: %s", async (_case, arrange) => {
    arrange();

    const view = await app.inject({ method: "GET", url: "/api/drop/t" });
    const res = await upload("t", [jpeg("a.jpg")]);

    expect(view.statusCode).toBe(404);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "This link isn't valid any more." });
    expect(filesOnDisk()).toEqual([]);
  });
});
