import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { db } from "../src/db.js";
import { enqueueAudiobookScan, processAudiobookScanQueue } from "../src/modules/library/audiobook/scanner.js";
import { getAudiobookBookDetail } from "../src/modules/library/audiobook/book-helpers.js";
import { resetDb, makeUser } from "./helpers/seed.js";

// End-to-end scan of a "reshaped box set" laid out the way tools/reshape-boxset.mjs
// produces it: one folder per work named `Author - Title [Narrator]`, each with a
// metadata.json sidecar + a .tif cover, multi-disc works kept in subfolders. Scanned
// in "Treat folder as book" mode (folder_structure → top-level grouping).

const AUTHOR = "Уладзімір Караткевіч";
const NARRATOR = "Андрэй Каляда";
const SERIES = "Каласы пад сярпом тваім";

interface FixtureBook {
  title: string;
  files: string[];
  series?: string;
  pos?: number;
  sidecar?: boolean; // default true; false → no metadata.json (folder-name parse path)
}

const books: FixtureBook[] = [
  { title: "Дзікае паляванне караля Стаха", files: ["01.mp3", "02.mp3", "03.mp3"] },
  // Merged multi-CD novel: two disc subfolders, globally numbered like the real rip.
  { title: "Хрыстос прызямліўся ў Гародні", files: [
    "Хрыстос прызямліўся ў Гародні І/01.mp3",
    "Хрыстос прызямліўся ў Гародні І/02.mp3",
    "Хрыстос прызямліўся ў Гародні ІІ/03.mp3",
    "Хрыстос прызямліўся ў Гародні ІІ/04.mp3"
  ] },
  { title: "Каласы пад сярпом тваім, кніга 1", files: ["01.mp3", "02.mp3"], series: SERIES, pos: 1 },
  { title: "Каласы пад сярпом тваім, кніга 2", files: ["01.mp3", "02.mp3"], series: SERIES, pos: 2 },
  { title: "Быў. Ёсць. Буду", files: ["01.mp3", "02.mp3"] },
  { title: "Чорны замак Альшанскі", files: ["1/01.mp3", "2/02.mp3"] },
  { title: "Цыганскі кароль", files: ["01.mp3", "02.mp3"] },
  { title: "Сівая легенда", files: ["01.mp3", "02.mp3"] },
  { title: "Ладдзя роспачы", files: ["01.mp3", "02.mp3"] },
  // No sidecar → author/narrator/title must come from the folder name.
  { title: "Чазенія", files: ["01.mp3", "02.mp3"], sidecar: false }
];

let rootDir = "";
let libSource = "";
let thumbDir = "";

function buildFixture(tiff: Buffer) {
  for (const book of books) {
    const dir = path.join(libSource, `${AUTHOR} - ${book.title} [${NARRATOR}]`);
    for (const rel of book.files) {
      const filePath = path.join(dir, rel);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from("not really audio"));
    }
    fs.writeFileSync(path.join(dir, "cover.tif"), tiff);
    if (book.sidecar !== false) {
      const meta: Record<string, unknown> = {
        title: book.title,
        authors: [AUTHOR],
        narrators: [NARRATOR],
        language: "be",
        genres: ["Беларуская літаратура"]
      };
      if (book.series) {
        meta.series = book.series;
        meta.seriesPosition = book.pos;
      }
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2), "utf8");
    }
  }
}

