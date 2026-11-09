// Photos on the TV (modules/library/gallery/tv-picks.ts, docs/tv-photos-plan.md): a
// controlled view. Only slideshows and albums an admin put on the list reach a TV, each
// for an audience of viewing profiles; the person's own access still applies; a rendered
// movie plays only when the viewer may see every photo in it; and a linked TV may read
// nothing else in the gallery.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { setSections, ALL_SECTIONS_ON } from "../src/core/sections.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { addAlbumItems, createAlbum } from "../src/modules/library/gallery/albums.js";
import { addSlideshowItems, createSlideshow } from "../src/modules/library/gallery/slideshows.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { galleryTvRoutesPlugin, tvGalleryRefusal } from "../src/modules/library/gallery/tv-picks.js";
import { profilesPlugin } from "../src/modules/profiles/index.js";
import { bootApp, type BootedApp, type TestSession } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

function asset(relativePath: string) {
  const extension = `.${relativePath.split(".").pop()}`;
  return { absolutePath: `/src/x/${relativePath}`, relativePath, fileName: relativePath, extension, kind: kindForExtension(extension)!, size: 1000, modifiedAtMs: Date.parse("2024-01-01T10:00:00Z") };
}

let booted: BootedApp;
let admin: TestSession;
let dadTv: TestSession;
let kidsId: string;
let openId: string;
let birthday: string;
let trip: string;
let secrets: string;
let privatePhoto: string;
let openPhoto: string;

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("dad", "member");
  makeLibrary("FAM", { createdBy: "admin", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "FAM", "member");
  makeLibrary("PRIV", { createdBy: "admin", type: "gallery" });
  grant("user", "admin", "PRIV", "manager");
  openPhoto = (await ingestGalleryAsset("FAM", asset("a.jpg"), false))!;
  const second = (await ingestGalleryAsset("FAM", asset("b.jpg"), false))!;
  privatePhoto = (await ingestGalleryAsset("PRIV", asset("p.jpg"), false))!;
  const everything = new Set(["FAM", "PRIV"]);

  birthday = createSlideshow({ id: "admin" }, "Grandma's birthday").id;
  addSlideshowItems(birthday, everything, [openPhoto, second]);
  // A slideshow holding one photo Dad can't open: its movie must never play for him.
  trip = createSlideshow({ id: "admin" }, "Trip").id;
  addSlideshowItems(trip, everything, [openPhoto, privatePhoto]);
  db.prepare("UPDATE gallery_slideshows SET render_status = 'ready', output_storage_key = 'x.mp4' WHERE id IN (?, ?)").run(birthday, trip);
  secrets = createAlbum({ id: "admin" }, "Secrets", null).id;
  addAlbumItems(secrets, everything, [privatePhoto]);

  booted = await bootApp({
    plugins: [profilesPlugin, galleryTvRoutesPlugin],
    afterRegister: (app: FastifyInstance) => {
      // Stand-ins for the gallery's own routes, so the fence in front of them is tested.
      for (const path of ["/api/library/gallery/albums/:id", "/api/library/gallery/slideshows/:id", "/api/library/gallery/slideshows/:id/movie", "/api/library/gallery/assets/:id/file", "/api/library/gallery/timeline", "/api/library/gallery/albums"]) {
        app.get(path, { preHandler: app.authenticate }, async () => ({ ok: true }));
      }
    }
  });
  admin = await booted.session("admin");
  dadTv = await booted.session("dad", { kind: "device" });
  kidsId = (await booted.as(admin.cookie).post("/api/profiles", { name: "Kids", avatar: "green", restricted: true })).json().profile.id;
  openId = (await booted.as(admin.cookie).post("/api/profiles", { name: "Russian", avatar: "red" })).json().profile.id;
});

afterEach(async () => {
  await booted.app.close();
  setSections(ALL_SECTIONS_ON, "admin");
});

const put = (body: unknown) => booted.as(admin.cookie).post("/api/library/gallery/tv/picks", body as never);
const tv = async (session = dadTv) => (await booted.as(session.cookie).get("/api/library/gallery/tv")).json().items as { name: string; kind: string; itemCount: number; movie?: boolean }[];
const wear = (profileId: string | null, session = dadTv) => booted.as(session.cookie).post("/api/profiles/switch", { profileId });

describe("the On TV list", () => {
  it("is an admin's to build, and only slideshows and albums go on it", async () => {
    const added = await put({ slideshowId: birthday });
    expect(added.statusCode).toBe(201);
    expect(added.json().picks).toEqual([expect.objectContaining({ kind: "slideshow", refId: birthday, name: "Grandma's birthday", audience: "grownups" })]);
    expect((await put({ slideshowId: birthday })).statusCode).toBe(409);
    expect((await put({ albumId: "nope" })).statusCode).toBe(404);
    expect((await put({})).statusCode).toBe(400);
    const member = await booted.session("dad");
    expect((await booted.as(member.cookie).post("/api/library/gallery/tv/picks", { albumId: secrets })).statusCode).toBe(403);
    expect((await booted.as(dadTv.cookie).post("/api/library/gallery/tv/picks", { albumId: secrets })).statusCode).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'gallery.tv.added'").get()).toEqual({ n: 1 });
  });

  it("keeps its order, takes things off, and loses what's deleted", async () => {
    await put({ slideshowId: birthday, audience: "everyone" });
    await put({ slideshowId: trip, audience: "everyone" });
    const picks = (await booted.as(admin.cookie).get("/api/library/gallery/tv/picks")).json().picks as { id: string }[];
    await booted.as(admin.cookie).put("/api/library/gallery/tv/picks/order", { ids: [picks[1].id, picks[0].id] });
    expect((await tv()).map((item) => item.name)).toEqual(["Trip", "Grandma's birthday"]);
    await booted.as(admin.cookie).delete(`/api/library/gallery/tv/picks/${picks[1].id}`);
    expect((await tv()).map((item) => item.name)).toEqual(["Grandma's birthday"]);
    db.prepare("DELETE FROM gallery_slideshows WHERE id = ?").run(birthday);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tv_photo_picks").get()).toEqual({ n: 0 });
  });
});

