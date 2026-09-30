import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { setHomeLocation } from "../src/modules/dashboard/home-location.js";
import { galleryRoutesPlugin } from "../src/modules/library/gallery/routes.js";
import {
  SAVED_PLACES_LIMIT,
  canUseSavedPlaces,
  createSavedPlace,
  deleteSavedPlace,
  listRecentPlaces,
  listSavedPlaces,
  recordPlaceUse
} from "../src/modules/library/gallery/saved-places.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

// Saved places (gallery/saved-places.ts): one list of named points for the whole
// household, the Home location copied in once, and each person's recent pins.

const HOME = { lat: 53.90123, lng: 27.55912 };
const DACHA = { lat: 53.95, lng: 27.31 };
/** About 20 m north of HOME: the same place. */
const HOME_YARD = { lat: 53.9014, lng: 27.55912 };

function makePhoto(libraryId: string, id: string): void {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, 'gallery', ?, 'ready', '2020-01-01T00:00:00.000Z')"
  ).run(id, libraryId, `${id}.jpg`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 9)").run(id, `${id}.jpg`);
}

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("editor", "member");
  makeUser("reader", "member");
  makeLibrary("gal", { createdBy: "admin", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "gal", "member");
  grant("user", "editor", "gal", "contributor");
});

describe("who is offered the list", () => {
  it("is anyone who can edit photos in a gallery library, and admins", () => {
    expect(canUseSavedPlaces({ id: "admin", role: "admin" })).toBe(true);
    expect(canUseSavedPlaces({ id: "editor", role: "member" })).toBe(true);
    expect(canUseSavedPlaces({ id: "reader", role: "member" })).toBe(false);
  });

  it("does not count the edit right in a library of another type", () => {
    makeLibrary("books", { createdBy: "admin", type: "audiobook" });
    grant("user", "reader", "books", "contributor");
    expect(canUseSavedPlaces({ id: "reader", role: "member" })).toBe(false);
  });
});

describe("the list", () => {
  it("keeps a place by name and refuses the same name twice, whatever the case", () => {
    const place = createSavedPlace({ name: "  Dacha ", ...DACHA }, "editor");
    expect(place).toMatchObject({ name: "Dacha", lat: DACHA.lat, lng: DACHA.lng, home: false, useCount: 0 });
    expect(() => createSavedPlace({ name: "dacha", lat: 1, lng: 2 }, "editor")).toThrow(/already a saved place/);
    expect(listSavedPlaces().map((p) => p.name)).toEqual(["Dacha"]);
  });

  it("stops at its limit", () => {
    for (let i = 0; i < SAVED_PLACES_LIMIT; i += 1) createSavedPlace({ name: `Place ${i}`, lat: i, lng: i }, "editor");
    expect(() => createSavedPlace({ name: "One more", lat: 60, lng: 60 }, "editor")).toThrow(/Delete one/);
  });

  it("puts the most used place first", () => {
    createSavedPlace({ name: "Apartment", ...HOME }, "editor");
    createSavedPlace({ name: "Dacha", ...DACHA }, "editor");
    recordPlaceUse("editor", DACHA);
    recordPlaceUse("admin", DACHA);
    recordPlaceUse("editor", HOME);
    expect(listSavedPlaces().map((p) => [p.name, p.useCount])).toEqual([["Dacha", 2], ["Apartment", 1]]);
  });
});

describe("the Home location", () => {
  it("is copied in once, the first time the list is read with a home set", () => {
    expect(listSavedPlaces()).toEqual([]);
    setHomeLocation({ latitude: HOME.lat, longitude: HOME.lng, label: "" }, "admin");
    const [home] = listSavedPlaces();
    expect(home).toMatchObject({ name: "", home: true, lat: HOME.lat, lng: HOME.lng });
    expect(listSavedPlaces()).toHaveLength(1);
  });

  it("takes the setting's label as its name", () => {
    setHomeLocation({ latitude: HOME.lat, longitude: HOME.lng, label: "Our flat" }, "admin");
    expect(listSavedPlaces()[0]).toMatchObject({ name: "Our flat", home: true });
  });

  it("stays deleted, and does not follow a later change of the setting", () => {
    setHomeLocation({ latitude: HOME.lat, longitude: HOME.lng, label: "" }, "admin");
    const [home] = listSavedPlaces();
    expect(deleteSavedPlace(home.id)).not.toBeNull();
    setHomeLocation({ latitude: 10, longitude: 10, label: "" }, "admin");
    expect(listSavedPlaces()).toEqual([]);
  });

  it("is not copied over a place someone already saved on the same spot", () => {
    createSavedPlace({ name: "Home sweet home", ...HOME_YARD }, "editor");
    setHomeLocation({ latitude: HOME.lat, longitude: HOME.lng, label: "" }, "admin");
    expect(listSavedPlaces().map((p) => p.name)).toEqual(["Home sweet home"]);
  });
});

