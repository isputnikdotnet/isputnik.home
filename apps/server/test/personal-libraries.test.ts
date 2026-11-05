// Personal libraries (docs/photo-sync-plan.md, phase 1): only the owner can open one.
// Another member and an admin see nothing of it — not its photos in any scope, not
// through a person shared with them, not on the admin's housekeeping pages, not in
// the activity log — only, for the admin, whose it is and how big.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { runAsViewer } from "../src/core/viewer-context.js";
import { canUserAccessBook, canUserAccessLibrary } from "../src/modules/library/shared/library-access.js";
import { resolveGalleryBrowseLibraryIds, resolveGalleryScopeLibraryIds } from "../src/modules/library/gallery/catalog-scope.js";
import { galleryFacets, queryGalleryFolders, queryGalleryMapPoints, queryGalleryTimeline } from "../src/modules/library/gallery/catalog.js";
import { getGalleryAsset } from "../src/modules/library/gallery/catalog-asset.js";
import { queryGalleryMemories, queryGalleryRecentlyAdded } from "../src/modules/library/gallery/catalog-memories.js";
import { listGalleryPeople } from "../src/modules/library/gallery/people.js";
import { canSeeThroughPeople, setPersonGrant } from "../src/modules/library/gallery/people-access.js";
import { listMissingGalleryPhotos } from "../src/modules/library/gallery/cleanup.js";
import { galleryLibraryOptions } from "../src/modules/library/gallery/duplicates/jobs.js";
import { faceRecognitionEnabledForLibrary, setFaceRecognitionEnabledForLibrary, enabledFaceLibraryIds } from "../src/modules/library/gallery/faces/settings.js";
import { enqueueFaceScanBatches } from "../src/modules/library/gallery/faces/queue.js";
import { galleryRoutesPlugin } from "../src/modules/library/gallery/routes.js";
import { libraryMembersPlugin } from "../src/modules/library/shared/members.js";
import { folderLocksPlugin } from "../src/modules/library/shared/folder-locks-routes.js";
import { registerTrashRoutes } from "../src/modules/library/shared/trash-routes.js";
import { registerPersonalLibraryRouteGuard } from "../src/modules/library/gallery/personal/route-guard.js";
import { personalLibraryRoutesPlugin } from "../src/modules/library/gallery/personal/routes.js";
import { personalLibraryIdOf } from "../src/modules/library/gallery/personal/personal-libraries.js";
import { adoptPersonalLibrary, handOverPersonalLibrary, orphanPersonalLibraryOf } from "../src/modules/library/gallery/personal/service.js";
import { savePersonalSettings } from "../src/modules/library/gallery/personal/settings.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { bootApp } from "./helpers/boot.js";
import { grant, makeLibrary, makeShare, makeUser, resetDb } from "./helpers/seed.js";

const mia = { id: "mia", role: "member" };     // owns the personal library
const olga = { id: "olga", role: "member" };   // another member
const admin = { id: "admin", role: "admin" };

function item(id: string, libraryId: string, folderPath: string) {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, 'gallery', ?, 'ready', strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
    .run(id, libraryId, folderPath);
  db.prepare("INSERT INTO item_metadata (item_id, source, title, cover_storage_key) VALUES (?, 'scan', ?, ?)")
    .run(id, folderPath.split("/").pop(), `${libraryId}/xx/yy/${id}-cover.webp`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size, taken_at, gps_lat, gps_lng) VALUES (?, 'photo', ?, 1000, '2020-11-05T10:00:00Z', 53.9, 27.5)")
    .run(id, folderPath);
}

function face(id: string, itemId: string, personId: string) {
  db.prepare(`
    INSERT INTO gallery_faces (id, item_id, person_id, box_x, box_y, box_w, box_h, assignment, source, thumb_storage_key)
    VALUES (?, ?, ?, 0.1, 0.1, 0.2, 0.2, 'confirmed', 'scan', ?)
  `).run(id, itemId, personId, `x/${id}-face.webp`);
}

function markPersonal(libraryId: string, userId: string) {
  db.prepare("UPDATE libraries SET personal_user_id = ?, owner_id = ?, owner_type = 'user' WHERE id = ?").run(userId, userId, libraryId);
}

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

