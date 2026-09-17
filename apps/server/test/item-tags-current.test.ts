import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { addEntityTags, getEntityTags, itemTagCounts } from "../src/modules/library/shared/tagging.js";
import { registerTagRoutes } from "../src/modules/library/tags.js";
import { applyBulkMetadata, bulkMetadataSchema } from "../src/modules/library/audiobook/book-helpers.js";
import { bootApp } from "./helpers/boot.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// The shared bulk tag editor opens on the tags a selection already carries (any
// type), and books take additions and removals without losing their other tags.

function makeItem(libraryId: string, id: string, type = "gallery"): void {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, ?, ?, 'ready', '2020-01-01T00:00:00.000Z')"
  ).run(id, libraryId, type, id);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
}

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "member");
  makeLibrary("gal", { createdBy: "u1", type: "gallery" });
  makeLibrary("books", { createdBy: "u1", type: "audiobook" });
  makeLibrary("private", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "gal", "member");
  grant("group", EVERYONE_GROUP_ID, "books", "member");
  for (const id of ["p1", "p2", "p3"]) makeItem("gal", id);
  makeItem("books", "b1", "audiobook");
  makeItem("private", "x1");
});

describe("itemTagCounts", () => {
  it("counts each tag across the selection, most-worn first, over any type", () => {
    for (const id of ["p1", "p2", "p3", "b1"]) addEntityTags("library_item", id, ["Crete 2019"]);
    addEntityTags("library_item", "p2", ["beach"]);
    expect(itemTagCounts(["p1", "p2", "p3", "b1"])).toEqual({
      items: 4,
      tags: [{ name: "Crete 2019", count: 4 }, { name: "beach", count: 1 }]
    });
  });

  it("counts nothing for ids that are not live items", () => {
    addEntityTags("library_item", "p1", ["beach"]);
    db.prepare("UPDATE library_items SET deleted_at = '2026-01-01' WHERE id = 'p2'").run();
    addEntityTags("library_item", "p2", ["beach"]);
    expect(itemTagCounts(["p1", "p2", "nope"])).toEqual({ items: 1, tags: [{ name: "beach", count: 1 }] });
    expect(itemTagCounts([])).toEqual({ items: 0, tags: [] });
  });
});

describe("POST /api/library/items/tags/current", () => {
  let app: FastifyInstance;
  let signIn: (userId: string) => Promise<string>;

  beforeEach(async () => {
    ({ app, signIn } = await bootApp({ plugins: [async (instance) => registerTagRoutes(instance)] }));
  });

  it("leaves out items the viewer cannot open", async () => {
    addEntityTags("library_item", "p1", ["beach"]);
    addEntityTags("library_item", "x1", ["secret"]);
    const res = await app.inject({
      method: "POST",
      url: "/api/library/items/tags/current",
      headers: { cookie: await signIn("u2") },
      payload: { ids: ["p1", "x1"] }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: 1, tags: [{ name: "beach", count: 1 }] });
  });
});

describe("bulk book metadata: addTags / removeTags", () => {
  it("adds and removes only the named tags", () => {
    addEntityTags("library_item", "b1", ["Fantasy", "To read"]);
    const patch = bulkMetadataSchema.parse({ bookIds: ["b1"], addTags: ["Favourites"], removeTags: ["to read"] });
    expect(applyBulkMetadata("b1", patch)).toBe(true);
    expect(getEntityTags("library_item", "b1")).toEqual(["Fantasy", "Favourites"]);
  });
});
