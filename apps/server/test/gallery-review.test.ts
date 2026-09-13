import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { markGalleryAssetReviewed, setGalleryPlaceAndTime, updateGalleryAsset } from "../src/modules/library/gallery/edit.js";
import { getGalleryAsset } from "../src/modules/library/gallery/catalog-asset.js";
import { dateFolderForCapture } from "../src/modules/library/gallery/date-folder.js";
import { listPhotoInboxItems, listPhotoInboxes } from "../src/modules/library/gallery/inbox.js";
import { floorTakenAt } from "../src/modules/library/gallery/taken-precision.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// Photo review, phase 1 (docs/photo-review-plan.md): a date known only to the
// year, a place as a person wrote it, and a mark that says someone went through
// the photo. All three live on gallery_details and are manual-only.

const ADMIN = { id: "u1", role: "admin" };
const HELPER = { id: "u2", role: "member" };
const INBOX_POLICY = JSON.stringify({ mode: "managed" });

function makePhoto(libraryId: string, id: string, relativePath: string, takenAt: string | null = null): void {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, 'gallery', ?, 'ready', '2020-01-01T00:00:00.000Z')"
  ).run(id, libraryId, relativePath);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size, taken_at) VALUES (?, 'photo', ?, 9, ?)")
    .run(id, relativePath, takenAt);
}

const details = (id: string) => db.prepare(
  "SELECT taken_at, taken_precision, taken_approx, taken_at_source, place_text, reviewed_at, reviewed_by FROM gallery_details WHERE item_id = ?"
).get(id) as {
  taken_at: string | null; taken_precision: string; taken_approx: number; taken_at_source: string;
  place_text: string | null; reviewed_at: string | null; reviewed_by: string | null;
};

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "member");
  makeLibrary("gal", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "gal", "member");
});

describe("floorTakenAt", () => {
  it("stores a coarse date as the first instant of its period, in UTC", () => {
    expect(floorTakenAt("1962-07-14T15:30:00.000Z", "day")).toBe("1962-07-14T00:00:00.000Z");
    expect(floorTakenAt("1962-07-14T15:30:00.000Z", "month")).toBe("1962-07-01T00:00:00.000Z");
    expect(floorTakenAt("1962-07-14T15:30:00.000Z", "year")).toBe("1962-01-01T00:00:00.000Z");
    expect(floorTakenAt("1967-07-14T15:30:00.000Z", "decade")).toBe("1960-01-01T00:00:00.000Z");
  });

  it("passes an exact instant through and refuses nonsense", () => {
    expect(floorTakenAt("1962-07-14T15:30:00Z", "time")).toBe("1962-07-14T15:30:00.000Z");
    expect(floorTakenAt("not a date", "year")).toBeNull();
  });
});

describe("the dated Keep layout at a coarse precision", () => {
  const fallback = new Date("2026-07-20T12:00:00Z");
  it("files as far as the date is known and no further", () => {
    expect(dateFolderForCapture("1962-01-01T00:00:00.000Z", fallback, "year")).toBe("1962");
    expect(dateFolderForCapture("1960-01-01T00:00:00.000Z", fallback, "decade")).toBe("1960");
    expect(dateFolderForCapture("1962-07-01T00:00:00.000Z", fallback, "month")).toBe("1962/1962-07");
    expect(dateFolderForCapture("1962-07-14T00:00:00.000Z", fallback, "day")).toBe("1962/1962-07-14");
  });
  it("uses the full layout for an undated photo whatever the precision says", () => {
    expect(dateFolderForCapture(null, fallback, "year")).toBe("2026/2026-07-20");
  });
});

