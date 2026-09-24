// "This is them" (docs/people-sharing-plan.md, Q1): a member linked to their own
// gallery person sees photos of themselves only when "Show them photos of
// themselves" is on — the link alone grants nothing (D12).
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { galleryRoutesPlugin } from "../src/modules/library/gallery/routes.js";
import { galleryPeopleAccessRoutesPlugin } from "../src/modules/library/gallery/people-access-routes.js";
import { mergeGalleryPeople } from "../src/modules/library/gallery/people.js";
import { selfLinkOf } from "../src/modules/library/gallery/people-access.js";
import { bootApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;

function photo(id: string, personId: string) {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'fam', 'gallery', ?, 'ready')").run(id, `Private/${id}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 1)").run(id, `Private/${id}.jpg`);
  db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, assignment, source) VALUES (?, ?, ?, 'confirmed', 'manual')").run(`f-${id}`, id, personId);
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("sam", "member");
  makeUser("anna", "member");
  makeLibrary("fam", { createdBy: "admin", type: "gallery", ownerId: "admin", ownerType: "user" });
  db.prepare("INSERT INTO gallery_people (id, name) VALUES ('sam-face', 'Sam'), ('sam-2', 'Sam (school)'), ('nameless', '')").run();
  photo("me", "sam-face");
  photo("school", "sam-2");
  ({ app, signIn } = await bootApp({ plugins: [galleryRoutesPlugin, galleryPeopleAccessRoutesPlugin] }));
});

afterEach(async () => { await app.close(); });

const link = async (userId: string, personId: string | null, showPhotos: boolean) =>
  app.inject({ method: "PUT", url: `/api/library/gallery/access/user/${userId}/self`, headers: { cookie: await signIn("admin") }, payload: { personId, showPhotos } });

const timelineOf = async (userId: string) => (await app.inject({
  method: "POST", url: "/api/library/gallery/timeline", headers: { cookie: await signIn(userId) }, payload: { q: "", kinds: [], limit: 20, offset: 0 }
})).json().assets.map((a: { id: string }) => a.id);

describe("linking a member to their own gallery person", () => {
  it("grants nothing until Show them photos of themselves is on, and stops when it goes off", async () => {
    expect((await link("sam", "sam-face", false)).json()).toMatchObject({ self: { personId: "sam-face", showPhotos: false } });
    expect(await timelineOf("sam")).toEqual([]);

    await link("sam", "sam-face", true);
    expect(await timelineOf("sam")).toEqual(["me"]);
    // Seen only through the link: redacted like any person grant.
    const asset = (await app.inject({ method: "GET", url: "/api/library/gallery/assets/me", headers: { cookie: await signIn("sam") } })).json().asset;
    expect(asset).toMatchObject({ folderPath: "me.jpg", libraryName: null });

    // The Access dialog lists it with the rest, marked as themselves.
    const access = (await app.inject({ method: "GET", url: "/api/library/gallery/access/user/sam", headers: { cookie: await signIn("admin") } })).json();
    expect(access.self).toMatchObject({ personId: "sam-face", showPhotos: true });
    expect(access.people).toMatchObject([{ id: "sam-face", self: true, direct: false }]);
    expect(access.photoCount).toBe(1);

    await link("sam", null, false);
    expect(await timelineOf("sam")).toEqual([]);
    expect(selfLinkOf("sam")).toBeNull();
  });

  it("takes a named person that is nobody else's", async () => {
    expect((await link("sam", "nameless", true)).statusCode).toBe(404);
    await link("sam", "sam-face", true);
    expect((await link("anna", "sam-face", true)).statusCode).toBe(409);
    const refused = await app.inject({ method: "PUT", url: "/api/library/gallery/access/user/sam/self", headers: { cookie: await signIn("sam") }, payload: { personId: "sam-2", showPhotos: true } });
    expect(refused.statusCode).toBe(403);
    // Who can see photos of Sam says who Sam is.
    const sharing = (await app.inject({ method: "GET", url: "/api/library/gallery/people/sam-face/sharing", headers: { cookie: await signIn("admin") } })).json();
    expect(sharing.self).toMatchObject({ userId: "sam", name: expect.any(String), showPhotos: true });
  });

  it("follows a merge of their face groups", async () => {
    await link("sam", "sam-2", true);
    mergeGalleryPeople("sam-2", "sam-face");
    expect(selfLinkOf("sam")).toMatchObject({ personId: "sam-face", showPhotos: true });
    expect((await timelineOf("sam")).sort()).toEqual(["me", "school"]);
  });
});
