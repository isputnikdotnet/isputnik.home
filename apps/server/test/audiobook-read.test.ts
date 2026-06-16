import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { getAudiobookBookDetail, updateManualMetadata } from "../src/modules/library/audiobook/book-helpers.js";
import { queryCatalog } from "../src/modules/library/audiobook/catalog.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// Seeds one fully-populated audiobook item on the new schema and returns its id.
function seedAudiobook(libraryId: string): string {
  const itemId = "item-1";
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'audiobook', 'Author/Book', 'ready')").run(itemId, libraryId);
  db.prepare("INSERT INTO item_metadata (item_id, source, title, sort_title, language, publisher) VALUES (?, 'scan', 'The Book', 'Book, The', 'en', 'Acme')").run(itemId);
  db.prepare("INSERT INTO audiobook_details (item_id, asin, duration_seconds) VALUES (?, 'B00ASIN', 3600)").run(itemId);

  db.prepare("INSERT INTO people (id, name, sort_name) VALUES ('p-auth', 'Jane Author', 'Author, Jane')").run();
  db.prepare("INSERT INTO people (id, name, sort_name) VALUES ('p-narr', 'Tom Narrator', 'Narrator, Tom')").run();
  db.prepare("INSERT INTO item_people (item_id, person_id, role, sort_order) VALUES (?, 'p-auth', 'author', 0)").run(itemId);
  db.prepare("INSERT INTO item_people (item_id, person_id, role, sort_order) VALUES (?, 'p-narr', 'narrator', 0)").run(itemId);

  db.prepare("INSERT INTO audio_files (id, item_id, relative_path, track_number, title, duration_seconds, size, status) VALUES ('f1', ?, 'Author/Book/01.mp3', 1, 'Chapter 1', 1800, 1000, 'available')").run(itemId);
  db.prepare("INSERT INTO audio_files (id, item_id, relative_path, track_number, duration_seconds, size, status) VALUES ('f2', ?, 'Author/Book/02.mp3', 2, 1800, 1200, 'available')").run(itemId);
  db.prepare("INSERT INTO audio_chapters (id, audio_file_id, ordinal, title, start_seconds, end_seconds) VALUES ('c1', 'f1', 0, 'Intro', 0, 60)").run();

  const categoryId = (db.prepare("SELECT id FROM categories ORDER BY sort_order LIMIT 1").get() as { id: string }).id;
  db.prepare("INSERT INTO item_categories (item_id, category_id, is_primary, source) VALUES (?, ?, 1, 'scan')").run(itemId, categoryId);

  db.prepare("INSERT INTO series (id, name, sort_name) VALUES ('s1', 'My Series', 'My Series')").run();
  db.prepare("INSERT INTO series_items (series_id, item_id, position, source) VALUES ('s1', ?, 2, 'scan')").run(itemId);
  return itemId;
}

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("L", { createdBy: "u1", type: "audiobook" });
  grant("group", EVERYONE_GROUP_ID, "L", "member"); // public => u1 can browse
});

describe("getAudiobookBookDetail (read path on the new schema)", () => {
  it("assembles the full detail across the split tables", () => {
    const id = seedAudiobook("L");
    const detail = getAudiobookBookDetail(id)!;

    expect(detail.title).toBe("The Book");
    expect(detail.authors).toEqual(["Jane Author"]);
    expect(detail.narrators).toEqual(["Tom Narrator"]);
    expect(detail.durationSeconds).toBe(3600);      // from audiobook_details
    expect(detail.asin).toBe("B00ASIN");            // from audiobook_details
    expect(detail.publisher).toBe("Acme");          // from item_metadata
    expect(detail.series).toBe("My Series");        // global series via series_items
    expect(detail.seriesPosition).toBe(2);
    expect(detail.category).not.toBeNull();         // primary item_categories row
    expect(detail.totalSize).toBe(2200);            // SUM(audio_files.size)
    expect(detail.files).toHaveLength(2);
    expect(detail.files[0].chapters).toHaveLength(1); // audio_chapters joined onto file
    expect(detail.files[0].chapters?.[0].title).toBe("Intro");
  });

  it("returns null for an unknown / deleted item", () => {
    expect(getAudiobookBookDetail("nope")).toBeNull();
  });
});