describe("editing a photo's date, place and reviewed mark", () => {
  it("keeps the precision and the 'about' flag, floors the date, and marks it manual", () => {
    makePhoto("gal", "p1", "box3/001.jpg", "2026-09-01T10:00:00.000Z");
    expect(updateGalleryAsset("p1", {
      title: "001.jpg", description: null, tags: [],
      takenAt: "1962-07-14T10:00:00.000Z", takenPrecision: "year", takenApprox: true
    })).toBe(true);
    const row = details("p1");
    expect(row.taken_at).toBe("1962-01-01T00:00:00.000Z");
    expect(row.taken_precision).toBe("year");
    expect(row.taken_approx).toBe(1);
    expect(row.taken_at_source).toBe("manual");

    const asset = getGalleryAsset("u1", ["gal"], "p1");
    expect(asset?.takenPrecision).toBe("year");
    expect(asset?.takenApprox).toBe(true);
  });

  it("treats a full instant with no precision as exact again", () => {
    makePhoto("gal", "p1", "box3/001.jpg", null);
    updateGalleryAsset("p1", { title: "001.jpg", description: null, tags: [], takenAt: "1962-01-01T00:00:00.000Z", takenPrecision: "year", takenApprox: true });
    updateGalleryAsset("p1", { title: "001.jpg", description: null, tags: [], takenAt: "1962-07-14T15:30:00.000Z" });
    const row = details("p1");
    expect(row.taken_at).toBe("1962-07-14T15:30:00.000Z");
    expect(row.taken_precision).toBe("time");
    expect(row.taken_approx).toBe(0);
  });

  it("can change only how an existing date is read", () => {
    makePhoto("gal", "p1", "box3/001.jpg", "1962-07-14T15:30:00.000Z");
    updateGalleryAsset("p1", { title: "001.jpg", description: null, tags: [], takenAt: null, takenApprox: true });
    expect(details("p1")).toMatchObject({ taken_at: "1962-07-14T15:30:00.000Z", taken_precision: "time", taken_approx: 1 });
    updateGalleryAsset("p1", { title: "001.jpg", description: null, tags: [], takenAt: null, takenPrecision: "month" });
    expect(details("p1")).toMatchObject({ taken_at: "1962-07-01T00:00:00.000Z", taken_precision: "month", taken_approx: 1 });
  });

  it("stores the place as written, trims it, and clears it with null", () => {
    makePhoto("gal", "p1", "box3/001.jpg", null);
    updateGalleryAsset("p1", { title: "001.jpg", description: null, tags: [], takenAt: null, placeText: "  the dacha in Ratomka " });
    expect(details("p1").place_text).toBe("the dacha in Ratomka");
    expect(getGalleryAsset("u1", ["gal"], "p1")?.placeText).toBe("the dacha in Ratomka");
    // Omitted = untouched.
    updateGalleryAsset("p1", { title: "001.jpg", description: "a note", tags: [], takenAt: null });
    expect(details("p1").place_text).toBe("the dacha in Ratomka");
    updateGalleryAsset("p1", { title: "001.jpg", description: null, tags: [], takenAt: null, placeText: null });
    expect(details("p1").place_text).toBeNull();
  });

  it("records who went through the photo and reports their name", () => {
    makePhoto("gal", "p1", "box3/001.jpg", null);
    expect(details("p1").reviewed_at).toBeNull();
    updateGalleryAsset("p1", { title: "001.jpg", description: null, tags: [], takenAt: null, reviewedBy: "u2" });
    const row = details("p1");
    expect(row.reviewed_at).not.toBeNull();
    expect(row.reviewed_by).toBe("u2");
    const asset = getGalleryAsset("u1", ["gal"], "p1");
    expect(asset?.reviewedAt).toBe(row.reviewed_at);
    expect(asset?.reviewedBy).toBe("u2");
  });

  it("marks a photo reviewed on its own for 'I don't know'", () => {
    makePhoto("gal", "p1", "box3/001.jpg", null);
    expect(markGalleryAssetReviewed("p1", "u2")).toBe(true);
    expect(markGalleryAssetReviewed("nope", "u2")).toBe(false);
    expect(details("p1").reviewed_by).toBe("u2");
  });

  it("survives a rescan: the scan UPSERT never writes the review columns", () => {
    makePhoto("gal", "p1", "box3/001.jpg", "2026-09-01T10:00:00.000Z");
    updateGalleryAsset("p1", {
      title: "001.jpg", description: null, tags: [], takenAt: "1962-01-01T00:00:00.000Z",
      takenPrecision: "year", takenApprox: true, placeText: "Minsk", reviewedBy: "u2"
    });
    // The scanner's UPSERT, reduced to the columns it touches.
    db.prepare(`
      INSERT INTO gallery_details (item_id, kind, relative_path, size, taken_at)
      VALUES ('p1', 'photo', 'box3/001.jpg', 10, '2026-09-02T10:00:00.000Z')
      ON CONFLICT(item_id) DO UPDATE SET
        size = excluded.size,
        taken_at = CASE WHEN gallery_details.taken_at_source = 'manual' THEN gallery_details.taken_at ELSE excluded.taken_at END
    `).run();
    expect(details("p1")).toMatchObject({
      taken_at: "1962-01-01T00:00:00.000Z", taken_precision: "year", taken_approx: 1, place_text: "Minsk", reviewed_by: "u2"
    });
  });
});

