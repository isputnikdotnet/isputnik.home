// The scan-rule API after layouts (docs/scan-layout-plan.md, phase 1): a rule
// accepts an ordered `layouts` list or the older single `pattern`, the list
// carries per-rule counts, the default layout has its own endpoint and refuses
// deletion, and the folder browser reports counts and ownership.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { scanRulesPlugin } from "../src/modules/library/shared/scan-rules-routes.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let app: FastifyInstance;
let base: string;
let root: string;

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({
    method, url,
    headers: { "x-test-user": "admin", "content-type": "application/json" },
    payload: payload === undefined ? undefined : JSON.stringify(payload)
  });

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  // validateLibrarySource only accepts a folder inside a configured storage root
  // and outside thumbnail storage; both live under one real-path temp base.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scan-rules-routes-")));
  root = path.join(base, "src");
  const thumbs = path.join(base, "thumbs");
  fs.mkdirSync(path.join(root, "Series", "Foundation"), { recursive: true });
  fs.mkdirSync(path.join(root, "Standalone"), { recursive: true });
  fs.mkdirSync(thumbs);
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'admin')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(thumbnailPathSettingKey, thumbs);
  db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('EB', 'Ebooks', 'ebook', ?, 'admin', '{}')").run(root);

  app = fastify();
  const gate = async (request: { headers: Record<string, unknown>; user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
    if (!row || row.role !== "admin") { reply.code(401).send({ error: "no" }); return; }
    request.user = row;
  };
  app.decorate("authenticate", gate as never);
  app.decorate("requireAdmin", gate as never);
  await app.register(scanRulesPlugin);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("rules with layouts", () => {
  it("creates from `layouts`, still accepts `pattern`, and lists counts", async () => {
    const created = await call("POST", "/api/library/libraries/EB/scan-rules", {
      name: "Series", layouts: ["{author}/{series}/{position} - {title}", "{author}/{title}"], paths: ["Series"]
    });
    expect(created.statusCode).toBe(200);
    const rule = created.json().rule;
    expect(rule.layouts).toEqual(["{author}/{series}/{position} - {title}", "{author}/{title}"]);

    const legacy = await call("POST", "/api/library/libraries/EB/scan-rules", { name: "Loose", pattern: "{title}", paths: ["Standalone"] });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().rule.layouts).toEqual(["{title}"]);

    const neither = await call("POST", "/api/library/libraries/EB/scan-rules", { name: "Bad", paths: ["X"] });
    expect(neither.statusCode).toBe(400);

    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, scan_rule_id) VALUES ('i1', 'EB', 'ebook', 'Series/Asimov/Foundation/01 - Foundation', ?)").run(rule.id);
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, scan_rule_id) VALUES ('i2', 'EB', 'ebook', 'Series/Odd/Deep/Deeper/Book', ?)").run(rule.id);

    const list = await call("GET", "/api/library/libraries/EB/scan-rules");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.defaultLayout).toBeNull();
    const series = body.rules.find((r: { id: string }) => r.id === rule.id);
    expect(series).toMatchObject({ books: 2, unmatched: 1, missingFolders: [], lastScannedAt: null, isDefault: false });
  });
});

describe("default layout", () => {
  it("is created and replaced through PUT, listed as defaultLayout, and cannot be deleted", async () => {
    expect((await call("GET", "/api/library/libraries/EB/default-layout")).json().rule).toBeNull();

    const put = await call("PUT", "/api/library/libraries/EB/default-layout", { layouts: ["{author}/{title}"] });
    expect(put.statusCode).toBe(200);
    const rule = put.json().rule;
    expect(rule).toMatchObject({ isDefault: true, paths: [""], layouts: ["{author}/{title}"] });

    const again = await call("PUT", "/api/library/libraries/EB/default-layout", { layouts: ["{title}"] });
    expect(again.json().rule.id).toBe(rule.id);
    expect((await call("GET", "/api/library/libraries/EB/scan-rules")).json().defaultLayout.layouts).toEqual(["{title}"]);

    const del = await call("DELETE", `/api/library/libraries/EB/scan-rules/${rule.id}`);
    expect(del.statusCode).toBe(400);
    expect((await call("GET", "/api/library/libraries/EB/default-layout")).json().rule.id).toBe(rule.id);
  });
});

