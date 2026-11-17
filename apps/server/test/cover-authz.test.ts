// Cover/thumbnail keys are deterministic (<libraryId>/<shard>/<item>-cover.webp),
// so authentication alone let any signed-in user fetch a private library's
// thumbnails by reconstructing the key. These pin the per-library access gate:
// an outsider 404s on a private library's bucket, a member gets the file, and the
// shared people/categories buckets stay readable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { coversPlugin } from "../src/modules/library/covers.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, grant } from "./helpers/seed.js";

let app: FastifyInstance;
let store: string;

// Write a .webp under the sharded path thumbnailStorageKey() would produce.
function writeThumb(bucket: string, resourceId: string, fileName: string): string {
  const shard = resourceId.slice(0, 4).padEnd(4, "0");
  const key = `${bucket}/${shard.slice(0, 2)}/${shard.slice(2, 4)}/${fileName}`;
  const abs = path.join(store, ...key.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "webp-bytes");
  return key;
}

async function get(key: string, user: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/library/covers/${key}`,
    headers: { "x-test-user": user }
  });
  return res.statusCode;
}

beforeEach(async () => {
  resetDb();
  store = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-cov-"));
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, store);
  makeUser("member");
  makeUser("outsider");
  // A private library (id must be 16 chars to read as a library bucket).
  const libId = "privatelib000001";
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES (?, 'P', 'audiobook', '/src', 'member', '{}')"
  ).run(libId);
  grant("user", "member", libId, "member");

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined) : undefined;
    if (!row) { reply.code(401).send({ error: "no" }); return; }
    request.user = row as never;
  });
  await app.register(coversPlugin);
  await app.ready();
});

afterEach(() => {
  fs.rmSync(store, { recursive: true, force: true });
});

describe("cover route enforces library access", () => {
  it("404s a private library's cover for an outsider", async () => {
    const key = writeThumb("privatelib000001", "item0001", "item0001-cover.webp");
    expect(await get(key, "outsider")).toBe(404);
  });

  it("serves it to a member of that library", async () => {
    const key = writeThumb("privatelib000001", "item0001", "item0001-cover.webp");
    expect(await get(key, "member")).toBe(200);
  });

  it("serves the shared people/categories buckets to any signed-in user", async () => {
    const personKey = writeThumb("people", "person01", "person01-face.webp");
    const catKey = writeThumb("categories", "cat00001", "cat00001-cover.webp");
    expect(await get(personKey, "outsider")).toBe(200);
    expect(await get(catKey, "outsider")).toBe(200);
  });

  it("blocks the encoded-slash traversal that collapses into a private bucket", async () => {
    writeThumb("privatelib000001", "item0001", "item0001-cover.webp");
    // %2f decodes into the wildcard param; the key collapses on disk to
    // privatelib000001/... The gate must derive the bucket from the resolved path.
    const status = await get("x%2f..%2fprivatelib000001/it/em/item0001-cover.webp", "outsider");
    expect(status).toBe(404);
  });

  it("refuses a non-image key so the route can't stream e.g. a slideshow movie", async () => {
    const mp4Key = writeThumb("slideshows", "show0001", "show0001.mp4");
    expect(await get(mp4Key, "outsider")).toBe(404);
  });
});

// A photo the viewer reaches only through something sent to them — an album
// shared with them, or the photo itself — shows its thumbnail too: the album
// page, For you and the lightbox draw every tile from this route.
describe("cover route honours what was shared with the viewer", () => {
  const lib = "gallerylib000001";
  let key = "";
  beforeEach(() => {
    makeUser("owner");
    db.prepare("INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES (?, 'G', 'gallery', '/src', 'owner', '{}')").run(lib);
    grant("user", "owner", lib, "manager");
    key = writeThumb(lib, "photo001", "photo001-cover.webp");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES ('photo001', ?, 'gallery', 'a/photo001.jpg')").run(lib);
    db.prepare("INSERT INTO item_metadata (item_id, cover_storage_key) VALUES ('photo001', ?)").run(key);
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('alb1', 'Trip', 'owner')").run();
    db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES ('alb1', 'photo001', 1)").run();
  });

  it("serves a photo in an album shared with the viewer, and stops when the share goes", async () => {
    expect(await get(key, "outsider")).toBe(404);
    db.prepare("INSERT INTO shares (id, module, resource_id, user_id, created_by) VALUES ('s1', 'gallery_album', 'alb1', 'outsider', 'owner')").run();
    expect(await get(key, "outsider")).toBe(200);
    db.prepare("UPDATE shares SET revoked_at = '2024-01-01T00:00:00Z'").run();
    expect(await get(key, "outsider")).toBe(404);
  });

  it("serves a photo shared with the viewer on its own", async () => {
    db.prepare("INSERT INTO shares (id, module, resource_id, user_id, created_by) VALUES ('s2', 'gallery', 'photo001', 'outsider', 'owner')").run();
    expect(await get(key, "outsider")).toBe(200);
  });
});

describe("cover route honours a book shared with the viewer", () => {
  it("serves the cover of an audiobook shared with them from a library they cannot open", async () => {
    const key = writeThumb("privatelib000001", "book0001", "book0001-cover.webp");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES ('book0001', 'privatelib000001', 'audiobook', 'b')").run();
    db.prepare("INSERT INTO item_metadata (item_id, cover_storage_key) VALUES ('book0001', ?)").run(key);
    expect(await get(key, "outsider")).toBe(404);
    db.prepare("INSERT INTO shares (id, module, resource_id, user_id, created_by) VALUES ('s3', 'audiobook', 'book0001', 'outsider', 'member')").run();
    expect(await get(key, "outsider")).toBe(200);
  });
});
