// Downloading a photo must save it under its own name. The route is
// /assets/:id/file, so with no Content-Disposition the browser names the save
// after the URL's last segment — every photo arriving as "file", "file (1)",
// "file (2)". These pin the header that stops that.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { galleryStreamPlugin, assetDisposition } from "../src/modules/library/gallery/stream.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

let app: FastifyInstance;
let root: string;

function makePhoto(id: string, relativePath: string, body = "jpeg-bytes"): string {
  const abs = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'GAL', 'gallery', ?, 'ready')"
  ).run(id, relativePath);
  db.prepare(
    "INSERT INTO gallery_details (item_id, kind, relative_path, mime_type) VALUES (?, 'photo', ?, 'image/jpeg')"
  ).run(id, relativePath);
  return id;
}

async function fetchAsset(id: string, query = "") {
  const response = await app.inject({
    method: "GET",
    url: `/api/library/gallery/assets/${id}/file${query}`,
    headers: { "x-test-user": "owner" }
  });
  return { status: response.statusCode, disposition: response.headers["content-disposition"] as string | undefined };
}

beforeEach(async () => {
  resetDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-dl-"));
  makeUser("owner");
  db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('GAL', 'GAL', 'gallery', ?, 'owner', '{}')").run(root);
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id
      ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined
      : undefined;
    if (!row) { reply.code(401).send({ error: "Unauthenticated" }); return; }
    request.user = row as never;
  });
  await app.register(galleryStreamPlugin);
  await app.ready();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("gallery download filename", () => {
  it("names an explicit download after the original file, not the route", async () => {
    makePhoto("p1", "2017/2017-12-19/IMG_4821.jpg");
    const { disposition } = await fetchAsset("p1", "?download=1");
    expect(disposition).toContain("attachment");
    expect(disposition).toContain('filename="IMG_4821.jpg"');
    expect(disposition).not.toContain('filename="file"');
  });

  it("still names the file when viewed inline, so \"Save image as\" gets it too", async () => {
    makePhoto("p1", "2017/IMG_4821.jpg");
    const { disposition } = await fetchAsset("p1");
    expect(disposition).toContain("inline");
    expect(disposition).toContain('filename="IMG_4821.jpg"');
  });

  it("carries a non-ASCII name in filename* and a safe fallback in filename", async () => {
    makePhoto("p1", "2017/Ёлка 2017.jpg");
    const { disposition } = await fetchAsset("p1", "?download=1");
    // The quoted form must stay ASCII; the RFC 5987 form carries the real name.
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("Ёлка 2017.jpg")}`);
    const quoted = /filename="([^"]*)"/.exec(disposition!)![1];
    expect(quoted).toMatch(/^[\x20-\x7E]*$/);
    expect(quoted).toContain(".jpg");
  });

  it("keeps the name on a ranged request, which is how a video downloads", async () => {
    makePhoto("p1", "2017/clip.mp4", "0123456789");
    const response = await app.inject({
      method: "GET",
      url: "/api/library/gallery/assets/p1/file?download=1",
      headers: { "x-test-user": "owner", range: "bytes=0-4" }
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers["content-disposition"]).toContain('filename="clip.mp4"');
  });
});

// Characters Windows forbids in a filename can't be round-tripped through a real
// file on disk, so the header builder is exercised directly here.
describe("assetDisposition (header building)", () => {
  it("does not let a quote or backslash break out of the quoted name", () => {
    const quoted = /filename="([^"]*)"/.exec(assetDisposition('2017/a"b\\c.jpg', { attachment: true }))![1];
    expect(quoted).toBe("a_b_c.jpg");
  });

  it("names the transcoded stand-in .mp4, since it is not the original container", () => {
    const header = assetDisposition("2017/clip.mov", { attachment: true, webCopy: true });
    expect(header).toContain('filename="clip.mp4"');
  });

  it("keeps the original extension when serving the original", () => {
    expect(assetDisposition("2017/clip.mov", { attachment: true })).toContain('filename="clip.mov"');
  });

  it("uses only the file's own name, never its folders", () => {
    const header = assetDisposition("2017/2017-12-19/IMG_4821.jpg", { attachment: true });
    expect(header).toContain('filename="IMG_4821.jpg"');
    expect(header).not.toContain("2017-12-19");
  });
});