describe("folder browser", () => {
  it("reports book counts and ownership per folder", async () => {
    const created = await call("POST", "/api/library/libraries/EB/scan-rules", { name: "Series", pattern: "{series}/{title}", paths: ["Series"] });
    const ruleId = created.json().rule.id as string;
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, scan_rule_id) VALUES ('i1', 'EB', 'ebook', 'Series/Foundation/Foundation', ?)").run(ruleId);
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES ('i2', 'EB', 'ebook', 'Standalone/Book')").run();

    const top = (await call("GET", "/api/library/libraries/EB/folders")).json();
    expect(top.totalBooks).toBe(2);
    expect(top.ownedBy).toBeNull();
    expect(top.folders).toEqual([
      { name: "Series", relativePath: "Series", books: 1, ownedBy: { ruleId, name: "Series", enabled: true, exact: true } },
      { name: "Standalone", relativePath: "Standalone", books: 1, ownedBy: null }
    ]);

    const inside = (await call("GET", "/api/library/libraries/EB/folders?path=Series")).json();
    expect(inside.books).toBe(1);
    expect(inside.ownedBy).toEqual({ ruleId, name: "Series", enabled: true, exact: true });
    expect(inside.folders[0]).toMatchObject({ name: "Foundation", books: 1, ownedBy: { ruleId, exact: false } });
  });
});

