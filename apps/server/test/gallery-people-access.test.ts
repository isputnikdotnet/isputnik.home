// Photos shared by person (docs/people-sharing-plan.md, phase 1): a relative with
// no library sees exactly the photos where a person shared with them is a
// confirmed face — in the ordinary gallery surfaces, with folder names, other
// people and (unless allowed) locations kept back.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { runAsViewer } from "../src/core/viewer-context.js";
import { canUserAccessBook, canUserDownloadBook } from "../src/modules/library/shared/library-access.js";
import { resolveGalleryBrowseLibraryIds, resolveGalleryScopeLibraryIds, SHARED_PEOPLE_SCOPE } from "../src/modules/library/gallery/catalog-scope.js";
import { galleryFacets, queryGalleryFolders, queryGalleryMapPoints, queryGalleryTimeline } from "../src/modules/library/gallery/catalog.js";
import { getGalleryAsset } from "../src/modules/library/gallery/catalog-asset.js";
import { confirmPersonPhotos, getGalleryPersonPhotos, listGalleryPeople, mergeGalleryPeople, deleteGalleryPerson } from "../src/modules/library/gallery/people.js";
import {
  canSeeThumbnailThroughPeople, personShareCounts, personReviewItemIds, setPersonGrant, setShareExcluded, setShowLocation,
  sharedPeopleFor
} from "../src/modules/library/gallery/people-access.js";
import { galleryPeopleAccessRoutesPlugin } from "../src/modules/library/gallery/people-access-routes.js";
import { galleryRoutesPlugin } from "../src/modules/library/gallery/routes.js";
import { deleteLibraryMembersForSubject } from "../src/modules/library/shared/library-access.js";
import { bootApp } from "./helpers/boot.js";
import { addToGroup, grant, makeGroup, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

const cousin = { id: "cousin", role: "member" };
const other = { id: "other", role: "member" };
const admin = { id: "admin", role: "admin" };

function item(id: string, libraryId: string, folderPath: string, gps: [number, number] | null = null) {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, 'gallery', ?, 'ready', ?)")
    .run(id, libraryId, folderPath, `2024-01-0${id.slice(-1)}T00:00:00Z`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title, cover_storage_key) VALUES (?, 'scan', ?, ?)")
    .run(id, folderPath.split("/").pop(), `${libraryId}/xx/yy/${id}-cover.webp`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size, taken_at, gps_lat, gps_lng) VALUES (?, 'photo', ?, 1, ?, ?, ?)")
    .run(id, folderPath, `2020-0${id.slice(-1)}-01T00:00:00Z`, gps?.[0] ?? null, gps?.[1] ?? null);
}

function person(id: string, name: string) {
  db.prepare("INSERT INTO gallery_people (id, name) VALUES (?, ?)").run(id, name);
}

function face(id: string, itemId: string, personId: string, assignment = "confirmed", box = [0.1, 0.1, 0.2, 0.2]) {
  db.prepare(`
    INSERT INTO gallery_faces (id, item_id, person_id, box_x, box_y, box_w, box_h, assignment, source, thumb_storage_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scan', ?)
  `).run(id, itemId, personId, box[0], box[1], box[2], box[3], assignment, `fam/xx/yy/${id}-face.webp`);
}

const ids = (assets: { id: string }[]) => assets.map((a) => a.id).sort();

function timeline(user: { id: string; role: string }, filter?: string[]) {
  return runAsViewer(user, () =>
    queryGalleryTimeline(user.id, resolveGalleryBrowseLibraryIds(user, filter), { q: "", kinds: [], limit: 50, offset: 0 }).assets);
}

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("cousin", "member");
  makeUser("other", "member");
  makeGroup("petrov", "admin");
  addToGroup("petrov", "cousin");
  // The family's private library: only the admin can open it.
  makeLibrary("fam", { createdBy: "admin", type: "gallery", ownerId: "admin", ownerType: "user" });
  grant("user", "admin", "fam", "manager");
  makeLibrary("inbox", { createdBy: "admin", type: "gallery", role: "inbox" });

  person("ivan", "Ivan");
  person("olga", "Olga");
  person("anna", "Anna");
  person("ivan2", "Ivan P");
  item("p1", "fam", "Secret/Hospital 2019/p1.jpg", [53.9, 27.5]);
  item("p2", "fam", "Secret/p2.jpg");
  item("p3", "fam", "Secret/p3.jpg");
  item("p4", "fam", "Secret/p4.jpg");
  item("p5", "fam", "Secret/p5.jpg");
  item("i1", "inbox", "new/i1.jpg");
  face("f1", "p1", "ivan");                    // Ivan, confirmed, at a party with…
  face("f2", "p1", "anna", "confirmed", [0.6, 0.1, 0.2, 0.2]);  // …Anna, who is not shared
  face("f3", "p2", "ivan", "auto");            // only matched automatically
  face("f4", "p3", "olga");
  face("f5", "p4", "ivan");                    // kept out below
  face("f6", "i1", "ivan");                    // in the Photo Inbox: never shared by person
  setShareExcluded("p4", true, "admin");
});

