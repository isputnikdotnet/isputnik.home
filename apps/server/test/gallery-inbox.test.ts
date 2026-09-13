import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID, parsePolicy } from "../src/core/permissions.js";
import { resolveGalleryScopeLibraryIds } from "../src/modules/library/gallery/catalog-scope.js";
import {
  discardPhotoInboxItems, keepPhotoInboxItems, listPhotoInboxItems, listPhotoInboxes, photoInboxLibraryIds
} from "../src/modules/library/gallery/inbox.js";
import { moveGalleryAsset, normaliseTargetFolder } from "../src/modules/library/gallery/move.js";
import { isPhotoInboxLibrary, setSystemLibraryRole } from "../src/modules/library/gallery/system-libraries.js";
import { enqueueFaceScanBatches } from "../src/modules/library/gallery/faces/queue.js";
import { enabledFaceLibraryIds, setFaceRecognitionEnabledForLibrary } from "../src/modules/library/gallery/faces/settings.js";
import { createLibraryRecord, updateLibraryRecord } from "../src/modules/library/shared/library-crud.js";
import { setCleanupRetentionDays, setTrashRetentionDays } from "../src/modules/library/shared/trash-settings.js";
import { thumbnailAbsolutePath, thumbnailPathSettingKey, thumbnailStorageKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";
import "./helpers/media-types.js";

// The Photo Inbox (docs/photo-inbox-proposal.md): the gallery library holding the
// 'inbox' role (docs/system-data-plan.md). Three promises, one block each — it is left out of every
// implicit scope; its photos are never scanned for faces; and the review's two
// verbs move a photo out of it whole (file, row, thumbnails) or bin it on the
// cleanup clock.

const ADMIN = { id: "u1", role: "admin" };
const MEMBER = { id: "u2", role: "member" };
const INBOX_POLICY = JSON.stringify({ mode: "managed" });

let base = "";
let thumbRoot = "";

function libraryRoot(id: string): string {
  return path.join(base, id);
}

function makeGalleryLibrary(id: string, policyJson = "{}", role?: "inbox" | "app-files"): void {
  makeLibrary(id, { createdBy: "u1", type: "gallery", policyJson, role });
  fs.mkdirSync(libraryRoot(id), { recursive: true });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = ?").run(libraryRoot(id), id);
  grant("group", EVERYONE_GROUP_ID, id, "member");
}

function makePhoto(libraryId: string, id: string, relativePath: string, takenAt: string | null = null): string {
  const absolute = path.join(libraryRoot(libraryId), relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, "JPEGBYTES");
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, 'gallery', ?, 'ready', '2020-01-01T00:00:00.000Z')"
  ).run(id, libraryId, relativePath);
  const coverKey = thumbnailStorageKey(libraryId, id, `${id}-cover.webp`);
  const previewKey = thumbnailStorageKey(libraryId, id, `${id}-cover-large.webp`);
  for (const key of [coverKey, previewKey]) {
    const abs = thumbnailAbsolutePath(key);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "WEBP");
  }
  db.prepare("INSERT INTO item_metadata (item_id, source, title, cover_storage_key) VALUES (?, 'scan', ?, ?)").run(id, id, coverKey);
  db.prepare(
    "INSERT INTO gallery_details (item_id, kind, relative_path, size, taken_at, preview_storage_key) VALUES (?, 'photo', ?, 9, ?, ?)"
  ).run(id, relativePath, takenAt, previewKey);
  return id;
}

const itemRow = (id: string) => db.prepare(
  `SELECT li.library_id, li.folder_path, li.discovered_at, gd.relative_path, gd.preview_storage_key, im.cover_storage_key
   FROM library_items li JOIN gallery_details gd ON gd.item_id = li.id LEFT JOIN item_metadata im ON im.item_id = li.id
   WHERE li.id = ?`
).get(id) as {
  library_id: string; folder_path: string; discovered_at: string; relative_path: string;
  preview_storage_key: string | null; cover_storage_key: string | null;
};

