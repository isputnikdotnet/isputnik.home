// Photo Sync phase 4 (docs/photo-sync-plan.md): how each phone's backup is going, for
// its owner (everything) and for an admin (the phone and the library's size — never a
// count of what was sent, never a file, and only problems about the phone or server).
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
import { setFreeSpaceProbeForTests } from "../src/modules/library/gallery/sync/put.js";
import { phoneStatuses, resetPhoneStatusThrottleForTests } from "../src/modules/library/gallery/sync/status.js";
import { personalLibrariesForAdmin } from "../src/modules/library/gallery/personal/service.js";
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

const status = () => phoneStatuses([{ id: deviceId, last_seen_at: null }]).get(deviceId)!;

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
    expect(s.problem).toEqual({ code: "type", detail: ".dng", at: expect.any(String) });
    expect(JSON.stringify(db.prepare("SELECT * FROM photo_sync_device_status").all())).not.toContain("secret");
    // Not a device-level problem: the admin's log hears nothing of it.
    expect(activity("photo_sync.%").filter((row) => row.event !== "photo_sync.phone_added")).toEqual([]);
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
    expect(status().problem).toEqual({ code: "not_listed", detail: "10.9.9.9", at: expect.any(String) });
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
    expect(view.phones).toEqual([{ id: deviceId, label: "Mia's tablet", createdAt: expect.any(String), lastSeen: expect.any(String), problem: null }]);
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
