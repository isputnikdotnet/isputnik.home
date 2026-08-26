import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import { db } from "../src/db.js";
import { loadHomeFeed, type AddedBatchCard, type MemoryCard, type SeriesNextCard } from "../src/modules/home/feed.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";

// The feed is derived and ranked by lifetime class, so what's worth pinning:
// sticky cards ride above everything, batches group a day's arrivals into ONE
// card, old events fall off, and the filler only appears when it's honest.

const dad = { id: "dad", role: "member" };

const TODAY = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
})();

function makeBook(itemId: string, opts: { libraryId?: string; title?: string; discoveredAt?: string } = {}): void {
  const libraryId = opts.libraryId ?? "lib-books";
  if (!db.prepare("SELECT 1 FROM libraries WHERE id = ?").get(libraryId)) {
    makeLibrary(libraryId, { createdBy: "dad", type: "ebook", ownerId: "dad", ownerType: "user" });
    grant("user", "dad", libraryId, "viewer");
  }
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, 'ebook', ?)")
    .run(itemId, libraryId, `/src/${libraryId}/${itemId}`);
  db.prepare("INSERT INTO item_metadata (item_id, title) VALUES (?, ?)").run(itemId, opts.title ?? itemId);
  if (opts.discoveredAt) {
    db.prepare("UPDATE library_items SET discovered_at = ? WHERE id = ?").run(opts.discoveredAt, itemId);
  }
}

function makePhoto(itemId: string, takenAt: string): void {
  if (!db.prepare("SELECT 1 FROM libraries WHERE id = 'lib-gallery'").get()) {
    makeLibrary("lib-gallery", { createdBy: "dad", type: "gallery", ownerId: "dad", ownerType: "user" });
    grant("user", "dad", "lib-gallery", "viewer");
  }
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, 'lib-gallery', 'gallery', ?)")
    .run(itemId, `/photos/${itemId}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, taken_at) VALUES (?, 'photo', ?, ?)")
    .run(itemId, `${itemId}.jpg`, takenAt);
}

function finish(userId: string, itemId: string): void {
  db.prepare(`
    INSERT INTO reading_progress (id, user_id, item_id, document_id, location, percent_complete, completed_at)
    VALUES (?, ?, ?, ?, 'loc', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(`rp-${itemId}`, userId, itemId, `doc-${itemId}`);
}

function makeSeries(seriesId: string, libraryId: string, members: { itemId: string; position: number }[]): void {
  db.prepare("INSERT INTO series (id, library_id, name) VALUES (?, ?, ?)").run(seriesId, libraryId, seriesId);
  for (const member of members) {
    db.prepare("INSERT INTO series_items (series_id, item_id, position) VALUES (?, ?, ?)")
      .run(seriesId, member.itemId, member.position);
  }
}

beforeEach(() => {
  resetDb();
  makeUser("dad");
  makeUser("mom");
  // reading_progress carries a real FK to document_files; a stub per book keeps
  // the finish() helper honest without modelling files.
  db.pragma("foreign_keys = OFF");
});

describe("sticky cards", () => {
  it("puts an undecided recommendation above everything, and drops a decided one", () => {
    makeBook("book-1", { title: "The Hobbit" });
    db.prepare("INSERT INTO notes (id, user_id, author_name, entity_type, entity_id, body) VALUES ('n1', 'mom', 'mom', 'ebook', 'book-1', 'fresh note')").run();
    makeBook("book-2", { title: "Decided Already" });
    db.prepare(`
      INSERT INTO recommendations (id, from_user_id, to_user_id, entity_type, entity_id, subject_title, from_name, status)
      VALUES ('r1', 'mom', 'dad', 'ebook', 'book-1', 'The Hobbit', 'mom', 'new'),
             ('r2', 'mom', 'dad', 'ebook', 'book-2', 'Decided Already', 'mom', 'dismissed')
    `).run();
    // Make the sticky old — it must still sit first, because it has no decay.
    db.prepare("UPDATE recommendations SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = 'r1'").run();

    const cards = loadHomeFeed(dad, TODAY);
    expect(cards[0]).toMatchObject({ type: "sent", title: "The Hobbit", fromName: "mom" });
    expect(cards.filter((card) => card.type === "sent")).toHaveLength(1);
  });
});

describe("added batches", () => {
  it("groups a day's arrivals into one card, never loose tiles", () => {
    for (let i = 0; i < 8; i++) makeBook(`b-${i}`);
    const cards = loadHomeFeed(dad, TODAY).filter((card): card is AddedBatchCard => card.type === "added_batch");
    expect(cards).toHaveLength(1);
    expect(cards[0].count).toBe(8);
    expect(cards[0].coverUrls.length).toBeLessThanOrEqual(5);
  });

  it("keeps separate days separate and lets a stale batch fall off", () => {
    makeBook("b-now");
    makeBook("b-lastweek", { discoveredAt: new Date(Date.now() - 6 * 86_400_000).toISOString() });
    makeBook("b-ancient", { discoveredAt: "2020-01-01T00:00:00.000Z" });

    const cards = loadHomeFeed(dad, TODAY).filter((card): card is AddedBatchCard => card.type === "added_batch");
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.count)).toEqual([1, 1]);
  });

  it("does not count books in libraries the viewer cannot browse", () => {
    makeBook("b-mine");
    makeLibrary("lib-private", { createdBy: "mom", type: "ebook", ownerId: "mom", ownerType: "user" });
    grant("user", "mom", "lib-private", "viewer");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES ('b-secret', 'lib-private', 'ebook', '/x')").run();

    const cards = loadHomeFeed(dad, TODAY).filter((card): card is AddedBatchCard => card.type === "added_batch");
    expect(cards).toHaveLength(1);
    expect(cards[0].count).toBe(1);
  });
});