beforeEach(() => {
  resetDb();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "photo-inbox-"));
  thumbRoot = path.join(base, "thumbs");
  fs.mkdirSync(thumbRoot);
  makeUser("u1", "admin");
  makeUser("u2", "member");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbRoot);
  makeGalleryLibrary("GAL");
  makeGalleryLibrary("INBOX", INBOX_POLICY, "inbox");
});

describe("the flag", () => {
  it("finds the flagged libraries and nothing else", () => {
    expect([...photoInboxLibraryIds()]).toEqual(["INBOX"]);
  });

  it("is left out of the implicit scope and honoured when named", () => {
    expect(resolveGalleryScopeLibraryIds(ADMIN)).toEqual(["GAL"]);
    expect(resolveGalleryScopeLibraryIds(ADMIN, [])).toEqual(["GAL"]);
    expect(resolveGalleryScopeLibraryIds(ADMIN, ["INBOX"])).toEqual(["INBOX"]);
    expect(resolveGalleryScopeLibraryIds(ADMIN, ["GAL", "INBOX"]).sort()).toEqual(["GAL", "INBOX"]);
  });

  it("is made by the app, keeps its role through an update, and refuses a new name", () => {
    db.prepare("DELETE FROM libraries WHERE id = 'INBOX'").run();
    fs.mkdirSync(path.join(base, "scans"));
    const created = createLibraryRecord({
      type: "gallery",
      // An `inbox` in a request body is not a way in any more: zod drops it.
      data: { name: "Scans", sourcePath: path.join(base, "scans"), ...({ inbox: true } as object) },
      userId: "u1",
      ip: "127.0.0.1",
      role: "inbox"
    });
    if ("error" in created) throw new Error(created.error);
    const rowOf = () => db.prepare("SELECT name, role, policy_json FROM libraries WHERE id = ?").get(created.libraryId) as { name: string; role: string | null; policy_json: string };
    expect(rowOf().role).toBe("inbox");
    expect(parsePolicy(rowOf().policy_json)).not.toHaveProperty("inbox");

    const kept = updateLibraryRecord({ type: "gallery", id: created.libraryId, data: { name: "Scans", visibility: "private" }, userId: "u1", ip: "127.0.0.1" });
    expect("error" in kept).toBe(false);
    expect(rowOf().role).toBe("inbox");

    const renamed = updateLibraryRecord({ type: "gallery", id: created.libraryId, data: { name: "Scans renamed" }, userId: "u1", ip: "127.0.0.1" });
    expect(renamed).toMatchObject({ status: 409 });
    expect(rowOf().name).toBe("Scans");
  });

  it("has one holder: giving the role to another library takes it from the first", () => {
    setSystemLibraryRole("inbox", "GAL");
    expect(photoInboxLibraryIds()).toEqual(new Set(["GAL"]));
    expect(isPhotoInboxLibrary("INBOX")).toBe(false);
    expect(() => db.prepare("UPDATE libraries SET role = 'inbox' WHERE id = 'INBOX'").run()).toThrow();
  });
});

describe("faces wait for acceptance", () => {
  it("queues no face scan for an Inbox and drops it from the enabled list", () => {
    setFaceRecognitionEnabledForLibrary("INBOX", true, "u1");
    setFaceRecognitionEnabledForLibrary("GAL", true, "u1");
    expect(enabledFaceLibraryIds()).toEqual(["GAL"]);
    expect(enqueueFaceScanBatches("INBOX")).toEqual([]);
    expect(enqueueFaceScanBatches("GAL").length).toBeGreaterThan(0);
  });
});

