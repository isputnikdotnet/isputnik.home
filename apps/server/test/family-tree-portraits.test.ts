import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { createFamilyPerson, getFamilyPerson, updateFamilyPerson } from "../src/modules/familytree/persons.js";
import {
  canUsePortraitPhoto, frameAroundFace, portraitSourcePhoto, renderPendingPortraits, setPortraitFromPhoto, setUploadedPortraitFile
} from "../src/modules/familytree/portraits.js";
import { UNSCANNED_PHOTOS_SQL } from "../src/modules/library/gallery/faces/queue.js";
import { FACE_EMBEDDING_MODEL } from "../src/modules/library/gallery/faces/model-id.js";
import { setHouseLibrary } from "../src/modules/library/gallery/house-library.js";
import { resolveGalleryBrowseLibraryIds } from "../src/modules/library/gallery/catalog-scope.js";
import { queryGalleryFolders, queryGalleryTimeline } from "../src/modules/library/gallery/catalog.js";
import { thumbnailAbsolutePath, thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";
import "./helpers/media-types.js";

// Portraits everyone can see, and portraits cut from a group photo
// (docs/people-sharing-plan.md, phases 3 and 4).

let base = "";
let photos = "";
let house = "";

// A 400x200 photo, left half red and right half blue — so which part a crop took
// can be read back off the pixels.
async function writePhoto(relative: string): Promise<void> {
  const target = path.join(photos, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const half = (r: number, b: number) => sharp({ create: { width: 200, height: 200, channels: 3, background: { r, g: 0, b } } }).png().toBuffer();
  await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: await half(255, 0), left: 0, top: 0 }, { input: await half(0, 255), left: 200, top: 0 }])
    .jpeg({ quality: 95 })
    .toFile(target);
}

function addPhotoItem(id: string, relative: string, rotation = 0): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'gal', 'gallery', ?, 'ready')").run(id, relative);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, path.basename(relative));
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size, width, height, rotation) VALUES (?, 'photo', ?, 1, 400, 200, ?)").run(id, relative, rotation);
}

async function portraitOf(personId: string) {
  const row = db.prepare("SELECT portrait_storage_key, portrait_item_id, portrait_crop_json, portrait_file_item_id FROM family_tree_persons WHERE id = ?")
    .get(personId) as { portrait_storage_key: string | null; portrait_item_id: string | null; portrait_crop_json: string | null; portrait_file_item_id: string | null };
  const image = row.portrait_storage_key ? await sharp(thumbnailAbsolutePath(row.portrait_storage_key)).raw().toBuffer({ resolveWithObject: true }) : null;
  return { ...row, image };
}