describe("activity cards", () => {
  it("carries a fresh note as its own card and lets an old one fall off", () => {
    makeBook("book-1", { title: "Dune", discoveredAt: "2020-01-01T00:00:00.000Z" });
    db.prepare("INSERT INTO notes (id, user_id, author_name, entity_type, entity_id, body) VALUES ('fresh', 'mom', 'mom', 'ebook', 'book-1', 'the sandworm chapter')").run();
    db.prepare("INSERT INTO notes (id, user_id, author_name, entity_type, entity_id, body) VALUES ('stale', 'mom', 'mom', 'ebook', 'book-1', 'long ago')").run();
    db.prepare("UPDATE notes SET created_at = '2020-06-01T00:00:00.000Z' WHERE id = 'stale'").run();

    const notes = loadHomeFeed(dad, TODAY).filter((card) => card.type === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ body: "the sandworm chapter", title: "Dune" });
  });
});

describe("the memory card", () => {
  it("appears for a real anniversary and ranks above the day's batch", () => {
    makePhoto("p-2019", `2019${TODAY.slice(4)}T10:00:00.000Z`);
    makePhoto("p-2018", `2018${TODAY.slice(4)}T09:00:00.000Z`);
    makeBook("b-today");

    const cards = loadHomeFeed(dad, TODAY);
    const memoryIndex = cards.findIndex((card) => card.type === "memory");
    const batchIndex = cards.findIndex((card) => card.type === "added_batch");
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeLessThan(batchIndex);

    const memory = cards[memoryIndex] as MemoryCard;
    expect(memory.totalCount).toBe(2);
    expect(memory.groups.map((group) => group.year)).toEqual([2019, 2018]);
  });

  it("offers no card when the only match is a whole-month fallback", () => {
    const nearMiss = TODAY.slice(0, 5) === "2026-" ? "2019-01-15T10:00:00.000Z" : "2019-01-15T10:00:00.000Z";
    void nearMiss;
    // A photo in the same month but >3 days away from today
    const day = Number(TODAY.slice(8, 10));
    const otherDay = day > 15 ? "05" : "25";
    makePhoto("p-far", `2019-${TODAY.slice(5, 7)}-${otherDay}T10:00:00.000Z`);

    expect(loadHomeFeed(dad, TODAY).some((card) => card.type === "memory")).toBe(false);
  });
});

describe("next in series", () => {
  it("suggests the next unread book after the last finished one", () => {
    makeBook("vol-1", { title: "Foundation" });
    makeBook("vol-2", { title: "Foundation and Empire" });
    makeSeries("Foundation", "lib-books", [
      { itemId: "vol-1", position: 1 },
      { itemId: "vol-2", position: 2 }
    ]);
    finish("dad", "vol-1");

    const cards = loadHomeFeed(dad, TODAY).filter((card): card is SeriesNextCard => card.type === "series_next");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      seriesName: "Foundation",
      finishedTitle: "Foundation",
      item: { id: "vol-2", title: "Foundation and Empire", kind: "ebook", href: "/ebooks/books/vol-2" }
    });
    // Filler stays at the bottom of the ranked feed.
    const all = loadHomeFeed(dad, TODAY);
    expect(all[all.length - 1].type).toBe("series_next");
  });

  it("stays quiet once the next book is already started, or nothing was finished", () => {
    makeBook("vol-1");
    makeBook("vol-2");
    makeSeries("s", "lib-books", [
      { itemId: "vol-1", position: 1 },
      { itemId: "vol-2", position: 2 }
    ]);
    expect(loadHomeFeed(dad, TODAY).some((card) => card.type === "series_next")).toBe(false);

    finish("dad", "vol-1");
    db.prepare(`
      INSERT INTO reading_progress (id, user_id, item_id, document_id, location, percent_complete)
      VALUES ('rp-started', 'dad', 'vol-2', 'doc-started', 'loc', 0.1)
    `).run();
    expect(loadHomeFeed(dad, TODAY).some((card) => card.type === "series_next")).toBe(false);
  });

  it("never suggests a book from a library the viewer cannot browse", () => {
    makeBook("vol-1");
    makeLibrary("lib-private", { createdBy: "mom", type: "ebook", ownerId: "mom", ownerType: "user" });
    grant("user", "mom", "lib-private", "viewer");
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES ('vol-2', 'lib-private', 'ebook', '/x')").run();
    makeSeries("s", "lib-books", [
      { itemId: "vol-1", position: 1 },
      { itemId: "vol-2", position: 2 }
    ]);
    finish("dad", "vol-1");

    expect(loadHomeFeed(dad, TODAY).some((card) => card.type === "series_next")).toBe(false);
  });
});
