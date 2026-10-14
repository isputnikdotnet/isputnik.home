import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { scanGalleryLibrary, scanSingleGalleryFile, checkBackSides } from "../src/modules/library/gallery/scanner.js";
import { splitBackSide, addBackSide, removeBackSide, rotateBackSide } from "../src/modules/library/gallery/back-side-files.js";
import { backRuleOf } from "../src/modules/library/gallery/back-sides.js";
import { listMissingGalleryPhotos } from "../src/modules/library/gallery/cleanup.js";
import { moveGalleryAsset } from "../src/modules/library/gallery/move.js";
import { trashBook, restoreTrashedItem } from "../src/modules/library/shared/trash.js";
import { normalizeBackSides } from "../src/modules/library/shared/library-settings.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";
import "./helpers/media-types.js";

// Back sides of scanned prints end to end (docs/back-sides-proposal.md): an
// Epson-shaped folder pairs itself under the library's rule, the twins can be
// cleaned up without losing the back, a pair survives the bin, and a back can be
// split off again — with everything its old row carried.

let base = "";
const root = (id: string) => path.join(base, id);

const EPSON = { sources: [{ id: "epson", enabled: true }, { id: "named", enabled: false }, { id: "custom", enabled: false }], patterns: [] };
const OFF = { sources: [], patterns: [] };

function makeGalleryLibrary(id: string, backSides: unknown = OFF): void {
  makeLibrary(id, { createdBy: "u1", type: "gallery" });
  fs.mkdirSync(root(id), { recursive: true });
  db.prepare("UPDATE libraries SET source_path = ?, settings_json = ? WHERE id = ?")
    .run(root(id), JSON.stringify({ back_sides: backSides }), id);
}

function setRule(id: string, backSides: unknown): void {
  db.prepare("UPDATE libraries SET settings_json = ? WHERE id = ?").run(JSON.stringify({ back_sides: backSides }), id);
}

/** A small real JPEG, distinct per seed, so sharp can read it and render previews. */
async function photo(libraryId: string, relativePath: string, seed = 1): Promise<string> {
  const abs = path.join(root(libraryId), relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const width = 48 + seed * 4;
  const height = 32 + seed * 2;
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = (i * seed) % 256; data[i + 1] = (i * 7 + seed * 31) % 256; data[i + 2] = (i * 3 + seed * 11) % 256;
  }
  await sharp(data, { raw: { width, height, channels: 3 } }).jpeg().toFile(abs);
  return abs;
}

// In place, not through the job queue: the queue's worker outlives a test and
// would race the next one's database reset.
async function scan(libraryId: string): Promise<void> {
  await scanGalleryLibrary(libraryId);
}

type Row = { id: string; folder_path: string; deleted_at: string | null; back_relative_path: string | null; back_preview_storage_key: string | null; back_rotation: number };
function rows(libraryId: string): Row[] {
  return db.prepare(`
    SELECT li.id, li.folder_path, li.deleted_at, gd.back_relative_path, gd.back_preview_storage_key, gd.back_rotation
    FROM library_items li LEFT JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.library_id = ? ORDER BY li.folder_path
  `).all(libraryId) as Row[];
}
const live = (libraryId: string) => rows(libraryId).filter((row) => row.deleted_at === null);
const byPath = (libraryId: string, folderPath: string) => rows(libraryId).find((row) => row.folder_path === folderPath);

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM jobs").run();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "back-sides-"));
  const thumbs = path.join(base, "thumbs");
  fs.mkdirSync(thumbs);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbs);
});