function timeline(user: { id: string; role: string }) {
  return runAsViewer(user, () => ids(queryGalleryTimeline(user.id, resolveGalleryBrowseLibraryIds(user), { q: "", kinds: [], limit: 50, offset: 0 }).assets));
}

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("mia");
  makeUser("olga");
  // The family library everyone opens, and Mia's personal library.
  makeLibrary("fam", { createdBy: "admin", type: "gallery" });
  grant("group", "grp-everyone", "fam", "member");
  makeLibrary("mine", { createdBy: "mia", type: "gallery" });
  markPersonal("mine", "mia");
  // Left over from before it was personal: must count for nothing.
  grant("group", "grp-everyone", "mine", "manager");
  grant("user", "olga", "mine", "manager");
  grant("user", "admin", "mine", "manager");

  db.prepare("INSERT INTO gallery_people (id, name) VALUES ('ivan', 'Ivan')").run();
  item("f1", "fam", "Family/f1.jpg");
  item("m1", "mine", "Secret/m1.jpg");
  item("m2", "mine", "Secret/m2.jpg");
  face("x1", "f1", "ivan");
  face("x2", "m1", "ivan");
});

describe("who can open a personal library", () => {
  it("is its owner alone — not another member, not an admin, whatever grants are left", () => {
    expect(canUserAccessLibrary({ id: "mine" }, mia.id, mia.role)).toBe(true);
    expect(canUserAccessLibrary({ id: "mine" }, olga.id, olga.role)).toBe(false);
    expect(canUserAccessLibrary({ id: "mine" }, admin.id, admin.role)).toBe(false);
    expect(canUserAccessBook("m1", { id: "mine" }, admin.id, admin.role, "gallery")).toBe(false);
  });

  it("is nobody once orphaned", () => {
    orphanPersonalLibraryOf("mia", "admin", null);
    expect(canUserAccessLibrary({ id: "mine" }, mia.id, mia.role)).toBe(false);
    expect(personalLibraryIdOf("mia")).toBeNull();
  });
});

describe("nothing derived reaches anyone else", () => {
  it("keeps its photos out of every scope but the owner's", () => {
    expect(timeline(mia)).toEqual(["f1", "m1", "m2"]);
    expect(timeline(olga)).toEqual(["f1"]);
    expect(timeline(admin)).toEqual(["f1"]);
    for (const user of [olga, admin]) {
      expect(resolveGalleryScopeLibraryIds(user)).not.toContain("mine");
      expect(resolveGalleryScopeLibraryIds(user, ["mine"])).toEqual([]);
      expect(resolveGalleryBrowseLibraryIds(user, ["mine"])).toEqual([]);
      expect(runAsViewer(user, () => getGalleryAsset(user.id, resolveGalleryScopeLibraryIds(user), "m1"))).toBeNull();
    }
  });

  it("keeps them off the map, out of facets, folders, memories and recently added", () => {
    for (const user of [olga, admin]) {
      const libIds = resolveGalleryBrowseLibraryIds(user);
      runAsViewer(user, () => {
        expect(queryGalleryMapPoints(libIds, { kinds: [], limit: 50 }).points).toHaveLength(1);
        expect(JSON.stringify(galleryFacets(libIds))).not.toContain("Secret");
        expect(JSON.stringify(queryGalleryFolders(user.id, libIds, "", 50, 0))).not.toContain("Secret");
        expect(ids(queryGalleryRecentlyAdded(user.id, libIds, 3650, 50).assets)).toEqual(["f1"]);
        expect(JSON.stringify(queryGalleryMemories(user.id, libIds, "2026-11-05", 10))).not.toContain("m1");
      });
    }
  });

  it("does not count its faces on another viewer's People", () => {
    const people = runAsViewer(olga, () => listGalleryPeople(resolveGalleryBrowseLibraryIds(olga), false));
    expect(people.find((p) => p.id === "ivan")).toMatchObject({ faceCount: 1, coverUrl: expect.stringContaining("x1-face") });
  });

  it("never shares its photos through a person granted to someone", () => {
    setPersonGrant({ subjectType: "user", subjectId: "olga" }, "ivan", true, "admin");
    expect(canSeeThroughPeople(olga, "m1")).toBe(false);
    expect(canSeeThroughPeople(olga, "f1")).toBe(true);
    expect(timeline(olga)).toEqual(["f1"]);
  });

  it("is never scanned for faces, whatever a setting row says", () => {
    setFaceRecognitionEnabledForLibrary("mine", true, "admin");
    expect(faceRecognitionEnabledForLibrary("mine")).toBe(false);
    expect(enabledFaceLibraryIds()).not.toContain("mine");
    expect(enqueueFaceScanBatches("mine")).toEqual([]);
  });

  it("stays off the admin's housekeeping lists", () => {
    db.prepare("UPDATE library_items SET deleted_at = '2026-11-01T00:00:00Z' WHERE id IN ('m2', 'f1')").run();
    expect(runAsViewer(admin, () => listMissingGalleryPhotos().items.map((i) => i.id))).toEqual(["f1"]);
    expect(galleryLibraryOptions().map((l) => l.id)).toEqual(["fam"]);
  });

  it("keeps its photos out of the activity log", async () => {
    const { logActivity } = await import("../src/db.js");
    logActivity({ event: "library.gallery.viewed", actorUserId: "mia", targetType: "gallery", targetId: "m1", detail: "viewed" });
    logActivity({ event: "library.gallery.uploaded", actorUserId: "mia", targetType: "library", targetId: "mine", detail: "Secret.jpg" });
    logActivity({ event: "library.gallery.viewed", actorUserId: "mia", targetType: "gallery", targetId: "f1", detail: "viewed" });
    logActivity({ event: "library.personal.created", actorUserId: "mia", targetType: "library", targetId: "mine", detail: "on" });
    const events = (db.prepare("SELECT event, target_id FROM activity_logs ORDER BY rowid").all() as { event: string; target_id: string }[]);
    expect(events).toEqual([
      { event: "library.gallery.viewed", target_id: "f1" },
      { event: "library.personal.created", target_id: "mine" }
    ]);
  });
});

