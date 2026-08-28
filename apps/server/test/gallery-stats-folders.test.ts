import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { collectStatusContributions, resetStatusContributors } from "../src/core/status-contributors.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { registerGalleryStats } from "../src/modules/library/gallery/stats.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// The Dashboard's "Folders with most photos" table. The query cuts a folder out
// of a file path with rtrim/replace, because SQLite has no lastIndexOf and doing
// it in JS would mean pulling one row per photo to fill a status card — so what
// the cut actually produces is worth pinning: the immediate folder, never a
// parent rolled up out of its children, and the root when there is no folder.

function asset(relativePath: string, takenAtIso = "2024-03-01T10:00:00Z") {
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

interface FolderRow {
  folder: string;
  libraryName: string;
  photoCount: number;
  videoCount: number;
}

function fullestFolders(): FolderRow[] {
  const status = collectStatusContributions() as {
    galleryStats: { fullestFolders: FolderRow[] };
  };
  return status.galleryStats.fullestFolders;
}

beforeEach(() => {
  resetDb();
  resetStatusContributors();
  registerGalleryStats();
  makeUser("boss", "admin");
  makeLibrary("GAL", { createdBy: "boss", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("gallery stats: fullest folders", () => {
  it("counts the folder a photo sits in, not the parents above it", async () => {
    for (const name of ["a", "b", "c"]) {
      await ingestGalleryAsset("GAL", asset(`2004/wedding/day1/${name}.jpg`), false);
    }
    await ingestGalleryAsset("GAL", asset("2004/wedding/toast.jpg"), false);

    const folders = fullestFolders();
    // "2004" and "2004/wedding" both hold day1's photos underneath them; only the
    // folder each file actually sits in is counted, or the library root would win
    // every list it appeared in.
    expect(folders.map((row) => [row.folder, row.photoCount])).toEqual([
      ["2004/wedding/day1", 3],
      ["2004/wedding", 1]
    ]);
  });

  it("carries the videos beside the photos it ranks on", async () => {
    await ingestGalleryAsset("GAL", asset("trip/one.jpg"), false);
    await ingestGalleryAsset("GAL", asset("trip/two.jpg"), false);
    await ingestGalleryAsset("GAL", asset("trip/clip.mp4"), false);

    expect(fullestFolders()).toEqual([
      expect.objectContaining({ folder: "trip", photoCount: 2, videoCount: 1, libraryName: "GAL" })
    ]);
  });

  it("leaves out a folder with no photos in it at all", async () => {
    await ingestGalleryAsset("GAL", asset("clips/only.mp4"), false);
    await ingestGalleryAsset("GAL", asset("snaps/one.jpg"), false);

    expect(fullestFolders().map((row) => row.folder)).toEqual(["snaps"]);
  });

  it("groups a file with no folder under the library root", async () => {
    await ingestGalleryAsset("GAL", asset("loose.jpg"), false);

    expect(fullestFolders()).toEqual([
      expect.objectContaining({ folder: "", photoCount: 1, libraryName: "GAL" })
    ]);
  });

  it("keeps two libraries' same-named folders apart", async () => {
    makeLibrary("GAL2", { createdBy: "boss", type: "gallery" });
    grant("group", EVERYONE_GROUP_ID, "GAL2", "member");
    await ingestGalleryAsset("GAL", asset("2004/a.jpg"), false);
    await ingestGalleryAsset("GAL2", asset("2004/b.jpg"), false);
    await ingestGalleryAsset("GAL2", asset("2004/c.jpg"), false);

    expect(fullestFolders().map((row) => [row.libraryName, row.folder, row.photoCount])).toEqual([
      ["GAL2", "2004", 2],
      ["GAL", "2004", 1]
    ]);
  });

  it("forgets a photo that has been trashed", async () => {
    await ingestGalleryAsset("GAL", asset("trip/one.jpg"), false);
    await ingestGalleryAsset("GAL", asset("trip/two.jpg"), false);
    db.prepare("UPDATE library_items SET deleted_at = datetime('now') WHERE folder_path = ?").run("trip/two.jpg");

    expect(fullestFolders()).toEqual([expect.objectContaining({ folder: "trip", photoCount: 1 })]);
  });
});
