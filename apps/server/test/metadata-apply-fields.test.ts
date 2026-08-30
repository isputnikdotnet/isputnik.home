// Applying a lookup result is field-by-field: the dialog sends the fields the
// user left ticked, and nothing else on the book may move. A provider that is
// right about the narrator and wrong about the year used to be all-or-nothing.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  applyMetadataCandidate,
  metadataMatchSchema,
  resolveMetadataApplyFields,
  METADATA_APPLY_FIELDS,
  type MetadataApplyField
} from "../src/modules/library/audiobook/book-helpers.js";
import type { MetadataCandidate } from "../src/modules/library/audiobook/providers/types.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

const BOOK_ID = "book-apply-1";

// No cover in any of these: downloading one would reach the network, and the
// cover field has its own coverage in cover-url-version.test.ts.
const CANDIDATE: MetadataCandidate = {
  title: "Dune",
  authors: ["Frank Herbert"],
  narrators: ["Scott Brick"],
  year: 1965,
  publisher: "Chilton Books",
  language: "en",
  isbn: "9780441013593",
  asin: "B002UZZBW4",
  genres: ["Science Fiction"],
  description: "A desert planet.",
  source: "audible"
};

function seedBook() {
  db.prepare(`
    INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at, updated_at)
    VALUES (?, 'AUDIO', 'audiobook', 'Dune', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(BOOK_ID);
  db.prepare(`
    INSERT INTO item_metadata (item_id, source, title, sort_title, year_published, publisher, description)
    VALUES (?, 'scan', 'dune 01', 'dune 01', 2001, 'Ripped by hand', 'Local blurb.')
  `).run(BOOK_ID);
  db.prepare("INSERT INTO audiobook_details (item_id, asin, duration_seconds) VALUES (?, 'LOCALASIN', 60)").run(BOOK_ID);
}

const apply = (fields: MetadataApplyField[]) =>
  applyMetadataCandidate(BOOK_ID, CANDIDATE, new Set(fields));

beforeEach(() => {
  resetDb();
  makeUser("owner", "admin");
  makeLibrary("AUDIO", { createdBy: "owner" });
  seedBook();
});

describe("applying a metadata result field by field", () => {
  it("writes only the fields asked for", async () => {
    const book = (await apply(["title", "narrators"]))!;

    expect(book.title).toBe("Dune");
    expect(book.narrators).toEqual(["Scott Brick"]);
    // Everything left unticked stands exactly as it was.
    expect(book.yearPublished).toBe(2001);
    expect(book.publisher).toBe("Ripped by hand");
    expect(book.description).toBe("Local blurb.");
    expect(book.asin).toBe("LOCALASIN");
    expect(book.authors).toEqual([]);
    expect(book.tags).toEqual([]);
  });

  it("keeps the year and the narrator apart — the whole point of the toggles", async () => {
    const book = (await apply(METADATA_APPLY_FIELDS.filter((field) => field !== "year")))!;

    expect(book.narrators).toEqual(["Scott Brick"]);
    expect(book.yearPublished).toBe(2001);
  });

  it("takes everything when every field is ticked", async () => {
    const book = (await apply([...METADATA_APPLY_FIELDS]))!;

    expect(book.title).toBe("Dune");
    expect(book.authors).toEqual(["Frank Herbert"]);
    expect(book.yearPublished).toBe(1965);
    expect(book.publisher).toBe("Chilton Books");
    expect(book.language).toBe("en");
    expect(book.isbn).toBe("9780441013593");
    expect(book.asin).toBe("B002UZZBW4");
    expect(book.description).toBe("A desert planet.");
    expect(book.tags).toEqual(["Science Fiction"]);
  });

  it("never blanks a value the result has nothing for", async () => {
    const sparse: MetadataCandidate = { title: "Dune", authors: [], source: "openlibrary" };

    const book = (await applyMetadataCandidate(BOOK_ID, sparse, new Set(METADATA_APPLY_FIELDS)))!;

    expect(book.yearPublished).toBe(2001);
    expect(book.publisher).toBe("Ripped by hand");
    expect(book.description).toBe("Local blurb.");
    expect(book.narrators).toEqual([]);
  });

  it("leaves the book untouched when nothing is ticked", async () => {
    const book = (await apply([]))!;

    expect(book.title).toBe("dune 01");
    expect(book.yearPublished).toBe(2001);
    expect(book.narrators).toEqual([]);
  });
});

describe("resolving which fields a request asked for", () => {
  const parse = (body: unknown) => metadataMatchSchema.parse(body);

  it("takes an explicit field list as the whole answer", () => {
    const fields = resolveMetadataApplyFields(parse({ candidate: CANDIDATE, fields: ["cover", "year"] }));
    expect([...fields].sort()).toEqual(["cover", "year"]);
  });

  it("falls back to the details/cover pair an older client still sends", () => {
    const detailsOnly = resolveMetadataApplyFields(parse({ candidate: CANDIDATE, updateDetails: true, updateCover: false }));
    expect(detailsOnly.has("cover")).toBe(false);
    expect(detailsOnly.has("narrators")).toBe(true);

    const coverOnly = resolveMetadataApplyFields(parse({ candidate: CANDIDATE, updateDetails: false, updateCover: true }));
    expect([...coverOnly]).toEqual(["cover"]);
  });

  it("rejects a field name it doesn't know", () => {
    expect(() => parse({ candidate: CANDIDATE, fields: ["series"] })).toThrow();
  });
});