beforeEach(async () => {
  resetDb();
  makeUser("u1", "admin");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-reshaped-"));
  rootDir = fs.realpathSync(base);
  libSource = path.join(rootDir, "Reshaped");
  thumbDir = path.join(rootDir, "_thumbs");
  fs.mkdirSync(libSource, { recursive: true });
  fs.mkdirSync(thumbDir, { recursive: true });

  // Scan prerequisites: a storage root the source sits inside, and thumbnail storage.
  db.prepare("DELETE FROM storage_roots").run();
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('library.thumbnail_path', ?)").run(thumbDir);
  db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('root1', 'Root', ?, 'u1')").run(rootDir);

  const tiff = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .tiff()
    .toBuffer();
  buildFixture(tiff);

  const settings = JSON.stringify({
    default_language: "be",
    scan_extensions: ["mp3"],
    scan_sources: [
      { id: "file_metadata", enabled: true },
      { id: "metadata_files", enabled: true },
      { id: "folder_structure", enabled: true },
      { id: "online_metadata", enabled: false }
    ]
  });
  db.prepare("INSERT INTO libraries (id, name, type, source_path, settings_json, created_by) VALUES ('L','L','audiobook',?,?,'u1')")
    .run(libSource, settings);
});

afterEach(() => {
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  rootDir = "";
});

describe("scanning a reshaped Karatkevich box set", () => {
  it("produces 10 books with correct people, series, ordering, and covers", async () => {
    const jobId = enqueueAudiobookScan("L");
    await processAudiobookScanQueue();

    const job = db.prepare("SELECT status, error FROM jobs WHERE id = ?").get(jobId) as { status: string; error: string | null };
    expect(job.error).toBeNull();
    expect(job.status).toBe("completed");

    const rows = db.prepare("SELECT id FROM library_items WHERE library_id = 'L' AND deleted_at IS NULL").all() as { id: string }[];
    expect(rows).toHaveLength(10);

    type Detail = NonNullable<ReturnType<typeof getAudiobookBookDetail>>;
    const byTitle = new Map<string, Detail>();
    for (const row of rows) {
      const detail = getAudiobookBookDetail(row.id)!;
      byTitle.set(detail.title, detail);
    }
    expect([...byTitle.keys()].sort()).toEqual(books.map((book) => book.title).sort());

    // Every book: one shared author, one narrator, a cover transcoded from the .tif.
    for (const book of books) {
      const detail = byTitle.get(book.title)!;
      expect(detail.authors).toEqual([AUTHOR]);
      expect(detail.narrators).toEqual([NARRATOR]);
      expect(detail.coverUrl).toBeTruthy();
    }
    expect((db.prepare("SELECT COUNT(*) AS c FROM people WHERE name = ?").get(AUTHOR) as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM audio_files WHERE status = 'available'").get() as { c: number }).c).toBe(23);

    // The two Каласы volumes share one series at positions 1 and 2.
    const k1 = byTitle.get("Каласы пад сярпом тваім, кніга 1")!;
    const k2 = byTitle.get("Каласы пад сярпом тваім, кніга 2")!;
    expect(k1.series).toBe(SERIES);
    expect(k2.series).toBe(SERIES);
    expect([k1.seriesPosition, k2.seriesPosition]).toEqual([1, 2]);
    expect((db.prepare("SELECT COUNT(*) AS c FROM series WHERE library_id = 'L'").get() as { c: number }).c).toBe(1);

    // Merged multi-CD novel: both discs collapse into one book, in disc-then-track order.
    const hr = byTitle.get("Хрыстос прызямліўся ў Гародні")!;
    expect(hr.files).toHaveLength(4);
    expect(hr.files.map((file) => file.trackNumber)).toEqual([1, 2, 3, 4]);
    expect(hr.files[0].relativePath).toContain("Гародні І/");
    expect(hr.files[3].relativePath).toContain("Гародні ІІ/");

    // Cover bytes actually landed in thumbnail storage.
    const coverKey = (db.prepare("SELECT cover_storage_key AS k FROM item_metadata WHERE item_id = ?").get(hr.id) as { k: string | null }).k;
    expect(coverKey).toBeTruthy();
    expect(fs.existsSync(path.resolve(thumbDir, coverKey!))).toBe(true);

    // Folder-name parsing carries a book with no sidecar (PR: Author - Title [Narrator]).
    const chazenia = byTitle.get("Чазенія")!;
    expect(chazenia.authors).toEqual([AUTHOR]);
    expect(chazenia.narrators).toEqual([NARRATOR]);
    expect(chazenia.files).toHaveLength(2);
  });
});
