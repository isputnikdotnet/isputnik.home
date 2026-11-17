// The web app's files: sent precompressed when the browser accepts it, and the
// content-hashed ones under static/ cached for good, while index.html, sw.js and
// the rest are revalidated (core/static-files.ts). They once went out raw, with
// max-age=0 on everything.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMMUTABLE_CACHE, isHashedAsset, registerStaticFiles } from "../src/core/static-files.js";

let app: FastifyInstance;
let root = "";
const script = `console.log(${JSON.stringify("x".repeat(4000))});\n`;

function write(relative: string, body: string, compressed = true): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  if (compressed) {
    fs.writeFileSync(`${full}.br`, brotliCompressSync(Buffer.from(body)));
    fs.writeFileSync(`${full}.gz`, gzipSync(Buffer.from(body)));
  }
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-static-"));
  write("static/index-Ab12Cd34.js", script);
  write("index.html", `<!doctype html><title>x</title>${"<!-- pad -->".repeat(200)}`);
  write("sw.js", script);
  write("static/small-Zz99.css", "a{}", false);
  app = fastify();
  await registerStaticFiles(app, root);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const get = (url: string, encoding?: string) =>
  app.inject({ method: "GET", url, headers: encoding ? { "accept-encoding": encoding } : {} });

describe("the web app's files", () => {
  it("sends Brotli to a browser that takes it, as the same file", async () => {
    const res = await get("/static/index-Ab12Cd34.js", "gzip, deflate, br");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers.vary).toMatch(/accept-encoding/i);
    expect(brotliDecompressSync(res.rawPayload).toString()).toBe(script);
  });

  it("sends gzip when that is all it takes, and the plain file to one that takes neither", async () => {
    const gz = await get("/static/index-Ab12Cd34.js", "gzip");
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.rawPayload).toString()).toBe(script);
    const plain = await get("/static/index-Ab12Cd34.js");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.payload).toBe(script);
  });

  it("falls back to the plain file when there is no compressed copy", async () => {
    const res = await get("/static/small-Zz99.css", "br");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.payload).toBe("a{}");
  });

  it("caches the hashed files for good, compressed or not", async () => {
    expect((await get("/static/index-Ab12Cd34.js", "br")).headers["cache-control"]).toBe(IMMUTABLE_CACHE);
    expect((await get("/static/index-Ab12Cd34.js")).headers["cache-control"]).toBe(IMMUTABLE_CACHE);
    expect((await get("/static/small-Zz99.css")).headers["cache-control"]).toBe(IMMUTABLE_CACHE);
  });

  it("keeps revalidating what a new release changes in place", async () => {
    for (const url of ["/index.html", "/sw.js"]) {
      const res = await get(url, "br");
      expect(res.headers["content-encoding"], url).toBe("br");
      expect(res.headers["cache-control"], url).not.toMatch(/immutable/);
    }
  });

  it("only counts files inside static/ as hashed", () => {
    expect(isHashedAsset(root, path.join(root, "static", "a-1.js"))).toBe(true);
    expect(isHashedAsset(root, path.join(root, "static", "a-1.js.br"))).toBe(true);
    expect(isHashedAsset(root, path.join(root, "sw.js"))).toBe(false);
    expect(isHashedAsset(root, path.join(root, "static"))).toBe(false);
    expect(isHashedAsset(root, path.join(root, "staticx", "a.js"))).toBe(false);
  });
});
