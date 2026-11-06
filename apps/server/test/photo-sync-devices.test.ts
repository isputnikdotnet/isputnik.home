// Photo Sync phase 2 (docs/photo-sync-plan.md): who may sync and from where, before a
// byte arrives. The gate (phone-sync networks, apart from trusted networks; the
// believable-address rule), the phone tokens bound to a personal library, and what
// revokes them.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { addTrustedNetwork } from "../src/core/security.js";
import { createApiToken } from "../src/core/api-tokens.js";
import {
  addSyncNetwork, copyTrustedNetworks, isSyncRequestAllowed, parseSyncAddress, phoneSyncAddress, saveSyncAddress,
  syncAddressOutsideNetworks, syncGateVerdict
} from "../src/modules/library/gallery/sync/networks.js";
import {
  addPhone, authenticatePhone, listPhones, resolvePhoneToken, revokePhone, revokePhonesOfUser
} from "../src/modules/library/gallery/sync/devices.js";
import { photoSyncRoutesPlugin } from "../src/modules/library/gallery/sync/routes.js";
import { handOverPersonalLibrary, orphanPersonalLibraryOf } from "../src/modules/library/gallery/personal/service.js";
import { deleteGalleryLibraryRecord } from "../src/modules/library/gallery/library-delete.js";
import { usersPlugin } from "../src/modules/users/users.js";
import { bootApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

const req = (ip: string, headers: Record<string, unknown> = {}) => ({ ip, headers });

function markPersonal(libraryId: string, userId: string) {
  db.prepare("UPDATE libraries SET personal_user_id = ?, owner_id = ?, owner_type = 'user' WHERE id = ?").run(userId, userId, libraryId);
}

function basic(token: string, user = "mia@test.local") {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

function fakeRequest(ip: string, authorization?: string, extra: Record<string, unknown> = {}): FastifyRequest {
  return { ip, headers: { ...(authorization ? { authorization } : {}), ...extra } } as unknown as FastifyRequest;
}

const tokenAbuse = (ip: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip_address = ? AND kind = 'token'").get(ip) as { n: number }).n;

beforeEach(() => {
  resetDb();
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.TRUST_PROXY;
  makeUser("admin", "admin");
  makeUser("mia");
  makeUser("olga");
  makeLibrary("mine", { createdBy: "mia", type: "gallery" });
  markPersonal("mine", "mia");
  makeLibrary("fam", { createdBy: "admin", type: "gallery" });
});

afterEach(() => {
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.TRUST_PROXY;
});

describe("the gate", () => {
  it("is off while the list is empty, even for a LAN address", () => {
    expect(syncGateVerdict(req("192.168.1.20"))).toEqual({ allowed: false, reason: "off" });
  });

  it("allows an address inside a listed network and refuses one outside", () => {
    addSyncNetwork("192.168.1.0/24", "Home Wi-Fi", "admin");
    expect(isSyncRequestAllowed(req("192.168.1.20"))).toBe(true);
    expect(syncGateVerdict(req("192.168.2.20"))).toEqual({ allowed: false, reason: "not_listed" });
    expect(syncGateVerdict(req("8.8.8.8"))).toEqual({ allowed: false, reason: "not_listed" });
  });

  it("ignores trusted networks: they are a separate list", () => {
    addTrustedNetwork("10.0.0.0/8", "VPN", "admin");
    expect(syncGateVerdict(req("10.1.2.3"))).toEqual({ allowed: false, reason: "off" });
    addSyncNetwork("192.168.1.0/24", null, "admin");
    expect(syncGateVerdict(req("10.1.2.3"))).toEqual({ allowed: false, reason: "not_listed" });
  });

  it("refuses a forwarded request when proxy trust is unconfigured, whatever the address", () => {
    addSyncNetwork("172.16.0.0/12", "Docker", "admin");
    // Behind an unconfigured proxy request.ip is the proxy's — inside the list, proving nothing.
    expect(syncGateVerdict(req("172.18.0.2", { "x-forwarded-for": "203.0.113.9" }))).toEqual({ allowed: false, reason: "proxy" });
    expect(syncGateVerdict(req("172.18.0.2", { forwarded: "for=203.0.113.9" }))).toEqual({ allowed: false, reason: "proxy" });
    // Configured, the address is believed again (Fastify has already resolved request.ip).
    process.env.TRUST_PROXY_HOPS = "1";
    expect(isSyncRequestAllowed(req("172.18.0.5", { "x-forwarded-for": "172.18.0.5" }))).toBe(true);
    delete process.env.TRUST_PROXY_HOPS;
    process.env.TRUST_PROXY = "172.18.0.2";
    expect(isSyncRequestAllowed(req("172.18.0.5", { "x-forwarded-for": "172.18.0.5" }))).toBe(true);
  });

  it("matches IPv6 ranges and IPv4-mapped addresses", () => {
    addSyncNetwork("fd00:1234::/32", "WireGuard", "admin");
    addSyncNetwork("192.168.1.0/24", null, "admin");
    expect(isSyncRequestAllowed(req("fd00:1234:0:1::5"))).toBe(true);
    expect(isSyncRequestAllowed(req("fd00:9999::5"))).toBe(false);
    expect(isSyncRequestAllowed(req("::ffff:192.168.1.20"))).toBe(true);
    expect(isSyncRequestAllowed(req("::ffff:192.168.2.20"))).toBe(false);
  });

  it("refuses bad ranges and duplicates", () => {
    expect(() => addSyncNetwork("192.168.1.0/33", null, "admin")).toThrow(/valid IP/);
    expect(() => addSyncNetwork("home", null, "admin")).toThrow(/valid IP/);
    addSyncNetwork("192.168.1.0/24", null, "admin");
    expect(() => addSyncNetwork("192.168.1.0/24", null, "admin")).toThrow(/already/);
  });

  it("copies trusted networks once, with their labels, and leaves the lists apart", () => {
    addTrustedNetwork("192.168.1.0/24", "Home", "admin");
    addTrustedNetwork("10.8.0.0/24", "VPN", "admin");
    addSyncNetwork("10.8.0.0/24", "Already here", "admin");
    expect(copyTrustedNetworks("admin")).toBe(1);
    expect(copyTrustedNetworks("admin")).toBe(0);
    const rows = db.prepare("SELECT cidr, label FROM sync_networks ORDER BY cidr").all();
    expect(rows).toEqual([{ cidr: "10.8.0.0/24", label: "Already here" }, { cidr: "192.168.1.0/24", label: "Home" }]);
    db.prepare("DELETE FROM sync_networks").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM trusted_networks").get() as { n: number }).n).toBe(2);
  });
});

describe("the address phones are told", () => {
  it("is only what the admin typed — never guessed", () => {
    addSyncNetwork("192.168.1.0/24", null, "admin");
    expect(phoneSyncAddress()).toBeNull();
    saveSyncAddress(parseSyncAddress("http://192.168.1.10:4000/"), "admin");
    expect(phoneSyncAddress()).toEqual({ url: "http://192.168.1.10:4000", host: "192.168.1.10", port: 4000, ssl: false });
    saveSyncAddress(parseSyncAddress("https://nas.lan"), "admin");
    expect(phoneSyncAddress()).toEqual({ url: "https://nas.lan", host: "nas.lan", port: 443, ssl: true });
    saveSyncAddress(parseSyncAddress("http://[fd00::5]:4000"), "admin");
    expect(phoneSyncAddress()).toMatchObject({ host: "fd00::5", port: 4000 });
    saveSyncAddress(null, "admin");
    expect(phoneSyncAddress()).toBeNull();
  });

  it("must be an http(s) URL with nothing after the port", () => {
    for (const bad of ["192.168.1.10:4000", "ftp://192.168.1.10", "http://192.168.1.10:4000/dav/", "http://u:p@192.168.1.10", "http://x?y=1", "nope"]) {
      expect(parseSyncAddress(bad)).toBeNull();
    }
  });

  it("warns, never blocks, when it is an IP outside every listed network", () => {
    addSyncNetwork("192.168.1.0/24", null, "admin");
    saveSyncAddress("http://192.168.2.10:4000", "admin");
    expect(syncAddressOutsideNetworks()).toBe(true);
    saveSyncAddress("http://192.168.1.10:4000", "admin");
    expect(syncAddressOutsideNetworks()).toBe(false);
    saveSyncAddress("http://nas.lan:4000", "admin");
    expect(syncAddressOutsideNetworks()).toBe(false);
  });
});

describe("phones", () => {
  beforeEach(() => addSyncNetwork("192.168.1.0/24", null, "admin"));

  it("needs a live personal library", () => {
    expect(() => addPhone({ id: "olga" }, "Pixel", null)).toThrow(/personal library/);
    orphanPersonalLibraryOf("mia", "admin", null);
    expect(() => addPhone({ id: "mia" }, "Pixel", null)).toThrow(/personal library/);
  });

  it("is a photo-sync token bound to the library, hashed, and resolves from a listed network", () => {
    const { raw, id } = addPhone({ id: "mia" }, "Galaxy S25", null);
    expect(raw).toMatch(/^isp_photo-sync_[0-9A-Za-z]{32}$/);
    const row = db.prepare("SELECT scope, label, library_id, token_hash FROM api_tokens WHERE id = ?").get(id) as Record<string, string>;
    expect(row).toMatchObject({ scope: "photo-sync", label: "Galaxy S25", library_id: "mine" });
    expect(row.token_hash).not.toContain(raw);
    const result = authenticatePhone(fakeRequest("192.168.1.30", basic(raw)));
    expect(result).toMatchObject({ ok: true, phone: { deviceId: id, libraryId: "mine", label: "Galaxy S25", user: { id: "mia" } } });
    expect(listPhones("mia")[0]).toMatchObject({ id, last_ip: "192.168.1.30" });
    expect(listPhones("mia")[0].last_seen_at).not.toBeNull();
  });

  it("refuses duplicate names", () => {
    addPhone({ id: "mia" }, "Pixel", null);
    expect(() => addPhone({ id: "mia" }, "pixel", null)).toThrow(/already/);
  });

  it("stops at the network before looking at the token", () => {
    const { raw } = addPhone({ id: "mia" }, "Pixel", null);
    expect(authenticatePhone(fakeRequest("203.0.113.5", basic(raw)))).toEqual({ ok: false, reason: "network" });
    expect(listPhones("mia")[0].last_seen_at).toBeNull();
    expect(authenticatePhone(fakeRequest("192.168.1.30", basic(raw), { "x-forwarded-for": "192.168.1.30" })))
      .toEqual({ ok: false, reason: "network" });
  });

  it("flags unknown tokens as abuse, but not a revoked one or a token of another scope's owner", () => {
    const { raw, id } = addPhone({ id: "mia" }, "Pixel", null);
    expect(authenticatePhone(fakeRequest("192.168.1.31", basic("isp_photo-sync_guessguessguessguessguessguessgues"))))
      .toEqual({ ok: false, reason: "credentials" });
    expect(tokenAbuse("192.168.1.31")).toBe(1);
    // Outside the network a guess is still a guess.
    authenticatePhone(fakeRequest("203.0.113.7", basic("isp_photo-sync_nopenopenopenopenopenopenopenopeno")));
    expect(tokenAbuse("203.0.113.7")).toBe(1);

    revokePhone("mia", id, null);
    expect(authenticatePhone(fakeRequest("192.168.1.32", basic(raw)))).toEqual({ ok: false, reason: "credentials" });
    expect(tokenAbuse("192.168.1.32")).toBe(0);
    // No credentials at all: a client probing before the challenge, not abuse.
    expect(authenticatePhone(fakeRequest("192.168.1.33"))).toEqual({ ok: false, reason: "credentials" });
    expect(tokenAbuse("192.168.1.33")).toBe(0);
  });

  it("never accepts another scope's token or the account password", () => {
    const opds = createApiToken("mia", "Kobo", "opds").raw;
    expect(resolvePhoneToken(opds, null)).toBeNull();
    expect(authenticatePhone(fakeRequest("192.168.1.30", basic("x")))).toEqual({ ok: false, reason: "credentials" });
  });

  it("only revokes the member's own phone", () => {
    const { id } = addPhone({ id: "mia" }, "Pixel", null);
    expect(revokePhone("olga", id, null)).toBe(false);
    expect(revokePhone("mia", id, null)).toBe(true);
    expect(listPhones("mia")).toEqual([]);
  });

  it("stop when the member is removed, or the library is orphaned, handed over or deleted", () => {
    const a = addPhone({ id: "mia" }, "A", null).raw;
    expect(revokePhonesOfUser("mia")).toBe(1);
    expect(resolvePhoneToken(a, null)).toBeNull();

    const b = addPhone({ id: "mia" }, "B", null).raw;
    orphanPersonalLibraryOf("mia", "admin", null);
    expect(resolvePhoneToken(b, null)).toBeNull();
    expect(listPhones("mia")).toEqual([]);

    // Handed to Olga: Mia's old phones never write into it again, Olga adds her own.
    handOverPersonalLibrary("mine", "olga", "admin", null);
    expect(resolvePhoneToken(b, null)).toBeNull();
    const c = addPhone({ id: "olga" }, "C", null).raw;
    expect(resolvePhoneToken(c, null)?.libraryId).toBe("mine");
    deleteGalleryLibraryRecord("mine");
    expect(resolvePhoneToken(c, null)).toBeNull();
    expect(listPhones("olga")).toEqual([]);
  });

  it("stop at once even without a revoke when the binding no longer holds", () => {
    const { raw } = addPhone({ id: "mia" }, "Pixel", null);
    db.prepare("UPDATE libraries SET personal_orphaned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'mine'").run();
    expect(resolvePhoneToken(raw, null)).toBeNull();
    db.prepare("UPDATE libraries SET personal_orphaned_at = NULL WHERE id = 'mine'").run();
    db.prepare("UPDATE users SET is_active = 0 WHERE id = 'mia'").run();
    expect(resolvePhoneToken(raw, null)).toBeNull();
  });
});

describe("through the API", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;

  beforeEach(async () => {
    ({ app, signIn } = await bootApp({ plugins: [photoSyncRoutesPlugin, usersPlugin] }));
  });
  afterEach(async () => {
    await app.close();
  });

  const as = async (userId: string, extra: Record<string, string> = {}) => ({ cookie: await signIn(userId), ...extra });

  it("lets only an admin keep the networks", async () => {
    expect((await app.inject({ method: "GET", url: "/api/photo-sync/networks", headers: await as("mia") })).statusCode).toBe(403);
    const added = await app.inject({ method: "POST", url: "/api/photo-sync/networks", headers: await as("admin"), payload: { cidr: "192.168.1.0/24", label: "Home" } });
    expect(added.statusCode).toBe(201);
    expect(added.json().networks).toEqual([expect.objectContaining({ cidr: "192.168.1.0/24", label: "Home" })]);
    const bad = await app.inject({ method: "POST", url: "/api/photo-sync/networks", headers: await as("admin"), payload: { cidr: "nope" } });
    expect(bad.json()).toMatchObject({ code: "bad_cidr" });
    // A range typed without its size (the phase 5 VPN run) is caught, not stored.
    const bare = await app.inject({ method: "POST", url: "/api/photo-sync/networks", headers: await as("admin"), payload: { cidr: "192.168.12.0" } });
    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toMatchObject({ code: "bare_network" });
    expect(bare.json().error ?? bare.json().message).toContain("192.168.12.0/24");
    const id = added.json().networks[0].id;
    const removed = await app.inject({ method: "DELETE", url: `/api/photo-sync/networks/${id}`, headers: await as("admin") });
    expect(removed.json().networks).toEqual([]);

    addTrustedNetwork("10.0.0.0/8", "VPN", "admin");
    const copied = await app.inject({ method: "POST", url: "/api/photo-sync/networks/copy-trusted", headers: await as("admin") });
    expect(copied.json()).toMatchObject({ added: 1, networks: [expect.objectContaining({ cidr: "10.0.0.0/8" })] });

    const address = await app.inject({ method: "PUT", url: "/api/photo-sync/address", headers: await as("admin"), payload: { address: "http://192.168.1.10:4000" } });
    expect(address.json()).toMatchObject({ address: "http://192.168.1.10:4000", addressOutsideNetworks: true });
    const badAddress = await app.inject({ method: "PUT", url: "/api/photo-sync/address", headers: await as("admin"), payload: { address: "192.168.1.10:4000" } });
    expect(badAddress.json()).toMatchObject({ code: "bad_address" });
    const cleared = await app.inject({ method: "PUT", url: "/api/photo-sync/address", headers: await as("admin"), payload: { address: null } });
    expect(cleared.json().address).toBeNull();
  });

  it("says phone sync is unavailable while no network is set", async () => {
    const view = await app.inject({ method: "GET", url: "/api/profile/phones", headers: await as("mia") });
    expect(view.json()).toMatchObject({ unavailable: "off", phones: [] });
    const add = await app.inject({ method: "POST", url: "/api/profile/phones", headers: await as("mia"), payload: { label: "Pixel" } });
    expect(add.statusCode).toBe(409);
    expect(add.json().code).toBe("sync_off");
  });

  it("adds a phone, shows its token and setup once, lists it without the secret, revokes it", async () => {
    addSyncNetwork("192.168.1.0/24", null, "admin");
    expect((await app.inject({ method: "GET", url: "/api/profile/phones", headers: await as("olga") })).json().unavailable).toBe("no_library");

    const add = await app.inject({
      method: "POST", url: "/api/profile/phones", headers: await as("mia", { host: "192.168.1.10:4000" }), payload: { label: "Galaxy S25" }
    });
    expect(add.statusCode).toBe(201);
    const body = add.json();
    expect(body.added.token).toMatch(/^isp_photo-sync_/);
    // No address set: the phone is still added and the token still shown once; the card
    // says the admin hasn't set the address. The browser's Host is never used.
    expect(body.added.setup).toEqual({
      address: null, host: null, port: null, path: "/dav/", ssl: false, username: "mia@test.local"
    });
    saveSyncAddress("http://192.168.1.10:4000", "admin");
    const second = await app.inject({ method: "POST", url: "/api/profile/phones", headers: await as("mia"), payload: { label: "Tablet" } });
    expect(second.json().added.setup).toMatchObject({ address: "http://192.168.1.10:4000", host: "192.168.1.10", port: 4000, ssl: false });
    const list = await app.inject({ method: "GET", url: "/api/profile/phones", headers: await as("mia") });
    expect(list.json().unavailable).toBeNull();
    expect(list.json().phones).toEqual([
      expect.objectContaining({ label: "Tablet" }),
      expect.objectContaining({ id: body.added.id, label: "Galaxy S25", lastSeen: null })
    ]);
    expect(JSON.stringify(list.json())).not.toContain(body.added.token);

    expect((await app.inject({ method: "DELETE", url: `/api/profile/phones/${body.added.id}`, headers: await as("olga") })).statusCode).toBe(404);
    const revoked = await app.inject({ method: "DELETE", url: `/api/profile/phones/${body.added.id}`, headers: await as("mia") });
    expect(revoked.json().phones).toEqual([expect.objectContaining({ label: "Tablet" })]);
  });

  it("revokes a removed member's phones", async () => {
    addSyncNetwork("192.168.1.0/24", null, "admin");
    const { raw } = addPhone({ id: "mia" }, "Pixel", null);
    const res = await app.inject({ method: "DELETE", url: "/api/users/mia", headers: await as("admin") });
    expect(res.statusCode).toBe(200);
    expect(db.prepare("SELECT revoked_at FROM api_tokens WHERE scope = 'photo-sync'").get()).toMatchObject({ revoked_at: expect.any(String) });
    expect(resolvePhoneToken(raw, null)).toBeNull();
  });
});
