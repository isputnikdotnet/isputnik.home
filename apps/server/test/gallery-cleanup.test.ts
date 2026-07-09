import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import {
  listMissingGalleryPhotos,
  purgeMissingGalleryPhotos,
  purgeMissingGalleryPhoto,
  getMissingRetentionDays,
  setMissingRetentionDays
} from "../src/modules/library/gallery/cleanup.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(relativePath: string, modifiedMs: number) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`,
    relativePath,
    fileName: relativePath.split("/").pop()!,
    extension,
    kind: kindForExtension(extension)!,
    size: 1000,
    modifiedAtMs: modifiedMs
  };
}

// Mark an already-ingested item as a missing-on-disk tombstone, `ageDays` in the past.
function tombstone(id: string, ageDays: number) {
  db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now',?) WHERE id = ?")
    .run(`-${ageDays} days`, id);
}

const T = Date.parse("2024-01-01T00:00:00Z");

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("missing-photo retention setting", () => {
  it("defaults to 30 days and round-trips a saved value (clamped)", () => {
    expect(getMissingRetentionDays()).toBe(30);
    expect(setMissingRetentionDays(7, "u1")).toBe(7);
    expect(getMissingRetentionDays()).toBe(7);
    expect(setMissingRetentionDays(-5, "u1")).toBe(0);   // clamped to 0 (= never)
    expect(setMissingRetentionDays(99999, "u1")).toBe(3650); // capped
  });
});

describe("listMissingGalleryPhotos", () => {
  it("returns only tombstones, newest-first, with a purge-due date from the retention window", async () => {
    const live = await ingestGalleryAsset("GAL", asset("live.jpg", T), false);
    const goneOld = await ingestGalleryAsset("GAL", asset("2019/old.jpg", T), false);
    const goneNew = await ingestGalleryAsset("GAL", asset("recent.jpg", T), false);
    tombstone(goneOld, 40);
    tombstone(goneNew, 2);

    const { items, retentionDays } = listMissingGalleryPhotos();
    expect(retentionDays).toBe(30);
    expect(items.map((i) => i.id).sort()).toEqual([goneNew, goneOld].sort());
    expect(items.some((i) => i.id === live)).toBe(false); // a live item is never listed

    const oldRow = items.find((i) => i.id === goneOld)!;
    expect(oldRow.path).toBe("2019/old.jpg");
    expect(oldRow.purgesAt).not.toBeNull(); // detectedAt + 30 days
  });

  it("reports no purge date when retention is disabled (0)", async () => {
    const gone = await ingestGalleryAsset("GAL", asset("x.jpg", T), false);
    tombstone(gone, 100);
    setMissingRetentionDays(0, "u1");
    const { items } = listMissingGalleryPhotos();
    expect(items[0].purgesAt).toBeNull();
  });
});

describe("purgeMissingGalleryPhotos (grace window)", () => {
  it("purges only tombstones older than the window, sparing recent ones and live items", async () => {
    const live = await ingestGalleryAsset("GAL", asset("live.jpg", T), false);
    const old = await ingestGalleryAsset("GAL", asset("old.jpg", T), false);
    const recent = await ingestGalleryAsset("GAL", asset("recent.jpg", T), false);
    tombstone(old, 40);
    tombstone(recent, 5);

    const result = purgeMissingGalleryPhotos(30);
    expect(result).toEqual({ purged: 1, eligible: 1 });

    const exists = (id: string) => db.prepare("SELECT 1 FROM library_items WHERE id = ?").get(id) != null;
    expect(exists(old)).toBe(false);   // past window → purged
    expect(exists(recent)).toBe(true); // within window → kept as tombstone
    expect(exists(live)).toBe(true);   // never deleted → untouched
  });

  it("retention 0 disables auto-purge entirely", async () => {
    const gone = await ingestGalleryAsset("GAL", asset("x.jpg", T), false);
    tombstone(gone, 500);
    setMissingRetentionDays(0, "u1");
    expect(purgeMissingGalleryPhotos()).toEqual({ purged: 0, eligible: 0 });
    expect(db.prepare("SELECT 1 FROM library_items WHERE id = ?").get(gone)).not.toBeNull();
  });

  it("cascades the item's gallery rows (details, faces, album membership) on purge", async () => {
    const id = await ingestGalleryAsset("GAL", asset("gone.jpg", T), false);
    db.prepare("INSERT INTO gallery_faces (id, item_id) VALUES ('f1', ?)").run(id);
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('al1', 'Trip', 'u1')").run();
    db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES ('al1', ?, 1)").run(id);
    tombstone(id, 60);

    expect(purgeMissingGalleryPhotos(30).purged).toBe(1);
    expect(db.prepare("SELECT 1 FROM library_items WHERE id = ?").get(id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM gallery_details WHERE item_id = ?").get(id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM gallery_faces WHERE item_id = ?").get(id)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM gallery_album_items WHERE item_id = ?").get(id)).toBeUndefined();
    // The album itself survives (only its membership row cascaded).
    expect(db.prepare("SELECT 1 FROM gallery_albums WHERE id = 'al1'").get()).not.toBeUndefined();
  });
});

describe("purgeMissingGalleryPhoto (single, ignores window)", () => {
  it("removes one tombstone regardless of age, and refuses a live item", async () => {
    const live = await ingestGalleryAsset("GAL", asset("live.jpg", T), false);
    const gone = await ingestGalleryAsset("GAL", asset("gone.jpg", T), false);
    tombstone(gone, 1); // only 1 day old — still purgeable via the explicit single-purge

    expect(purgeMissingGalleryPhoto(live, "u1")).toBe(false); // not a tombstone
    expect(db.prepare("SELECT 1 FROM library_items WHERE id = ?").get(live)).not.toBeUndefined();

    expect(purgeMissingGalleryPhoto(gone, "u1")).toBe(true);
    expect(db.prepare("SELECT 1 FROM library_items WHERE id = ?").get(gone)).toBeUndefined();

    expect(purgeMissingGalleryPhoto("nope", "u1")).toBe(false); // unknown id
  });
});