describe("listing", () => {
  it("groups what is waiting by delivery, newest first, with the root as its own", () => {
    makePhoto("INBOX", "a1", "boxA/1.jpg");
    makePhoto("INBOX", "a2", "boxA/2.jpg");
    makePhoto("INBOX", "r1", "loose.jpg");
    makePhoto("GAL", "g1", "kept.jpg");
    db.prepare("UPDATE library_items SET discovered_at = '2021-06-01T00:00:00.000Z' WHERE id = 'r1'").run();

    const inboxes = listPhotoInboxes(ADMIN);
    expect(inboxes.map((inbox) => inbox.id)).toEqual(["INBOX"]);
    expect(inboxes[0].count).toBe(3);
    expect(inboxes[0].canReview).toBe(true);
    expect(inboxes[0].deliveries).toEqual([
      { folder: "", count: 1, reviewed: 0, newestAt: "2021-06-01T00:00:00.000Z", viaLink: false },
      { folder: "boxA", count: 2, reviewed: 0, newestAt: "2020-01-01T00:00:00.000Z", viaLink: false }
    ]);

    const all = listPhotoInboxItems(ADMIN, "INBOX", { folder: null, limit: 10, offset: 0 })!;
    expect(all.total).toBe(3);
    expect(all.items.map((item) => item.id)).toEqual(["r1", "a1", "a2"]);
    const boxA = listPhotoInboxItems(ADMIN, "INBOX", { folder: "boxA", limit: 10, offset: 0 })!;
    expect(boxA.items.map((item) => item.id)).toEqual(["a1", "a2"]);
    const root = listPhotoInboxItems(ADMIN, "INBOX", { folder: "", limit: 10, offset: 0 })!;
    expect(root.items.map((item) => item.id)).toEqual(["r1"]);
    expect(listPhotoInboxItems(ADMIN, "GAL", { folder: null, limit: 10, offset: 0 })).toBeNull();
  });

  it("tells a member who may look but not review", () => {
    makePhoto("INBOX", "a1", "boxA/1.jpg");
    expect(listPhotoInboxes(MEMBER)[0].canReview).toBe(false);
  });
});

describe("moving an asset", () => {
  it("carries the file, the row and the thumbnails into the destination", () => {
    makePhoto("INBOX", "a1", "boxA/1.jpg");
    const before = itemRow("a1");

    const result = moveGalleryAsset("a1", { libraryId: "GAL", folder: "Scans/Box A" });
    expect(result.ok).toBe(true);

    const after = itemRow("a1");
    expect(after.library_id).toBe("GAL");
    expect(after.folder_path).toBe("Scans/Box A/1.jpg");
    expect(after.relative_path).toBe("Scans/Box A/1.jpg");
    expect(fs.existsSync(path.join(libraryRoot("GAL"), "Scans", "Box A", "1.jpg"))).toBe(true);
    expect(fs.existsSync(path.join(libraryRoot("INBOX"), "boxA", "1.jpg"))).toBe(false);
    // The emptied delivery folder is gone; the Inbox root stays.
    expect(fs.existsSync(path.join(libraryRoot("INBOX"), "boxA"))).toBe(false);
    expect(fs.existsSync(libraryRoot("INBOX"))).toBe(true);
    // Arriving in a library counts as arriving.
    expect(after.discovered_at > before.discovered_at).toBe(true);
    // Thumbnails re-homed into the destination's bucket, files and keys alike.
    expect(after.preview_storage_key!.startsWith("GAL/")).toBe(true);
    expect(after.cover_storage_key!.startsWith("GAL/")).toBe(true);
    expect(fs.existsSync(thumbnailAbsolutePath(after.preview_storage_key!))).toBe(true);
    expect(fs.existsSync(thumbnailAbsolutePath(before.preview_storage_key!))).toBe(false);
  });

  it("numbers a name the destination already has, on disk or in the catalogue", () => {
    makePhoto("INBOX", "a1", "1.jpg");
    makePhoto("GAL", "g1", "1.jpg");
    const result = moveGalleryAsset("a1", { libraryId: "GAL", folder: "" });
    expect(result.ok && result.folderPath).toBe("1 (2).jpg");
  });

  it("refuses an external destination, the Inbox, and a bad folder", () => {
    makeGalleryLibrary("EXT", JSON.stringify({ mode: "external" }));
    makePhoto("INBOX", "a1", "1.jpg");
    makePhoto("GAL", "g1", "kept.jpg");
    expect(moveGalleryAsset("a1", { libraryId: "EXT", folder: "" })).toMatchObject({ ok: false, status: 403 });
    expect(moveGalleryAsset("g1", { libraryId: "INBOX", folder: "" })).toMatchObject({ ok: false, status: 403 });
    expect(moveGalleryAsset("a1", { libraryId: "GAL", folder: "../out" })).toMatchObject({ ok: false, status: 400 });
    expect(itemRow("a1").library_id).toBe("INBOX");
  });

  it("makes a typed folder safe", () => {
    expect(normaliseTargetFolder(" Scans / Box A ")).toBe("Scans/Box A");
    expect(normaliseTargetFolder("")).toBe("");
    expect(normaliseTargetFolder("a\\b")).toBe("a/b");
    expect(normaliseTargetFolder("../x")).toBeNull();
    expect(normaliseTargetFolder(".hidden")).toBeNull();
    expect(normaliseTargetFolder("bad:name")).toBeNull();
  });
});

