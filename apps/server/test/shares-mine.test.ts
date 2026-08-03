// GET /api/shares/mine — the one list behind Profile → Shared links. The three
// per-kind endpoints it replaces each JOIN a different table, so the risk here is
// the guarded joins: a 'gallery_set' link's resource_id self-references the link
// id, and must not be mistaken for an item id.
import { beforeEach, describe, expect, it } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { sha256 } from "../src/crypto.js";
import { librarySharesPlugin } from "../src/modules/library/shared/shares.js";
import { resetDb, makeUser, makeLibrary, futureIso, pastIso } from "./helpers/seed.js";

let app: FastifyInstance;

function makeItem(id: string, opts: { library: string; type?: string; title?: string | null; folder?: string }): string {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, ?, ?, 'ready')"
  ).run(id, opts.library, opts.type ?? "audiobook", opts.folder ?? `/${id}`);
  if (opts.title !== null) {
    db.prepare("INSERT INTO item_metadata (item_id, title) VALUES (?, ?)").run(id, opts.title ?? id);
  }
  return id;
}

function makeLink(opts: {
  id: string;
  module: string;
  resourceId: string;
  createdBy?: string;
  expiresAt?: string;
  label?: string | null;
  revoked?: boolean;
}): string {
  db.prepare(
    `INSERT INTO share_links (id, module, resource_id, token_hash, permission, label, expires_at, created_by, revoked_at)
     VALUES (?, ?, ?, ?, 'read', ?, ?, ?, ?)`
  ).run(
    opts.id,
    opts.module,
    opts.resourceId,
    sha256(`token-${opts.id}`),
    opts.label ?? null,
    opts.expiresAt ?? futureIso(),
    opts.createdBy ?? "owner",
    opts.revoked ? new Date().toISOString() : null
  );
  return opts.id;
}

async function listMine(userId: string) {
  const response = await app.inject({
    method: "GET",
    url: "/api/shares/mine",
    headers: { "x-test-user": userId }
  });
  return { status: response.statusCode, shares: response.json().shares as Record<string, unknown>[] };
}

beforeEach(async () => {
  resetDb();
  makeUser("owner");
  makeUser("other");
  makeLibrary("lib-audio", { createdBy: "owner", type: "audiobook" });
  makeLibrary("lib-photos", { createdBy: "owner", type: "gallery" });

  app = fastify();
  // Stubbed auth — the real session decorators are core code and out of scope.
  app.decorate("authenticate", async (request, reply) => {
    const id = request.headers["x-test-user"] as string | undefined;
    const row = id
      ? db.prepare("SELECT id, role FROM users WHERE id = ?").get(id) as { id: string; role: string } | undefined
      : undefined;
    if (!row) { reply.code(401).send({ error: "Unauthenticated" }); return; }
    request.user = row as never;
  });
  app.decorate("requireAdmin", async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== "admin") reply.code(403).send({ error: "Admin only" });
  });
  await app.register(librarySharesPlugin);
  await app.ready();
});

describe("GET /api/shares/mine", () => {
  it("names a single-item link from its metadata title", async () => {
    makeItem("book-1", { library: "lib-audio", title: "The Hobbit" });
    makeLink({ id: "link-1", module: "audiobook", resourceId: "book-1", label: "For Grandma" });

    const { shares } = await listMine("owner");
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      id: "link-1",
      kind: "item",
      module: "audiobook",
      title: "The Hobbit",
      label: "For Grandma",
      itemCount: 1,
      status: "active"
    });
  });

  it("falls back to the folder name when an item has no title row", async () => {
    makeItem("book-2", { library: "lib-audio", title: null, folder: "/shelf/Dune" });
    makeLink({ id: "link-2", module: "audiobook", resourceId: "book-2" });

    const { shares } = await listMine("owner");
    expect(shares[0].title).toBe("Dune");
  });

  it("counts an album's live items and names the album", async () => {
    makeItem("photo-1", { library: "lib-photos", type: "gallery" });
    makeItem("photo-2", { library: "lib-photos", type: "gallery" });
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('album-1', 'Summer 2026', 'owner')").run();
    db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES ('album-1', 'photo-1', 0), ('album-1', 'photo-2', 1)").run();
    makeLink({ id: "link-3", module: "gallery_album", resourceId: "album-1" });

    const { shares } = await listMine("owner");
    expect(shares[0]).toMatchObject({ kind: "album", title: "Summer 2026", itemCount: 2 });
  });

  it("excludes album photos that have been trashed from the count", async () => {
    makeItem("photo-1", { library: "lib-photos", type: "gallery" });
    makeItem("photo-2", { library: "lib-photos", type: "gallery" });
    db.prepare("UPDATE library_items SET deleted_at = ? WHERE id = 'photo-2'").run(new Date().toISOString());
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('album-1', 'Summer 2026', 'owner')").run();
    db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES ('album-1', 'photo-1', 0), ('album-1', 'photo-2', 1)").run();
    makeLink({ id: "link-4", module: "gallery_album", resourceId: "album-1" });

    const { shares } = await listMine("owner");
    expect(shares[0].itemCount).toBe(1);
  });

  it("counts a quick link's photos without mistaking its self-referencing resource_id for an item", async () => {
    makeItem("photo-1", { library: "lib-photos", type: "gallery", title: "A photo" });
    // A 'gallery_set' link points at itself; its contents live in share_link_items.
    makeLink({ id: "link-5", module: "gallery_set", resourceId: "link-5" });
    db.prepare("INSERT INTO share_link_items (id, share_link_id, item_id, position) VALUES ('sli-1', 'link-5', 'photo-1', 0)").run();

    const { shares } = await listMine("owner");
    expect(shares[0]).toMatchObject({ kind: "set", title: "Selected photos", itemCount: 1, resourceId: null });
  });

  it("marks a past expiry as expired but still lists it", async () => {
    makeItem("book-1", { library: "lib-audio", title: "The Hobbit" });
    makeLink({ id: "link-6", module: "audiobook", resourceId: "book-1", expiresAt: pastIso() });

    const { shares } = await listMine("owner");
    expect(shares).toHaveLength(1);
    expect(shares[0].status).toBe("expired");
  });

  it("omits revoked links", async () => {
    makeItem("book-1", { library: "lib-audio", title: "The Hobbit" });
    makeLink({ id: "link-7", module: "audiobook", resourceId: "book-1", revoked: true });

    const { shares } = await listMine("owner");
    expect(shares).toHaveLength(0);
  });

  it("shows only the caller's own links", async () => {
    makeItem("book-1", { library: "lib-audio", title: "The Hobbit" });
    makeLink({ id: "mine", module: "audiobook", resourceId: "book-1" });
    makeLink({ id: "theirs", module: "audiobook", resourceId: "book-1", createdBy: "other" });

    expect((await listMine("owner")).shares.map((s) => s.id)).toEqual(["mine"]);
    expect((await listMine("other")).shares.map((s) => s.id)).toEqual(["theirs"]);
  });

  it("never returns a token, in any form", async () => {
    makeItem("book-1", { library: "lib-audio", title: "The Hobbit" });
    makeLink({ id: "link-8", module: "audiobook", resourceId: "book-1" });

    const { shares } = await listMine("owner");
    const serialized = JSON.stringify(shares[0]);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain(sha256("token-link-8"));
  });

  it("requires a session", async () => {
    const response = await app.inject({ method: "GET", url: "/api/shares/mine" });
    expect(response.statusCode).toBe(401);
  });
});
