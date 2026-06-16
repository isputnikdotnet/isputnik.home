import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { writeBookScan, type PreparedBookScan } from "../src/modules/library/audiobook/scanner.js";
import { getAudiobookBookDetail } from "../src/modules/library/audiobook/book-helpers.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function preparedBook(overrides: Partial<PreparedBookScan> = {}): PreparedBookScan {
  return {
    bookId: "scan-1",
    folderAbsolutePath: "/x/Author/Book",
    folderPath: "Author/Book",
    manualMetadata: false,
    title: "Scanned Book",
    sortTitle: "Scanned Book",
    description: "From scan",
    yearPublished: 2021,
    language: "en",
    durationSeconds: 7200,
    coverStorageKey: null,
    isbn: "ISBN1",
    asin: "ASIN1",
    publisher: "Pub",
    authors: ["Scan Author"],
    narrators: ["Scan Narrator"],
    genres: ["Science Fiction", "Adventure"],
    seriesName: "Scan Series",
    seriesPosition: 3,
    skipMetadataUpdate: false,
    files: [
      { relativePath: "Author/Book/01.mp3", mimeType: "audio/mpeg", trackNumber: 1, chapterTitle: "One", durationSeconds: 3600, size: 100, modifiedAt: "2021-01-01T00:00:00.000Z", contentHash: null, chapters: [{ title: "Ch1", startSeconds: 0, endSeconds: 60 }] },
      { relativePath: "Author/Book/02.mp3", mimeType: "audio/mpeg", trackNumber: 2, chapterTitle: "Two", durationSeconds: 3600, size: 120, modifiedAt: "2021-01-01T00:00:00.000Z", contentHash: null, chapters: undefined }
    ],
    documents: [{ relativePath: "Author/Book/extra.pdf", format: "pdf", mimeType: "application/pdf", size: 500 }],
    ...overrides
  };
}

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("L", { createdBy: "u1", type: "audiobook" });
  grant("group", EVERYONE_GROUP_ID, "L", "member");
});

describe("writeBookScan (scan write -> read round-trip)", () => {
  it("writes a fresh item across every split table and reads it back", () => {
    db.transaction(() => writeBookScan("L", preparedBook()))();
    const detail = getAudiobookBookDetail("scan-1")!;

    expect(detail.title).toBe("Scanned Book");          // item_metadata
    expect(detail.metadataSource).toBe("scan");
    expect(detail.durationSeconds).toBe(7200);          // audiobook_details
    expect(detail.publisher).toBe("Pub");
    expect(detail.authors).toEqual(["Scan Author"]);    // item_people/people (global)
    expect(detail.narrators).toEqual(["Scan Narrator"]);
    expect(detail.series).toBe("Scan Series");          // global series + series_items
    expect(detail.seriesPosition).toBe(3);
    expect(detail.category).not.toBeNull();             // matchCategoryId -> item_categories
    expect([...detail.tags].sort()).toEqual(["Adventure", "Science Fiction"]); // taggables(library_item)
    expect(detail.files).toHaveLength(2);
    expect(detail.files[0].chapters).toHaveLength(1);   // audio_chapters
    expect(detail.documents).toHaveLength(1);           // document_files (companion)
    expect(detail.documents[0].format).toBe("pdf");
  });

  it("a rescan upserts in place (no duplicate items/files) and refreshes duration", () => {
    db.transaction(() => writeBookScan("L", preparedBook()))();
    db.transaction(() => writeBookScan("L", preparedBook({ durationSeconds: 9999 })))();

    expect((db.prepare("SELECT COUNT(*) c FROM library_items").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM audio_files WHERE item_id = 'scan-1' AND status = 'available'").get() as { c: number }).c).toBe(2);
    expect(getAudiobookBookDetail("scan-1")!.durationSeconds).toBe(9999);
  });

  it("preserves a manual title/asin while still refreshing scan-owned fields", () => {
    db.transaction(() => writeBookScan("L", preparedBook()))();
    // simulate a manual edit
    db.prepare("UPDATE item_metadata SET source = 'manual', title = 'Hand Title' WHERE item_id = 'scan-1'").run();
    db.prepare("UPDATE audiobook_details SET asin = 'MANUAL_ASIN' WHERE item_id = 'scan-1'").run();

    db.transaction(() => writeBookScan("L", preparedBook({ title: "Rescanned Title", asin: "SCAN_ASIN", durationSeconds: 5000 })))();
    const detail = getAudiobookBookDetail("scan-1")!;

    expect(detail.title).toBe("Hand Title");     // manual title preserved
    expect(detail.asin).toBe("MANUAL_ASIN");     // manual asin preserved
    expect(detail.durationSeconds).toBe(5000);   // duration always refreshes
  });
});
