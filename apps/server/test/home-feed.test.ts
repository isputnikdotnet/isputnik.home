import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/mail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/mail.js")>();
  return { ...actual, sendMail: vi.fn(async () => {}), isMailConfigured: () => false };
});

import { db } from "../src/db.js";
import { loadHomeFeed, type AddedBatchCard, type MemoryCard, type PhotosAddedCard, type SeriesNextCard } from "../src/modules/home/feed.js";
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

function makePhoto(itemId: string, takenAt: string, opts: { libraryId?: string; discoveredAt?: string } = {}): void {
  const libraryId = opts.libraryId ?? "lib-gallery";
  if (!db.prepare("SELECT 1 FROM libraries WHERE id = ?").get(libraryId)) {
    makeLibrary(libraryId, { createdBy: "dad", type: "gallery", ownerId: "dad", ownerType: "user" });
    grant("user", "dad", libraryId, "viewer");
  }
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, 'gallery', ?)")
    .run(itemId, libraryId, `/photos/${itemId}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, taken_at) VALUES (?, 'photo', ?, ?)")
    .run(itemId, `${itemId}.jpg`, takenAt);
  if (opts.discoveredAt) {
    db.prepare("UPDATE library_items SET discovered_at = ? WHERE id = ?").run(opts.discoveredAt, itemId);
  }
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
    expect(memory.years).toEqual([2019, 2018]);
    expect(memory.strip.map((entry) => entry.year)).toEqual([2019, 2018]);
  });

  it("picks the strip for variety: every year first, people first within a year", () => {
    // 2019 has three photos on this day — the middle one has a person in it —
    // and 2018 has one. Four slots: one per year first, so 2018 is guaranteed a
    // place even though 2019 alone could fill the strip; within 2019 the photo
    // with the person leads.
    makePhoto("p19-a", `2019${TODAY.slice(4)}T08:00:00.000Z`);
    makePhoto("p19-face", `2019${TODAY.slice(4)}T09:00:00.000Z`);
    makePhoto("p19-b", `2019${TODAY.slice(4)}T10:00:00.000Z`);
    makePhoto("p18", `2018${TODAY.slice(4)}T09:00:00.000Z`);
    db.prepare("INSERT INTO gallery_faces (id, item_id) VALUES ('f1', 'p19-face')").run();

    const memory = loadHomeFeed(dad, TODAY).find((card): card is MemoryCard => card.type === "memory")!;
    expect(memory.strip).toHaveLength(4);
    expect(new Set(memory.strip.map((entry) => entry.year))).toEqual(new Set([2019, 2018]));
    // Newest year leads, and its first photo is the one with a person.
    expect(memory.strip[0].year).toBe(2019);
    expect(memory.strip[0].item.id).toBe("p19-face");
  });

  it("stays on the exact day when it can fill the strip, widening only when thin", () => {
    // A photo two days off in an old year, plus four photos exactly on the day.
    const near = new Date(new Date(`${TODAY}T00:00:00Z`).getTime() - 2 * 86_400_000);
    const nearMonthDay = `${String(near.getUTCMonth() + 1).padStart(2, "0")}-${String(near.getUTCDate()).padStart(2, "0")}`;
    makePhoto("p-near", `2015-${nearMonthDay}T10:00:00.000Z`);
    for (let i = 0; i < 4; i++) makePhoto(`p-day-${i}`, `201${6 + i}${TODAY.slice(4)}T10:00:00.000Z`);

    // Four exact-day photos fill the strip — the near year stays out.
    const full = loadHomeFeed(dad, TODAY).find((card): card is MemoryCard => card.type === "memory")!;
    expect(full.precision).toBe("day");
    expect(full.years).not.toContain(2015);
    expect(full.strip.map((entry) => entry.year)).toEqual([2019, 2018, 2017, 2016]);

    // Thin the day out and the near year is welcome again.
    db.prepare("DELETE FROM library_items WHERE id IN ('p-day-0', 'p-day-1', 'p-day-2')").run();
    const thin = loadHomeFeed(dad, TODAY).find((card): card is MemoryCard => card.type === "memory")!;
    expect(thin.years).toContain(2015);
  });

  it("ignores rejected face tags when preferring people", () => {
    makePhoto("p-plain", `2019${TODAY.slice(4)}T08:00:00.000Z`);
    makePhoto("p-rejected", `2019${TODAY.slice(4)}T09:00:00.000Z`);
    db.prepare("INSERT INTO gallery_faces (id, item_id, assignment) VALUES ('f1', 'p-rejected', 'rejected')").run();

    const memory = loadHomeFeed(dad, TODAY).find((card): card is MemoryCard => card.type === "memory")!;
    // No usable face anywhere — chronological order stands.
    expect(memory.strip.map((entry) => entry.item.id)).toEqual(["p-plain", "p-rejected"]);
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

describe("the new-photos card", () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const photosCard = (user = dad) =>
    loadHomeFeed(user, TODAY).find((card): card is PhotosAddedCard => card.type === "photos_added") ?? null;

  it("is one card for the whole week, counting every arrival but showing four", () => {
    for (let i = 0; i < 6; i++) makePhoto(`p-${i}`, "2024-03-01T10:00:00.000Z", { discoveredAt: daysAgo(i) });

    const cards = loadHomeFeed(dad, TODAY).filter((card) => card.type === "photos_added");
    expect(cards).toHaveLength(1);
    const card = cards[0] as PhotosAddedCard;
    expect(card.count).toBe(6);
    expect(card.days).toBe(7);
    expect(card.strip).toHaveLength(4);
    // Newest arrival first, whatever the photos' own dates say.
    expect(card.strip.map((item) => item.id)).toEqual(["p-0", "p-1", "p-2", "p-3"]);
  });

  it("is absent when nothing arrived in the window, however full the gallery is", () => {
    makePhoto("p-old", "2024-03-01T10:00:00.000Z", { discoveredAt: daysAgo(9) });
    expect(photosCard()).toBeNull();
  });

  it("counts only what landed inside the window", () => {
    makePhoto("p-fresh", "2024-03-01T10:00:00.000Z", { discoveredAt: daysAgo(2) });
    makePhoto("p-stale", "2024-03-01T10:00:00.000Z", { discoveredAt: daysAgo(30) });

    const card = photosCard()!;
    expect(card.count).toBe(1);
    expect(card.strip.map((item) => item.id)).toEqual(["p-fresh"]);
  });

  it("does not count photos in libraries the viewer cannot browse", () => {
    makePhoto("p-mine", "2024-03-01T10:00:00.000Z", { discoveredAt: daysAgo(1) });
    makeLibrary("lib-private-gallery", { createdBy: "mom", type: "gallery", ownerId: "mom", ownerType: "user" });
    grant("user", "mom", "lib-private-gallery", "viewer");
    makePhoto("p-secret", "2024-03-01T10:00:00.000Z", { libraryId: "lib-private-gallery", discoveredAt: daysAgo(1) });

    const card = photosCard()!;
    expect(card.count).toBe(1);
    expect(card.strip.map((item) => item.id)).toEqual(["p-mine"]);
  });

  it("sits under the day's memory and fades below a fresher one as it ages", () => {
    // Photos taken on this day in an old year, all of them scanned in a week ago.
    makePhoto("p-2019", `2019${TODAY.slice(4)}T10:00:00.000Z`, { discoveredAt: daysAgo(6) });
    const cards = loadHomeFeed(dad, TODAY);
    const memoryIndex = cards.findIndex((card) => card.type === "memory");
    const photosIndex = cards.findIndex((card) => card.type === "photos_added");
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeLessThan(photosIndex);
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

describe("the quote of the day opens the page", () => {
  // It is the one card that is the same for the whole house and changes every
  // morning, so it is PINNED rather than ranked: it must not drift down the page
  // as the day's activity piles up above it.
  const seedRotating = (id: string, text: string) => {
    db.prepare(
      "INSERT INTO quotes (id, user_id, text, source_author, visibility, in_rotation) VALUES (?, 'dad', ?, 'Someone', 'family', 1)"
    ).run(id, text);
  };

  it("comes first, ahead of every ranked card", () => {
    seedRotating("q1", "The quote of the day");
    const cards = loadHomeFeed(dad, TODAY);
    expect(cards[0]?.type).toBe("quote");
    // And it is the only one: a second quote card would be two quotes of the day.
    expect(cards.filter((card) => card.type === "quote")).toHaveLength(1);
  });

  it("leaves the rest of the feed in its usual order", () => {
    seedRotating("q1", "The quote of the day");
    const withQuote = loadHomeFeed(dad, TODAY).filter((card) => card.type !== "quote");

    db.prepare("DELETE FROM quotes").run();
    const withoutQuote = loadHomeFeed(dad, TODAY);

    expect(withQuote.map((card) => card.type)).toEqual(withoutQuote.map((card) => card.type));
  });

  it("simply is not there when nothing is in rotation", () => {
    const cards = loadHomeFeed(dad, TODAY);
    expect(cards.some((card) => card.type === "quote")).toBe(false);
  });
});
