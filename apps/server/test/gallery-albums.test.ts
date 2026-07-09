import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import {
  createAlbum,
  updateAlbum,
  deleteAlbum,
  addAlbumItems,
  removeAlbumItems,
  listAlbums,
  getAlbum,
  getAlbumItems,
  getAlbumFilePaths,
  canEditAlbum
} from "../src/modules/library/gallery/albums.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(relativePath: string, takenAtIso: string) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`,
    relativePath,
    fileName: relativePath.split("/").pop()!,
    extension,
    kind: kindForExtension(extension)!,
    size: 1000,
    modifiedAtMs: Date.parse(takenAtIso)
  };
}

// creator owns albums; viewer is a plain member; admin is an admin. GAL is open
// to everyone, PRIV only to creator — so PRIV items are invisible to viewer.
const creator = { id: "creator", role: "member" };
const viewer = { id: "viewer", role: "member" };
const admin = { id: "boss", role: "admin" };
const GAL_LIBS = ["GAL", "PRIV"];
let a = "";
let b = "";
let c = "";
let priv = "";

beforeEach(async () => {
  resetDb();
  makeUser("creator");
  makeUser("viewer");
  makeUser("boss", "admin");
  makeLibrary("GAL", { createdBy: "creator", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  makeLibrary("PRIV", { createdBy: "creator", type: "gallery" });
  grant("user", "creator", "PRIV", "manager");
  a = (await ingestGalleryAsset("GAL", asset("a.jpg", "2024-03-01T10:00:00Z"), false))!;
  b = (await ingestGalleryAsset("GAL", asset("b.jpg", "2024-01-01T10:00:00Z"), false))!;
  c = (await ingestGalleryAsset("GAL", asset("c.jpg", "2024-02-01T10:00:00Z"), false))!;
  priv = (await ingestGalleryAsset("PRIV", asset("priv.jpg", "2024-04-01T10:00:00Z"), false))!;
});

describe("album edit rights", () => {
  it("creator and admins can edit; other members cannot", () => {
    const album = createAlbum(creator, "Trip", null);
    expect(canEditAlbum(album, creator)).toBe(true);
    expect(canEditAlbum(album, admin)).toBe(true);
    expect(canEditAlbum(album, viewer)).toBe(false);
  });
});

describe("album membership", () => {
  it("adds accessible items once, skips inaccessible/unknown/duplicates", () => {
    const album = createAlbum(creator, "Trip", null);
    // viewer's accessible set excludes PRIV.
    const viewerLibs = new Set(["GAL"]);
    expect(addAlbumItems(album.id, viewerLibs, [a, b, priv, "nope"])).toEqual({ added: 2, skipped: 2 });
    expect(addAlbumItems(album.id, viewerLibs, [a])).toEqual({ added: 0, skipped: 1 });
    expect(removeAlbumItems(album.id, [a])).toBe(1);
  });

  it("update validates the cover is a member; delete cascades memberships, not photos", () => {
    const album = createAlbum(creator, "Trip", null);
    addAlbumItems(album.id, new Set(["GAL"]), [a]);
    expect(updateAlbum(album.id, { coverItemId: b })).toBe(false); // b not in album
    expect(updateAlbum(album.id, { coverItemId: a })).toBe(true);
    expect(getAlbum(album.id)!.cover_item_id).toBe(a);

    expect(deleteAlbum(album.id)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM gallery_album_items WHERE album_id = ?").get(album.id) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM library_items WHERE id = ?").get(a) as { n: number }).n).toBe(1);
  });
});

describe("album visibility", () => {
  it("hides an effectively-empty album from members but not from its creator or admins", () => {
    const album = createAlbum(creator, "Private stuff", null);
    addAlbumItems(album.id, new Set(GAL_LIBS), [priv]); // only a PRIV item

    // viewer can't see PRIV → zero visible items → hidden.
    expect(listAlbums(viewer, ["GAL"]).map((row) => row.id)).not.toContain(album.id);
    // creator and admin still see it (with their own visible counts).
    expect(listAlbums(creator, GAL_LIBS).map((row) => row.id)).toContain(album.id);
    expect(listAlbums(admin, GAL_LIBS).map((row) => row.id)).toContain(album.id);
  });

  it("counts and covers only the viewer's visible items", () => {
    const album = createAlbum(creator, "Mixed", null);
    addAlbumItems(album.id, new Set(GAL_LIBS), [a, priv]);

    const forViewer = listAlbums(viewer, ["GAL"]).find((row) => row.id === album.id)!;
    expect(forViewer.itemCount).toBe(1);
    expect(forViewer.canEdit).toBe(false);

    const forCreator = listAlbums(creator, GAL_LIBS).find((row) => row.id === album.id)!;
    expect(forCreator.itemCount).toBe(2);
    expect(forCreator.canEdit).toBe(true);
  });
});

describe("album item ordering", () => {
  it("taken_at mode is chronological; manual mode follows append order", () => {
    const album = createAlbum(creator, "Trip", null);
    addAlbumItems(album.id, new Set(["GAL"]), [a, c, b]); // appended in this order

    const byDate = getAlbumItems("creator", ["GAL"], getAlbum(album.id)!, 50, 0);
    expect(byDate.total).toBe(3);
    expect(byDate.assets.map((x) => x.id)).toEqual([b, c, a]); // Jan, Feb, Mar

    updateAlbum(album.id, { sortMode: "manual" });
    const manual = getAlbumItems("creator", ["GAL"], getAlbum(album.id)!, 50, 0);
    expect(manual.assets.map((x) => x.id)).toEqual([a, c, b]);
  });

  it("pages and filters by the viewer's access", () => {
    const album = createAlbum(creator, "Trip", null);
    addAlbumItems(album.id, new Set(GAL_LIBS), [a, b, c, priv]);

    const viewerPage = getAlbumItems("viewer", ["GAL"], getAlbum(album.id)!, 2, 0);
    expect(viewerPage.total).toBe(3); // priv invisible
    expect(viewerPage.assets).toHaveLength(2);

    const rest = getAlbumItems("viewer", ["GAL"], getAlbum(album.id)!, 2, 2);
    expect(rest.assets).toHaveLength(1);
  });
});

describe("album download file paths", () => {
  it("returns viewer-visible files in album sort order with their source paths", () => {
    const album = createAlbum(creator, "Trip", null);
    addAlbumItems(album.id, new Set(GAL_LIBS), [a, c, b, priv]);

    // Viewer can't see PRIV, so its item drops; the rest come back chronologically.
    const forViewer = getAlbumFilePaths(["GAL"], getAlbum(album.id)!);
    expect(forViewer.map((f) => f.relative_path)).toEqual(["b.jpg", "c.jpg", "a.jpg"]);
    expect(forViewer.every((f) => f.source_path.length > 0)).toBe(true);

    // The creator (access to both libraries) also gets the private item.
    const forCreator = getAlbumFilePaths(GAL_LIBS, getAlbum(album.id)!);
    expect(forCreator.map((f) => f.relative_path)).toEqual(["b.jpg", "c.jpg", "a.jpg", "priv.jpg"]);
  });
});
