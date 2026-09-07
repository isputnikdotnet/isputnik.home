import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { addAlbumItems, createAlbum } from "../src/modules/library/gallery/albums.js";
import { loadAlbumReview } from "../src/modules/library/gallery/review.js";
import { markGalleryAssetReviewed } from "../src/modules/library/gallery/edit.js";
import { canUserWriteAsset, getLibraryForBook, userHasGalleryAlbumEditShareForItem } from "../src/modules/library/shared/library-access.js";
import { grantAlbumAccess } from "../src/modules/library/shared/shares.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// "Ask what they remember" (docs/photo-review-plan.md, phase 3): an album sent
// with a question carries an 'edit' share, which lets the recipient write on
// the album's photos — those and no others — bounded by what the sender may
// curate. Review mode over the album reads through the same share.

const CREATOR = { id: "creator", role: "member" };
const HELPER = { id: "helper", role: "member" };
const ORIGIN = "http://test.local";

function makePhoto(libraryId: string, id: string, relativePath: string): void {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, 'gallery', ?, 'ready', '2020-01-01T00:00:00.000Z')"
  ).run(id, libraryId, relativePath);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 9)").run(id, relativePath);
}

let albumId = "";

beforeEach(() => {
  resetDb();
  makeUser("creator", "member");
  makeUser("helper", "member");
  // A private library the creator manages and the helper cannot see at all.
  makeLibrary("gal", { createdBy: "creator", type: "gallery", ownerId: "creator", ownerType: "user" });
  grant("user", "creator", "gal", "manager");
  makePhoto("gal", "in1", "summer/001.jpg");
  makePhoto("gal", "in2", "summer/002.jpg");
  makePhoto("gal", "out", "winter/001.jpg");
  albumId = createAlbum(CREATOR, "Summer 1971", null).id;
  addAlbumItems(albumId, new Set(["gal"]), ["in1", "in2"]);
});

describe("the edit share that comes with a question", () => {
  it("lets the recipient write on the album's photos and no others", () => {
    expect(grantAlbumAccess({ albumId, toUserId: "helper", by: CREATOR, permission: "edit", origin: ORIGIN })).toBe("ok");
    const lib = getLibraryForBook("in1")!;
    expect(userHasGalleryAlbumEditShareForItem("in1", "helper")).toBe(true);
    expect(canUserWriteAsset("in1", lib, "helper", "member")).toBe(true);
    expect(canUserWriteAsset("in2", lib, "helper", "member")).toBe(true);
    expect(canUserWriteAsset("out", lib, "helper", "member")).toBe(false);
  });

  it("a plain share only lets them look, and a later plain share never takes the edit right back", () => {
    grantAlbumAccess({ albumId, toUserId: "helper", by: CREATOR, origin: ORIGIN });
    const lib = getLibraryForBook("in1")!;
    expect(canUserWriteAsset("in1", lib, "helper", "member")).toBe(false);

    grantAlbumAccess({ albumId, toUserId: "helper", by: CREATOR, permission: "edit", origin: ORIGIN });
    grantAlbumAccess({ albumId, toUserId: "helper", by: CREATOR, origin: ORIGIN });
    expect(canUserWriteAsset("in1", lib, "helper", "member")).toBe(true);
    const row = db.prepare("SELECT permission FROM shares WHERE module = 'gallery_album' AND resource_id = ? AND user_id = 'helper'")
      .get(albumId) as { permission: string };
    expect(row.permission).toBe("edit");
  });

  it("is bounded by what the sender may curate", () => {
    // A viewer of the library cannot hand out an edit right through an album,
    // even one they made: the share exists, but reaches nothing.
    makeUser("viewer", "member");
    grant("user", "viewer", "gal", "viewer");
    const theirs = createAlbum({ id: "viewer" }, "Borrowed", null).id;
    addAlbumItems(theirs, new Set(["gal"]), ["in1"]);
    expect(grantAlbumAccess({ albumId: theirs, toUserId: "helper", by: { id: "viewer", role: "member" }, permission: "edit", origin: ORIGIN })).toBe("ok");
    expect(canUserWriteAsset("in1", getLibraryForBook("in1")!, "helper", "member")).toBe(false);
  });
});

describe("Review mode over an album", () => {
  it("is not there for someone the album was never sent to", () => {
    expect(loadAlbumReview(HELPER, albumId)).toBeNull();
    expect(loadAlbumReview(HELPER, "nope")).toBeNull();
  });

  it("walks the album's photos, unreviewed first, and says whether she may write", () => {
    grantAlbumAccess({ albumId, toUserId: "helper", by: CREATOR, permission: "edit", origin: ORIGIN });
    markGalleryAssetReviewed("in1", "helper");
    const review = loadAlbumReview(HELPER, albumId);
    expect(review?.album.name).toBe("Summer 1971");
    expect(review?.items.map((item) => item.id)).toEqual(["in2", "in1"]);
    expect(review?.canEdit).toBe(true);
  });

  it("reads as viewing only over a plain share, and for the creator as their own library right", () => {
    grantAlbumAccess({ albumId, toUserId: "helper", by: CREATOR, origin: ORIGIN });
    expect(loadAlbumReview(HELPER, albumId)?.canEdit).toBe(false);
    const own = loadAlbumReview(CREATOR, albumId);
    expect(own?.items).toHaveLength(2);
    expect(own?.canEdit).toBe(true);
  });
});
