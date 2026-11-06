// Photo Sync phase 6 (docs/photo-sync-plan.md): a phone linked to a library its photos
// already sit in (Immich's, read as an ordinary gallery library) sends them without
// anything being stored twice. Linked per phone and per library by an admin; a link
// counts only while the phone's owner can open the library.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { addSyncNetwork } from "../src/modules/library/gallery/sync/networks.js";
import { addPhone } from "../src/modules/library/gallery/sync/devices.js";
import { photoSyncDavPlugin } from "../src/modules/library/gallery/sync/dav.js";
import { photoSyncRoutesPlugin } from "../src/modules/library/gallery/sync/routes.js";
import { linkedTargetsOf, PhoneLinkError, phonesForLibrary, setLibraryPhones } from "../src/modules/library/gallery/sync/links.js";
import { scanSingleGalleryFile } from "../src/modules/library/gallery/scanner.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";
import "./helpers/media-types.js";

const PHONE_IP = "192.168.1.36";

let booted: BootedApp;
let app: FastifyInstance;
let base: string;
let mine: string;
let family: string;
let token: string;
let deviceId: string;

const basic = (password: string) => `Basic ${Buffer.from(`mia@test.local:${password}`).toString("base64")}`;

function put(url: string, payload: Buffer, password = token) {
  return app.inject({
    method: "PUT" as InjectOptions["method"], url, payload, remoteAddress: PHONE_IP,
    headers: { authorization: basic(password), "content-type": "image/jpeg" }
  });
}

async function jpeg(seed: number): Promise<Buffer> {
  const width = 40 + seed * 4;
  const height = 30 + seed * 2;
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = (i * seed) % 256; data[i + 1] = (i * 7 + seed * 31) % 256; data[i + 2] = (i * 3 + seed * 11) % 256;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

/** A photo already in the family library, the way Immich left it there. */
async function inFamily(name: string, body: Buffer): Promise<string> {
  fs.mkdirSync(path.join(family, "2025"), { recursive: true });
  fs.writeFileSync(path.join(family, "2025", name), body);
  return (await scanSingleGalleryFile("family", `2025/${name}`))!;
}

const filesIn = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs); else out.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
};

const recordOf = (clientPath: string) =>
  db.prepare("SELECT item_id FROM photo_sync_files WHERE device_id = ? AND client_path = ?").get(deviceId, clientPath) as { item_id: string | null } | undefined;

beforeEach(async () => {
  resetDb();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "photo-sync-links-"));
  mine = path.join(base, "mine");
  family = path.join(base, "family");
  fs.mkdirSync(mine);
  fs.mkdirSync(family);
  fs.mkdirSync(path.join(base, "thumbs"));
  makeUser("admin", "admin");
  makeUser("mia");
  makeUser("olga");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'admin')").run(fs.realpathSync(base));
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(thumbnailPathSettingKey, path.join(base, "thumbs"));
  makeLibrary("mine", { createdBy: "mia", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ?, personal_user_id = 'mia', owner_id = 'mia', owner_type = 'user' WHERE id = 'mine'").run(mine);
  makeLibrary("family", { createdBy: "admin", type: "gallery" });
  db.prepare("UPDATE libraries SET name = 'Current Phone', source_path = ? WHERE id = 'family'").run(family);
  grant("user", "mia", "family", "member");
  addSyncNetwork("192.168.1.0/24", "Home Wi-Fi", "admin");
  const phone = addPhone({ id: "mia" }, "Mia's phone", null);
  token = phone.raw;
  deviceId = phone.id;
  booted = await bootApp({ csrf: true, plugins: [photoSyncDavPlugin, photoSyncRoutesPlugin] });
  app = booted.app;
});

