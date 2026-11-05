// Photo Sync phase 0 spike (src/modules/library/gallery/sync/spike.ts): enough of
// WebDAV for a phone app to get through a backup, behind the real CSRF hook, with
// every request in the log. Throwaway, like the spike itself.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootApp } from "./helpers/boot.js";
import { photoSyncSpikePlugin } from "../src/modules/library/gallery/sync/spike.js";

const auth = { authorization: `Basic ${Buffer.from("phone-a:spike").toString("base64")}` };

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-sync-spike-"));
  ({ app } = await bootApp({ csrf: true, plugins: [[photoSyncSpikePlugin, { dir }]] }));
});

afterEach(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const log = () => fs.readFileSync(path.join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("Photo Sync spike", () => {
  it("answers OPTIONS without credentials and challenges everything else", async () => {
    const options = await app.inject({ method: "OPTIONS", url: "/dav/" });
    expect(options.statusCode).toBe(200);
    expect(options.headers.dav).toContain("1");
    expect(options.headers.allow).toContain("PROPFIND");

    const anonymous = await app.inject({ method: "PROPFIND", url: "/dav/", headers: { depth: "1" } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers["www-authenticate"]).toMatch(/^Basic /);

    const wrong = await app.inject({ method: "PROPFIND", url: "/dav/", headers: { authorization: `Basic ${Buffer.from("x:nope").toString("base64")}` } });
    expect(wrong.statusCode).toBe(401);
  });

  it("takes a backup the way an app sends one: MKCOL, PUT, PROPFIND, MOVE, GET", async () => {
    expect((await app.inject({ method: "MKCOL", url: "/dav/2026", headers: auth })).statusCode).toBe(201);
    expect((await app.inject({ method: "MKCOL", url: "/dav/2026", headers: auth })).statusCode).toBe(405);
    expect((await app.inject({ method: "MKCOL", url: "/dav/x/y", headers: auth })).statusCode).toBe(409);

    // No Content-Type at all, and a photo type — both reach the handler unparsed.
    const put = await app.inject({ method: "PUT", url: "/dav/2026/IMG_0001.HEIC.part", headers: { ...auth, "x-oc-mtime": "1762300800" }, payload: Buffer.from("heic bytes") });
    expect(put.statusCode).toBe(201);
    expect(put.headers["x-oc-mtime"]).toBe("accepted");
    const typed = await app.inject({ method: "PUT", url: "/dav/2026/IMG_0001.MOV", headers: { ...auth, "content-type": "video/quicktime" }, payload: Buffer.from("mov") });
    expect(typed.statusCode).toBe(201);
    const again = await app.inject({ method: "PUT", url: "/dav/2026/IMG_0001.MOV", headers: { ...auth, "content-type": "video/quicktime" }, payload: Buffer.from("mov") });
    expect(again.statusCode).toBe(204);

    const move = await app.inject({ method: "MOVE", url: "/dav/2026/IMG_0001.HEIC.part", headers: { ...auth, destination: "http://phone.example/dav/2026/IMG_0001.HEIC" } });
    expect(move.statusCode).toBe(201);

    const list = await app.inject({
      method: "PROPFIND", url: "/dav/2026/", headers: { ...auth, depth: "1", "content-type": "application/xml" },
      payload: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>'
    });
    expect(list.statusCode).toBe(207);
    expect(list.body).toContain("<d:href>/dav/2026/IMG_0001.HEIC</d:href>");
    expect(list.body).toContain("<d:href>/dav/2026/IMG_0001.MOV</d:href>");
    expect(list.body).not.toContain(".part");

    const get = await app.inject({ method: "GET", url: "/dav/2026/IMG_0001.HEIC", headers: auth });
    expect(get.statusCode).toBe(200);
    expect(get.body).toBe("heic bytes");
    const head = await app.inject({ method: "HEAD", url: "/dav/2026/IMG_0001.HEIC", headers: auth });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe("10");
    expect(fs.statSync(path.join(dir, "files", "2026", "IMG_0001.HEIC")).mtime.getTime()).toBe(1762300800 * 1000);

    const entries = log();
    expect(entries.map((e) => e.method)).toEqual(["MKCOL", "MKCOL", "MKCOL", "PUT", "PUT", "PUT", "MOVE", "PROPFIND", "GET", "HEAD"]);
    const firstPut = entries[3];
    expect(firstPut.bodyBytes).toBe(10);
    expect(firstPut.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(firstPut.headers.authorization).toBe("Basic phone-a:***");
    expect(entries[7].body).toContain("getcontentlength");
  });

  it("refuses deletes, path escapes and a PUT into a missing folder", async () => {
    await app.inject({ method: "PUT", url: "/dav/a.jpg", headers: auth, payload: "x" });
    const del = await app.inject({ method: "DELETE", url: "/dav/a.jpg", headers: auth });
    expect(del.statusCode).toBe(403);
    expect(fs.existsSync(path.join(dir, "files", "a.jpg"))).toBe(true);

    // The URL parser may resolve the dot segment before routing (then it is not a
    // /dav path at all and CSRF refuses it); either way it must not be stored.
    expect((await app.inject({ method: "PUT", url: "/dav/%2e%2e/escape.jpg", headers: auth, payload: "x" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "PUT", url: "/dav/a%2Fb.jpg", headers: auth, payload: "x" })).statusCode).toBe(400);
    expect((await app.inject({ method: "MOVE", url: "/dav/a.jpg", headers: { ...auth, destination: "/elsewhere/a.jpg" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/dav/missing/b.jpg", headers: auth, payload: "x" })).statusCode).toBe(409);
    expect(fs.existsSync(path.join(dir, "escape.jpg"))).toBe(false);
  });

  it("streams a large upload over a real socket and refuses a raw .. path", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const big = crypto.randomBytes(24 * 1024 * 1024);

    const put = await rawRequest(port, "PUT", "/dav/VID_0001.MOV", { ...auth, "content-length": String(big.length), expect: "100-continue" }, big);
    expect(put).toBe(201);
    const stored = fs.readFileSync(path.join(dir, "files", "VID_0001.MOV"));
    expect(crypto.createHash("sha256").update(stored).digest("hex")).toBe(crypto.createHash("sha256").update(big).digest("hex"));
    expect(log().at(-1).sha256).toBe(crypto.createHash("sha256").update(big).digest("hex"));

    // http.request sends the path exactly as written — no dot-segment resolution.
    expect(await rawRequest(port, "PUT", "/dav/../escape.bin", { ...auth, "content-length": "1" }, Buffer.from("x"))).toBeGreaterThanOrEqual(400);
    expect(await rawRequest(port, "PUT", "/dav/%2e%2e/escape.bin", { ...auth, "content-length": "1" }, Buffer.from("x"))).toBe(400);
    expect(fs.existsSync(path.join(dir, "escape.bin"))).toBe(false);
    expect(fs.readdirSync(path.join(dir, "files")).filter((n) => n.endsWith(".spike-part"))).toEqual([]);
  });
});

function rawRequest(port: number, method: string, urlPath: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    if (headers.expect) request.on("continue", () => request.end(body));
    else request.end(body);
  });
}