describe("adopt, orphan, hand over", () => {
  beforeEach(() => {
    makeLibrary("phone", { createdBy: "admin", type: "gallery" });
    grant("user", "admin", "phone", "manager");
    grant("user", "olga", "phone", "viewer");
    item("p1", "phone", "Camera/p1.jpg");
    makeShare({ module: "gallery", resourceId: "p1", userId: "olga", createdBy: "admin" });
  });

  it("adoption removes every other grant and every other person's share", () => {
    adoptPersonalLibrary("phone", "olga", "admin", null);
    expect(canUserAccessLibrary({ id: "phone" }, admin.id, admin.role)).toBe(false);
    expect(canUserAccessLibrary({ id: "phone" }, olga.id, olga.role)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'library' AND object_id = 'phone'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT revoked_at FROM shares WHERE resource_id = 'p1'").get()).toMatchObject({ revoked_at: expect.any(String) });
    expect(db.prepare("SELECT personal_adopted_at FROM libraries WHERE id = 'phone'").get()).toMatchObject({ personal_adopted_at: expect.any(String) });
  });

  it("refuses a member who already has one, and a system library", () => {
    expect(() => adoptPersonalLibrary("phone", "mia", "admin", null)).toThrow(/already has/);
    makeLibrary("in", { createdBy: "admin", type: "gallery", role: "inbox" });
    expect(() => adoptPersonalLibrary("in", "olga", "admin", null)).toThrow(/system library/);
  });

  it("hands an orphaned library to a member with none — and only an orphaned one", () => {
    expect(() => handOverPersonalLibrary("mine", "olga", "admin", null)).toThrow(/removed/);
    orphanPersonalLibraryOf("mia", "admin", null);
    handOverPersonalLibrary("mine", "olga", "admin", null);
    expect(canUserAccessLibrary({ id: "mine" }, olga.id, olga.role)).toBe(true);
    expect(canUserAccessLibrary({ id: "mine" }, admin.id, admin.role)).toBe(false);
    expect(personalLibraryIdOf("olga")).toBe("mine");
  });

  it("lets a re-issued account start a new one instead of inheriting the orphan", () => {
    orphanPersonalLibraryOf("mia", "admin", null);
    makeLibrary("mine2", { createdBy: "mia", type: "gallery" });
    markPersonal("mine2", "mia");
    expect(personalLibraryIdOf("mia")).toBe("mine2");
    expect(canUserAccessLibrary({ id: "mine" }, mia.id, mia.role)).toBe(false);
  });
});

describe("through the API", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;
  let root: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-"));
    db.prepare("DELETE FROM storage_roots").run();
    // Creating a library insists on thumbnail storage being configured first.
    fs.mkdirSync(path.join(root, "_thumbs"));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, path.join(root, "_thumbs"));
    db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('r1', 'Media', ?, 'admin')").run(fs.realpathSync(root));
    ({ app, signIn } = await bootApp({
      plugins: [async (instance: FastifyInstance) => {
        registerPersonalLibraryRouteGuard(instance);
        await instance.register(galleryRoutesPlugin);
        await instance.register(libraryMembersPlugin);
        await instance.register(folderLocksPlugin);
        registerTrashRoutes(instance);
        await instance.register(personalLibraryRoutesPlugin);
      }]
    }));
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const as = async (userId: string) => ({ cookie: await signIn(userId) });

  it("shows the admin whose it is and its size, nothing more", async () => {
    const res = await app.inject({ method: "GET", url: "/api/library/gallery-libraries?manage=1", headers: await as("admin") });
    const mine = res.json().libraries.find((l: { id: string }) => l.id === "mine");
    expect(mine).toMatchObject({ personal: { ownerId: "mia", ownerName: "mia", orphaned: false }, totalSizeBytes: 2000, bookCount: 0, fileCount: null, canManageLibrary: false });
    expect(mine.sourcePath).toBeUndefined();
    expect(mine.settings).toBeUndefined();
    // Another member does not see it listed at all.
    const other = await app.inject({ method: "GET", url: "/api/library/gallery-libraries", headers: await as("olga") });
    expect(other.json().libraries.map((l: { id: string }) => l.id)).toEqual(["fam"]);
  });

  it("answers 404 to the admin on every library-id route but deleting an orphan", async () => {
    const admin = await as("admin");
    for (const [method, url] of [
      ["GET", "/api/library/gallery/assets/m1"],
      ["GET", "/api/library/libraries/mine/members"],
      ["GET", "/api/library/libraries/mine/folder-locks"],
      ["PATCH", "/api/library/gallery-libraries/mine"],
      ["POST", "/api/library/gallery-libraries/mine/rescan"],
      ["DELETE", "/api/library/gallery-libraries/mine"]
    ] as const) {
      const res = await app.inject({ method, url, headers: admin, payload: method === "GET" ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    orphanPersonalLibraryOf("mia", "admin", null);
    const del = await app.inject({ method: "DELETE", url: "/api/library/gallery-libraries/mine", headers: admin });
    expect(del.statusCode).toBe(200);
  });

  it("won't let the owner give access to it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/library/libraries/mine/members", headers: await as("mia"),
      payload: { subjectType: "user", subjectId: "olga", role: "viewer" }
    });
    expect(res.statusCode).toBe(409);
  });

  it("keeps another member's personal bin out of the admin's Recycle Bin", async () => {
    db.prepare("INSERT INTO trashed_items (id, library_id, library_type, library_name, source_path, title, origin_path, trash_path) VALUES ('t1', 'mine', 'gallery', 'mine', '/src/mine', 'Secret', 'Secret/m2.jpg', '.trash/t1')").run();
    const res = await app.inject({ method: "GET", url: "/api/library/trash", headers: await as("admin") });
    expect(JSON.stringify(res.json())).not.toContain("Secret");
  });

  it("lets a member turn one on only once the admin allows it", async () => {
    const olgaH = await as("olga");
    expect((await app.inject({ method: "GET", url: "/api/profile/personal-library", headers: olgaH })).json())
      .toMatchObject({ library: null, canTurnOn: false, unavailable: "off" });

    const adminH = await as("admin");
    const saved = await app.inject({
      method: "PUT", url: "/api/storage/personal-libraries/settings", headers: adminH,
      payload: { enabled: true, storageRootId: "r1", folder: "Personal", who: "chosen", subjects: [{ type: "user", id: "olga" }], sizeLimitGB: null }
    });
    expect(saved.statusCode).toBe(200);

    const on = await app.inject({ method: "POST", url: "/api/profile/personal-library", headers: olgaH, payload: { name: "Olga's photos" } });
    expect(on.statusCode, on.body).toBe(201);
    expect(on.json().library).toMatchObject({ name: "Olga's photos", sizeBytes: 0 });
    expect(fs.existsSync(path.join(root, "Personal", "olga"))).toBe(true);
    const again = await app.inject({ method: "POST", url: "/api/profile/personal-library", headers: olgaH, payload: {} });
    expect(again.statusCode).toBe(409);
    // Not on the list: refused.
    db.prepare("DELETE FROM libraries WHERE id = 'mine'").run();
    const miaTry = await app.inject({ method: "POST", url: "/api/profile/personal-library", headers: await as("mia"), payload: {} });
    expect(miaTry.statusCode).toBe(403);
  });

  it("refuses a personal folder inside another library", async () => {
    db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'fam'").run(path.join(fs.realpathSync(root), "Family"));
    const res = await app.inject({
      method: "PUT", url: "/api/storage/personal-libraries/settings", headers: await as("admin"),
      payload: { enabled: true, storageRootId: "r1", folder: "Family/Personal", who: "everyone", subjects: [], sizeLimitGB: 5 }
    });
    expect(res.statusCode).toBe(409);
    expect(savePersonalSettings).toBeTypeOf("function");
  });
});