describe("scanning an Epson folder", () => {
  it("pairs each _b with its raw scan, leaves the _a copy a photo and a lone _b alone", async () => {
    makeGalleryLibrary("GAL", EPSON);
    await photo("GAL", "Box/Scan_0015.jpg", 1);
    await photo("GAL", "Box/Scan_0015_a.jpg", 2);
    await photo("GAL", "Box/Scan_0015_b.jpg", 3);
    await photo("GAL", "Box/Scan_0016.jpg", 4);
    await photo("GAL", "Box/Scan_0016_a.jpg", 5);
    await photo("GAL", "Box/Scan_0099_b.jpg", 6);
    await scan("GAL");

    const items = live("GAL").map((row) => row.folder_path);
    expect(items).toEqual(["Box/Scan_0015.jpg", "Box/Scan_0015_a.jpg", "Box/Scan_0016.jpg", "Box/Scan_0016_a.jpg", "Box/Scan_0099_b.jpg"]);
    const front = byPath("GAL", "Box/Scan_0015.jpg")!;
    expect(front.back_relative_path).toBe("Box/Scan_0015_b.jpg");
    expect(front.back_preview_storage_key).toMatch(/-back-large\.webp$/);
    expect(byPath("GAL", "Box/Scan_0015_a.jpg")!.back_relative_path).toBeNull();
    // No row at all for the back: it was never an item.
    expect(byPath("GAL", "Box/Scan_0015_b.jpg")).toBeUndefined();

    // A rescan changes nothing and renders nothing again.
    const keyBefore = front.back_preview_storage_key;
    await scan("GAL");
    expect(byPath("GAL", "Box/Scan_0015.jpg")!.back_preview_storage_key).toBe(keyBefore);
    expect(live("GAL").length).toBe(5);
  });

  it("does nothing with the rule off, and the dry run says what turning it on would do", async () => {
    makeGalleryLibrary("GAL", OFF);
    await photo("GAL", "X.jpg", 1);
    await photo("GAL", "X_b.jpg", 2);
    await photo("GAL", "Y_b.jpg", 3);
    await scan("GAL");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["X.jpg", "X_b.jpg", "Y_b.jpg"]);

    const check = checkBackSides("GAL", backRuleOf(normalizeBackSides(EPSON)));
    expect(check).toEqual({ files: 3, pairs: 1, itemsToRetire: 1, unmatched: 1 });
  });

  it("retires a photo that becomes a back, keeps its row out of the missing list, and Split brings it back", async () => {
    makeGalleryLibrary("GAL", OFF);
    await photo("GAL", "X.jpg", 1);
    await photo("GAL", "X_b.jpg", 2);
    await scan("GAL");
    const ghostId = byPath("GAL", "X_b.jpg")!.id;
    db.prepare("INSERT INTO item_metadata (item_id, source, title, description) VALUES (?, 'manual', 'The back', 'Granny wrote on it') ON CONFLICT(item_id) DO UPDATE SET source = 'manual', title = 'The back', description = 'Granny wrote on it'")
      .run(ghostId);

    setRule("GAL", EPSON);
    await scan("GAL");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["X.jpg"]);
    expect(byPath("GAL", "X.jpg")!.back_relative_path).toBe("X_b.jpg");
    const ghost = byPath("GAL", "X_b.jpg")!;
    expect(ghost.id).toBe(ghostId);
    expect(ghost.deleted_at).not.toBeNull();
    expect(listMissingGalleryPhotos().items.map((item) => item.path)).toEqual([]);

    // Rule off again: the pair holds, the back is still no photo.
    setRule("GAL", OFF);
    await scan("GAL");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["X.jpg"]);
    expect(byPath("GAL", "X.jpg")!.back_relative_path).toBe("X_b.jpg");

    const split = await splitBackSide(byPath("GAL", "X.jpg")!.id);
    expect(split.ok).toBe(true);
    expect(fs.existsSync(path.join(root("GAL"), "X (back).jpg"))).toBe(true);
    expect(byPath("GAL", "X.jpg")!.back_relative_path).toBeNull();
    const revived = byPath("GAL", "X (back).jpg")!;
    expect(revived.id).toBe(ghostId);
    expect(revived.deleted_at).toBeNull();
    const meta = db.prepare("SELECT title, description FROM item_metadata WHERE item_id = ?").get(ghostId) as { title: string; description: string };
    expect(meta).toEqual({ title: "The back", description: "Granny wrote on it" });
    // And a rescan leaves it a photo.
    setRule("GAL", EPSON);
    await scan("GAL");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["X (back).jpg", "X.jpg"]);
  });
});

