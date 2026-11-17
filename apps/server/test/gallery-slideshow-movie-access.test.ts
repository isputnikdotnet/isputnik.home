// A slideshow's rendered movie has every photo baked in and cannot leave one out,
// so on the website, as on a TV, it plays only for someone who may see every photo
// in it (and for its creator and admins). Seeing ONE photo was once enough: a
// member who saw a single photo of a slideshow could play or download the movie,
// photos from libraries they cannot open included.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { addSlideshowItems, createSlideshow } from "../src/modules/library/gallery/slideshows.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { gallerySlideshowRoutesPlugin } from "../src/modules/library/gallery/slideshow-routes.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { bootApp, type BootedApp, type TestSession } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

function asset(relativePath: string) {
  const extension = `.${relativePath.split(".").pop()}`;
  return { absolutePath: `/src/x/${relativePath}`, relativePath, fileName: relativePath, extension, kind: kindForExtension(extension)!, size: 1000, modifiedAtMs: Date.parse("2024-01-01T10:00:00Z") };
}

let booted: BootedApp;
let admin: TestSession;
let dad: TestSession;
let store = "";
let whole = "";   // every photo in a library Dad can open
let partly = "";  // one photo Dad can open, one he cannot

beforeEach(async () => {
  resetDb();
  store = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-movie-"));
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, store);
  fs.mkdirSync(path.join(store, "slideshows"), { recursive: true });
  fs.writeFileSync(path.join(store, "slideshows", "movie.mp4"), "mp4-bytes");

  makeUser("admin", "admin");
  makeUser("dad", "member");
  makeLibrary("FAM", { createdBy: "admin", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "FAM", "member");
  makeLibrary("PRIV", { createdBy: "admin", type: "gallery" });
  grant("user", "admin", "PRIV", "manager");
  const open = (await ingestGalleryAsset("FAM", asset("a.jpg"), false))!;
  const second = (await ingestGalleryAsset("FAM", asset("b.jpg"), false))!;
  const hidden = (await ingestGalleryAsset("PRIV", asset("p.jpg"), false))!;
  const everything = new Set(["FAM", "PRIV"]);
  whole = createSlideshow({ id: "admin" }, "Birthday").id;
  addSlideshowItems(whole, everything, [open, second]);
  partly = createSlideshow({ id: "admin" }, "Trip").id;
  addSlideshowItems(partly, everything, [open, hidden]);
  db.prepare("UPDATE gallery_slideshows SET render_status = 'ready', output_storage_key = 'slideshows/movie.mp4', rendered_at = '2024-01-01T00:00:00Z'").run();

  booted = await bootApp({ plugins: [gallerySlideshowRoutesPlugin] });
  admin = await booted.session("admin");
  dad = await booted.session("dad");
});

afterEach(async () => {
  await booted.app.close();
  fs.rmSync(store, { recursive: true, force: true });
});

const detail = async (session: TestSession, id: string) =>
  (await booted.as(session.cookie).get(`/api/library/gallery/slideshows/${id}`)).json().slideshow as { movieUrl: string | null };
const movie = async (session: TestSession, id: string) =>
  (await booted.as(session.cookie).get(`/api/library/gallery/slideshows/${id}/movie`)).statusCode;

describe("a slideshow's movie on the website", () => {
  it("plays for someone who may see every photo in it", async () => {
    expect((await detail(dad, whole)).movieUrl).toContain(`/slideshows/${whole}/movie`);
    expect(await movie(dad, whole)).toBe(200);
  });

  it("is not offered, and does not play, for someone who sees only part of it", async () => {
    // He still sees the slideshow and the photo he may open…
    expect(await detail(dad, partly)).toBeTruthy();
    // …but not the movie that holds the one he may not.
    expect((await detail(dad, partly)).movieUrl).toBeNull();
    expect(await movie(dad, partly)).toBe(404);
  });

  it("plays for its creator and admins", async () => {
    expect((await detail(admin, partly)).movieUrl).not.toBeNull();
    expect(await movie(admin, partly)).toBe(200);
  });
});
