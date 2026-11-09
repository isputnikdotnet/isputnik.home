// Photo Sync phase 3 (docs/photo-sync-plan.md): the /dav endpoint a phone backs up
// through. Played the way PhotoSync for Android was seen to play it (plan › Spike
// results): MKCOL ×2, PROPFIND Depth 1 of the album folder, PUT to the final name
// with X-OC-Mtime, PROPPATCH getlastmodified as bare unix seconds.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { addSyncNetwork, removeSyncNetwork, listSyncNetworks } from "../src/modules/library/gallery/sync/networks.js";
import { addPhone, revokePhone } from "../src/modules/library/gallery/sync/devices.js";
import { photoSyncDavPlugin } from "../src/modules/library/gallery/sync/dav.js";
import { davPathOf } from "../src/modules/library/gallery/sync/namespace.js";
import {
  deviceFolderName, inFlightBytes, parseClientDate, setFreeSpaceProbeForTests, STAGING_PREFIX
} from "../src/modules/library/gallery/sync/put.js";
import { getPersonalSettings, savePersonalSettings } from "../src/modules/library/gallery/personal/settings.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { bootApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";
import "./helpers/media-types.js";

const PHONE_IP = "192.168.1.36";

let app: FastifyInstance;
let base: string;
let root: string;
let token: string;
let deviceId: string;

const basic = (password: string, user = "mia@test.local") => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/** A request from the tablet, signed in with its token unless told otherwise. */
function dav(method: string, url: string, opts: { headers?: Record<string, string>; payload?: InjectOptions["payload"]; ip?: string; auth?: string | null } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const auth = opts.auth === undefined ? basic(token) : opts.auth;
  if (auth) headers.authorization = auth;
  return app.inject({ method: method as InjectOptions["method"], url, headers, payload: opts.payload, remoteAddress: opts.ip ?? PHONE_IP });
}

/** A small real JPEG, distinct per seed. No EXIF date — dates come from elsewhere. */
async function jpeg(seed = 1): Promise<Buffer> {
  const width = 40 + seed * 4;
  const height = 30 + seed * 2;
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = (i * seed) % 256; data[i + 1] = (i * 7 + seed * 31) % 256; data[i + 2] = (i * 3 + seed * 11) % 256;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

/** One file the way PhotoSync sends it. */
async function sendLikePhotoSync(album: string, name: string, body: Buffer, unixSeconds: number) {
  await dav("MKCOL", "/dav/Samsung%20SM-X820/");
  await dav("MKCOL", `/dav/Samsung%20SM-X820/${album}/`);
  const listing = await dav("PROPFIND", `/dav/Samsung%20SM-X820/${album}/`, { headers: { depth: "1", "content-type": "text/xml" }, payload: "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:allprop/></d:propfind>" });
  const put = await dav("PUT", `/dav/Samsung%20SM-X820/${album}/${encodeURIComponent(name)}`, {
    headers: { "content-type": "image/jpeg", "x-oc-mtime": `${unixSeconds}.00`, "x-recordtime": `${unixSeconds}.00` },
    payload: body
  });
  const patch = await dav("PROPPATCH", `/dav/Samsung%20SM-X820/${album}/${encodeURIComponent(name)}`, {
    headers: { "content-type": "text/xml" },
    payload: `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:getlastmodified>${unixSeconds}</d:getlastmodified></d:prop></d:set></d:propertyupdate>`
  });
  return { listing, put, patch };
}

/** Every file under the library root, relative, excluding staging. */
function filesOnDisk(dir = root): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs); else out.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

const items = () => db.prepare(`
  SELECT li.id, li.library_id, gd.relative_path, gd.taken_at FROM library_items li JOIN gallery_details gd ON gd.item_id = li.id
  WHERE li.deleted_at IS NULL ORDER BY gd.relative_path
`).all() as { id: string; library_id: string; relative_path: string; taken_at: string }[];

