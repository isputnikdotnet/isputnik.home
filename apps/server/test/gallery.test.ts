import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { updateGalleryAsset } from "../src/modules/library/gallery/edit.js";
import {
  queryGalleryTimeline,
  queryGalleryFolders,
  galleryFacets,
  queryGalleryMapPoints,
  resolveGalleryScopeLibraryIds
} from "../src/modules/library/gallery/catalog.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// A synthetic walked asset. With metaEnabled=false the ingester never reads the
// file for EXIF; thumbnail generation just fails gracefully (no cover) since the
// path doesn't exist — so we can exercise the catalog without real media on disk.
// taken_at falls back to the file mtime, which we control via `modifiedMs`.
function asset(relativePath: string, modifiedMs: number, kindOverride?: "photo" | "video") {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`,
    relativePath,
    fileName: relativePath.split("/").pop()!,
    extension,
    kind: kindOverride ?? kindForExtension(extension)!,
    size: 1000,
    modifiedAtMs: modifiedMs
  };
}

const DAY = 86_400_000;

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("kindForExtension", () => {
  it("classifies photos and videos, ignoring other files", () => {
    expect(kindForExtension(".jpg")).toBe("photo");
    expect(kindForExtension(".HEIC")).toBe("photo");
    expect(kindForExtension(".mp4")).toBe("video");
    expect(kindForExtension(".mov")).toBe("video");
    expect(kindForExtension(".txt")).toBeNull();
  });
});

describe("gallery ingest + timeline", () => {
  it("makes one item per file and orders the timeline newest-first by date", async () => {
    const base = Date.parse("2024-01-01T00:00:00Z");
    await ingestGalleryAsset("GAL", asset("a.jpg", base + DAY), false);          // oldest
    await ingestGalleryAsset("GAL", asset("b.jpg", base + 3 * DAY), false);      // newest
    await ingestGalleryAsset("GAL", asset("trip/c.mp4", base + 2 * DAY), false); // middle, video

    const items = db.prepare("SELECT COUNT(*) c FROM library_items WHERE library_id = 'GAL'").get() as { c: number };
    expect(items.c).toBe(3);

    const { assets, total } = queryGalleryTimeline("u1", ["GAL"], { q: "", kinds: [], limit: 50, offset: 0 });
    expect(total).toBe(3);
    expect(assets.map((a) => a.title)).toEqual(["b.jpg", "c.mp4", "a.jpg"]);
    expect(assets.find((a) => a.title === "c.mp4")?.kind).toBe("video");
  });

  it("re-ingesting the same path upserts in place (no duplicate item)", async () => {
    const t = Date.parse("2024-05-05T00:00:00Z");
    const id1 = await ingestGalleryAsset("GAL", asset("a.jpg", t), false);
    const id2 = await ingestGalleryAsset("GAL", asset("a.jpg", t + DAY), false);
    expect(id1).toBe(id2);
    expect((db.prepare("SELECT COUNT(*) c FROM library_items WHERE library_id = 'GAL'").get() as { c: number }).c).toBe(1);
  });

  it("filters the timeline by kind", async () => {
    const t = Date.parse("2024-06-01T00:00:00Z");
    await ingestGalleryAsset("GAL", asset("a.jpg", t), false);
    await ingestGalleryAsset("GAL", asset("clip.mp4", t + 1000), false);

    const photos = queryGalleryTimeline("u1", ["GAL"], { q: "", kinds: ["photo"], limit: 50, offset: 0 });
    expect(photos.assets.map((a) => a.kind)).toEqual(["photo"]);
    const videos = queryGalleryTimeline("u1", ["GAL"], { q: "", kinds: ["video"], limit: 50, offset: 0 });
    expect(videos.assets.map((a) => a.kind)).toEqual(["video"]);
  });
});

describe("gallery folder view", () => {
  beforeEach(async () => {
    const t = Date.parse("2024-01-01T00:00:00Z");
    await ingestGalleryAsset("GAL", asset("root.jpg", t), false);
    await ingestGalleryAsset("GAL", asset("2024/spring/x.jpg", t + DAY), false);
    await ingestGalleryAsset("GAL", asset("2024/spring/y.jpg", t + 2 * DAY), false);
    await ingestGalleryAsset("GAL", asset("2024/summer/z.jpg", t + 3 * DAY), false);
  });

  it("lists immediate subfolders with counts and the assets in the current folder", () => {
    const root = queryGalleryFolders("u1", ["GAL"], "", 100, 0);
    expect(root.folders.map((f) => f.name)).toEqual(["2024"]);
    expect(root.folders[0].assetCount).toBe(3); // whole subtree
    expect(root.assets.map((a) => a.title)).toEqual(["root.jpg"]);

    const y2024 = queryGalleryFolders("u1", ["GAL"], "2024", 100, 0);
    expect(y2024.folders.map((f) => f.name)).toEqual(["spring", "summer"]);
    expect(y2024.assets).toHaveLength(0); // no files directly in 2024/

    const spring = queryGalleryFolders("u1", ["GAL"], "2024/spring", 100, 0);
    expect(spring.folders).toHaveLength(0);
    expect(spring.assets.map((a) => a.title).sort()).toEqual(["x.jpg", "y.jpg"]);
  });
});

describe("gallery manual edits", () => {
  it("keeps a hand-edited title, date, and tags across a rescan", async () => {
    const id = await ingestGalleryAsset("GAL", asset("a.jpg", Date.parse("2024-02-02T00:00:00Z")), false);
    updateGalleryAsset(id, {
      title: "Sunset at the lake",
      description: "Golden hour",
      takenAt: "2019-07-04T18:30:00.000Z",
      tags: ["vacation", "lake"]
    });

    // A rescan sees the file as changed (new mtime) and re-ingests it.
    await ingestGalleryAsset("GAL", asset("a.jpg", Date.parse("2024-09-09T00:00:00Z")), false);

    const { assets } = queryGalleryTimeline("u1", ["GAL"], { q: "", kinds: [], limit: 50, offset: 0 });
    const row = assets.find((a) => a.id === id)!;
    expect(row.title).toBe("Sunset at the lake");
    expect(row.description).toBe("Golden hour");
    expect(row.takenAt).toBe("2019-07-04T18:30:00.000Z"); // manual date preserved, not the mtime
    expect(row.tags.sort()).toEqual(["lake", "vacation"]);
  });
});

describe("gallery access scoping", () => {
  it("hides a private gallery from a user with no grant", async () => {
    // A second gallery with NO Everyone grant — private to its members.
    makeLibrary("PRIV", { createdBy: "u1", type: "gallery" });
    grant("user", "u1", "PRIV", "manager");
    await ingestGalleryAsset("PRIV", asset("secret.jpg", Date.now()), false);
    makeUser("u2");

    const owner = resolveGalleryScopeLibraryIds({ id: "u1", role: "member" }, "all");
    expect(owner).toContain("PRIV");

    const stranger = resolveGalleryScopeLibraryIds({ id: "u2", role: "member" }, "all");
    expect(stranger).not.toContain("PRIV");
    expect(queryGalleryTimeline("u2", stranger, { q: "", kinds: [], limit: 50, offset: 0 }).total).toBe(0);
  });

  it("reports kind facets for the scoped libraries", async () => {
    const t = Date.now();
    await ingestGalleryAsset("GAL", asset("a.jpg", t), false);
    await ingestGalleryAsset("GAL", asset("b.mp4", t), false);
    const facets = galleryFacets(["GAL"]);
    expect(facets.kinds.find((k) => k.kind === "photo")?.count).toBe(1);
    expect(facets.kinds.find((k) => k.kind === "video")?.count).toBe(1);
  });
});

describe("gallery map points", () => {
  it("returns only geotagged assets and counts them via the withGps facet", async () => {
    const t = Date.parse("2024-03-03T00:00:00Z");
    const geo = await ingestGalleryAsset("GAL", asset("paris.jpg", t), false);
    await ingestGalleryAsset("GAL", asset("nogps.jpg", t + DAY), false); // no coordinates
    // metaEnabled=false skips EXIF, so set coordinates directly to exercise the query.
    db.prepare("UPDATE gallery_details SET gps_lat = ?, gps_lng = ? WHERE item_id = ?").run(48.8584, 2.2945, geo);

    const { points } = queryGalleryMapPoints(["GAL"], { kinds: [], limit: 100 });
    expect(points.map((p) => p.id)).toEqual([geo]);
    expect(points[0]).toMatchObject({ lat: 48.8584, lng: 2.2945, title: "paris.jpg" });

    expect(galleryFacets(["GAL"]).withGps).toBe(1);
  });

  it("respects the kind filter", async () => {
    const t = Date.now();
    const photo = await ingestGalleryAsset("GAL", asset("p.jpg", t), false);
    const video = await ingestGalleryAsset("GAL", asset("v.mp4", t + 1000), false);
    db.prepare("UPDATE gallery_details SET gps_lat = 1, gps_lng = 1 WHERE item_id IN (?, ?)").run(photo, video);

    const photos = queryGalleryMapPoints(["GAL"], { kinds: ["photo"], limit: 100 });
    expect(photos.points.map((p) => p.id)).toEqual([photo]);
  });
});

describe("gallery rotation", () => {
  const at = Date.parse("2024-02-02T00:00:00Z");
  const rowFor = (id: string) => {
    const { assets } = queryGalleryTimeline("u1", ["GAL"], { q: "", kinds: [], limit: 50, offset: 0 });
    return assets.find((a) => a.id === id)!;
  };

  it("defaults rotation to 0 and exposes it on the asset", async () => {
    const id = await ingestGalleryAsset("GAL", asset("a.jpg", at), false);
    expect(rowFor(id).rotation).toBe(0);
  });

  it("swaps the displayed dimensions for a 90/270° rotation, leaving the stored width/height", async () => {
    const id = await ingestGalleryAsset("GAL", asset("a.jpg", at), false);
    db.prepare("UPDATE gallery_details SET width = 400, height = 300, rotation = 90 WHERE item_id = ?").run(id);

    const row = rowFor(id);
    expect(row.rotation).toBe(90);
    expect([row.width, row.height]).toEqual([300, 400]); // swapped for display

    const raw = db.prepare("SELECT width, height FROM gallery_details WHERE item_id = ?").get(id) as { width: number; height: number };
    expect([raw.width, raw.height]).toEqual([400, 300]); // raw dims untouched (rescan recomputes them)
  });

  it("keeps a 180° rotation's dimensions unswapped", async () => {
    const id = await ingestGalleryAsset("GAL", asset("a.jpg", at), false);
    db.prepare("UPDATE gallery_details SET width = 400, height = 300, rotation = 180 WHERE item_id = ?").run(id);
    const row = rowFor(id);
    expect([row.width, row.height]).toEqual([400, 300]);
  });

  it("preserves a user-set rotation across a rescan", async () => {
    const id = await ingestGalleryAsset("GAL", asset("a.jpg", at), false);
    db.prepare("UPDATE gallery_details SET rotation = 270 WHERE item_id = ?").run(id);

    // A rescan sees a changed mtime and re-ingests; the UPSERT must not reset rotation.
    await ingestGalleryAsset("GAL", asset("a.jpg", at + DAY), false);

    expect((db.prepare("SELECT rotation FROM gallery_details WHERE item_id = ?").get(id) as { rotation: number }).rotation).toBe(270);
  });

  it("cache-busts the thumbnail URL so a regenerated image reloads", async () => {
    const id = await ingestGalleryAsset("GAL", asset("a.jpg", at), false);
    db.prepare("UPDATE item_metadata SET cover_storage_key = 'gallery/aa/bb/x-cover.webp' WHERE item_id = ?").run(id);
    expect(rowFor(id).coverUrl).toMatch(/\?v=/);
  });
});