describe("the review", () => {
  it("keeps into a folder, or by date, and counts what it could not touch", () => {
    makePhoto("INBOX", "a1", "boxA/1.jpg", "2003-07-14T10:00:00.000Z");
    makePhoto("INBOX", "a2", "boxA/2.jpg", null);
    makePhoto("GAL", "g1", "kept.jpg");

    const byFolder = keepPhotoInboxItems(ADMIN, ["a1", "g1", "nope"], { libraryId: "GAL", folder: "Scans", dated: false });
    expect(byFolder.ok && byFolder.counts).toEqual({ done: 1, forbidden: 1, missing: 1, locked: 0, failed: 0 });
    expect(itemRow("a1").folder_path).toBe("Scans/1.jpg");

    const byDate = keepPhotoInboxItems(ADMIN, ["a2"], { libraryId: "GAL", folder: null, dated: true });
    expect(byDate.ok && byDate.counts.done).toBe(1);
    // No capture date: today's folder, the upload rule's fallback.
    expect(itemRow("a2").folder_path).toMatch(/^\d{4}\/\d{4}-\d{2}-\d{2}\/2\.jpg$/);
    expect(listPhotoInboxes(ADMIN)[0].count).toBe(0);
  });

  it("refuses the whole request when the destination is wrong", () => {
    makePhoto("INBOX", "a1", "1.jpg");
    expect(keepPhotoInboxItems(ADMIN, ["a1"], { libraryId: "INBOX", folder: null, dated: false })).toMatchObject({ ok: false, status: 403 });
    expect(keepPhotoInboxItems(ADMIN, ["a1"], { libraryId: "missing", folder: null, dated: false })).toMatchObject({ ok: false, status: 404 });
    // A member who may add to the destination still may not take photos out of
    // an Inbox they only view: reviewing takes the delete right on the Inbox.
    grant("user", "u2", "GAL", "contributor");
    const asMember = keepPhotoInboxItems(MEMBER, ["a1"], { libraryId: "GAL", folder: null, dated: false });
    expect(asMember.ok && asMember.counts.forbidden).toBe(1);
    expect(itemRow("a1").library_id).toBe("INBOX");
  });

  it("discards to the Recycle Bin on the cleanup clock", () => {
    setTrashRetentionDays(30);
    setCleanupRetentionDays(3);
    makePhoto("INBOX", "a1", "boxA/1.jpg");
    makePhoto("GAL", "g1", "kept.jpg");

    const counts = discardPhotoInboxItems(ADMIN, ["a1", "g1"]);
    expect(counts).toEqual({ done: 1, forbidden: 1, missing: 0, locked: 0, failed: 0 });

    const binned = db.prepare("SELECT source, expires_at FROM trashed_items").get() as { source: string; expires_at: string };
    expect(binned.source).toBe("photo_inbox");
    const days = (new Date(binned.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
    expect(listPhotoInboxes(ADMIN)[0].count).toBe(0);
  });
});