describe("the rule", () => {
  it("shares nothing until a person is granted", () => {
    expect(timeline(cousin)).toEqual([]);
    expect(canUserAccessBook("p1", { id: "fam" }, "cousin", "member", "gallery")).toBe(false);
  });

  it("shares confirmed faces only — not automatic matches, not excluded photos, not the Inbox", () => {
    setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan", true, "admin");
    expect(ids(timeline(cousin))).toEqual(["p1"]);
    expect(canUserAccessBook("p1", { id: "fam" }, "cousin", "member", "gallery")).toBe(true);
    expect(canUserDownloadBook("p1", { id: "fam" }, "cousin", "member", "gallery")).toBe(true);
    for (const hidden of ["p2", "p4", "p5"]) {
      expect(canUserAccessBook(hidden, { id: "fam" }, "cousin", "member", "gallery"), hidden).toBe(false);
    }
    expect(canUserAccessBook("i1", { id: "inbox" }, "cousin", "member", "gallery")).toBe(false);
    // Nobody else gains anything.
    expect(timeline(other)).toEqual([]);
  });

  it("reaches through groups, and a deny beats a group's grant", () => {
    setPersonGrant({ subjectType: "group", subjectId: "petrov" }, "olga", true, "admin");
    setPersonGrant({ subjectType: "group", subjectId: "petrov" }, "ivan", true, "admin");
    expect(ids(timeline(cousin))).toEqual(["p1", "p3"]);
    db.prepare("INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role) VALUES ('user', 'cousin', 'gallery_person', 'ivan', 'deny')").run();
    expect(ids(timeline(cousin))).toEqual(["p3"]);
  });

  it("follows the faces: confirming shares, rejecting and withdrawing take away", () => {
    setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan", true, "admin");
    expect(personShareCounts("ivan")).toEqual({ shared: 1, toReview: 1, excluded: 1 });
    expect(personReviewItemIds("ivan", 10, 0)).toEqual({ itemIds: ["p2"], total: 1 });
    expect(confirmPersonPhotos("ivan", ["p2"], [])).toEqual({ confirmed: 1, rejected: 0 });
    expect(ids(timeline(cousin))).toEqual(["p1", "p2"]);

    expect(confirmPersonPhotos("ivan", [], ["p1"])).toEqual({ confirmed: 0, rejected: 0 });  // a confirmed face is not the review's to undo
    db.prepare("UPDATE gallery_faces SET assignment = 'auto' WHERE id = 'f1'").run();
    expect(confirmPersonPhotos("ivan", [], ["p1"])).toEqual({ confirmed: 0, rejected: 1 });
    expect(ids(timeline(cousin))).toEqual(["p2"]);

    setShareExcluded("p4", false, "admin");
    expect(ids(timeline(cousin))).toEqual(["p2", "p4"]);
    setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan", false, "admin");
    expect(timeline(cousin)).toEqual([]);
  });

  it("only a named person can be shared, and a merge or delete carries the grants", () => {
    person("nobody", "");
    expect(setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "nobody", true, "admin")).toBe(false);
    setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan2", true, "admin");
    mergeGalleryPeople("ivan2", "ivan");
    expect(sharedPeopleFor(cousin)).toEqual(["ivan"]);
    deleteGalleryPerson("ivan");
    expect(sharedPeopleFor(cousin)).toEqual([]);
  });

  it("goes with the group when the group is deleted", () => {
    setPersonGrant({ subjectType: "group", subjectId: "petrov" }, "ivan", true, "admin");
    setShowLocation({ subjectType: "group", subjectId: "petrov" }, true);
    deleteLibraryMembersForSubject("group", "petrov");
    expect(sharedPeopleFor(cousin)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM access_settings").get()).toEqual({ n: 0 });
  });
});