describe("the back follows its front", () => {
  it("hands the back to the _a twin when the raw scan is deleted, and keeps it through the twin's own bin trip", async () => {
    makeGalleryLibrary("GAL", EPSON);
    await photo("GAL", "X.jpg", 1);
    await photo("GAL", "X_a.jpg", 2);
    await photo("GAL", "X_b.jpg", 3);
    await scan("GAL");

    trashBook(byPath("GAL", "X.jpg")!.id, "u1", { source: "duplicate_cleanup" });
    const twin = byPath("GAL", "X_a.jpg")!;
    expect(twin.back_relative_path).toBe("X_b.jpg");
    expect(fs.existsSync(path.join(root("GAL"), "X_b.jpg"))).toBe(true);
    const binned = db.prepare("SELECT back_path FROM trashed_items").get() as { back_path: string | null };
    expect(binned.back_path).toBeNull();

    // The twin, now the only front, goes into the bin WITH its back and comes back paired.
    trashBook(twin.id, "u1");
    expect(fs.existsSync(path.join(root("GAL"), "X_b.jpg"))).toBe(false);
    const row = db.prepare("SELECT id, back_path FROM trashed_items WHERE origin_path = 'X_a.jpg'").get() as { id: string; back_path: string | null };
    expect(row.back_path).toBe("X_b.jpg");

    setRule("GAL", OFF); // whatever the rule says by then
    await restoreTrashedItem(row.id, true); // deferred, like a bulk restore: the scan is ours
    await scan("GAL");
    expect(fs.existsSync(path.join(root("GAL"), "X_b.jpg"))).toBe(true);
    expect(live("GAL").map((r) => r.folder_path)).toEqual(["X_a.jpg"]);
    expect(byPath("GAL", "X_a.jpg")!.back_relative_path).toBe("X_b.jpg");
  });

  it("moves with the front into another library", async () => {
    makeGalleryLibrary("GAL", EPSON);
    makeGalleryLibrary("DEST", OFF);
    await photo("GAL", "X.jpg", 1);
    await photo("GAL", "X_b.jpg", 2);
    await scan("GAL");
    const moved = moveGalleryAsset(byPath("GAL", "X.jpg")!.id, { libraryId: "DEST", folder: "Kept" });
    expect(moved.ok).toBe(true);
    expect(fs.existsSync(path.join(root("DEST"), "Kept", "X_b.jpg"))).toBe(true);
    expect(byPath("DEST", "Kept/X.jpg")!.back_relative_path).toBe("Kept/X_b.jpg");
    await scan("DEST");
    expect(live("DEST").map((r) => r.folder_path)).toEqual(["Kept/X.jpg"]);
  });
});

describe("by hand", () => {
  it("adds, rotates, replaces and removes a back on a photo whose library has no rule", async () => {
    makeGalleryLibrary("GAL", OFF);
    await photo("GAL", "Granny.jpg", 1);
    await scan("GAL");
    const id = byPath("GAL", "Granny.jpg")!.id;

    const first = await photo("GAL", ".upload-1/back.png", 2);
    expect((await addBackSide(id, { tmpPath: first, filename: "back.png" })).ok).toBe(true);
    expect(byPath("GAL", "Granny.jpg")!.back_relative_path).toBe("Granny_back.png");

    const turned = await rotateBackSide(id, "cw");
    expect(turned.ok && turned.rotation).toBe(90);
    // The turn is the back's own and survives a rescan.
    await scan("GAL");
    expect(byPath("GAL", "Granny.jpg")!.back_rotation).toBe(90);
    expect(live("GAL").map((r) => r.folder_path)).toEqual(["Granny.jpg"]);

    const second = await photo("GAL", ".upload-2/back2.jpg", 3);
    expect((await addBackSide(id, { tmpPath: second, filename: "back2.jpg" })).ok).toBe(true);
    expect(byPath("GAL", "Granny.jpg")!.back_relative_path).toBe("Granny_back.jpg");
    expect(byPath("GAL", "Granny.jpg")!.back_rotation).toBe(0);
    // The first back was set aside, not destroyed.
    const kept = fs.readdirSync(path.join(root("GAL"), ".trash", "replaced", "GAL", id));
    expect(kept.some((name) => name.endsWith("Granny_back.png"))).toBe(true);

    expect((await removeBackSide(id)).ok).toBe(true);
    expect(byPath("GAL", "Granny.jpg")!.back_relative_path).toBeNull();
    expect(fs.existsSync(path.join(root("GAL"), "Granny_back.jpg"))).toBe(false);
  });

  it("catalogues a lone back that lands beside its front by attaching it, not as a photo", async () => {
    makeGalleryLibrary("GAL", EPSON);
    await photo("GAL", "2024/X.jpg", 1);
    await scan("GAL");
    await photo("GAL", "2024/X_b.jpg", 2);
    const id = await scanSingleGalleryFile("GAL", "2024/X_b.jpg");
    expect(id).toBe(byPath("GAL", "2024/X.jpg")!.id);
    expect(byPath("GAL", "2024/X.jpg")!.back_relative_path).toBe("2024/X_b.jpg");
    expect(live("GAL").length).toBe(1);
  });
});
