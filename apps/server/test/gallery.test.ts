import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { updateGalleryAsset } from "../src/modules/library/gallery/edit.js";
import {
  queryGalleryTimeline,
  queryGalleryFolders,
  galleryFacets,
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
