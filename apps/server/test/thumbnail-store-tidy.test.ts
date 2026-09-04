// The thumbnail-store housekeeping pass. Its whole design rests on one asymmetry:
// empty folders are removed, unreferenced FILES are only counted — because "no row
// points at this file" does not mean the file is junk.
//
// A book's "-cover-large.webp" and a video's "-web.mp4" are written by the scanner
// and the transcoder and recorded in no column at all, on purpose. In a store
// audited by hand, 338 files had no matching key and 322 of them were exactly that:
// files the app still serves. A sweep that trusted the key check alone would have
// deleted every large book cover and every transcode on the machine, weekly and
// unattended. The tests below pin the rule that separates those from real orphans,
// and pin the fact that nothing here deletes a file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let workdir: string;
let store: string;
let closeDb: () => void;
let audit: typeof import("../src/modules/library/shared/thumbnail-audit.js");
let db: typeof import("../src/db.js")["db"];

const LIVE_ITEM = "aaaaaaaaaaaaaaaa";
const GONE_ITEM = "zzzzzzzzzzzzzzzz";
const LIVE_FACE = "ffffffffffffffff";

function put(key: string, body = "x"): void {
  const full = path.join(store, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function storeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(store, full).split(path.sep).join("/"));
    }
  };
  walk(store);
  return out.sort();
}

beforeEach(async () => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-tidy-"));
  store = path.join(workdir, "thumbnails");
  fs.mkdirSync(store, { recursive: true });
  process.env.THUMBNAIL_PATH = store;

  vi.resetModules();
  ({ db } = await import("../src/db.js"));
  audit = await import("../src/modules/library/shared/thumbnail-audit.js");
  closeDb = () => db.close();

  // A library with one live item and one live face on it; GONE_ITEM is deliberately
  // absent — it stands for a row a restore rolled back past.
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('u0', 'u@t.local', 'x', 'U', 'admin')").run();
  db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by) VALUES ('lib0000000000000', 'L', 'gallery', '/m', 'u0')").run();
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, 'lib0000000000000', 'gallery', '/m/a')").run(LIVE_ITEM);
  db.prepare("INSERT INTO gallery_faces (id, item_id) VALUES (?, ?)").run(LIVE_FACE, LIVE_ITEM);
});

afterEach(() => {
  closeDb?.();
  delete process.env.THUMBNAIL_PATH;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("counting what nothing points at", () => {
  it("does not count a file the catalog references", () => {
    const key = `lib0000000000000/aa/aa/${LIVE_ITEM}-cover.webp`;
    put(key);
    db.prepare("INSERT INTO item_metadata (item_id, cover_storage_key) VALUES (?, ?)").run(LIVE_ITEM, key);

    expect(audit.auditThumbnailStore()).toEqual({ files: 1, orphans: 0 });
  });

  it("spares derived files no column records, when their owner is alive", () => {
    // THE case this job exists to not get wrong. Neither of these is in any column;
    // both are served by the app. 322 of one real store's 338 unreferenced files
    // were these.
    put(`lib0000000000000/aa/aa/${LIVE_ITEM}-cover-large.webp`);
    put(`lib0000000000000/aa/aa/${LIVE_ITEM}-web.mp4`);

    expect(audit.auditThumbnailStore()).toEqual({ files: 2, orphans: 0 });
  });

  it("spares a face crop while its face row lives", () => {
    put(`lib0000000000000/ff/ff/${LIVE_FACE}-face.webp`);

    expect(audit.auditThumbnailStore()).toEqual({ files: 1, orphans: 0 });
  });

  it("counts a file whose owner is gone", () => {
    put(`lib0000000000000/zz/zz/${GONE_ITEM}-cover.webp`);
    put(`lib0000000000000/zz/zz/${GONE_ITEM}-cover-large.webp`);

    expect(audit.auditThumbnailStore()).toEqual({ files: 2, orphans: 2 });
  });

  it("never removes a file, whatever it decides about it", () => {
    const orphan = `lib0000000000000/zz/zz/${GONE_ITEM}-cover.webp`;
    put(orphan);

    audit.auditThumbnailStore();
    audit.removeEmptyThumbnailDirs();

    expect(fs.existsSync(path.join(store, orphan))).toBe(true);
  });

  it("reports nothing when the store is not configured", () => {
    delete process.env.THUMBNAIL_PATH;
    vi.resetModules();
    // Re-imported without a store path, the audit must be a no-op rather than throw.
    return import("../src/modules/library/shared/thumbnail-audit.js").then((fresh) => {
      expect(fresh.auditThumbnailStore()).toEqual({ files: 0, orphans: 0 });
    });
  });
});

describe("removing empty folders", () => {
  it("removes an empty shard and leaves one holding a file", () => {
    fs.mkdirSync(path.join(store, "lib0000000000000/zz/zz"), { recursive: true });
    put(`lib0000000000000/aa/aa/${LIVE_ITEM}-cover.webp`);

    expect(audit.removeEmptyThumbnailDirs()).toBe(2); // zz/zz then zz

    expect(fs.existsSync(path.join(store, "lib0000000000000/zz"))).toBe(false);
    expect(storeFiles()).toEqual([`lib0000000000000/aa/aa/${LIVE_ITEM}-cover.webp`]);
  });

  it("collapses a folder whose only contents were empty folders", () => {
    fs.mkdirSync(path.join(store, "deadbucket00000/aa/bb"), { recursive: true });

    expect(audit.removeEmptyThumbnailDirs()).toBe(3); // bb, aa, then the bucket
    expect(fs.existsSync(path.join(store, "deadbucket00000"))).toBe(false);
  });

  it("never removes the store root, even when it is empty", () => {
    expect(audit.removeEmptyThumbnailDirs()).toBe(0);
    expect(fs.existsSync(store)).toBe(true);
  });

  it("keeps a folder holding an unreferenced file", () => {
    // Counting it is one thing; its folder is not empty, so it stays.
    put(`lib0000000000000/zz/zz/${GONE_ITEM}-cover.webp`);

    expect(audit.removeEmptyThumbnailDirs()).toBe(0);
    expect(fs.existsSync(path.join(store, "lib0000000000000/zz/zz"))).toBe(true);
  });
});
