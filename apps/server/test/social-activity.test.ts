import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import { db } from "../src/db.js";
import { loadActivity } from "../src/modules/social/activity.js";
import { createChapter, updateStory } from "../src/modules/stories/stories.js";
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

describe("stories", () => {
  function story(id: string, author: string, status: string, coverItemId: string | null): void {
    db.prepare(
      "INSERT INTO stories (id, title, subtitle, status, created_by, cover_item_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, "Dracula", "Better than I remembered", status, author, coverItemId);
    db.prepare("INSERT INTO story_chapters (id, story_id, position) VALUES (?, ?, 0)").run(`${id}-ch`, id);
  }

  it("reports a story somebody else published", () => {
    story("s1", "mom", "published", null);
    const items = loadActivity(dad, 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "story", actorName: "mom", title: "Dracula", href: "/stories/s1" });
  });

  it("says nothing about a draft, even to an admin who could open it", () => {
    story("s1", "mom", "draft", null);
    expect(loadActivity(dad, 10)).toEqual([]);
    expect(loadActivity({ id: "boss", role: "admin" }, 10)).toEqual([]);
  });

  // The one exception to "not your own doings": publishing is a small
  // occasion, and the author's story sits on their front page like anyone's.
  it("shows the author their own published story", () => {
    story("s1", "dad", "published", null);
    expect(loadActivity(dad, 10)).toMatchObject([{ kind: "story", actorName: "dad", title: "Dracula" }]);
  });

  it("dates a story from its publish, not from the draft it started as", () => {
    story("s1", "mom", "published", null);
    db.prepare("UPDATE stories SET created_at = '2026-01-01T00:00:00.000Z', published_at = '2026-08-01T00:00:00.000Z' WHERE id = 's1'").run();
    expect(loadActivity(dad, 10)[0].createdAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("stamps the publish when a story goes live, and clears it on the way back", () => {
    story("s1", "mom", "draft", null);
    updateStory("s1", { status: "published" });
    const stamped = db.prepare("SELECT published_at FROM stories WHERE id = 's1'").get() as { published_at: string | null };
    expect(stamped.published_at).toBeTruthy();
    // Saying 'published' again is not a second publish.
    updateStory("s1", { status: "published", title: "Dracula, revisited" });
    expect((db.prepare("SELECT published_at FROM stories WHERE id = 's1'").get() as { published_at: string }).published_at).toBe(stamped.published_at);
    updateStory("s1", { status: "draft" });
    expect((db.prepare("SELECT published_at FROM stories WHERE id = 's1'").get() as { published_at: string | null }).published_at).toBeNull();
  });

  it("reports a chapter added to a published story, to the house and to its author", () => {
    story("s1", "mom", "published", null);
    db.prepare("UPDATE stories SET chapter_noun = 'Day' WHERE id = 's1'").run();
    const chapter = createChapter("s1", { title: "The last climb" }, "mom");
    for (const viewer of [dad, mom]) {
      const items = loadActivity(viewer, 10);
      const update = items.find((item) => item.kind === "story_update");
      expect(update).toMatchObject({
        actorName: "mom",
        title: "Dracula",
        href: `/stories/s1/chapters/${chapter.id}`,
        chapter: { id: chapter.id, title: "The last climb", noun: "Day", number: 2 }
      });
    }
  });

  it("says nothing about a chapter added while the story was still a draft", () => {
    story("s1", "mom", "draft", null);
    createChapter("s1", { title: "Early days" }, "mom");
    updateStory("s1", { status: "published" });
    expect(loadActivity(dad, 10).map((item) => item.kind)).toEqual(["story"]);
  });

  it("forgets an added chapter that was deleted again", () => {
    story("s1", "mom", "published", null);
    const chapter = createChapter("s1", { title: "Oops" }, "mom");
    db.prepare("DELETE FROM story_chapters WHERE id = ?").run(chapter.id);
    expect(loadActivity(dad, 10).map((item) => item.kind)).toEqual(["story"]);
  });

  // The bug this fixes: a review wears the artwork of the book it is about, and
  // that book is a library item in nobody's GALLERY — so the card, which only
  // looked there, arrived with no picture at all.
  it("shows the book cover a review wears", () => {
    makeBook("book-1", "lib-1", ["dad", "mom"]);
    db.prepare("UPDATE item_metadata SET cover_storage_key = ? WHERE item_id = ?")
      .run("lib-1/bo/ok/book-1-cover.webp", "book-1");
    story("s1", "mom", "published", "book-1");

    const items = loadActivity(dad, 10);
    expect(items).toHaveLength(1);
    expect(items[0].coverUrl).toBe("/api/library/covers/lib-1/bo/ok/book-1-cover.webp");
  });

  it("hands over no cover from a book library the reader cannot open", () => {
    makeBook("secret", "lib-private", ["mom"]);
    db.prepare("UPDATE item_metadata SET cover_storage_key = ? WHERE item_id = ?")
      .run("lib-private/se/cr/secret-cover.webp", "secret");
    story("s1", "mom", "published", "secret");

    const items = loadActivity(dad, 10);
    expect(items).toHaveLength(1);
    expect(items[0].coverUrl).toBeNull();
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
