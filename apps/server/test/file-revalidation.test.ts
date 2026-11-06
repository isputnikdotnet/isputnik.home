// Media file routes send ETag/Last-Modified and answer 304, so a browser
// revalidates a cached photo instead of downloading it again
// (negotiateFileRequest in shared/document-stream.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { negotiateFileRequest, pipeFileToReply } from "../src/modules/library/shared/document-stream.js";

let dir: string;
let file: string;
let app: FastifyInstance;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "isp-reval-"));
  file = path.join(dir, "a.bin");
  fs.writeFileSync(file, "0123456789");
  app = Fastify();
  app.get("/f", (request, reply) => {
    const stat = fs.statSync(file);
    const negotiated = negotiateFileRequest(request, reply, stat);
    if (!negotiated) return;
    const { range, validators } = negotiated;
    reply.hijack();
    if (range) {
      reply.raw.writeHead(206, { ...validators, "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`, "Content-Length": range.size });
      pipeFileToReply(reply, file, { start: range.start, end: range.end });
    } else {
      reply.raw.writeHead(200, { ...validators, "Content-Length": stat.size });
      pipeFileToReply(reply, file);
    }
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("file revalidation", () => {
  it("sends validators and answers 304 to a matching If-None-Match", async () => {
    const first = await app.inject({ method: "GET", url: "/f" });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-z]+-[0-9a-z]+"$/);
    expect(first.headers["last-modified"]).toBeTruthy();

    const again = await app.inject({ method: "GET", url: "/f", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    expect(again.headers.etag).toBe(etag);

    // Browsers may send it weak; If-None-Match compares weakly.
    const weak = await app.inject({ method: "GET", url: "/f", headers: { "if-none-match": `W/${etag}` } });
    expect(weak.statusCode).toBe(304);
  });

  it("answers 304 to If-Modified-Since at or after the mtime", async () => {
    const first = await app.inject({ method: "GET", url: "/f" });
    const lm = first.headers["last-modified"] as string;
    const again = await app.inject({ method: "GET", url: "/f", headers: { "if-modified-since": lm } });
    expect(again.statusCode).toBe(304);
    const older = new Date(Date.parse(lm) - 60_000).toUTCString();
    const stale = await app.inject({ method: "GET", url: "/f", headers: { "if-modified-since": older } });
    expect(stale.statusCode).toBe(200);
  });

  it("serves the whole file again once it changes", async () => {
    const first = await app.inject({ method: "GET", url: "/f" });
    const etag = first.headers.etag as string;
    fs.writeFileSync(file, "changed contents");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    const again = await app.inject({ method: "GET", url: "/f", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe("changed contents");
    expect(again.headers.etag).not.toBe(etag);
  });

  it("honours a range only while If-Range still matches", async () => {
    const current = (await app.inject({ method: "GET", url: "/f" })).headers.etag as string;
    const ranged = await app.inject({ method: "GET", url: "/f", headers: { range: "bytes=0-3", "if-range": current } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toHaveLength(4);

    const stale = await app.inject({ method: "GET", url: "/f", headers: { range: "bytes=0-3", "if-range": "\"old-tag\"" } });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toBe(fs.readFileSync(file, "utf8"));
  });

  it("still refuses an unsatisfiable range", async () => {
    const res = await app.inject({ method: "GET", url: "/f", headers: { range: "bytes=500-600" } });
    expect(res.statusCode).toBe(416);
  });
});