afterEach(async () => {
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("a phone linked to a library its photos are already in", () => {
  it("records a photo already there against that item and stores nothing", async () => {
    const body = await jpeg(1);
    const familyItem = await inFamily("IMG_0001.jpg", body);
    setLibraryPhones("family", [deviceId], { id: "admin" }, null);
    const res = await put("/dav/Camera/IMG_0001.jpg", body);
    expect(res.statusCode).toBe(201);
    expect(filesIn(mine)).toEqual([]);
    expect(recordOf("/Camera/IMG_0001.jpg")?.item_id).toBe(familyItem);
    // A new photo still goes to the personal library.
    expect((await put("/dav/Camera/IMG_0002.jpg", await jpeg(2))).statusCode).toBe(201);
    expect(filesIn(mine)).toHaveLength(1);
  });

  it("stores the photo when the phone isn't linked", async () => {
    const body = await jpeg(1);
    await inFamily("IMG_0001.jpg", body);
    expect((await put("/dav/Camera/IMG_0001.jpg", body)).statusCode).toBe(201);
    expect(filesIn(mine)).toHaveLength(1);
  });

  it("doesn't bring a photo back after it is deleted from that library", async () => {
    const body = await jpeg(1);
    const familyItem = await inFamily("IMG_0001.jpg", body);
    setLibraryPhones("family", [deviceId], { id: "admin" }, null);
    await put("/dav/Camera/IMG_0001.jpg", body);
    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(familyItem);
    expect((await put("/dav/Camera/IMG_0001.jpg", body)).statusCode).toBe(204);
    expect(filesIn(mine)).toEqual([]);
  });

  it("finds a Live Photo's clip, which rides on its still", async () => {
    const body = await jpeg(3);
    const still = await inFamily("IMG_0003.jpg", await jpeg(4));
    fs.writeFileSync(path.join(family, "2025", "IMG_0003.MOV"), body);
    db.prepare("UPDATE gallery_details SET motion_relative_path = '2025/IMG_0003.MOV', motion_size = ? WHERE item_id = ?").run(body.length, still);
    setLibraryPhones("family", [deviceId], { id: "admin" }, null);
    expect((await put("/dav/Camera/IMG_0003.MOV", body)).statusCode).toBe(201);
    expect(filesIn(mine)).toEqual([]);
    expect(recordOf("/Camera/IMG_0003.MOV")?.item_id).toBe(still);
  });
});

describe("who can be linked", () => {
  it("refuses a phone whose owner can't open the library", () => {
    db.prepare("DELETE FROM assignments WHERE subject_id = 'mia' AND object_id = 'family'").run();
    expect(phonesForLibrary("family")).toEqual([]);
    expect(() => setLibraryPhones("family", [deviceId], { id: "admin" }, null)).toThrow(PhoneLinkError);
  });

  it("stops counting a link when the owner loses access, and keeps it", async () => {
    const body = await jpeg(1);
    await inFamily("IMG_0001.jpg", body);
    setLibraryPhones("family", [deviceId], { id: "admin" }, null);
    db.prepare("DELETE FROM assignments WHERE subject_id = 'mia' AND object_id = 'family'").run();
    expect(linkedTargetsOf(deviceId, { id: "mia", role: "member" })).toEqual([]);
    expect(phonesForLibrary("family")).toEqual([expect.objectContaining({ id: deviceId, linked: true, canOpen: false })]);
    expect((await put("/dav/Camera/IMG_0001.jpg", body)).statusCode).toBe(201);
    expect(filesIn(mine)).toHaveLength(1);
  });

  it("links only shared photo libraries: never a personal or a system one", () => {
    expect(() => setLibraryPhones("mine", [deviceId], { id: "admin" }, null)).toThrow(PhoneLinkError);
    makeLibrary("inbox", { createdBy: "admin", type: "gallery", role: "inbox" });
    expect(() => setLibraryPhones("inbox", [deviceId], { id: "admin" }, null)).toThrow(PhoneLinkError);
  });

  it("drops the link with the phone or the library", () => {
    setLibraryPhones("family", [deviceId], { id: "admin" }, null);
    db.prepare("DELETE FROM libraries WHERE id = 'family'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM photo_sync_library_links").get()).toEqual({ n: 0 });
  });
});

describe("the routes", () => {
  it("lets an admin read and set a library's phones, and logs it", async () => {
    const admin = booted.as(await booted.signIn("admin"));
    const before = await admin.get("/api/photo-sync/libraries/family/phones");
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      syncOn: true,
      phones: [{ id: deviceId, label: "Mia's phone", member: { id: "mia", name: "mia" }, linked: false, canOpen: true }]
    });
    const set = await admin.put("/api/photo-sync/libraries/family/phones", JSON.stringify({ deviceIds: [deviceId] }), { "content-type": "application/json" });
    expect(set.statusCode).toBe(200);
    expect(set.json().phones[0].linked).toBe(true);
    const logged = db.prepare("SELECT detail FROM activity_logs WHERE event = 'photo_sync.linked'").all() as { detail: string }[];
    expect(logged).toEqual([{ detail: "Phone \"Mia's phone\" (mia) now skips photos already in \"Current Phone\"." }]);
    // The admin's phones page and the member's own phone card name the link.
    const overview = (await admin.get("/api/photo-sync/phones")).json();
    expect(overview.phones[0].links).toEqual([{ libraryId: "family", name: "Current Phone", counts: true }]);
    const own = (await booted.as(await booted.signIn("mia")).get("/api/profile/phones")).json();
    expect(own.phones[0].links).toEqual([{ libraryId: "family", name: "Current Phone", counts: true }]);
    // Unlinking.
    await admin.put("/api/photo-sync/libraries/family/phones", JSON.stringify({ deviceIds: [] }), { "content-type": "application/json" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE event = 'photo_sync.unlinked'").get()).toEqual({ n: 1 });
  });

  it("refuses members, a personal library, and a phone that can't be linked", async () => {
    const member = booted.as(await booted.signIn("mia"));
    expect((await member.get("/api/photo-sync/libraries/family/phones")).statusCode).toBe(403);
    const admin = booted.as(await booted.signIn("admin"));
    expect((await admin.get("/api/photo-sync/libraries/mine/phones")).statusCode).toBe(404);
    fs.mkdirSync(path.join(base, "olgas"));
    makeLibrary("olgas", { createdBy: "olga", type: "gallery" });
    db.prepare("UPDATE libraries SET source_path = ?, personal_user_id = 'olga', owner_id = 'olga', owner_type = 'user' WHERE id = 'olgas'").run(path.join(base, "olgas"));
    const olgas = addPhone({ id: "olga" }, "Olga's phone", null);
    const refused = await admin.put("/api/photo-sync/libraries/family/phones", JSON.stringify({ deviceIds: [olgas.id] }), { "content-type": "application/json" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("cannot_open");
  });
});
