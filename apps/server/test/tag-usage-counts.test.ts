// Control panel › Tags reads two usage counts: library items (books and Gallery
// photos alike) and everything else (albums, stories, family-tree people…). The
// page used to read only the first, under the name `bookCount`, so a tag on a
// story or a person looked unused there. Prune always checked both. These tests
// pin the counts and that prune removes only what neither counts.
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { categoriesAdminPlugin } from "../src/modules/library/audiobook/categories-routes.js";
import { bootApp } from "./helpers/boot.js";
import { makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

interface TagRow { id: string; name: string; libraryItemCount: number; otherCount: number }

let app: FastifyInstance;
let signIn: (userId: string) => Promise<string>;

function makeTag(id: string): string {
  db.prepare("INSERT INTO tags (id, key, display_name) VALUES (?, ?, ?)").run(id, id, id);
  return id;
}

function makeItem(id: string, libraryId: string, type: string, deleted = false): string {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, deleted_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, libraryId, type, id, deleted ? new Date().toISOString() : null);
  return id;
}

function tag(tagId: string, entityType: string, entityId: string): void {
  db.prepare("INSERT INTO taggables (tag_id, entity_type, entity_id) VALUES (?, ?, ?)").run(tagId, entityType, entityId);
}

beforeEach(async () => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("member");
  makeLibrary("books", { createdBy: "admin", type: "audiobook" });
  makeLibrary("photos", { createdBy: "admin", type: "gallery" });

  tag(makeTag("on-book"), "library_item", makeItem("book-1", "books", "audiobook"));
  tag(makeTag("on-photo"), "library_item", makeItem("photo-1", "photos", "gallery"));
  tag(makeTag("on-story"), "story", "story-1");
  tag(makeTag("on-person"), "family_tree_person", "person-1");
  tag(makeTag("on-deleted"), "library_item", makeItem("book-gone", "books", "audiobook", true));
  makeTag("unused");

  ({ app, signIn } = await bootApp({ plugins: [categoriesAdminPlugin] }));
});

async function listTags(): Promise<Record<string, TagRow>> {
  const response = await app.inject({ method: "GET", url: "/api/library/manage/tags", headers: { cookie: await signIn("admin") } });
  expect(response.statusCode).toBe(200);
  const rows = (response.json() as { tags: TagRow[] }).tags;
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

describe("tag usage counts", () => {
  it("counts books and Gallery photos as library items, and stories and people elsewhere", async () => {
    const tags = await listTags();
    expect(tags["on-book"]).toMatchObject({ libraryItemCount: 1, otherCount: 0 });
    expect(tags["on-photo"]).toMatchObject({ libraryItemCount: 1, otherCount: 0 });
    expect(tags["on-story"]).toMatchObject({ libraryItemCount: 0, otherCount: 1 });
    expect(tags["on-person"]).toMatchObject({ libraryItemCount: 0, otherCount: 1 });
    expect(tags["on-deleted"]).toMatchObject({ libraryItemCount: 0, otherCount: 0 });
    expect(tags.unused).toMatchObject({ libraryItemCount: 0, otherCount: 0 });
    // The old name is gone, so a client still reading it fails typecheck rather than showing 0.
    expect(tags["on-book"]).not.toHaveProperty("bookCount");
  });

  it("prunes only tags that neither count sees", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/library/manage/tags/prune", payload: {}, headers: { cookie: await signIn("admin") }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pruned: 2 });
    expect(Object.keys(await listTags()).sort()).toEqual(["on-book", "on-person", "on-photo", "on-story"]);
  });

  it("is for admins only", async () => {
    const response = await app.inject({ method: "GET", url: "/api/library/manage/tags", headers: { cookie: await signIn("member") } });
    expect(response.statusCode).toBe(403);
  });
});
