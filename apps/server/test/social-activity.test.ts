import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import { db } from "../src/db.js";
import { loadActivity } from "../src/modules/social/activity.js";
import { grant, makeLibrary, resetDb } from "./helpers/seed.js";

// The feed is derived, so the things worth testing are what it leaves OUT: your
// own doings, things you cannot see, and the events that already have a home
// elsewhere on the page.

const dad = { id: "dad", role: "member" };
const mom = { id: "mom", role: "member" };

function makeUser(id: string, role: "admin" | "member" = "member"): void {
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, 'x', ?, ?)")
    .run(id, `${id}@test.local`, id, role);
}

function makeBook(itemId: string, libraryId: string, viewers: string[]): void {
  if (!db.prepare("SELECT 1 FROM libraries WHERE id = ?").get(libraryId)) {
    makeLibrary(libraryId, { createdBy: "dad", type: "ebook", ownerId: "dad", ownerType: "user" });
    for (const viewer of viewers) grant("user", viewer, libraryId, "viewer");
  }
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, 'ebook', ?)")
    .run(itemId, libraryId, `/src/${libraryId}/${itemId}`);
  db.prepare("INSERT INTO item_metadata (item_id, title) VALUES (?, ?)").run(itemId, "The Hobbit");
}

function note(id: string, author: string, entityType: string, entityId: string, body: string): void {
  db.prepare(`
    INSERT INTO notes (id, user_id, author_name, entity_type, entity_id, body)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, author, author, entityType, entityId, body);
}

beforeEach(() => {
  resetDb();
  makeUser("dad");
  makeUser("mom");
});

describe("what the feed shows", () => {
  it("reports a note somebody else left, with its words", () => {
    makeBook("book-1", "lib-1", ["dad", "mom"]);
    note("n1", "mom", "ebook", "book-1", "the middle drags");

    const items = loadActivity(dad, 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "note",
      actorName: "mom",
      title: "The Hobbit",
      body: "the middle drags",
      href: "/ebooks/books/book-1"
    });
  });

  it("reports albums, slideshows and new people in the tree", () => {
    makeLibrary("lib-g", { createdBy: "dad", type: "gallery", ownerId: "dad", ownerType: "user" });
    grant("user", "dad", "lib-g", "viewer");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES ('p1', 'lib-g', 'gallery', '/p1.jpg')").run();

    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('alb', 'Summer 2019', 'mom')").run();
    db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES ('alb', 'p1', 0)").run();
    db.prepare("INSERT INTO gallery_slideshows (id, name, created_by) VALUES ('sl', 'Christmas', 'mom')").run();
    db.prepare("INSERT INTO gallery_slideshow_items (slideshow_id, item_id, position) VALUES ('sl', 'p1', 0)").run();
    db.prepare("INSERT INTO family_tree_persons (id, name, created_by) VALUES ('p', 'Grandma', 'mom')").run();

    const kinds = loadActivity(dad, 10).map((item) => item.kind).sort();
    expect(kinds).toEqual(["album", "person", "slideshow"]);
  });

  it("puts the newest first", () => {
    makeBook("book-1", "lib-1", ["dad", "mom"]);
    note("old", "mom", "ebook", "book-1", "first");
    note("new", "mom", "ebook", "book-1", "second");
    db.prepare("UPDATE notes SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = 'old'").run();

    expect(loadActivity(dad, 10).map((item) => item.body)).toEqual(["second", "first"]);
  });
});

describe("what the feed leaves out", () => {
  it("leaves out your own doings — you already know about those", () => {
    makeBook("book-1", "lib-1", ["dad", "mom"]);
    note("mine", "dad", "ebook", "book-1", "my own remark");
    note("theirs", "mom", "ebook", "book-1", "hers");
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('alb', 'Mine', 'dad')").run();

    const items = loadActivity(dad, 10);
    expect(items.map((item) => item.body)).toEqual(["hers"]);
  });

  it("leaves out anything about a thing you cannot see", () => {
    // A library only dad can browse; mom must not learn there is a book in it,
    // nor read what he said about it.
    makeBook("book-1", "lib-private", ["dad"]);
    note("n1", "dad", "ebook", "book-1", "a private opinion");

    expect(loadActivity(mom, 10)).toEqual([]);
    expect(loadActivity(dad, 10)).toHaveLength(0); // his own note, excluded above
  });

  it("stops reporting a note once it is removed", () => {
    makeBook("book-1", "lib-1", ["dad", "mom"]);
    note("n1", "mom", "ebook", "book-1", "regrettable");
    expect(loadActivity(dad, 10)).toHaveLength(1);

    db.prepare("UPDATE notes SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'n1'").run();
    expect(loadActivity(dad, 10)).toEqual([]);
  });

  it("leaves out a note whose subject has since gone", () => {
    makeBook("book-1", "lib-1", ["dad", "mom"]);
    note("n1", "mom", "ebook", "book-1", "about a book that will vanish");
    db.prepare("DELETE FROM library_items WHERE id = 'book-1'").run();

    // Unlike an inbox card, a feed line about nothing is worth nothing — there
    // is no decision pending on it, so it simply stops being news.
    expect(loadActivity(dad, 10)).toEqual([]);
  });

  it("leaves out an album whose photos the viewer cannot see", () => {
    makeLibrary("lib-private", { createdBy: "mom", type: "gallery", ownerId: "mom", ownerType: "user" });
    grant("user", "mom", "lib-private", "viewer");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES ('p1', 'lib-private', 'gallery', '/p1.jpg')").run();
    db.prepare("INSERT INTO gallery_albums (id, name, created_by) VALUES ('alb', 'Private', 'mom')").run();
    db.prepare("INSERT INTO gallery_album_items (album_id, item_id, position) VALUES ('alb', 'p1', 0)").run();

    expect(loadActivity(dad, 10)).toEqual([]);
  });
});

describe("the limit", () => {
  it("returns a full page of visible rows even when many are filtered away", () => {
    makeBook("book-1", "lib-1", ["dad", "mom"]);
    makeBook("secret", "lib-private", ["mom"]);
    // Ten notes dad cannot see, interleaved with five he can. A naive LIMIT would
    // fetch the invisible ones and hand back a nearly empty page.
    for (let i = 0; i < 10; i++) note(`hidden-${i}`, "mom", "ebook", "secret", `hidden ${i}`);
    for (let i = 0; i < 5; i++) note(`shown-${i}`, "mom", "ebook", "book-1", `shown ${i}`);

    expect(loadActivity(dad, 5)).toHaveLength(5);
  });

  it("never returns more than asked for", () => {
    makeBook("book-1", "lib-1", ["dad", "mom"]);
    for (let i = 0; i < 20; i++) note(`n-${i}`, "mom", "ebook", "book-1", `note ${i}`);
    expect(loadActivity(dad, 6)).toHaveLength(6);
  });
});
