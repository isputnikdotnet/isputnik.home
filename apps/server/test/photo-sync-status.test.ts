// Photo Sync phase 4 (docs/photo-sync-plan.md): how each phone's backup is going, for
// its owner (everything) and for an admin (the phone and the library's size — never a
// count of what was sent, never a file, and only problems about the phone or server).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { addSyncNetwork } from "../src/modules/library/gallery/sync/networks.js";
import { addPhone } from "../src/modules/library/gallery/sync/devices.js";
import { photoSyncDavPlugin } from "../src/modules/library/gallery/sync/dav.js";
import { photoSyncRoutesPlugin } from "../src/modules/library/gallery/sync/routes.js";
import { setFreeSpaceProbeForTests } from "../src/modules/library/gallery/sync/put.js";
import { isPhoneStale, phoneStatuses, resetPhoneStatusThrottleForTests, STALE_DAYS } from "../src/modules/library/gallery/sync/status.js";
import { personalLibrariesForAdmin } from "../src/modules/library/gallery/personal/service.js";
import { getPersonalSettings, savePersonalSettings } from "../src/modules/library/gallery/personal/settings.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { bootApp, type BootedApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";
import "./helpers/media-types.js";

const PHONE_IP = "192.168.1.36";

let booted: BootedApp;
let app: FastifyInstance;
let base: string;
let token: string;
let deviceId: string;

const basic = (password: string) => `Basic ${Buffer.from(`mia@test.local:${password}`).toString("base64")}`;

function dav(method: string, url: string, opts: { headers?: Record<string, string>; payload?: InjectOptions["payload"]; ip?: string } = {}) {
  return app.inject({
    method: method as InjectOptions["method"], url,
    headers: { authorization: basic(token), ...(opts.headers ?? {}) },
    payload: opts.payload, remoteAddress: opts.ip ?? PHONE_IP
  });
}

async function jpeg(seed = 1): Promise<Buffer> {
  const width = 40 + seed * 4;
  const height = 30;
  const data = Buffer.alloc(width * height * 3, seed * 17);
  for (let i = 0; i < data.length; i += 3) data[i] = (i * seed) % 256;
  return sharp(data, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

async function send(name: string, body: Buffer) {
  await dav("MKCOL", "/dav/Tab/");
  return dav("PUT", `/dav/Tab/${encodeURIComponent(name)}`, { headers: { "content-type": "image/jpeg" }, payload: body });
}

const activity = (event: string) =>
  db.prepare("SELECT event, target_type, target_id, detail FROM activity_logs WHERE event LIKE ?").all(event) as
    { event: string; target_type: string; target_id: string; detail: string }[];

beforeEach(async () => {
  resetDb();
  resetPhoneStatusThrottleForTests();
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.TRUST_PROXY;
  base = fs.mkdtempSync(path.join(os.tmpdir(), "photo-sync-status-"));
  const root = path.join(base, "mine");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, "thumbs"));
  makeUser("admin", "admin");
  makeUser("mia");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'admin')").run(fs.realpathSync(base));
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(thumbnailPathSettingKey, path.join(base, "thumbs"));
  makeLibrary("mine", { createdBy: "mia", type: "gallery" });
  db.prepare("UPDATE libraries SET source_path = ?, personal_user_id = 'mia', owner_id = 'mia', owner_type = 'user' WHERE id = 'mine'").run(root);
  addSyncNetwork("192.168.1.0/24", "Tablet Wi-Fi", "admin");
  const phone = addPhone({ id: "mia" }, "Mia's tablet", null);
  token = phone.raw;
  deviceId = phone.id;
  booted = await bootApp({ csrf: true, plugins: [photoSyncDavPlugin, photoSyncRoutesPlugin] });
  app = booted.app;
});

afterEach(async () => {
  setFreeSpaceProbeForTests(null);
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
});

const status = () => phoneStatuses([{ id: deviceId, last_seen_at: null, created_at: new Date().toISOString() }]).get(deviceId)!;