describe("bulk place and time with a precision", () => {
  it("stamps one coarse date and one place onto the selection", () => {
    makePhoto("gal", "p1", "box3/001.jpg", null);
    makePhoto("gal", "p2", "box3/002.jpg", "2026-01-01T00:00:00.000Z");
    const result = setGalleryPlaceAndTime(["p1", "p2", "missing"], {
      takenAt: "1958-06-01T00:00:00.000Z", takenPrecision: "decade", takenApprox: true, placeText: "Grandmother's yard"
    });
    expect(result).toEqual({ updated: 2, noDate: 0 });
    for (const id of ["p1", "p2"]) {
      expect(details(id)).toMatchObject({ taken_at: "1950-01-01T00:00:00.000Z", taken_precision: "decade", taken_approx: 1, place_text: "Grandmother's yard" });
    }
  });

  it("a place alone counts as an edit", () => {
    makePhoto("gal", "p1", "box3/001.jpg", null);
    expect(setGalleryPlaceAndTime(["p1"], { placeText: "Minsk" })).toEqual({ updated: 1, noDate: 0 });
    expect(details("p1").place_text).toBe("Minsk");
  });

  it("a clock shift makes the date exact again", () => {
    makePhoto("gal", "p1", "box3/001.jpg", null);
    setGalleryPlaceAndTime(["p1"], { takenAt: "1962-01-01T00:00:00.000Z", takenPrecision: "year", takenApprox: true });
    setGalleryPlaceAndTime(["p1"], { shiftMinutes: 60 });
    expect(details("p1")).toMatchObject({ taken_at: "1962-01-01T01:00:00.000Z", taken_precision: "time", taken_approx: 0 });
  });
});

describe("the Inbox in Review mode", () => {
  beforeEach(() => {
    makeLibrary("inbox", { createdBy: "u1", type: "gallery", policyJson: INBOX_POLICY, role: "inbox" });
    // Viewable by the house; the helper's write right is granted per test.
    grant("group", EVERYONE_GROUP_ID, "inbox", "viewer");
    makePhoto("inbox", "b", "box3/002.jpg");
    makePhoto("inbox", "a", "box3/001.jpg");
    makePhoto("inbox", "c", "box3/003.jpg");
    makePhoto("inbox", "z", "box4/001.jpg");
  });

  it("counts what has been gone through, per delivery and overall", () => {
    grant("user", "u2", "inbox", "contributor");
    markGalleryAssetReviewed("a", "u2");
    const [inbox] = listPhotoInboxes(HELPER);
    expect(inbox.count).toBe(4);
    expect(inbox.reviewed).toBe(1);
    expect(inbox.deliveries.map((d) => [d.folder, d.count, d.reviewed])).toEqual([["box3", 3, 1], ["box4", 1, 0]]);
  });

  it("a contributor may write but not Keep, and an admin may do both", () => {
    grant("user", "u2", "inbox", "contributor");
    const [asHelper] = listPhotoInboxes(HELPER);
    expect(asHelper.canEdit).toBe(true);
    expect(asHelper.canReview).toBe(false);
    const [asAdmin] = listPhotoInboxes(ADMIN);
    expect(asAdmin.canEdit).toBe(true);
    expect(asAdmin.canReview).toBe(true);
  });

  it("walks a delivery in file order with the unreviewed ones first", () => {
    markGalleryAssetReviewed("a", "u1");
    const walk = listPhotoInboxItems(ADMIN, "inbox", { folder: "box3", limit: 10, offset: 0, order: "review" });
    expect(walk?.items.map((item) => item.id)).toEqual(["b", "c", "a"]);
    // The grid keeps its newest-first order.
    const grid = listPhotoInboxItems(ADMIN, "inbox", { folder: "box3", limit: 10, offset: 0 });
    expect(grid?.total).toBe(3);
  });
});
