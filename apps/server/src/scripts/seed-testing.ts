/**
 * Generates a reusable testing database at data/db/testing/isputnik-testing.sqlite
 * seeded with a known admin account and fake audiobook data (libraries, authors,
 * narrators, series, categories, books with metadata/files, plus a few playback
 * progress states and tags). Run with: `npm run seed:testing --workspace apps/server`.
 *
 * The file is regenerated from scratch each run, so it's deterministic and never
 * needs to be committed — it lives under the gitignored data/ folder. Load it into
 * the app from Control Panel → Maintenance → "Load testing data".
 *
 * Known login (also recorded in the project memory file):
 *   email:    test@test.com
 *   password: test1234
 */
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { hashPassword } from "../crypto.js";

const TEST_EMAIL = "test@test.com";
const TEST_PASSWORD = "test1234";
const TEST_DISPLAY_NAME = "Test Admin";

const repoRoot = process.cwd().includes(path.join("apps", "server"))
  ? path.resolve(process.cwd(), "..", "..")
  : process.cwd();
const testingDbPath = path.join(repoRoot, "data", "db", "testing", "isputnik-testing.sqlite");

// Start from a clean slate every run.
fs.mkdirSync(path.dirname(testingDbPath), { recursive: true });
for (const suffix of ["", "-wal", "-shm", ".restore"]) {
  fs.rmSync(`${testingDbPath}${suffix}`, { force: true });
}

// db.ts opens config.dbPath at import time and applies schema + category seeds, so
// point it at the testing file BEFORE importing it.
process.env.DB_PATH = testingDbPath;
const { db } = await import("../db.js");

// ── Fake-data vocabulary (deterministic, index-driven — no randomness) ──────────
const ADJECTIVES = ["Hidden", "Crimson", "Silent", "Broken", "Eternal", "Hollow", "Gilded", "Frozen", "Burning", "Distant", "Shattered", "Whispering", "Forgotten", "Radiant", "Savage", "Velvet", "Golden", "Iron", "Pale", "Restless", "Sacred", "Twisted", "Wandering", "Lost"];
const NOUNS = ["Empire", "Garden", "Throne", "Tide", "Lantern", "Covenant", "Horizon", "Machine", "Orchard", "Requiem", "Citadel", "Voyage", "Ashes", "Compass", "Mirror", "Harvest", "Beacon", "Hollow", "Cathedral", "Meridian", "Labyrinth", "Sermon", "Tempest", "Reckoning"];
const SERIES_NOUNS = ["Cycle", "Chronicles", "Saga", "Sequence", "Files", "Legacy", "Codex", "Annals", "Quartet", "Trilogy", "Tales", "Archive", "Continuum", "Dominion", "Legends"];
const FIRST = ["Jane", "Marcus", "Elena", "Theodore", "Priya", "Oscar", "Mei", "Diego", "Nadia", "Samuel", "Aisha", "Liam", "Greta", "Omar", "Sofia", "Henry", "Isabel", "David", "Catherine", "Robert", "Yuki", "Ravi", "Lena", "Tomas", "Amara", "Noah", "Freya", "Hassan", "Clara", "Viktor"];
const LAST = ["Holloway", "Reed", "Vance", "Frost", "Nair", "Lindqvist", "Tanaka", "Marquez", "Petrov", "Boone", "Rahman", "Gallagher", "Lindholm", "Haddad", "Moreno", "Calloway", "Bennett", "Okafor", "Wells", "Glenn", "Sato", "Kapoor", "Novak", "Bergstrom", "Diallo", "Chen", "Andersen", "Ali", "Whitman", "Sokolov"];
const TAGS = ["Bestseller", "New Release", "Award Winning", "Classic", "Family Favorite", "Page Turner"];

