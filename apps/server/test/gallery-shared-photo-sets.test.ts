// What a relative may make of photos shared with them by person
// (docs/people-sharing-plan.md): Q3 — their own albums and slideshows, yes; Q4 —
// onward by guest link, no. A member they send an album to sees only the photos
// that member could open anyway.
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { galleryRoutesPlugin } from "../src/modules/library/gallery/routes.js";
import { galleryAlbumRoutesPlugin } from "../src/modules/library/gallery/album-routes.js";
import { gallerySlideshowRoutesPlugin } from "../src/modules/library/gallery/slideshow-routes.js";
import { librarySharesPlugin } from "../src/modules/library/shared/shares/index.js";
import { socialPlugin } from "../src/modules/social/index.js";
import { setPersonGrant } from "../src/modules/library/gallery/people-access.js";
import { bootApp } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;

function photo(id: string, personId: string | null) {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'fam', 'gallery', ?, 'ready')").run(id, `Private/${id}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 1)").run(id, `Private/${id}.jpg`);
  if (personId) db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, assignment, source) VALUES (?, ?, ?, 'confirmed', 'manual')").run(`f-${id}`, id, personId);
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("cousin", "member");
  makeUser("aunt", "member");
  makeUser("uncle", "member");
  makeLibrary("fam", { createdBy: "admin", type: "gallery", ownerId: "admin", ownerType: "user" });
  db.prepare("INSERT INTO gallery_people (id, name) VALUES ('ivan', 'Ivan')").run();
  photo("ivan-1", "ivan");
  photo("ivan-2", "ivan");
  photo("private", null);
  setPersonGrant({ subjectType: "user", subjectId: "cousin" }, "ivan", true, "admin");
  // The aunt was given Ivan too; the uncle nothing.
  setPersonGrant({ subjectType: "user", subjectId: "aunt" }, "ivan", true, "admin");
  ({ app, signIn } = await bootApp({ plugins: [galleryRoutesPlugin, galleryAlbumRoutesPlugin, gallerySlideshowRoutesPlugin, librarySharesPlugin, socialPlugin] }));
});

afterEach(async () => { await app.close(); });

const as = async (user: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: await signIn(user) }, payload });

async function cousinAlbum(): Promise<string> {
  const res = await as("cousin", "POST", "/api/library/gallery/albums/from", { name: "Grandpa", itemIds: ["ivan-1", "ivan-2", "private"] });
  expect(res.statusCode).toBe(201);
  return res.json().album.id as string;
}

describe("Q3: a relative's own albums and slideshows", () => {
  it("take the photos shared with them, and nothing else", async () => {
    const albumId = await cousinAlbum();
    const album = (await as("cousin", "GET", `/api/library/gallery/albums/${albumId}`)).json();
    expect(album.assets.map((a: { id: string }) => a.id).sort()).toEqual(["ivan-1", "ivan-2"]);

    const slideshow = await as("cousin", "POST", "/api/library/gallery/slideshows", { name: "Ivan", itemIds: ["ivan-1", "private"] });
    expect(slideshow.statusCode).toBe(201);
    const count = db.prepare("SELECT COUNT(*) AS n FROM gallery_slideshow_items WHERE slideshow_id = ?").get(slideshow.json().slideshow.id) as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("Q4: onward to members only", () => {
  it("never makes a guest link for them", async () => {
    const albumId = await cousinAlbum();
    // Refused (404: to someone who cannot curate it, the photo is not there to link).
    expect((await as("cousin", "POST", "/api/shares", { bookId: "ivan-1" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await as("cousin", "POST", "/api/shares/album", { albumId })).statusCode).toBe(403);
    // ...nor offers one: the Share link tab is not there.
    const photoSheet = (await as("cousin", "GET", "/api/social/destinations?entityType=gallery&entityId=ivan-1")).json();
    expect(photoSheet.manageLinks).toBe(false);
    const albumSheet = (await as("cousin", "GET", `/api/social/destinations?entityType=gallery_album&entityId=${albumId}`)).json();
    expect(albumSheet.manageLinks).toBe(false);
  });

  it("shows a member sent their album only what that member could see anyway", async () => {
    const albumId = await cousinAlbum();
    for (const to of ["aunt", "uncle"]) {
      expect((await as("cousin", "POST", "/api/shares/album/user", { albumId, userId: to })).statusCode).toBeLessThan(300);
    }
    const auntView = (await as("aunt", "GET", `/api/library/gallery/shared-albums/${albumId}`)).json();
    expect(auntView.items.map((i: { id: string }) => i.id).sort()).toEqual(["ivan-1", "ivan-2"]);
    const uncleView = (await as("uncle", "GET", `/api/library/gallery/shared-albums/${albumId}`)).json();
    expect(uncleView.items).toEqual([]);
    // And the album share opens none of those photos' files for the uncle.
    expect((await as("uncle", "GET", "/api/library/gallery/assets/ivan-1")).statusCode).toBe(404);
  });

  it("still lets a curator make a link from their own libraries", async () => {
    grant("user", "admin", "fam", "manager");
    const res = await as("admin", "POST", "/api/library/gallery/albums/from", { name: "All", itemIds: ["ivan-1", "private"] });
    const albumId = res.json().album.id as string;
    expect((await as("admin", "POST", "/api/shares/album", { albumId })).statusCode).toBe(201);
  });
});