const hrefsOf = (body: string) => Array.from(body.matchAll(/<d:href>([^<]+)<\/d:href>/g)).map((m) => decodeURIComponent(m[1]!));

const tokenAbuse = (ip: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip_address = ? AND kind = 'token'").get(ip) as { n: number }).n;

function setSizeLimitGB(gb: number | null) {
  savePersonalSettings({ ...getPersonalSettings(), sizeLimitGB: gb }, "admin");
}

beforeEach(async () => {
  resetDb();
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.TRUST_PROXY;
  base = fs.mkdtempSync(path.join(os.tmpdir(), "photo-sync-dav-"));
  root = path.join(base, "mine");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, "olgas"));
  makeUser("admin", "admin");
  makeUser("mia");
  makeUser("olga");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'admin')").run(fs.realpathSync(base));
  fs.mkdirSync(path.join(base, "thumbs"));
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(thumbnailPathSettingKey, path.join(base, "thumbs"));
  makeLibrary("mine", { createdBy: "mia", type: "gallery" });
  makeLibrary("olgas", { createdBy: "olga", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ?, personal_user_id = 'mia', owner_id = 'mia', owner_type = 'user' WHERE id = 'mine'").run(root);
  db.prepare("UPDATE libraries SET source_path = ?, personal_user_id = 'olga', owner_id = 'olga', owner_type = 'user' WHERE id = 'olgas'").run(path.join(base, "olgas"));
  addSyncNetwork("192.168.1.0/24", "Tablet Wi-Fi", "admin");
  const phone = addPhone({ id: "mia" }, "Mia's tablet", null);
  token = phone.raw;
  deviceId = phone.id;
  ({ app } = await bootApp({ csrf: true, plugins: [photoSyncDavPlugin] }));
});