// The average colour of an image, to tell red from blue.
function mostlyRed(image: { data: Buffer; info: sharp.OutputInfo }): boolean {
  let r = 0; let b = 0;
  for (let i = 0; i < image.data.length; i += image.info.channels) { r += image.data[i]; b += image.data[i + 2]; }
  return r > b;
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("cousin", "member");
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-portraits-")));
  photos = path.join(base, "Photos");
  house = path.join(base, "House");
  fs.mkdirSync(photos, { recursive: true });
  fs.mkdirSync(house, { recursive: true });
  fs.mkdirSync(path.join(base, "_thumbs"), { recursive: true });
  db.prepare("DELETE FROM storage_roots").run();
  db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('root1', 'Root', ?, 'admin')").run(base);
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, path.join(base, "_thumbs"));
  // A private photo library: the cousin has no grant on it.
  makeLibrary("gal", { createdBy: "admin", type: "gallery", ownerId: "admin", ownerType: "user" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'gal'").run(photos);
  grant("user", "admin", "gal", "manager");
  makeLibrary("house", { createdBy: "admin", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'house'").run(house);
  await writePhoto("party.jpg");
  addPhotoItem("p1", "party.jpg");
});

afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("a frame around a face", () => {
  it("is square in pixels, the face near the top third, and stays on the photo", () => {
    const frame = frameAroundFace({ x: 0.45, y: 0.3, w: 0.05, h: 0.1 }, 1000, 500);
    expect(frame.w * 1000).toBeCloseTo(frame.h * 500, 5);
    expect(frame.h * 500).toBeCloseTo((0.1 * 500) / 0.45, 5);
    // A face at the very edge still gets a frame that lies inside the photo.
    const edge = frameAroundFace({ x: 0.95, y: 0, w: 0.05, h: 0.2 }, 1000, 500);
    expect(edge.x + edge.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(edge.y).toBeGreaterThanOrEqual(0);
  });
});

describe("a portrait chosen from the gallery", () => {
  it("is rendered into the tree's own storage, so it no longer needs the photo's library", async () => {
    const person = createFamilyPerson({ name: "Ivan" }, "admin");
    const result = await setPortraitFromPhoto(person.id, "p1", null, "admin");
    expect(result.keptInAppFiles).toBe(false);
    const saved = await portraitOf(person.id);
    expect(saved.portrait_item_id).toBe("p1");
    expect(saved.portrait_storage_key).toMatch(/^familytree\//);
    // No linked face: the whole photo.
    expect(saved.portrait_crop_json).toBeNull();
    expect(saved.image?.info).toMatchObject({ width: 400, height: 200 });
    expect(getFamilyPerson(person.id)?.portraitUrl).toContain("/api/library/covers/familytree/");
  });

  it("is cut to the linked face when the photo shows it", async () => {
    db.prepare("INSERT INTO gallery_people (id, name) VALUES ('gp1', 'Ivan')").run();
    db.prepare("INSERT INTO gallery_faces (id, item_id, person_id, box_x, box_y, box_w, box_h, assignment, source) VALUES ('f1', 'p1', 'gp1', 0.8, 0.3, 0.08, 0.2, 'confirmed', 'scan')").run();
    const person = createFamilyPerson({ name: "Ivan" }, "admin");
    updateFamilyPerson(person.id, { galleryPersonId: "gp1" });
    await setPortraitFromPhoto(person.id, "p1", null, "admin");
    const saved = await portraitOf(person.id);
    expect(saved.portrait_crop_json).not.toBeNull();
    expect(saved.image!.info.width).toBe(saved.image!.info.height);
    expect(mostlyRed(saved.image!)).toBe(false);
  });

  it("follows the user's rotation: the frame is on the photo as shown", async () => {
    await writePhoto("turned.jpg");
    addPhotoItem("p2", "turned.jpg", 90);
    const person = createFamilyPerson({ name: "Olga" }, "admin");
    // Turned a quarter clockwise, the 400x200 photo shows 200x400 with red on top.
    await setPortraitFromPhoto(person.id, "p2", { x: 0, y: 0, w: 1, h: 0.5 }, "admin");
    const saved = await portraitOf(person.id);
    expect(saved.image?.info).toMatchObject({ width: 200, height: 200 });
    expect(mostlyRed(saved.image!)).toBe(true);
  });

  it("only from a photo the editor can see", () => {
    expect(canUsePortraitPhoto({ id: "admin", role: "admin" }, "p1")).toBe(true);
    expect(canUsePortraitPhoto({ id: "cousin", role: "member" }, "p1")).toBe(false);
    expect(canUsePortraitPhoto({ id: "admin", role: "admin" }, "missing")).toBe(false);
  });
});

describe("a portrait cut from a group photo", () => {
  it("keeps the crop in App files → Family tree → Portraits, marked derived and never face-scanned", async () => {
    setHouseLibrary("house", "admin");
    const person = createFamilyPerson({ name: "Ivan Petrov" }, "admin");
    const result = await setPortraitFromPhoto(person.id, "p1", { x: 0.5, y: 0, w: 0.5, h: 1 }, "admin");
    expect(result.keptInAppFiles).toBe(true);
    expect(fs.readdirSync(path.join(house, "Family tree", "Portraits"))).toEqual(["Ivan Petrov.jpg"]);
    const saved = await portraitOf(person.id);
    expect(mostlyRed(saved.image!)).toBe(false);
    expect(JSON.parse(saved.portrait_crop_json!)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(getFamilyPerson(person.id)?.portraitCrop).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    const file = db.prepare("SELECT library_id, derived_from_item_id FROM library_items JOIN gallery_details ON gallery_details.item_id = library_items.id WHERE library_items.id = ?")
      .get(saved.portrait_file_item_id) as { library_id: string; derived_from_item_id: string };
    expect(file).toEqual({ library_id: "house", derived_from_item_id: "p1" });
    const unscanned = db.prepare(`SELECT li.id ${UNSCANNED_PHOTOS_SQL}`).all(FACE_EMBEDDING_MODEL, "house");
    expect(unscanned).toEqual([]);
  });

  it("re-cropping bins the old copy and its image; an upload or removal does too", async () => {
    setHouseLibrary("house", "admin");
    const person = createFamilyPerson({ name: "Ivan" }, "admin");
    await setPortraitFromPhoto(person.id, "p1", { x: 0.5, y: 0, w: 0.5, h: 1 }, "admin");
    const first = await portraitOf(person.id);
    await setPortraitFromPhoto(person.id, "p1", { x: 0, y: 0, w: 0.5, h: 1 }, "admin");
    const second = await portraitOf(person.id);
    expect(mostlyRed(second.image!)).toBe(true);
    expect(fs.existsSync(thumbnailAbsolutePath(first.portrait_storage_key!))).toBe(false);
    const binned = () => (db.prepare("SELECT COUNT(*) AS n FROM trashed_items").get() as { n: number }).n;
    const live = (id: string | null) => db.prepare("SELECT 1 FROM library_items WHERE id = ? AND deleted_at IS NULL").get(id) != null;
    expect(binned()).toBe(1);
    expect(live(first.portrait_file_item_id)).toBe(false);
    expect(live(second.portrait_file_item_id)).toBe(true);
    await setUploadedPortraitFile(person.id, null, "admin");
    const cleared = await portraitOf(person.id);
    expect(cleared).toMatchObject({ portrait_storage_key: null, portrait_item_id: null, portrait_crop_json: null, portrait_file_item_id: null });
    expect(binned()).toBe(2);
    expect(live(second.portrait_file_item_id)).toBe(false);
  });
});

describe("portraits chosen before 4.21", () => {
  it("get an image of their own at startup, once", async () => {
    const person = createFamilyPerson({ name: "Ivan" }, "admin");
    db.prepare("UPDATE family_tree_persons SET portrait_item_id = 'p1' WHERE id = ?").run(person.id);
    expect(await renderPendingPortraits()).toBe(1);
    expect((await portraitOf(person.id)).portrait_storage_key).toMatch(/^familytree\//);
    expect(await renderPendingPortraits()).toBe(0);
  });
});

describe("a portrait uploaded straight to the tree", () => {
  it("gets a photo to re-cut from on the first Adjust, kept with the family's uploads", async () => {
    setHouseLibrary("house", "admin");
    const person = createFamilyPerson({ name: "Anna" }, "admin");
    const key = `familytree/${person.id.slice(0, 2)}/${person.id}-portrait-1.jpg`;
    fs.mkdirSync(path.dirname(thumbnailAbsolutePath(key)), { recursive: true });
    fs.copyFileSync(path.join(photos, "party.jpg"), thumbnailAbsolutePath(key));
    await setUploadedPortraitFile(person.id, key, "admin");

    const itemId = await portraitSourcePhoto(person.id);
    expect(fs.readdirSync(path.join(house, "Family tree", "Uploaded portraits"))).toEqual(["Anna.jpg"]);
    // The portrait itself is untouched until a frame is saved; asking again reuses the photo.
    expect(await portraitOf(person.id)).toMatchObject({ portrait_storage_key: key, portrait_item_id: itemId });
    expect(await portraitSourcePhoto(person.id)).toBe(itemId);

    await setPortraitFromPhoto(person.id, itemId, { x: 0, y: 0, w: 0.5, h: 1 }, "admin");
    const saved = await portraitOf(person.id);
    expect(mostlyRed(saved.image!)).toBe(true);
    expect(fs.existsSync(thumbnailAbsolutePath(key))).toBe(false);
  });

  it("says so when there is no portrait, or no App storage", async () => {
    const person = createFamilyPerson({ name: "Anna" }, "admin");
    await expect(portraitSourcePhoto(person.id)).rejects.toMatchObject({ statusCode: 404 });
    db.prepare("UPDATE family_tree_persons SET portrait_storage_key = 'familytree/x/y.jpg' WHERE id = ?").run(person.id);
    await expect(portraitSourcePhoto(person.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("family-tree uploads in the Gallery", () => {
  function houseItem(id: string, folderPath: string, kind = "photo", derivedFrom: string | null = null) {
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'house', 'gallery', ?, 'ready')").run(id, folderPath);
    db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size, derived_from_item_id) VALUES (?, ?, ?, 1, ?)").run(id, kind, folderPath, derivedFrom);
  }

  const timeline = (user: { id: string; role: string }) => {
    const libIds = resolveGalleryBrowseLibraryIds(user);
    return queryGalleryTimeline(user.id, libIds, { q: "", kinds: [], limit: 50, offset: 0 }).assets.map((a) => a.id).sort();
  };

  it("show beside the other photos; what the app made for itself stays out", () => {
    setHouseLibrary("house", "admin");
    const person = createFamilyPerson({ name: "Ivan" }, "admin");
    houseItem("used", "Family tree/2026/2026-09-19/clipping.jpg");
    houseItem("orphan", "Family tree/2026/2026-09-19/spare.jpg");
    houseItem("crop", "Family tree/Portraits/Ivan.jpg", "photo", "used");
    houseItem("voice", "Voice notes/2026/note.weba", "audio");
    db.prepare("INSERT INTO family_tree_photos (person_id, item_id, position) VALUES (?, 'used', 1)").run(person.id);

    // The admin sees every family upload, next to the library they have.
    expect(timeline({ id: "admin", role: "admin" })).toEqual(["orphan", "p1", "used"]);
    // A member with no photo library at all sees the uploads the tree uses.
    expect(timeline({ id: "cousin", role: "member" })).toEqual(["used"]);
    // The folder view has them under Family tree.
    const admin = { id: "admin", role: "admin" };
    const folders = queryGalleryFolders("admin", resolveGalleryBrowseLibraryIds(admin), "", 50, 0).folders.map((f) => f.name);
    expect(folders).toContain("Family tree");
    expect(folders).not.toContain("Voice notes");
  });
});