// Distinct "First Last" names; ranges are kept disjoint so an author name never
// collides with a narrator name (both are stored in the authors table).
function namePool(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, n) => {
    const idx = start + n;
    return `${FIRST[idx % FIRST.length]} ${LAST[Math.floor(idx / FIRST.length) % LAST.length]}`;
  });
}
const AUTHORS = namePool(0, 40);
const NARRATORS = namePool(FIRST.length * 2, 25);
const SERIES = Array.from({ length: 15 }, (_, i) => `The ${ADJECTIVES[i % ADJECTIVES.length]} ${SERIES_NOUNS[i % SERIES_NOUNS.length]}`);
const LIBRARIES = [
  { name: "Family Audiobooks", count: 480 },
  { name: "Kids & Classics", count: 320 },
  { name: "Sci-Fi Vault", count: 200 }
];

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// Unique, readable titles: cycle adjective×noun, appending ", Book N" for repeats.
const titleCounts = new Map<string, number>();
const makeTitle = (i: number) => {
  const base = `The ${ADJECTIVES[i % ADJECTIVES.length]} ${NOUNS[(i * 7 + 3) % NOUNS.length]}`;
  const seen = titleCounts.get(base) ?? 0;
  titleCounts.set(base, seen + 1);
  return seen === 0 ? base : `${base}, Book ${seen + 1}`;
};

const now = new Date().toISOString();

