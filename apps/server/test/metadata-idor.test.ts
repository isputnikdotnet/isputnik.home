// The metadata/cover-editor routes act on a book id. They used to carry only
// `authenticate`, so any signed-in user could pass any library item id — even a
// gallery photo's, since getBookCoverFolder doesn't filter by type — and read a
// private library's cover-candidate listing, cover bytes, or (via
// metadata-search) its title. These pin the write-access gate that closed it,
// including the cross-type case, and confirm a writer still gets through.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { registerMetadataRoutes } from "../src/modules/library/audiobook/metadata-routes.js";
import { resetDb, makeUser, grant } from "./helpers/seed.js";

let app: FastifyInstance;
let root: string;

function makeAudiobook(id: string, libraryId: string, folder: string): void {
  const abs = path.join(root, folder);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, "cover.jpg"), "jpeg-bytes");
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'audiobook', ?, 'ready')"
  ).run(id, libraryId, folder);
}

function makeGalleryPhoto(id: string, libraryId: string, folder: string): void {
  const abs = path.join(root, folder);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, "IMG_0001.jpg"), "jpeg-bytes");
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')"
  ).run(id, libraryId, folder);
}

async function get(url: string, user: string) {
  const response = await app.inject({ method: "GET", url, headers: { "x-test-user": user } });
  return { status: response.statusCode, body: response.body };
}

beforeEach(async () => {
  resetDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-idor-"));
  makeUser("owner");
  makeUser("outsider");
  makeUser("writer");

  // A private audiobook library and a private gallery library — no Everyone grant.
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('AUD', 'AUD', 'audiobook', ?, 'owner', '{}')"
  ).run(root);
  db.prepare(
    "INSERT INTO libraries (id, name, type, source_path, created_by, policy_json) VALUES ('GAL', 'GAL', 'gallery', ?, 'owner', '{}')"
  ).run(root);
  makeAudiobook("book1", "AUD", "Book One");
  makeGalleryPhoto("photo1", "GAL", "2019/Trip");
  // The writer can edit the audiobook library, nothing in the gallery library.
  grant("user", "writer", "AUD", "contributor");

  app = fastify();
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id
      ? (db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined)
      : undefined;
    if (!row) {
      reply.code(401).send({ error: "Unauthenticated" });
      return;
    }
    request.user = row as never;
  });
  registerMetadataRoutes(app);
  await app.ready();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("metadata/cover routes reject readers without write access", () => {
  it("404s cover-candidates for a user with no access to the book's library", async () => {
    const { status } = await get("/api/library/books/book1/cover-candidates", "outsider");
    expect(status).toBe(404);
  });

  it("404s the cover-candidate download for a user with no access", async () => {
    const { status } = await get(
      "/api/library/books/book1/cover-candidate?path=cover.jpg",
      "outsider"
    );
    expect(status).toBe(404);
  });

  it("404s metadata-search before it can reach a provider or leak the title", async () => {
    const { status } = await get("/api/library/books/book1/metadata-search", "outsider");
    expect(status).toBe(404);
  });

  it("closes the cross-type hole: a gallery photo id is not readable via the book route", async () => {
    // The writer can edit AUD but has no access to GAL — passing the gallery
    // item's id to the audiobook cover route must not list its folder.
    const { status } = await get("/api/library/books/photo1/cover-candidates", "writer");
    expect(status).toBe(404);
  });
});

describe("a writer still reaches the editor routes", () => {
  it("lists cover candidates for a book the user can edit", async () => {
    const { status, body } = await get("/api/library/books/book1/cover-candidates", "writer");
    expect(status).toBe(200);
    expect(JSON.parse(body).covers.map((c: { name: string }) => c.name)).toContain("cover.jpg");
  });

  it("serves a cover-candidate file for a writer", async () => {
    const { status } = await get("/api/library/books/book1/cover-candidate?path=cover.jpg", "writer");
    expect(status).toBe(200);
  });
});