describe("what a relative sees of a shared photo", () => {
  beforeEach(() => {
    setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan", true, "admin");
  });

  it("no folder path, no library name, and no location until allowed", () => {
    const [asset] = timeline(cousin);
    expect(asset).toMatchObject({ folderPath: "p1.jpg", folder: "", libraryName: null, gps: null, placeText: null });
    expect(runAsViewer(cousin, () => queryGalleryMapPoints(resolveGalleryBrowseLibraryIds(cousin), { kinds: [], limit: 10 }).points)).toEqual([]);
    setShowLocation({ subjectType: "group", subjectId: "petrov" }, true);   // a group's setting counts
    expect(timeline(cousin)[0].gps).toEqual({ lat: 53.9, lng: 27.5 });
    expect(runAsViewer(cousin, () => queryGalleryMapPoints(resolveGalleryBrowseLibraryIds(cousin), { kinds: [], limit: 10 }).points)).toHaveLength(1);
    // The owner still sees everything as it is.
    const own = runAsViewer(admin, () => queryGalleryTimeline("admin", resolveGalleryBrowseLibraryIds(admin), { q: "", kinds: [], limit: 50, offset: 0 }).assets);
    expect(own.find((a) => a.id === "p1")).toMatchObject({ folderPath: "Secret/Hospital 2019/p1.jpg", libraryName: "fam" });
  });

  it("only the shared people are named or marked on it, and listed under People", () => {
    const detail = runAsViewer(cousin, () => getGalleryAsset("cousin", resolveGalleryScopeLibraryIds(cousin), "p1"))!;
    expect(detail.people.map((p) => p.name)).toEqual(["Ivan"]);
    expect(detail.faces.map((f) => f.personName)).toEqual(["Ivan"]);
    const people = runAsViewer(cousin, () => listGalleryPeople(resolveGalleryBrowseLibraryIds(cousin)));
    expect(people.map((p) => p.name)).toEqual(["Ivan"]);
    const facets = runAsViewer(cousin, () => galleryFacets(resolveGalleryBrowseLibraryIds(cousin)));
    expect(facets.people).toEqual(["Ivan"]);
    // Anna's photos, asked for by id, show nothing shared through Ivan.
    expect(runAsViewer(cousin, () => getGalleryPersonPhotos("cousin", resolveGalleryBrowseLibraryIds(cousin), "anna", 10, 0))?.total).toBe(0);
    expect(runAsViewer(cousin, () => getGalleryPersonPhotos("cousin", resolveGalleryBrowseLibraryIds(cousin), "ivan", 10, 0))?.total).toBe(1);
  });

  it("stays out of the folder views, and a filter can narrow to just these", () => {
    expect(runAsViewer(cousin, () => queryGalleryFolders("cousin", resolveGalleryBrowseLibraryIds(cousin), "", 50, 0))).toMatchObject({ folders: [], assets: [] });
    expect(ids(timeline(cousin, [SHARED_PEOPLE_SCOPE]))).toEqual(["p1"]);
    expect(timeline(cousin, ["fam"])).toEqual([]);
  });

  it("thumbnails: the photo's own and the shared person's face, not the other guests'", () => {
    expect(canSeeThumbnailThroughPeople(cousin, "fam/xx/yy/p1-cover.webp")).toBe(true);
    expect(canSeeThumbnailThroughPeople(cousin, "fam/xx/yy/f1-face.webp")).toBe(true);
    expect(canSeeThumbnailThroughPeople(cousin, "fam/xx/yy/f2-face.webp")).toBe(false);
    expect(canSeeThumbnailThroughPeople(cousin, "fam/xx/yy/p3-cover.webp")).toBe(false);
    expect(canSeeThumbnailThroughPeople(other, "fam/xx/yy/p1-cover.webp")).toBe(false);
  });
});

describe("over HTTP", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;

  beforeEach(async () => {
    ({ app, signIn } = await bootApp({ plugins: [galleryRoutesPlugin, galleryPeopleAccessRoutesPlugin] }));
  });
  afterEach(async () => { await app.close(); });

  it("an admin shares a person; the relative's timeline and photo page follow, redacted", async () => {
    const adminCookie = await signIn("admin");
    const cousinCookie = await signIn("cousin");
    const put = await app.inject({ method: "PUT", url: "/api/library/gallery/people/ivan/sharing/user/cousin", headers: { cookie: adminCookie } });
    expect(put.statusCode).toBe(200);
    const access = await app.inject({ method: "GET", url: "/api/library/gallery/access/user/cousin", headers: { cookie: adminCookie } });
    expect(access.json()).toMatchObject({ people: [{ id: "ivan", direct: true, counts: { shared: 1, toReview: 1 } }], photoCount: 1 });

    const list = await app.inject({ method: "POST", url: "/api/library/gallery/timeline", headers: { cookie: cousinCookie }, payload: { q: "", kinds: [], limit: 20, offset: 0 } });
    expect(list.statusCode).toBe(200);
    expect(list.json().assets.map((a: { id: string }) => a.id)).toEqual(["p1"]);
    expect(list.json().assets[0]).toMatchObject({ folderPath: "p1.jpg", libraryName: null, gps: null });

    const detail = await app.inject({ method: "GET", url: "/api/library/gallery/assets/p1", headers: { cookie: cousinCookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().asset.people.map((p: { name: string }) => p.name)).toEqual(["Ivan"]);
    const refused = await app.inject({ method: "GET", url: "/api/library/gallery/assets/p3", headers: { cookie: cousinCookie } });
    expect(refused.statusCode).toBe(404);

    // Only an admin manages sharing.
    const denied = await app.inject({ method: "PUT", url: "/api/library/gallery/people/olga/sharing/user/cousin", headers: { cookie: cousinCookie } });
    expect(denied.statusCode).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'access.person.granted'").get()).toEqual({ n: 1 });
  });
});