describe("recent places", () => {
  it("are each person's own, newest first, one row per spot", () => {
    recordPlaceUse("editor", DACHA, "Ratomka, Belarus");
    recordPlaceUse("editor", HOME);
    // used_at is to the millisecond: make the first two plainly older.
    db.prepare("UPDATE gallery_recent_places SET used_at = '2026-01-01T00:00:00.000Z'").run();
    recordPlaceUse("editor", DACHA);
    recordPlaceUse("admin", { lat: 1, lng: 1 }, "Elsewhere");
    expect(listRecentPlaces("editor", "en").map((p) => [p.lat, p.label])).toEqual([
      // The label from the first time survives a second pin without one.
      [DACHA.lat, "Ratomka, Belarus"],
      [HOME.lat, null]
    ]);
    expect(listRecentPlaces("admin", "en").map((p) => p.label)).toEqual(["Elsewhere"]);
  });

  it("leave out a spot that is a saved place, and count towards it instead", () => {
    recordPlaceUse("editor", HOME);
    expect(listRecentPlaces("editor", "en")).toHaveLength(1);
    createSavedPlace({ name: "Home", ...HOME }, "editor");
    expect(listRecentPlaces("editor", "en")).toEqual([]);

    recordPlaceUse("editor", HOME_YARD);
    expect(listSavedPlaces()[0].useCount).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_recent_places").get()).toEqual({ n: 1 });
  });

  it("offers five and keeps no more than twelve", () => {
    for (let i = 0; i < 15; i += 1) {
      recordPlaceUse("editor", { lat: i, lng: i }, `Spot ${i}`);
      // used_at is to the millisecond, and order is what is being tested.
      db.prepare("UPDATE gallery_recent_places SET used_at = ? WHERE lat = ?").run(new Date(2026, 0, 1, 0, 0, i).toISOString(), i);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_recent_places").get()).toEqual({ n: 12 });
    expect(listRecentPlaces("editor", "en").map((p) => p.label)).toEqual(["Spot 14", "Spot 13", "Spot 12", "Spot 11", "Spot 10"]);
  });
});

describe("the routes", () => {
  let app: FastifyInstance;
  let booted: BootedApp;

  beforeEach(async () => {
    booted = await bootApp({ plugins: [galleryRoutesPlugin] });
    app = booted.app;
  });
  afterEach(async () => { await app.close(); });

  const as = async (userId: string) => booted.as(await booted.signIn(userId));

  it("read an empty list, not an error, for someone who cannot edit photos", async () => {
    createSavedPlace({ name: "Home", ...HOME }, "editor");
    const res = await (await as("reader")).get("/api/library/gallery/saved-places");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ canSave: false, places: [], recent: [] });
  });

  it("refuse a change from someone who cannot edit photos", async () => {
    const place = createSavedPlace({ name: "Home", ...HOME }, "editor");
    const reader = await as("reader");
    expect((await reader.post("/api/library/gallery/saved-places", { name: "Mine", lat: 1, lng: 1 })).statusCode).toBe(403);
    expect((await reader.patch(`/api/library/gallery/saved-places/${place.id}`, { name: "Mine" })).statusCode).toBe(403);
    expect((await reader.delete(`/api/library/gallery/saved-places/${place.id}`)).statusCode).toBe(403);
    expect(listSavedPlaces().map((p) => p.name)).toEqual(["Home"]);
  });

  it("save, rename and delete one list for everyone who can", async () => {
    const editor = await as("editor");
    const created = await editor.post("/api/library/gallery/saved-places", { name: "Dacha", ...DACHA });
    expect(created.statusCode).toBe(201);
    const { place } = created.json() as { place: { id: string } };

    expect((await editor.post("/api/library/gallery/saved-places", { name: "DACHA", lat: 1, lng: 1 })).statusCode).toBe(409);
    expect((await editor.post("/api/library/gallery/saved-places", { name: " ", lat: 1, lng: 1 })).statusCode).toBe(400);
    expect((await editor.post("/api/library/gallery/saved-places", { name: "Pole", lat: 91, lng: 1 })).statusCode).toBe(400);

    // The admin reads and renames what the editor saved.
    const admin = await as("admin");
    expect((await admin.get("/api/library/gallery/saved-places")).json()).toMatchObject({ canSave: true, places: [{ name: "Dacha" }] });
    const renamed = await admin.patch(`/api/library/gallery/saved-places/${place.id}`, { name: "Summer house" });
    expect(renamed.json()).toMatchObject({ place: { id: place.id, name: "Summer house" } });

    expect((await editor.delete(`/api/library/gallery/saved-places/${place.id}`)).json()).toEqual({ deleted: true });
    expect((await editor.delete(`/api/library/gallery/saved-places/${place.id}`)).statusCode).toBe(404);
    expect((await editor.patch(`/api/library/gallery/saved-places/${place.id}`, { name: "Gone" })).statusCode).toBe(404);
  });

  it("remember where a photo was pinned, and leave the pin when the place is deleted", async () => {
    makePhoto("gal", "p1");
    makePhoto("gal", "p2");
    const editor = await as("editor");

    const bulk = await editor.post("/api/library/gallery/assets/bulk-place-time", { ids: ["p1"], gps: DACHA, gpsLabel: "Ratomka, Belarus" });
    expect(bulk.json()).toMatchObject({ updated: 1 });
    expect((await editor.get("/api/library/gallery/saved-places")).json()).toMatchObject({
      recent: [{ lat: DACHA.lat, lng: DACHA.lng, label: "Ratomka, Belarus" }]
    });

    const place = createSavedPlace({ name: "Home", ...HOME }, "editor");
    const one = await editor.patch("/api/library/gallery/assets/p2", { title: "p2", tags: [], gps: HOME });
    expect(one.statusCode).toBe(200);
    expect(listSavedPlaces()[0]).toMatchObject({ name: "Home", useCount: 1 });

    deleteSavedPlace(place.id);
    expect(db.prepare("SELECT gps_lat, gps_lng FROM gallery_details WHERE item_id = 'p2'").get()).toEqual({ gps_lat: HOME.lat, gps_lng: HOME.lng });
  });

  it("remember nothing for an edit that set no location, or changed no photo", async () => {
    makePhoto("gal", "p1");
    const editor = await as("editor");
    await editor.patch("/api/library/gallery/assets/p1", { title: "Renamed", tags: [] });
    await editor.post("/api/library/gallery/assets/bulk-place-time", { ids: ["nope"], gps: DACHA });
    expect(db.prepare("SELECT COUNT(*) AS n FROM gallery_recent_places").get()).toEqual({ n: 0 });
  });
});