describe("preview", () => {
  it("runs the layouts over real files and reports layout index, formats and change", async () => {
    fs.writeFileSync(path.join(root, "Series", "Foundation", "01 - Foundation.epub"), "x");
    fs.writeFileSync(path.join(root, "Series", "Foundation", "01 - Foundation.pdf"), "x");
    fs.writeFileSync(path.join(root, "Series", "Loose.epub"), "x");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES ('i1', 'EB', 'ebook', 'Series/Foundation/01 - Foundation')").run();

    const res = await call("POST", "/api/library/libraries/EB/scan-rules/preview", {
      paths: ["Series"], layouts: ["{series}/{position} - {title}", "{title}"]
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows;
    expect(rows).toEqual([
      {
        path: "Series/Foundation/01 - Foundation", matched: true, layoutIndex: 0,
        series: "Foundation", position: 1, title: "Foundation", formats: ["epub", "pdf"], warnings: [], change: "moves-from-default"
      },
      { path: "Series/Loose", matched: true, layoutIndex: 1, title: "Loose", formats: ["epub"], warnings: [], change: "new" }
    ]);

    // The pre-layouts body shape still works.
    const old = await call("POST", "/api/library/libraries/EB/scan-rules/preview", { paths: ["Series"], pattern: "{title}" });
    expect(old.statusCode).toBe(200);
    expect(old.json().rows.map((r: { matched: boolean }) => r.matched)).toEqual([false, true]);
  });
});

describe("rule-scoped scan", () => {
  it("queues a scan confined to the rule and refuses it for a rule that is off", async () => {
    const created = await call("POST", "/api/library/libraries/EB/scan-rules", { name: "Series", pattern: "{series}/{title}", paths: ["Series"] });
    const rule = created.json().rule;

    const queued = await call("POST", `/api/library/libraries/EB/scan-rules/${rule.id}/scan`, {});
    expect(queued.statusCode).toBe(200);
    expect(queued.json().queued).toBe(true);
    const job = db.prepare("SELECT type, payload FROM jobs WHERE id = ?").get(queued.json().jobId) as { type: string; payload: string };
    expect(job.type).toBe("SCAN_EBOOK_LIBRARY");
    expect(JSON.parse(job.payload)).toEqual({ libraryId: "EB", options: { ruleId: rule.id } });

    await call("PATCH", `/api/library/libraries/EB/scan-rules/${rule.id}`, { name: "Series", pattern: "{series}/{title}", paths: ["Series"], enabled: false });
    expect((await call("POST", `/api/library/libraries/EB/scan-rules/${rule.id}/scan`)).statusCode).toBe(400);
    expect((await call("POST", "/api/library/libraries/EB/scan-rules/nope/scan", {})).statusCode).toBe(404);
  });
});

describe("audiobook preview", () => {
  it("dispatches to the audiobook walk and reports track counts", async () => {
    const source = path.join(base, "audio");
    fs.mkdirSync(path.join(source, "Isaac Asimov", "Foundation", "01 - Foundation"), { recursive: true });
    for (const f of ["001.mp3", "002.mp3"]) fs.writeFileSync(path.join(source, "Isaac Asimov", "Foundation", "01 - Foundation", f), "x");
    db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('AB', 'Audiobooks', 'audiobook', ?, 'admin', '{}')").run(source);

    const res = await call("POST", "/api/library/libraries/AB/scan-rules/preview", { paths: [""], layouts: ["{author}/{series}/{position} - {title}"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([{
      path: "Isaac Asimov/Foundation/01 - Foundation", matched: true, layoutIndex: 0,
      author: "Isaac Asimov", series: "Foundation", position: 1, title: "Foundation",
      tracks: 2, warnings: [], change: "new"
    }]);
  });
});

describe("creating a library with a default layout", () => {
  it("saves the root rule before the first scan is queued", async () => {
    const { ebookRoutesPlugin } = await import("../src/modules/library/ebook/routes.js");
    const { getDefaultLayoutRule } = await import("../src/modules/library/shared/scan-rules.js");
    const created = fastify();
    const gate = async (request: { headers: Record<string, unknown>; user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      const id = request.headers["x-test-user"] as string | undefined;
      const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
      if (!row) { reply.code(401).send({ error: "no" }); return; }
      request.user = row;
    };
    created.decorate("authenticate", gate as never);
    created.decorate("requireAdmin", gate as never);
    await created.register(ebookRoutesPlugin);
    await created.ready();
    try {
      const source = path.join(base, "new-ebooks");
      fs.mkdirSync(source);
      const res = await created.inject({
        method: "POST", url: "/api/library/ebook-libraries",
        headers: { "x-test-user": "admin", "content-type": "application/json" },
        payload: JSON.stringify({ name: "New", sourcePath: source, defaultLayouts: ["{author}/{title}"] })
      });
      expect(res.statusCode).toBe(201);
      const libraryId = res.json().library.id as string;
      const rule = getDefaultLayoutRule(libraryId);
      expect(rule).toMatchObject({ isDefault: true, layouts: ["{author}/{title}"] });
      // The rule row predates the queued scan job, so that scan already sees it.
      const job = db.prepare("SELECT created_at FROM jobs WHERE id = ?").get(res.json().job.id) as { created_at: string };
      expect(rule!.createdAt <= job.created_at).toBe(true);

      // A bad layout is refused before anything is created.
      const other = path.join(base, "other-ebooks");
      fs.mkdirSync(other);
      const bad = await created.inject({
        method: "POST", url: "/api/library/ebook-libraries",
        headers: { "x-test-user": "admin", "content-type": "application/json" },
        payload: JSON.stringify({ name: "Bad", sourcePath: other, defaultLayouts: ["{narrator}/{title}"] })
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe("{narrator} is only valid for audiobook rules.");
      expect((db.prepare("SELECT COUNT(*) AS n FROM libraries WHERE source_path = ?").get(other) as { n: number }).n).toBe(0);
    } finally {
      await created.close();
    }
  });
});