describe("queryCatalog (paged catalog on the new schema)", () => {
  const emptyFilters = { authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], status: [], durations: [] };

  it("lists the item with the same shape as the detail view", () => {
    const id = seedAudiobook("L");
    const result = queryCatalog("u1", ["L"], { q: "", sort: "title", limit: 10, offset: 0, filters: emptyFilters });

    expect(result.total).toBe(1);
    expect(result.books).toHaveLength(1);
    const book = result.books[0] as { id: string; title: string; authors: string[]; durationSeconds: number | null; series: string | null };
    expect(book.id).toBe(id);
    expect(book.title).toBe("The Book");
    expect(book.authors).toEqual(["Jane Author"]);
    expect(book.durationSeconds).toBe(3600);
    expect(book.series).toBe("My Series");
  });

  it("counts each item once despite the multiplying joins (COUNT DISTINCT)", () => {
    seedAudiobook("L");
    // a second series membership would multiply the LEFT JOIN rows
    db.prepare("INSERT INTO series (id, name, sort_name) VALUES ('s2', 'Other Series', 'Other Series')").run();
    db.prepare("INSERT INTO series_items (series_id, item_id, position, source) VALUES ('s2', 'item-1', 1, 'scan')").run();
    const result = queryCatalog("u1", ["L"], { q: "", sort: "title", limit: 10, offset: 0, filters: emptyFilters });
    expect(result.total).toBe(1);
  });

  it("filters by author facet value", () => {
    seedAudiobook("L");
    const hit = queryCatalog("u1", ["L"], { q: "", sort: "title", limit: 10, offset: 0, filters: { ...emptyFilters, authors: ["Jane Author"] } });
    const miss = queryCatalog("u1", ["L"], { q: "", sort: "title", limit: 10, offset: 0, filters: { ...emptyFilters, authors: ["Nobody"] } });
    expect(hit.total).toBe(1);
    expect(miss.total).toBe(0);
  });
});

describe("updateManualMetadata (write -> read round-trip across split tables)", () => {
  it("persists every field into its new home and reads it back", () => {
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('w1', 'L', 'audiobook', 'x', 'ready')").run();
    db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('w1', 'scan', 'Old Title')").run();
    const categoryKey = (db.prepare("SELECT key FROM categories ORDER BY sort_order LIMIT 1").get() as { key: string }).key;

    const detail = updateManualMetadata("w1", {
      title: "New Title",
      authors: ["Author A", "Author B"],
      narrators: ["Narrator N"],
      tags: ["Sci-Fi", "Space"],
      categoryKey,
      publisher: "Pub",
      yearPublished: 2020,
      description: "Desc",
      language: "en",
      isbn: "111",
      asin: "A222",
      series: "Trilogy",
      seriesPosition: 1.5
    })!;

    expect(detail.title).toBe("New Title");          // item_metadata
    expect(detail.metadataSource).toBe("manual");
    expect(detail.publisher).toBe("Pub");
    expect(detail.asin).toBe("A222");                // audiobook_details
    expect(detail.authors).toEqual(["Author A", "Author B"]); // item_people/people
    expect(detail.narrators).toEqual(["Narrator N"]);
    expect([...detail.tags].sort()).toEqual(["Sci-Fi", "Space"]); // taggables (library_item)
    expect(detail.category).not.toBeNull();          // item_categories primary
    expect(detail.series).toBe("Trilogy");           // global series + series_items
    expect(detail.seriesPosition).toBe(1.5);

    // people are global — one row per name, reusable across libraries.
    expect((db.prepare("SELECT COUNT(*) c FROM people WHERE name = 'Author A'").get() as { c: number }).c).toBe(1);
    // primary category is a single is_primary row.
    expect((db.prepare("SELECT COUNT(*) c FROM item_categories WHERE item_id = 'w1' AND is_primary = 1").get() as { c: number }).c).toBe(1);
  });

  it("clearing the series removes the membership", () => {
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('w2', 'L', 'audiobook', 'y', 'ready')").run();
    db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES ('w2', 'scan', 'T')").run();
    updateManualMetadata("w2", { title: "T", authors: [], narrators: [], tags: [], series: "S", seriesPosition: 1 });
    expect((db.prepare("SELECT COUNT(*) c FROM series_items WHERE item_id = 'w2'").get() as { c: number }).c).toBe(1);
    updateManualMetadata("w2", { title: "T", authors: [], narrators: [], tags: [], series: null });
    expect((db.prepare("SELECT COUNT(*) c FROM series_items WHERE item_id = 'w2'").get() as { c: number }).c).toBe(0);
  });
});
