import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { trashBook, restoreTrashedItem } from "../src/modules/library/shared/trash.js";
import { enqueueGalleryScan } from "../src/modules/library/gallery/scanner.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

// Restoring a photo needs a library scan to re-discover it — and that scan walks the
// WHOLE library. Queued per item, restoring a few hundred photos from the Recycle Bin
// queued a few hundred complete library walks, run one after another, and the server
// served nothing else for as long as that took.
//
// Two defences, one test each: identical pending scans collapse into one, and a bulk
// restore doesn't ask for a scan per item in the first place.
const SCAN_JOB = "SCAN_GALLERY_LIBRARY";

let sourceRoot = "";

const scanJobs = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = ?").get(SCAN_JOB) as { n: number }).n;

function makePhoto(id: string, relativePath: string): string {
  const absolute = path.join(sourceRoot, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, "JPEGBYTES");
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'GAL', 'gallery', ?, 'ready')"
  ).run(id, relativePath);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  return id;
}

beforeEach(() => {
  resetDb();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trash-restore-"));
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

describe("restoring without stacking library scans", () => {
  it("joins the scan already waiting instead of queueing another", () => {
    const first = enqueueGalleryScan("GAL");
    const second = enqueueGalleryScan("GAL");
    const third = enqueueGalleryScan("GAL");

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(scanJobs()).toBe(1);
  });

  it("keeps a different kind of scan separate", () => {
    // A subtree rescan is not the same work as a full one, so it queues on its own.
    enqueueGalleryScan("GAL");
    enqueueGalleryScan("GAL", { folder: "2021" });
    expect(scanJobs()).toBe(2);
  });

  it("asks for no scan at all while restoring in bulk", () => {
    const ids = ["p1", "p2", "p3"];
    for (const id of ids) trashBook(makePhoto(id, `${id}.jpg`), "u1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get()).toEqual({ n: 3 });
    // A delta, because resetDb doesn't clear `jobs` — rows from earlier tests in this
    // file are still here, and only the change across the restore loop is the point.
    const before = scanJobs();

    // What the Restore all route does: defer, then scan once per library after.
    for (const row of db.prepare("SELECT id FROM trashed_items").all() as { id: string }[]) {
      void restoreTrashedItem(row.id, true);
    }

    // The regression: one full library walk queued for every photo put back.
    expect(scanJobs()).toBe(before);
  });
});
