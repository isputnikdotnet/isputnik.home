import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { hashPassword } from "../src/crypto.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { galleryAlbumRoutesPlugin } from "../src/modules/library/gallery/album-routes.js";
import { getAlbum, getAlbumItemIds } from "../src/modules/library/gallery/albums.js";
import { bootApp } from "./helpers/boot.js";
import { grant, makeLibrary, resetDb } from "./helpers/seed.js";

// "Ask someone" from a folder or a selection (docs/for-you-plan.md): the
// photos become an album in one step, named by the sender, which the question
// then rides on. The route is the only new server piece; the rest is Send to.

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;

function makePhoto(libraryId: string, id: string, relativePath: string, takenAt: string): void {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')"
  ).run(id, libraryId, relativePath);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size, taken_at) VALUES (?, 'photo', ?, 9, ?)")
    .run(id, relativePath, takenAt);
}

beforeEach(async () => {
  resetDb();
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('mom', 'mom@test.local', ?, 'mom', 'member')")
    .run(await hashPassword("correct-horse-battery"));
  makeLibrary("gal", { createdBy: "mom", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "gal", "member");
  makeLibrary("private", { createdBy: "mom", type: "gallery" });
  makePhoto("gal", "s2", "Summer 1971/002.jpg", "1971-07-02T00:00:00.000Z");
  makePhoto("gal", "s1", "Summer 1971/001.jpg", "1971-07-01T00:00:00.000Z");
  makePhoto("gal", "s3", "Summer 1971/dacha/003.jpg", "1971-07-03T00:00:00.000Z");
  makePhoto("gal", "w1", "Winter 1971/001.jpg", "1971-12-01T00:00:00.000Z");
  makePhoto("private", "p1", "x/001.jpg", "1971-07-04T00:00:00.000Z");
  ({ app, signIn } = await bootApp({ plugins: [galleryAlbumRoutesPlugin] }));
});

describe("an album from a selection or a folder", () => {
  it("makes the album from the selected photos, in the caller's scope only", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/library/gallery/albums/from",
      headers: { cookie: await signIn("mom") },
      payload: { name: "For Grandma", itemIds: ["s1", "w1", "p1"] }
    });
    expect(response.statusCode).toBe(201);
    const { album } = response.json() as { album: { id: string; name: string; itemCount: number; canEdit: boolean } };
    expect(album).toMatchObject({ name: "For Grandma", itemCount: 2, canEdit: true });
    expect(getAlbum(album.id)?.created_by).toBe("mom");
    expect(new Set(getAlbumItemIds(["gal"], getAlbum(album.id)!))).toEqual(new Set(["s1", "w1"]));
  });

  it("takes a whole folder, subfolders included, in date order", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/library/gallery/albums/from",
      headers: { cookie: await signIn("mom") },
      payload: { name: "Summer 1971", folder: { libraryId: "gal", path: "Summer 1971" } }
    });
    expect(response.statusCode).toBe(201);
    const { album } = response.json() as { album: { id: string; itemCount: number } };
    expect(album.itemCount).toBe(3);
    expect(getAlbumItemIds(["gal"], getAlbum(album.id)!)).toEqual(["s1", "s2", "s3"]);
  });

  it("refuses an empty pick, a folder with nothing in it, and a library the caller cannot see", async () => {
    const cookieHeader = await signIn("mom");
    const empty = await app.inject({ method: "POST", url: "/api/library/gallery/albums/from", headers: { cookie: cookieHeader }, payload: { name: "Nothing" } });
    expect(empty.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/library/gallery/albums/from", headers: { cookie: cookieHeader }, payload: { name: "Nothing", folder: { libraryId: "gal", path: "Spring 1971" } } });
    expect(missing.statusCode).toBe(400);
    db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('guest', 'g@test.local', 'x', 'guest', 'member')").run();
    const unseen = await app.inject({ method: "POST", url: "/api/library/gallery/albums/from", headers: { cookie: await signIn("guest") }, payload: { name: "Nothing", folder: { libraryId: "private", path: "x" } } });
    expect(unseen.statusCode).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_albums").get()).toEqual({ n: 0 });
  });
});