describe("what a TV shows", () => {
  it("follows each pick's audience", async () => {
    await put({ slideshowId: birthday, audience: "grownups" });
    await put({ slideshowId: trip, audience: "chosen", profileIds: [kidsId, "nonsense"] });
    expect((await tv()).map((item) => item.name)).toEqual(["Grandma's birthday"]);
    await wear(openId);
    expect((await tv()).map((item) => item.name)).toEqual(["Grandma's birthday"]);
    await wear(kidsId);
    expect((await tv()).map((item) => item.name)).toEqual(["Trip"]);
    const picks = (await booted.as(admin.cookie).get("/api/library/gallery/tv/picks")).json().picks;
    expect(picks[1].profileIds).toEqual([kidsId]);
    // "Without a profile" is a choice of its own.
    await booted.as(admin.cookie).patch(`/api/library/gallery/tv/picks/${picks[1].id}`, { audience: "chosen", profileIds: [""] });
    await wear(null);
    expect((await tv()).map((item) => item.name)).toEqual(["Grandma's birthday", "Trip"]);
  });

  it("counts only the viewer's photos, and leaves out what they see nothing of", async () => {
    await put({ slideshowId: trip, audience: "everyone" });
    await put({ albumId: secrets, audience: "everyone" });
    expect(await tv()).toEqual([expect.objectContaining({ name: "Trip", itemCount: 1 })]);
    const adminTv = await booted.session("admin", { kind: "device" });
    expect((await tv(adminTv)).map((item) => [item.name, item.itemCount])).toEqual([["Trip", 2], ["Secrets", 1]]);
  });

  it("offers a slideshow's movie only to someone who may see every photo in it", async () => {
    await put({ slideshowId: birthday, audience: "everyone" });
    await put({ slideshowId: trip, audience: "everyone" });
    expect((await tv()).map((item) => [item.name, item.movie])).toEqual([["Grandma's birthday", true], ["Trip", false]]);
    const adminTv = await booted.session("admin", { kind: "device" });
    expect((await tv(adminTv)).map((item) => item.movie)).toEqual([true, true]);
  });

  it("is empty while the household's Photos are switched off", async () => {
    await put({ slideshowId: birthday, audience: "everyone" });
    setSections({ ...ALL_SECTIONS_ON, gallery: false }, "admin");
    expect(await tv()).toEqual([]);
  });
});

describe("the fence for a linked TV", () => {
  const get = (url: string, session = dadTv) => booted.as(session.cookie).get(url);

  it("lets a TV read only what's on its list", async () => {
    await put({ slideshowId: birthday, audience: "everyone" });
    await put({ slideshowId: trip, audience: "everyone" });
    expect((await get(`/api/library/gallery/slideshows/${birthday}`)).statusCode).toBe(200);
    expect((await get(`/api/library/gallery/slideshows/${birthday}/movie`)).statusCode).toBe(200);
    // On the list, but its movie holds a photo Dad can't open.
    expect((await get(`/api/library/gallery/slideshows/${trip}`)).statusCode).toBe(200);
    expect((await get(`/api/library/gallery/slideshows/${trip}/movie`)).statusCode).toBe(403);
    expect((await get(`/api/library/gallery/assets/${openPhoto}/file`)).statusCode).toBe(200);
    // Not on the list: the album, its photo, the timeline, the album list.
    expect((await get(`/api/library/gallery/albums/${secrets}`)).statusCode).toBe(403);
    expect((await get("/api/library/gallery/timeline")).statusCode).toBe(403);
    expect((await get("/api/library/gallery/albums")).statusCode).toBe(403);
  });

  it("follows the profile worn, and leaves browsers alone", async () => {
    await put({ slideshowId: birthday, audience: "grownups" });
    await wear(kidsId);
    expect((await get(`/api/library/gallery/slideshows/${birthday}`)).statusCode).toBe(403);
    const browser = await booted.session("dad");
    expect((await get("/api/library/gallery/timeline", browser)).statusCode).toBe(200);
  });

  it("decides by the path alone", () => {
    const allowed = { slideshows: new Set(["s"]), albums: new Set(["a"]), musics: new Set(["m"]), assets: () => new Set(["p"]), movie: () => false };
    expect(tvGalleryRefusal("/api/video/home", "GET", allowed)).toBeNull();
    expect(tvGalleryRefusal("/api/library/gallery/tv", "GET", allowed)).toBeNull();
    expect(tvGalleryRefusal("/api/library/gallery/albums/a", "GET", allowed)).toBeNull();
    expect(tvGalleryRefusal("/api/library/gallery/albums/a", "PATCH", allowed)).not.toBeNull();
    expect(tvGalleryRefusal("/api/library/gallery/music/m/stream", "GET", allowed)).toBeNull();
    expect(tvGalleryRefusal("/api/library/gallery/music/x/stream", "GET", allowed)).not.toBeNull();
    expect(tvGalleryRefusal("/api/library/gallery/slideshows/s/movie", "GET", allowed)).not.toBeNull();
    expect(tvGalleryRefusal("/api/library/gallery/assets/p", "GET", allowed)).toBeNull();
    expect(tvGalleryRefusal("/api/library/gallery/assets/q/file", "GET", allowed)).not.toBeNull();
  });
});