describe("a phone's status", () => {
  it("counts what arrived, today and in all, and not the repeats", async () => {
    const a = await jpeg(1);
    const b = await jpeg(2);
    expect((await send("a.jpg", a)).statusCode).toBe(201);
    expect((await send("b.jpg", b)).statusCode).toBe(201);
    expect((await send("a.jpg", a)).statusCode).toBe(204);
    // An old record falls out of the last 24 hours but stays in the total.
    db.prepare("UPDATE photo_sync_files SET received_at = '2026-01-01T00:00:00.000Z' WHERE client_path = '/Tab/b.jpg'").run();
    const s = status();
    expect(s.total).toEqual({ files: 2, bytes: a.length + b.length });
    expect(s.day).toEqual({ files: 1, bytes: a.length });
    expect(s.lastReceived).not.toBe("2026-01-01T00:00:00.000Z");
    expect(s.problem).toBeNull();
  });

  it("does not count repeated MKCOLs or a 204 as problems", async () => {
    const a = await jpeg(1);
    await send("a.jpg", a);
    for (let i = 0; i < 3; i++) expect((await dav("MKCOL", "/dav/Tab/")).statusCode).toBe(405);
    expect((await send("a.jpg", a)).statusCode).toBe(204);
    expect(status().problem).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM photo_sync_device_status").get()).toEqual({ n: 0 });
  });

  it("keeps the last problem: the type, never the file name", async () => {
    const res = await dav("PUT", "/dav/Tab/IMG_0001_secret.dng", { payload: Buffer.from("raw") });
    expect(res.statusCode).toBe(415);
    const s = status();
    expect(s.problem).toEqual({ code: "type", detail: ".dng", at: expect.any(String), current: true });
    expect(JSON.stringify(db.prepare("SELECT * FROM photo_sync_device_status").all())).not.toContain("secret");
    // Not a device-level problem: the admin's log hears nothing of it.
    expect(activity("photo_sync.%").filter((row) => !["photo_sync.phone_added", "photo_sync.connected"].includes(row.event))).toEqual([]);
  });

  it("records a full disk, and logs it once for the admin with the phone as the target", async () => {
    setFreeSpaceProbeForTests(() => 0);
    for (let i = 0; i < 3; i++) expect((await send(`p${i}_holiday.jpg`, await jpeg(i + 1))).statusCode).toBe(507);
    expect(status().problem?.code).toBe("disk_full");
    const logged = activity("photo_sync.failed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ target_type: "photo_sync_device", target_id: deviceId });
    expect(logged[0]!.detail).not.toContain("holiday");
  });

  it("records a refusal from outside the networks against the phone, without counting it as contact", async () => {
    const res = await dav("PROPFIND", "/dav/", { ip: "10.9.9.9", headers: { depth: "0" } });
    expect(res.statusCode).toBe(403);
    expect(status().problem).toEqual({ code: "not_listed", detail: "10.9.9.9", at: expect.any(String), current: true });
    const row = db.prepare("SELECT last_seen_at FROM api_tokens WHERE id = ?").get(deviceId) as { last_seen_at: string | null };
    expect(row.last_seen_at).toBeNull();
    expect(activity("photo_sync.refused")).toHaveLength(1);
  });

  it("writes the same problem at most once a minute", async () => {
    for (let i = 0; i < 5; i++) await dav("PROPFIND", "/dav/", { ip: "10.9.9.9", headers: { depth: "0" } });
    const first = status().problem!.at;
    db.prepare("UPDATE photo_sync_device_status SET last_error_at = '2026-01-01T00:00:00.000Z'").run();
    await dav("PROPFIND", "/dav/", { ip: "10.9.9.9", headers: { depth: "0" } });
    expect(status().problem!.at).toBe("2026-01-01T00:00:00.000Z");
    expect(first).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("who sees it", () => {
  it("shows the owner everything on their Phones list", async () => {
    await send("a.jpg", await jpeg(1));
    await dav("PUT", "/dav/Tab/x.dng", { payload: Buffer.from("raw") });
    const res = await booted.as(await booted.signIn("mia")).get("/api/profile/phones");
    const phone = res.json().phones[0];
    expect(phone.status.total.files).toBe(1);
    expect(phone.status.lastContact).toEqual(expect.any(String));
    expect(phone.status.problem.code).toBe("type");
  });

  it("shows an admin the phone, the library's size and device-level problems only", async () => {
    const photo = await jpeg(1);
    await send("a.jpg", photo);
    await dav("PUT", "/dav/Tab/x.dng", { payload: Buffer.from("raw") });
    const admin = booted.as(await booted.signIn("admin"));
    expect((await booted.as(await booted.signIn("mia")).get("/api/photo-sync/members/mia")).statusCode).toBe(403);

    let view = (await admin.get("/api/photo-sync/members/mia")).json();
    expect(view.library.sizeBytes).toBe(photo.length);
    expect(view.phones).toEqual([{ id: deviceId, label: "Mia's tablet", createdAt: expect.any(String), lastSeen: expect.any(String), problem: null, stale: false }]);
    expect(JSON.stringify(view)).not.toMatch(/a\.jpg|Tab\/|files/);

    await dav("PROPFIND", "/dav/", { ip: "10.9.9.9", headers: { depth: "0" } });
    view = (await admin.get("/api/photo-sync/members/mia")).json();
    expect(view.phones[0].problem.code).toBe("not_listed");

    expect(personalLibrariesForAdmin()[0]).toMatchObject({ ownerId: "mia", phones: 1, sizeBytes: photo.length });

    const revoked = await admin.delete(`/api/photo-sync/members/mia/phones/${deviceId}`);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().phones).toEqual([]);
    expect((await dav("PROPFIND", "/dav/", { headers: { depth: "0" } })).statusCode).toBe(401);
    expect(activity("photo_sync.phone_revoked")[0]!.detail).toContain("for a member");
    expect(personalLibrariesForAdmin()[0]!.phones).toBe(0);
  });
});

// Phase 5: the history in Logs, the end of a problem, out-of-touch phones, a library
// near its limit, and the admin's Security › Phone sync.
describe("phase 5: what happened and what is wrong now", () => {
  const VPN_IP = "192.168.12.2";

  it("ends a network refusal with the next contact, and says so in the log", async () => {
    await dav("PROPFIND", "/dav/", { ip: VPN_IP, headers: { depth: "0" } });
    expect(status().problem).toMatchObject({ code: "not_listed", detail: VPN_IP, current: true });
    addSyncNetwork("192.168.12.0/24", "VPN", "admin");
    expect((await dav("PROPFIND", "/dav/", { ip: VPN_IP, headers: { depth: "0" } })).statusCode).toBe(207);
    expect(status().problem).toMatchObject({ code: "not_listed", current: false });
    expect(activity("photo_sync.recovered")).toEqual([expect.objectContaining({ target_id: deviceId, detail: 'Phone "Mia\'s tablet" is backing up again.' })]);
    // Another request changes nothing more.
    await dav("PROPFIND", "/dav/", { ip: VPN_IP, headers: { depth: "0" } });
    expect(activity("photo_sync.recovered")).toHaveLength(1);
  });

  it("ends a file problem only when a file goes through, a repeat included", async () => {
    setFreeSpaceProbeForTests(() => 0);
    const photo = await jpeg(1);
    expect((await send("a.jpg", photo)).statusCode).toBe(507);
    setFreeSpaceProbeForTests(null);
    await dav("PROPFIND", "/dav/", { headers: { depth: "0" } });
    expect(status().problem).toMatchObject({ code: "disk_full", current: true });
    expect((await send("a.jpg", photo)).statusCode).toBe(201);
    expect(status().problem).toMatchObject({ code: "disk_full", current: false });
    expect(activity("photo_sync.recovered")).toHaveLength(1);
    // The same problem again is a new story: logged again, current again.
    setFreeSpaceProbeForTests(() => 0);
    expect((await send("b.jpg", await jpeg(2))).statusCode).toBe(507);
    expect(status().problem).toMatchObject({ code: "disk_full", current: true });
    expect(activity("photo_sync.failed")).toHaveLength(2);
  });

  it("logs a first contact and a move to another phone-sync network, not every request", async () => {
    addSyncNetwork("192.168.12.0/24", "UniFi VPN", "admin");
    await dav("PROPFIND", "/dav/", { headers: { depth: "0" } });
    await dav("PROPFIND", "/dav/", { headers: { depth: "0" } });
    await dav("PROPFIND", "/dav/", { ip: "192.168.1.40", headers: { depth: "0" } });
    await dav("PROPFIND", "/dav/", { ip: VPN_IP, headers: { depth: "0" } });
    expect(activity("photo_sync.connected").map((row) => row.detail)).toEqual([
      'Phone "Mia\'s tablet" made its first contact, from Tablet Wi-Fi (192.168.1.36).',
      'Phone "Mia\'s tablet" now connects from UniFi VPN (192.168.12.2).'
    ]);
  });

  it("logs a refused password from inside a network — a revoked phone by name, once an hour — but not a missing one", async () => {
    const admin = booted.as(await booted.signIn("admin"));
    await admin.delete(`/api/photo-sync/members/mia/phones/${deviceId}`);
    for (let i = 0; i < 3; i++) expect((await dav("PROPFIND", "/dav/", { headers: { depth: "0" } })).statusCode).toBe(401);
    const unknown = `Basic ${Buffer.from("x:isp_photo-sync_nothing").toString("base64")}`;
    expect((await dav("PROPFIND", "/dav/", { headers: { depth: "0", authorization: unknown } })).statusCode).toBe(401);
    expect((await app.inject({ method: "PROPFIND" as InjectOptions["method"], url: "/dav/", remoteAddress: PHONE_IP })).statusCode).toBe(401);
    const refused = activity("photo_sync.refused");
    expect(refused).toEqual([
      expect.objectContaining({ target_id: deviceId, detail: expect.stringContaining("its password was revoked") }),
      expect.objectContaining({ target_id: null, detail: "A phone was refused: its password matches no phone." })
    ]);
  });

  it("calls a phone stale after a week without contact", () => {
    const now = Date.parse("2026-11-20T00:00:00.000Z");
    const day = 86_400_000;
    expect(isPhoneStale({ last_seen_at: new Date(now - (STALE_DAYS - 1) * day).toISOString(), created_at: "2026-01-01T00:00:00.000Z" }, now)).toBe(false);
    expect(isPhoneStale({ last_seen_at: new Date(now - STALE_DAYS * day).toISOString(), created_at: "2026-01-01T00:00:00.000Z" }, now)).toBe(true);
    // Never seen: counted from when it was added.
    expect(isPhoneStale({ last_seen_at: null, created_at: new Date(now - day).toISOString() }, now)).toBe(false);
    expect(isPhoneStale({ last_seen_at: null, created_at: new Date(now - 8 * day).toISOString() }, now)).toBe(true);
  });

  it("warns the owner before the size limit, on the Phones view", async () => {
    const photo = await jpeg(1);
    await send("a.jpg", photo);
    const me = booted.as(await booted.signIn("mia"));
    expect((await me.get("/api/profile/phones")).json().usage).toBeNull();
    savePersonalSettings({ ...getPersonalSettings(), sizeLimitGB: (photo.length / 0.95) / 1024 ** 3 }, "admin");
    expect((await me.get("/api/profile/phones")).json().usage).toMatchObject({ usedBytes: photo.length, nearLimit: true, atLimit: false });
    savePersonalSettings({ ...getPersonalSettings(), sizeLimitGB: (photo.length * 2) / 1024 ** 3 }, "admin");
    expect((await me.get("/api/profile/phones")).json().usage).toMatchObject({ nearLimit: false, atLimit: false });
  });

  it("gives the admin every phone on Security › Phone sync, with the fix for an address on no list", async () => {
    expect((await booted.as(await booted.signIn("mia")).get("/api/photo-sync/phones")).statusCode).toBe(403);
    await send("a.jpg", await jpeg(1));
    await dav("PUT", "/dav/Tab/x.dng", { payload: Buffer.from("raw") });
    const admin = booted.as(await booted.signIn("admin"));
    let view = (await admin.get("/api/photo-sync/phones")).json();
    expect(view.networks).toHaveLength(1);
    expect(view.phones).toEqual([expect.objectContaining({
      id: deviceId, label: "Mia's tablet", member: { id: "mia", name: expect.any(String) }, lastIp: PHONE_IP,
      network: "Tablet Wi-Fi", problem: null, stale: false, nearLimit: false, suggestedRange: null
    })]);
    // The privacy line: no counts, no files, no file types.
    expect(JSON.stringify(view)).not.toMatch(/a\.jpg|\.dng|Tab\/|"files"|"total"/);

    await dav("PROPFIND", "/dav/", { ip: VPN_IP, headers: { depth: "0" } });
    view = (await admin.get("/api/photo-sync/phones")).json();
    expect(view.phones[0]).toMatchObject({ problem: { code: "not_listed", detail: VPN_IP, current: true }, suggestedRange: "192.168.12.0/24" });
    expect((await admin.post("/api/photo-sync/networks", { cidr: "192.168.12.0/24", label: "VPN" })).statusCode).toBe(201);
    view = (await admin.get("/api/photo-sync/phones")).json();
    expect(view.phones[0].suggestedRange).toBeNull();
  });

  it("files a Live Photo's clip beside its still, even when its date falls on the next day", async () => {
    const photo = await jpeg(5);
    const day1 = String(Date.parse("2026-11-05T23:59:59Z") / 1000);
    const day2 = String(Date.parse("2026-11-06T00:00:01Z") / 1000);
    await dav("MKCOL", "/dav/Tab/");
    expect((await dav("PUT", "/dav/Tab/IMG_0100.JPG", { headers: { "content-type": "image/jpeg", "x-oc-mtime": day1 }, payload: photo })).statusCode).toBe(201);
    const movPath = path.join(base, "clip.mov");
    execFileSync((ffmpegStatic as unknown as string | null) || "ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mov", "-y", movPath
    ]);
    const res = await dav("PUT", "/dav/Tab/IMG_0100.MOV", { headers: { "content-type": "video/quicktime", "x-oc-mtime": day2 }, payload: fs.readFileSync(movPath) });
    expect(res.statusCode).toBe(201);
    const items = db.prepare(`
      SELECT li.folder_path, gd.motion_relative_path FROM library_items li JOIN gallery_details gd ON gd.item_id = li.id
      WHERE li.library_id = 'mine' AND li.deleted_at IS NULL
    `).all() as { folder_path: string; motion_relative_path: string | null }[];
    expect(items).toEqual([{
      folder_path: expect.stringMatching(/2026-11-05[/]IMG_0100[.]JPG$/),
      motion_relative_path: expect.stringMatching(/2026-11-05[/]IMG_0100[.]MOV$/)
    }]);
  });
});