afterEach(async () => {
  setFreeSpaceProbeForTests(null);
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("paths and dates", () => {
  it("refuses escapes and odd segments, keeps Unicode", () => {
    expect(davPathOf("/dav/")).toBe("/");
    expect(davPathOf("/dav/A/b.jpg?x=1")).toBe("/A/b.jpg");
    expect(davPathOf("/dav/%D0%A4%D0%BE%D1%82%D0%BE/1.jpg")).toBe("/Фото/1.jpg");
    expect(davPathOf("/dav/../etc/passwd")).toBeNull();
    expect(davPathOf("/dav/A/%2E%2E/b.jpg")).toBeNull();
    expect(davPathOf("/dav/A%2Fb.jpg")).toBeNull();
    expect(davPathOf("/dav/A%5Cb.jpg")).toBeNull();
    expect(davPathOf("/dav/A%00.jpg")).toBeNull();
    expect(davPathOf("/dav/%E0%A4%A")).toBeNull();
    expect(davPathOf("/davx/a")).toBeNull();
  });

  it("reads unix seconds (PhotoSync) and RFC 1123 dates; refuses nonsense", () => {
    expect(parseClientDate("1793893935.00")?.toISOString()).toBe("2026-11-05T15:52:15.000Z");
    expect(parseClientDate("Thu, 05 Nov 2026 15:52:15 GMT")?.toISOString()).toBe("2026-11-05T15:52:15.000Z");
    expect(parseClientDate("0")).toBeNull();
    expect(parseClientDate("not a date")).toBeNull();
    expect(parseClientDate("99999999999")).toBeNull();
  });

  it("makes a folder name of the phone's name", () => {
    expect(deviceFolderName("Mia's tablet")).toBe("Mia's tablet");
    expect(deviceFolderName("../..")).toBe("Phone");
    expect(deviceFolderName("a/b:c")).toBe("a b c");
    expect(deviceFolderName(null)).toBe("Phone");
  });
});

describe("who gets in", () => {
  it("answers OPTIONS to anyone, from anywhere", async () => {
    const res = await dav("OPTIONS", "/dav/", { auth: null, ip: "8.8.8.8" });
    expect(res.statusCode).toBe(200);
    expect(res.headers.dav).toContain("1");
    expect(res.headers.allow).toContain("PROPFIND");
  });

  it("challenges a request with no credentials, and a revoked or unknown token", async () => {
    const anonymous = await dav("PROPFIND", "/dav/", { auth: null, headers: { depth: "0" } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toMatch(/^Basic /);
    expect(tokenAbuse(PHONE_IP)).toBe(0);

    const unknown = await dav("PROPFIND", "/dav/", { auth: basic("isp_photo-sync_nope"), headers: { depth: "0" } });
    expect(unknown.statusCode).toBe(401);
    expect(tokenAbuse(PHONE_IP)).toBe(1);

    // The account's password is never a way in.
    expect((await dav("PROPFIND", "/dav/", { auth: basic("test1234"), headers: { depth: "0" } })).statusCode).toBe(401);

    revokePhone("mia", deviceId, null);
    const revoked = await dav("PUT", "/dav/a.jpg", { payload: await jpeg() });
    expect(revoked.statusCode).toBe(401);
    expect(filesOnDisk()).toEqual([]);
  });

  it("refuses a good token from outside the phone-sync networks, without a challenge", async () => {
    const res = await dav("PUT", "/dav/a.jpg", { ip: "192.168.2.50", payload: await jpeg() });
    expect(res.statusCode).toBe(403);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(filesOnDisk()).toEqual([]);
  });

  it("stops at once when the network is taken off the list", async () => {
    expect((await dav("PROPFIND", "/dav/", { headers: { depth: "0" } })).statusCode).toBe(207);
    for (const network of listSyncNetworks()) removeSyncNetwork(network.id);
    expect((await dav("PROPFIND", "/dav/", { headers: { depth: "0" } })).statusCode).toBe(403);
  });

  it("refuses a forwarded request when proxy trust is unconfigured", async () => {
    const res = await dav("PROPFIND", "/dav/", { headers: { depth: "0", "x-forwarded-for": "203.0.113.9" } });
    expect(res.statusCode).toBe(403);
  });

  it("stops when the library stops being the member's", async () => {
    db.prepare("UPDATE libraries SET personal_orphaned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'mine'").run();
    expect((await dav("PROPFIND", "/dav/", { headers: { depth: "0" } })).statusCode).toBe(401);
  });

  it("answers a bad path with 400", async () => {
    expect((await dav("PUT", "/dav/a/..%5C..%5Cx.jpg", { payload: await jpeg() })).statusCode).toBe(400);
  });
});

describe("a backup, the way PhotoSync sends it", () => {
  it("files by date under the phone's folder, records it, and answers the phone with its own paths", async () => {
    // 20261102_160025.jpg: a Samsung camera name. The name's date beats the phone's.
    const first = await sendLikePhotoSync("Camera", "20261102_160025.jpg", await jpeg(1), 1793893935);
    // The album folder exists after MKCOL, empty.
    expect(first.listing.statusCode).toBe(207);
    expect(hrefsOf(first.listing.body)).toEqual(["/dav/Samsung SM-X820/Camera/"]);
    expect(first.put.statusCode).toBe(201);
    expect(first.put.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(first.put.headers["x-oc-mtime"]).toBe("accepted");
    expect(first.patch.statusCode).toBe(207);

    // A WhatsApp file with no date in its name: the phone's date files it.
    const second = await sendLikePhotoSync("WhatsApp", "IMG-WA0001.jpg", await jpeg(2), 1793893935);
    expect(second.put.statusCode).toBe(201);
    // A Pixel name.
    expect((await sendLikePhotoSync("Camera", "PXL_20250714_081530123.jpg", await jpeg(3), 1793893935)).put.statusCode).toBe(201);

    expect(filesOnDisk()).toEqual([
      "Mia's tablet/2025/2025-07-14/PXL_20250714_081530123.jpg",
      "Mia's tablet/2026/2026-11-02/20261102_160025.jpg",
      expect.stringMatching(/^Mia's tablet\/2026\/2026-11-0[45]\/IMG-WA0001\.jpg$/)
    ].sort());
    const catalogued = items();
    expect(catalogued).toHaveLength(3);
    expect(catalogued.every((item) => item.library_id === "mine")).toBe(true);
    // The phone's date became the WhatsApp file's date (no EXIF, no name date).
    expect(catalogued.find((item) => item.relative_path.endsWith("IMG-WA0001.jpg"))!.taken_at).toBe("2026-11-05T15:52:15.000Z");

    const listing = await dav("PROPFIND", "/dav/Samsung%20SM-X820/Camera/", { headers: { depth: "1" } });
    expect(listing.statusCode).toBe(207);
    expect(hrefsOf(listing.body)).toEqual([
      "/dav/Samsung SM-X820/Camera/",
      "/dav/Samsung SM-X820/Camera/20261102_160025.jpg",
      "/dav/Samsung SM-X820/Camera/PXL_20250714_081530123.jpg"
    ]);
    expect(listing.body).toContain("<d:getcontentlength>");
    expect(listing.body).toContain("Thu, 05 Nov 2026 15:52:15 GMT");
    const top = await dav("PROPFIND", "/dav/", { headers: { depth: "1" } });
    expect(hrefsOf(top.body)).toEqual(["/dav/", "/dav/Samsung SM-X820/"]);
    // Depth 0 on a file.
    const one = await dav("PROPFIND", "/dav/Samsung%20SM-X820/Camera/20261102_160025.jpg", { headers: { depth: "0" } });
    expect(hrefsOf(one.body)).toEqual(["/dav/Samsung SM-X820/Camera/20261102_160025.jpg"]);
  });

  it("answers a repeated MKCOL with 405, and a MKCOL without its parent with 409", async () => {
    expect((await dav("MKCOL", "/dav/Samsung%20SM-X820/")).statusCode).toBe(201);
    expect((await dav("MKCOL", "/dav/Samsung%20SM-X820/")).statusCode).toBe(405);
    expect((await dav("MKCOL", "/dav/Samsung%20SM-X820/Camera")).statusCode).toBe(201);
    expect((await dav("MKCOL", "/dav/Samsung%20SM-X820/Camera/")).statusCode).toBe(405);
    expect((await dav("MKCOL", "/dav/Nope/Camera/")).statusCode).toBe(409);
    expect((await dav("MKCOL", "/dav/")).statusCode).toBe(405);
    // Nothing on disk for a folder.
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("sends nothing twice: the same path and content is a 204 and writes nothing", async () => {
    const body = await jpeg(1);
    expect((await sendLikePhotoSync("Camera", "20261102_160025.jpg", body, 1793893935)).put.statusCode).toBe(201);
    const again = await dav("PUT", "/dav/Samsung%20SM-X820/Camera/20261102_160025.jpg", { payload: body });
    expect(again.statusCode).toBe(204);
    expect(filesOnDisk()).toHaveLength(1);
    expect(items()).toHaveLength(1);
  });

  it("records content already in the library against that item (a second phone, or a reinstall)", async () => {
    const body = await jpeg(1);
    await sendLikePhotoSync("Camera", "20261102_160025.jpg", body, 1793893935);
    const second = addPhone({ id: "mia" }, "Mia's phone", null);
    const res = await app.inject({
      method: "PUT", url: "/dav/Pixel/DCIM/copy.jpg", payload: body, remoteAddress: PHONE_IP,
      headers: { authorization: basic(second.raw) }
    });
    expect(res.statusCode).toBe(201);
    expect(filesOnDisk()).toHaveLength(1);
    const record = db.prepare("SELECT item_id FROM photo_sync_files WHERE device_id = ?").get(second.id) as { item_id: string };
    expect(record.item_id).toBe(items()[0]!.id);
    // And the second phone sees only its own path.
    const listing = await app.inject({ method: "PROPFIND", url: "/dav/", headers: { authorization: basic(second.raw), depth: "1" }, remoteAddress: PHONE_IP });
    expect(hrefsOf(listing.body)).toEqual(["/dav/", "/dav/Pixel/"]);
  });

  it("finds a photo uploaded by hand by its bytes", async () => {
    const body = await jpeg(4);
    fs.mkdirSync(path.join(root, "2024"), { recursive: true });
    fs.writeFileSync(path.join(root, "2024", "by-hand.jpg"), body);
    const { scanSingleGalleryFile } = await import("../src/modules/library/gallery/scanner.js");
    const handId = await scanSingleGalleryFile("mine", "2024/by-hand.jpg");
    const res = await dav("PUT", "/dav/Camera/IMG_1.jpg", { payload: body });
    expect(res.statusCode).toBe(201);
    expect(filesOnDisk()).toEqual(["2024/by-hand.jpg"]);
    expect((db.prepare("SELECT item_id FROM photo_sync_files WHERE client_path = '/Camera/IMG_1.jpg'").get() as { item_id: string }).item_id).toBe(handId);
  });

  it("stores the original again once the file a phone sent was replaced in place", async () => {
    // A record of what was sent is no proof the bytes are still there: the file was edited
    // (rotated, retouched) on the server after the first phone sent it, and the catalogue
    // followed. The second phone's untouched original must not be thrown away.
    const original = await jpeg(1);
    await dav("PUT", "/dav/Camera/a.jpg", { payload: original });
    const [stored] = filesOnDisk();
    fs.writeFileSync(path.join(root, stored!), await jpeg(2));
    const { scanSingleGalleryFile } = await import("../src/modules/library/gallery/scanner.js");
    await scanSingleGalleryFile("mine", stored!);
    const second = addPhone({ id: "mia" }, "Mia's phone", null);
    const res = await app.inject({
      method: "PUT", url: "/dav/Pixel/DCIM/a.jpg", payload: original, remoteAddress: PHONE_IP,
      headers: { authorization: basic(second.raw) }
    });
    expect(res.statusCode).toBe(201);
    const files = filesOnDisk();
    expect(files).toHaveLength(2);
    expect(files.some((file) => fs.readFileSync(path.join(root, file)).equals(original))).toBe(true);
  });

  it("takes the same phone's copy again when the file at its path was replaced in place", async () => {
    // PhotoSync re-sends a path when asked to; "nothing changed" is only true while the
    // server still has those bytes. A deletion at home is different and stays a 204 below.
    const original = await jpeg(1);
    await dav("PUT", "/dav/Camera/a.jpg", { payload: original });
    const [stored] = filesOnDisk();
    fs.writeFileSync(path.join(root, stored!), await jpeg(2));
    const { scanSingleGalleryFile } = await import("../src/modules/library/gallery/scanner.js");
    await scanSingleGalleryFile("mine", stored!);
    expect((await dav("PUT", "/dav/Camera/a.jpg", { payload: original })).statusCode).toBe(201);
    const files = filesOnDisk();
    expect(files).toHaveLength(2);
    expect(files.some((file) => fs.readFileSync(path.join(root, file)).equals(original))).toBe(true);
    // Sent again untouched, it is "nothing changed" once more.
    expect((await dav("PUT", "/dav/Camera/a.jpg", { payload: original })).statusCode).toBe(204);
    expect(filesOnDisk()).toHaveLength(2);
  });

  it("finds a copy among any number of same-size files", async () => {
    // Sixty files of one size, the wanted one sorted last: no fixed cutoff may hide it.
    const size = 4096;
    fs.mkdirSync(path.join(root, "2024"));
    const insertItem = db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, 'mine', 'gallery', ?, 'ready', '2026-01-01T00:00:00.000Z')");
    const insertDetails = db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, ?)");
    const bodyOf = (n: number) => { const body = Buffer.alloc(size, 0); body.writeUInt32BE(n, 0); return body; };
    for (let n = 0; n < 60; n += 1) {
      const relativePath = `2024/f${String(n).padStart(2, "0")}.jpg`;
      fs.writeFileSync(path.join(root, relativePath), bodyOf(n));
      insertItem.run(`same${String(n).padStart(2, "0")}`, relativePath);
      insertDetails.run(`same${String(n).padStart(2, "0")}`, relativePath, size);
    }
    const res = await dav("PUT", "/dav/Camera/x.jpg", { payload: bodyOf(59) });
    expect(res.statusCode).toBe(201);
    expect(filesOnDisk()).toHaveLength(60);
    expect((db.prepare("SELECT item_id FROM photo_sync_files WHERE client_path = '/Camera/x.jpg'").get() as { item_id: string }).item_id).toBe("same59");
    // The digests read on the way are kept, so the next lookup compares instead of reading.
    expect((db.prepare("SELECT COUNT(*) AS n FROM gallery_details WHERE content_hash IS NOT NULL").get() as { n: number }).n).toBe(60);
  });

  it("never overwrites: new content at a known path is a new file, and the old one stays", async () => {
    await dav("PUT", "/dav/Camera/IMG_20261102_160025.jpg", { payload: await jpeg(1) });
    const changed = await dav("PUT", "/dav/Camera/IMG_20261102_160025.jpg", { payload: await jpeg(2) });
    expect(changed.statusCode).toBe(201);
    expect(filesOnDisk()).toEqual([
      "Mia's tablet/2026/2026-11-02/IMG_20261102_160025 (2).jpg",
      "Mia's tablet/2026/2026-11-02/IMG_20261102_160025.jpg"
    ]);
    expect(items()).toHaveLength(2);
  });

  it("keeps the record when the item is deleted at home, so the phone doesn't send it again", async () => {
    const body = await jpeg(1);
    await dav("PUT", "/dav/Camera/a.jpg", { payload: body });
    db.prepare("DELETE FROM library_items").run();
    const listing = await dav("PROPFIND", "/dav/Camera/", { headers: { depth: "1" } });
    expect(hrefsOf(listing.body)).toContain("/dav/Camera/a.jpg");
    expect((await dav("PUT", "/dav/Camera/a.jpg", { payload: body })).statusCode).toBe(204);
  });

  it("re-dates a file when the date only comes with PROPPATCH", async () => {
    await dav("PUT", "/dav/WhatsApp/IMG-WA0002.jpg", { payload: await jpeg(5) });
    const patch = await dav("PROPPATCH", "/dav/WhatsApp/IMG-WA0002.jpg", {
      payload: "<d:propertyupdate xmlns:d=\"DAV:\"><d:set><d:prop><d:getlastmodified>Mon, 06 Jul 2026 08:00:00 GMT</d:getlastmodified></d:prop></d:set></d:propertyupdate>"
    });
    expect(patch.statusCode).toBe(207);
    expect(items()[0]!.taken_at).toBe("2026-07-06T08:00:00.000Z");
  });
});

describe("one phone, one namespace", () => {
  it("never lists another phone's files, or the library's own", async () => {
    fs.writeFileSync(path.join(root, "by-hand.jpg"), await jpeg(9));
    await dav("PUT", "/dav/Mine/a.jpg", { payload: await jpeg(1) });
    const olgas = addPhone({ id: "olga" }, "Olga's phone", null);
    const other = (method: string, url: string, extra: Record<string, string> = {}) =>
      app.inject({ method: method as InjectOptions["method"], url, headers: { authorization: basic(olgas.raw, "olga@test.local"), ...extra }, remoteAddress: PHONE_IP });
    expect(hrefsOf((await other("PROPFIND", "/dav/", { depth: "1" })).body)).toEqual(["/dav/"]);
    expect((await other("PROPFIND", "/dav/Mine/a.jpg", { depth: "0" })).statusCode).toBe(404);
    expect((await other("HEAD", "/dav/Mine/a.jpg")).statusCode).toBe(404);
    // And Olga's upload goes to Olga's library.
    expect((await app.inject({ method: "PUT", url: "/dav/x.jpg", payload: await jpeg(2), remoteAddress: PHONE_IP, headers: { authorization: basic(olgas.raw) } })).statusCode).toBe(201);
    expect(items().map((i) => i.library_id).sort()).toEqual(["mine", "olgas"]);
  });

  it("answers HEAD for its own files, refuses GET, DELETE and COPY", async () => {
    await dav("PUT", "/dav/Camera/a.jpg", { payload: await jpeg(1) });
    const head = await dav("HEAD", "/dav/Camera/a.jpg");
    expect(head.statusCode).toBe(200);
    expect(head.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await dav("GET", "/dav/Camera/a.jpg")).statusCode).toBe(403);
    expect((await dav("DELETE", "/dav/Camera/a.jpg")).statusCode).toBe(403);
    expect((await dav("DELETE", "/dav/Camera/")).statusCode).toBe(403);
    expect((await dav("COPY", "/dav/Camera/a.jpg", { headers: { destination: "/dav/Camera/b.jpg" } })).statusCode).toBe(501);
    expect(filesOnDisk()).toHaveLength(1);
  });

  it("moves inside the namespace only, and never touches the library file", async () => {
    await dav("PUT", "/dav/Camera/tmp-a.jpg", { payload: await jpeg(1) });
    const before = filesOnDisk();
    expect((await dav("MOVE", "/dav/Camera/tmp-a.jpg", { headers: { destination: "http://192.168.2.137:4000/dav/Camera/a.jpg" } })).statusCode).toBe(201);
    expect(filesOnDisk()).toEqual(before);
    const listing = await dav("PROPFIND", "/dav/Camera/", { headers: { depth: "1" } });
    expect(hrefsOf(listing.body)).toEqual(["/dav/Camera/", "/dav/Camera/a.jpg"]);
    expect((await dav("MOVE", "/dav/Camera/a.jpg", { headers: { destination: "/elsewhere/a.jpg" } })).statusCode).toBe(400);
    expect((await dav("MOVE", "/dav/Camera/a.jpg", { headers: { destination: "/dav/../a.jpg" } })).statusCode).toBe(400);
  });
});

describe("limits", () => {
  it("refuses a type the library doesn't take with 415", async () => {
    const res = await dav("PUT", "/dav/Camera/raw.dng", { payload: Buffer.from("raw bytes") });
    expect(res.statusCode).toBe(415);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("refuses a file over the library's upload cap with 413, before and while streaming", async () => {
    db.prepare("UPDATE libraries SET policy_json = ? WHERE id = 'mine'").run(JSON.stringify({ maxUploadMB: 1 }));
    const big = Buffer.alloc(1024 * 1024 + 10, 7);
    expect((await dav("PUT", "/dav/big.jpg", { payload: big })).statusCode).toBe(413);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("refuses past the member's size limit with 507", async () => {
    setSizeLimitGB(0.000001); // ≈ 1 KB
    const res = await dav("PUT", "/dav/a.jpg", { payload: Buffer.alloc(4096, 1) });
    expect(res.statusCode).toBe(507);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("holds room for uploads in flight, so two that fit alone never both fit", async () => {
    const a = await jpeg(1);
    const b = await jpeg(2);
    setSizeLimitGB((Math.max(a.length, b.length) * 1.5) / 1024 ** 3);
    const [first, second] = await Promise.all([
      dav("PUT", "/dav/a.jpg", { payload: a }),
      dav("PUT", "/dav/b.jpg", { payload: b })
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 507]);
    expect(filesOnDisk()).toHaveLength(1);
    expect(inFlightBytes("mine")).toBe(0);
    // And on its own, the refused one fits once there is room again.
    setSizeLimitGB(((a.length + b.length) * 1.5) / 1024 ** 3);
    expect((await dav("PUT", "/dav/c.jpg", { payload: first.statusCode === 201 ? b : a })).statusCode).toBe(201);
    expect(filesOnDisk()).toHaveLength(2);
  });

  it("refuses with 507 when the disk is full, and leaves nothing behind", async () => {
    setFreeSpaceProbeForTests(() => 300 * 1024 * 1024); // just over the reserve
    const res = await dav("PUT", "/dav/a.jpg", { payload: await jpeg(1) });
    expect(res.statusCode).toBe(201);
    setFreeSpaceProbeForTests(() => 10 * 1024 * 1024);
    expect((await dav("PUT", "/dav/b.jpg", { payload: await jpeg(2) })).statusCode).toBe(507);
    expect(fs.readdirSync(root).some((name) => name.startsWith(STAGING_PREFIX))).toBe(false);
  });

  it("refuses a body shorter than its Content-Length or a wrong checksum, keeping nothing", async () => {
    const body = await jpeg(1);
    const wrong = await dav("PUT", "/dav/a.jpg", { payload: body, headers: { "oc-checksum": `SHA1:${"0".repeat(40)}` } });
    expect(wrong.statusCode).toBe(400);
    const right = await dav("PUT", "/dav/a.jpg", {
      payload: body, headers: { "oc-checksum": `SHA1:${crypto.createHash("sha1").update(body).digest("hex")}`, "content-md5": crypto.createHash("md5").update(body).digest("base64") }
    });
    expect(right.statusCode).toBe(201);
    expect(filesOnDisk()).toHaveLength(1);
  });
});

describe("over a real socket", () => {
  it("streams a large upload without buffering it, and drops a cut-off one", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    addSyncNetwork("127.0.0.0/8", "Loopback", "admin");
    const { port } = app.server.address() as AddressInfo;
    // A real JPEG head, then 64 MB of padding after its end marker: still a file the
    // gallery takes, and big enough that buffering it would show.
    const head = await jpeg(6);
    const size = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 0);
    const expected = crypto.createHash("sha256");

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port, method: "PUT", path: "/dav/Camera/VID_20260101_120000.jpg",
        headers: { authorization: basic(token), "content-length": String(head.length + size), "x-oc-mtime": "1793893935.00" }
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.write(head); expected.update(head);
      let sent = 0;
      const pump = () => {
        while (sent < size) {
          sent += chunk.length; expected.update(chunk);
          if (!req.write(chunk)) { req.once("drain", pump); return; }
        }
        req.end();
      };
      pump();
    });
    expect(status).toBe(201);
    const stored = filesOnDisk();
    expect(stored).toEqual(["Mia's tablet/2026/2026-01-01/VID_20260101_120000.jpg"]);
    expect(fs.statSync(path.join(root, stored[0]!)).size).toBe(head.length + size);
    const record = db.prepare("SELECT sha256, size FROM photo_sync_files").get() as { sha256: string; size: number };
    expect(record).toEqual({ sha256: expected.digest("hex"), size: head.length + size });

    // A transfer that stops part-way leaves nothing behind.
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port, method: "PUT", path: "/dav/Camera/cut.jpg",
        headers: { authorization: basic(token), "content-length": String(10 * 1024 * 1024) }
      });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write(Buffer.alloc(1024 * 1024, 1), () => setTimeout(() => req.destroy(), 100));
    });
    for (let i = 0; i < 50 && fs.readdirSync(root).some((n) => n.startsWith(STAGING_PREFIX)); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.readdirSync(root).filter((n) => n.startsWith(STAGING_PREFIX))).toEqual([]);
    expect(filesOnDisk()).toHaveLength(1);
  }, 60_000);
});
