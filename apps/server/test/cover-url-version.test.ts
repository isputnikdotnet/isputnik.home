// A book's cover file is overwritten in place under a key derived from its id, so
// the URL alone can't tell a new cover from the old one — the browser keeps
// painting the image it already has, which is why applying a metadata match
// looked like it left the cover untouched. Both book payloads therefore stamp the
// metadata row's updated_at on the cover URL; these pin that it is there and that
// it moves when the cover does.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { getAudiobookBookDetail, updateBookCover } from "../src/modules/library/audiobook/book-helpers.js";
import { queryCatalog } from "../src/modules/library/audiobook/catalog.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const BOOK_ID = "book-cover-1";
const COVER_KEY = "AUDIO/bo/ok/book-cover-1-cover.webp";

function seedBook(coverKey: string | null, updatedAt: string) {
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at, updated_at)
    VALUES (?, 'AUDIO', 'audiobook', 'Some Book', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(BOOK_ID);
  db.prepare(`
    INSERT INTO item_metadata (item_id, source, title, sort_title, cover_storage_key, updated_at)
    VALUES (?, 'scan', 'Some Book', 'Some Book', ?, ?)
  `).run(BOOK_ID, coverKey, updatedAt);
  db.prepare("INSERT INTO audiobook_details (item_id, duration_seconds) VALUES (?, 60)").run(BOOK_ID);
}

beforeEach(() => {
  resetDb();
  makeUser("reader");
  makeLibrary("AUDIO", { createdBy: "reader" });
  grant("group", EVERYONE_GROUP_ID, "AUDIO", "viewer");
});

describe("book cover URLs", () => {
  it("carries the metadata row's version, on both the cover and its large twin", () => {
    seedBook(COVER_KEY, "2026-02-03T04:05:06.700Z");

    const book = getAudiobookBookDetail(BOOK_ID)!;
    expect(book.coverUrl).toBe(`/api/library/covers/${COVER_KEY}?v=2026-02-03T04%3A05%3A06.700Z`);
    expect(book.coverLargeUrl).toBe(
      "/api/library/covers/AUDIO/bo/ok/book-cover-1-cover-large.webp?v=2026-02-03T04%3A05%3A06.700Z"
    );
  });

  it("changes when a new cover is written to the same storage key", () => {
    seedBook(COVER_KEY, "2026-02-03T04:05:06.700Z");
    const before = getAudiobookBookDetail(BOOK_ID)!.coverUrl;

    // What the Apply / upload / online-cover paths all end in: the same key,
    // re-pointed. Nothing but updated_at distinguishes the two images.
    const after = updateBookCover(BOOK_ID, COVER_KEY)!.coverUrl;

    expect(after).not.toBe(before);
    expect(after).toContain(`/api/library/covers/${COVER_KEY}?v=`);
  });

  it("versions the browse-grid rows too, not just the detail payload", () => {
    seedBook(COVER_KEY, "2026-02-03T04:05:06.700Z");

    const { books } = queryCatalog("reader", ["AUDIO"], {
      q: "", sort: "title", limit: 10, offset: 0, letter: null,
      filters: {
        libraries: [], authors: [], narrators: [], categories: [], tags: [],
        series: [], languages: [], status: [], durations: []
      }
    }) as { books: { coverUrl: string }[] };

    expect(books[0].coverUrl).toBe(`/api/library/covers/${COVER_KEY}?v=2026-02-03T04%3A05%3A06.700Z`);
  });

  it("leaves a book with no cover at null", () => {
    seedBook(null, "2026-02-03T04:05:06.700Z");

    const book = getAudiobookBookDetail(BOOK_ID)!;
    expect(book.coverUrl).toBeNull();
    expect(book.coverLargeUrl).toBeNull();
  });
});
