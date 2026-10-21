import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { galleryPeopleRoutesPlugin } from "../src/modules/library/gallery/people-routes.js";
import { createGalleryPerson, listGalleryPeople } from "../src/modules/library/gallery/people.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

// POST /api/library/gallery/assets/bulk-people: one person onto a whole
// selection from the multi-select bar. The single route's body over many ids —
// the person is resolved once (a new name becomes ONE person), permission is
// checked per photo and refused ones are counted rather than fatal, and
// re-tagging is a no-op, as it is for one photo.

function makePhoto(libraryId: string, id: string): void {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, 'gallery', ?, 'ready', '2020-01-01T00:00:00.000Z')"
  ).run(id, libraryId, `${id}.jpg`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 9)").run(id, `${id}.jpg`);
}

const manualTags = (personId: string): string[] =>
  (db.prepare("SELECT item_id FROM gallery_faces WHERE person_id = ? AND source = 'manual' ORDER BY item_id").all(personId) as { item_id: string }[])
    .map((row) => row.item_id);

describe("bulk people tagging", () => {
  let app: FastifyInstance;
  let booted: BootedApp;

  beforeEach(async () => {
    resetDb();
    makeUser("admin", "admin");
    makeUser("editor", "member");
    makeUser("reader", "member");
    makeLibrary("gal", { createdBy: "admin", type: "gallery" });
    makeLibrary("locked", { createdBy: "admin", type: "gallery" });
    grant("group", EVERYONE_GROUP_ID, "gal", "member");
    grant("group", EVERYONE_GROUP_ID, "locked", "member");
    grant("user", "editor", "gal", "contributor");
    makePhoto("gal", "p1");
    makePhoto("gal", "p2");
    makePhoto("locked", "p3");
    booted = await bootApp({ plugins: [galleryPeopleRoutesPlugin] });
    app = booted.app;
  });
  afterEach(async () => { await app.close(); });

  const as = async (userId: string) => booted.as(await booted.signIn(userId));

  it("creates a new name once and puts it on every writable photo, counting the rest", async () => {
    const editor = await as("editor");
    const res = await editor.post("/api/library/gallery/assets/bulk-people", { ids: ["p1", "p2", "p3", "missing"], name: "Grandma" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { updated: number; forbidden: number; person: { id: string; name: string } };
    expect(body).toMatchObject({ updated: 2, forbidden: 2, person: { name: "Grandma" } });

    const people = listGalleryPeople(["gal", "locked"], true);
    expect(people.map((p) => p.name)).toEqual(["Grandma"]);
    expect(people[0].faceCount).toBe(2);
    expect(manualTags(body.person.id)).toEqual(["p1", "p2"]);
  });

  it("links a name to the existing person, whatever the case, and re-tagging changes nothing", async () => {
    const grandma = createGalleryPerson("Grandma");
    const editor = await as("editor");
    expect((await editor.post("/api/library/gallery/assets/bulk-people", { ids: ["p1"], name: "grandma" })).json())
      .toMatchObject({ updated: 1, forbidden: 0, person: { id: grandma.id } });
    expect((await editor.post("/api/library/gallery/assets/bulk-people", { ids: ["p1", "p2"], personId: grandma.id })).json())
      .toMatchObject({ updated: 2, forbidden: 0 });
    expect(listGalleryPeople(["gal"], true)).toHaveLength(1);
    expect(manualTags(grandma.id)).toEqual(["p1", "p2"]);
  });

  it("refuses an unknown person, and creates nobody when nothing is writable", async () => {
    const editor = await as("editor");
    expect((await editor.post("/api/library/gallery/assets/bulk-people", { ids: ["p1"], personId: "nope" })).statusCode).toBe(404);

    const reader = await as("reader");
    const res = await reader.post("/api/library/gallery/assets/bulk-people", { ids: ["p1", "p2"], name: "Nobody" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ updated: 0, forbidden: 2, person: null });
    expect(listGalleryPeople(["gal"], true)).toHaveLength(0);
  });

  it("rejects a body with neither a person nor a name, or too many ids", async () => {
    const editor = await as("editor");
    expect((await editor.post("/api/library/gallery/assets/bulk-people", { ids: ["p1"] })).statusCode).toBe(400);
    const ids = Array.from({ length: 201 }, (_, i) => `x${i}`);
    expect((await editor.post("/api/library/gallery/assets/bulk-people", { ids, name: "Too many" })).statusCode).toBe(400);
  });
});