// ── Inserts ─────────────────────────────────────────────────────────────────
const insertUser = db.prepare(`
  INSERT INTO users (id, email, password_hash, display_name, role, protected_from_delete)
  VALUES (?, ?, ?, ?, 'admin', 1)
`);
const insertLibrary = db.prepare(`
  INSERT INTO libraries (id, name, type, source_path, settings_json, scan_status, last_scanned_at, created_by, owner_id, owner_type, visibility)
  VALUES (?, ?, 'audiobook', ?, '{}', 'idle', ?, ?, NULL, NULL, 'public')
`);
const insertAuthor = db.prepare("INSERT INTO authors (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)");
const insertSeries = db.prepare("INSERT INTO series (id, library_id, name, sort_name) VALUES (?, ?, ?, ?)");
const insertBook = db.prepare(`
  INSERT INTO books (id, library_id, folder_path, series_id, series_position, status, discovered_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)
`);
const insertMetadata = db.prepare(`
  INSERT INTO book_metadata (id, book_id, source, title, sort_title, description, year_published, language, duration_seconds, category_id, updated_at)
  VALUES (?, ?, 'manual', ?, ?, ?, ?, 'en', ?, ?, ?)
`);
const insertBookAuthor = db.prepare("INSERT INTO book_authors (book_id, author_id, role, sort_order) VALUES (?, ?, ?, ?)");
const insertFile = db.prepare(`
  INSERT INTO book_files (id, book_id, relative_path, mime_type, track_number, chapter_title, duration_seconds, size, status)
  VALUES (?, ?, ?, 'audio/mpeg', ?, ?, ?, ?, 'available')
`);
const insertProgress = db.prepare(`
  INSERT INTO playback_progress (id, user_id, book_id, position_seconds, duration_seconds, percent_complete, completed_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTag = db.prepare("INSERT INTO tags (id, key, display_name) VALUES (?, ?, ?)");
const insertTaggable = db.prepare("INSERT OR IGNORE INTO taggables (tag_id, entity_type, entity_id) VALUES (?, 'book', ?)");

const adminPasswordHash = await hashPassword(TEST_PASSWORD);

const seed = db.transaction(() => {
  const adminId = nanoid(16);
  insertUser.run(adminId, TEST_EMAIL, adminPasswordHash, TEST_DISPLAY_NAME);

  const tagIds = TAGS.map((name) => {
    const id = nanoid(16);
    insertTag.run(id, slug(name), name);
    return id;
  });

  // Categories are auto-seeded by db.ts on import; assign books across them.
  const categories = db.prepare("SELECT id FROM categories ORDER BY sort_order").all() as { id: string }[];

  let globalIndex = 0;
  let bookCounter = 0;
  for (const libDef of LIBRARIES) {
    const libraryId = nanoid(16);
    insertLibrary.run(libraryId, libDef.name, `/testing/${slug(libDef.name)}`, now, adminId);

    const authorId = new Map<string, string>();
    for (const name of AUTHORS) {
      const id = nanoid(16);
      insertAuthor.run(id, libraryId, name, name);
      authorId.set(name, id);
    }
    const narratorId = new Map<string, string>();
    for (const name of NARRATORS) {
      const id = nanoid(16);
      insertAuthor.run(id, libraryId, name, name);
      narratorId.set(name, id);
    }
    const seriesId = new Map<string, string>();
    for (const name of SERIES) {
      const id = nanoid(16);
      insertSeries.run(id, libraryId, name, name);
      seriesId.set(name, id);
    }

    for (let k = 0; k < libDef.count; k++) {
      const i = globalIndex++;
      const bookTitle = makeTitle(i);
      const bookId = nanoid(16);

      const author1 = AUTHORS[i % AUTHORS.length];
      const author2 = i % 3 === 0 ? AUTHORS[(i + 5) % AUTHORS.length] : null;
      const narrator = NARRATORS[i % NARRATORS.length];

      const inSeries = i % 2 === 0;
      const seriesName = inSeries ? SERIES[i % SERIES.length] : null;
      const seriesPos = inSeries ? (i % 6) + 1 : null;

      const category = categories.length > 0 ? categories[i % categories.length] : null;
      const duration = 3600 + (i % 9) * 1200; // 1h – 3h40m
      const year = 1995 + (i % 30);
      const folder = `${slug(author1)}/${String(i).padStart(4, "0")}-${slug(bookTitle)}`;
      const description = `${bookTitle} is a fictional ${seriesName ? `entry in ${seriesName}` : "standalone story"} used for interface testing. It carries fake metadata only — there is no real audio.`;

      insertBook.run(bookId, libraryId, folder, seriesName ? seriesId.get(seriesName)! : null, seriesPos, now, now);
      insertMetadata.run(nanoid(16), bookId, bookTitle, bookTitle, description, year, duration, category?.id ?? null, now);

      insertBookAuthor.run(bookId, authorId.get(author1)!, "author", 0);
      if (author2 && author2 !== author1) insertBookAuthor.run(bookId, authorId.get(author2)!, "author", 1);
      insertBookAuthor.run(bookId, narratorId.get(narrator)!, "narrator", 0);

      const fileCount = 1 + (i % 5);
      const perFile = Math.floor(duration / fileCount);
      for (let t = 0; t < fileCount; t++) {
        const trackNo = t + 1;
        insertFile.run(
          nanoid(16),
          bookId,
          `${String(trackNo).padStart(2, "0")} - Chapter ${trackNo}.mp3`,
          trackNo,
          `Chapter ${trackNo}`,
          perFile,
          perFile * 32000, // ~256kbps-ish fake size
        );
      }

      // Tag roughly every other book with 1–2 tags.
      if (i % 2 === 0) insertTaggable.run(tagIds[i % tagIds.length], bookId);
      if (i % 4 === 1) insertTaggable.run(tagIds[(i + 2) % tagIds.length], bookId);

      // A few progress states for the admin to exercise badges/bars.
      if (i % 5 === 0 && i % 10 !== 0) {
        const pct = 0.35 + (i % 3) * 0.15;
        insertProgress.run(nanoid(16), adminId, bookId, Math.floor(duration * pct), duration, pct, null, now);
      } else if (i % 10 === 0) {
        insertProgress.run(nanoid(16), adminId, bookId, duration, duration, 1, now, now);
      }

      bookCounter++;
    }
  }

  return bookCounter;
});

const bookTotal = seed();

// WAL → main file, so the single .sqlite is self-contained for copying/loading.
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();

console.log(`✓ Testing database written to ${testingDbPath}`);
console.log(`  ${LIBRARIES.length} libraries · ${bookTotal} books`);
console.log(`  Login: ${TEST_EMAIL} / ${TEST_PASSWORD}`);
