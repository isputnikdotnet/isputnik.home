// Scan rules in the audiobook scanner (docs/scan-layout-plan.md, phase 2), against
// the A cases from the challenging-cases list: series-first layouts, many files as
// one book, Part folders, two narrators of one title. Plus the mechanics: per-owner
// reconcile, rule-scoped scans, single-book rescan inside a rule, and the preview.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../src/db.js";
import {
  enqueueAudiobookScan, processAudiobookScanQueue, rescanSingleBook, previewAudiobookRulePattern, walkAudiobookFiles
} from "../src/modules/library/audiobook/scanner.js";
import { createScanRule, updateScanRule, isScanRuleError, loadOwnerIndex, getScanRule } from "../src/modules/library/shared/scan-rules.js";
import { normalizeLibrarySettings } from "../src/modules/library/shared/library-settings.js";
import { resetDb, makeUser } from "./helpers/seed.js";

let rootDir = "";
let libSource = "";

const SETTINGS = normalizeLibrarySettings("audiobook", JSON.stringify({ scan_extensions: ["mp3", "m4b"] })) as never;

function touch(...rel: string[]) {
  const file = path.join(libSource, ...rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from("not really audio"));
}
const tracks = (n: number) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(3, "0")}.mp3`);

interface Item { id: string; folder_path: string; scan_rule_id: string | null; deleted_at: string | null }
const items = () => db.prepare("SELECT id, folder_path, scan_rule_id, deleted_at FROM library_items WHERE library_id = 'L' ORDER BY folder_path").all() as Item[];
const live = () => items().filter((i) => i.deleted_at === null);
const byPath = (p: string) => live().find((i) => i.folder_path === p);
const titleOf = (id: string) => (db.prepare("SELECT title FROM item_metadata WHERE item_id = ?").get(id) as { title: string }).title;
const peopleOf = (id: string, role: string) =>
  (db.prepare("SELECT p.name FROM item_people ip JOIN people p ON p.id = ip.person_id WHERE ip.item_id = ? AND ip.role = ? ORDER BY ip.sort_order").all(id, role) as { name: string }[]).map((r) => r.name);
const seriesOf = (id: string) =>
  db.prepare("SELECT s.name AS name, si.position AS position FROM series_items si JOIN series s ON s.id = si.series_id WHERE si.item_id = ?").get(id) as { name: string; position: number } | undefined;
const trackPaths = (id: string) =>
  (db.prepare("SELECT relative_path FROM audio_files WHERE item_id = ? AND deleted_at IS NULL ORDER BY track_number").all(id) as { relative_path: string }[]).map((r) => r.relative_path);

async function scan(options: { ruleId?: string } = {}) {
  const jobId = enqueueAudiobookScan("L", options);
  await processAudiobookScanQueue();
  const job = db.prepare("SELECT status, error FROM jobs WHERE id = ?").get(jobId) as { status: string; error: string | null };
  expect(job.error).toBeNull();
  expect(job.status).toBe("completed");
}

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-ab-rules-")));
  libSource = path.join(rootDir, "Audiobooks");
  const thumbs = path.join(rootDir, "_thumbs");
  fs.mkdirSync(libSource, { recursive: true });
  fs.mkdirSync(thumbs, { recursive: true });
  db.prepare("DELETE FROM storage_roots").run();
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('library.thumbnail_path', ?)").run(thumbs);
  db.prepare("INSERT INTO storage_roots (id, name, path, created_by) VALUES ('root1', 'Root', ?, 'u1')").run(rootDir);
  db.prepare("INSERT INTO libraries (id, name, type, source_path, settings_json, created_by) VALUES ('L','L','audiobook',?,?,'u1')")
    .run(libSource, JSON.stringify({ scan_extensions: ["mp3", "m4b"], scan_sources: [{ id: "file_metadata", enabled: true }] }));

  // A2: twenty tracks, one book. A3: Part folders below the book. A1: a series-first
  // shelf whose books have different authors. A4: two recordings of one title.
  for (const t of tracks(20)) touch("Shelves", "Iain M. Banks", "Culture", "02 - The Player of Games", t);
  for (const t of tracks(3)) touch("Shelves", "Brandon Sanderson", "Stormlight Archive", "01 - The Way of Kings", "Part 1", t);
  for (const t of tracks(3)) touch("Shelves", "Brandon Sanderson", "Stormlight Archive", "01 - The Way of Kings", "Part 2", t);
  for (const t of tracks(2)) touch("Various", "The Horus Heresy", "01 - Horus Rising", t);
  for (const t of tracks(2)) touch("Various", "The Horus Heresy", "02 - False Gods", t);
  touch("Shelves", "J.R.R. Tolkien", "The Hobbit", "Andy Serkis", "The Hobbit.m4b");
  touch("Shelves", "J.R.R. Tolkien", "The Hobbit", "Rob Inglis", "The Hobbit.m4b");
  // Default-scanner territory: a plain folder book outside every rule.
  for (const t of tracks(2)) touch("Loose", "Some Book", t);
});

afterEach(() => {
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  rootDir = "";
});

function makeRules() {
  const shelves = createScanRule("L", {
    name: "Author shelves",
    layouts: ["{author}/{series}/{position} - {title}", "{author}/{title}/{narrator}"],
    // Layouts are read relative to the rule folder, so the author level sits below it.
    paths: ["Shelves"]
  });
  const various = createScanRule("L", { name: "Various", layouts: ["{series}/{position} - {title}"], paths: ["Various"] });
  if (isScanRuleError(shelves) || isScanRuleError(various)) throw new Error("setup failed");
  return { shelves, various };
}

describe("the walk draws book boundaries from the layouts", () => {
  it("A2/A3/A4: one book per matched directory, everything beneath it is a track", async () => {
    const { shelves } = makeRules();
    const ownership = { index: loadOwnerIndex("L"), owners: new Map(), onlyRuleId: null };
    const map = await walkAudiobookFiles(libSource, SETTINGS, "folder_hierarchy", ownership);
    const summary: Record<string, number> = {};
    for (const [key, files] of map) summary[path.relative(libSource, key).replace(/\\/g, "/")] = files.length;
    expect(summary).toEqual({
      "Shelves/Iain M. Banks/Culture/02 - The Player of Games": 20,
      "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings": 6,   // Part 1 + Part 2
      "Various/The Horus Heresy/01 - Horus Rising": 2,
      "Various/The Horus Heresy/02 - False Gods": 2,
      "Shelves/J.R.R. Tolkien/The Hobbit/Andy Serkis": 1,
      "Shelves/J.R.R. Tolkien/The Hobbit/Rob Inglis": 1,
      "Loose/Some Book": 2                                              // default scanner
    });
    const kings = ownership.owners.get(path.join(libSource, "Shelves", "Brandon Sanderson", "Stormlight Archive", "01 - The Way of Kings"));
    expect(kings).toMatchObject({ ruleId: shelves.id, anchor: "Shelves", fields: { matched: true, layoutIndex: 0, series: "Stormlight Archive", position: 1, title: "The Way of Kings" } });
    const serkis = ownership.owners.get(path.join(libSource, "Shelves", "J.R.R. Tolkien", "The Hobbit", "Andy Serkis"));
    expect(serkis?.fields).toMatchObject({ layoutIndex: 1, author: "J.R.R. Tolkien", title: "The Hobbit", narrator: "Andy Serkis" });
    expect(ownership.owners.has(path.join(libSource, "Loose", "Some Book"))).toBe(false);
  });

  it("a rule-scoped walk starts at the rule's folders and ignores everyone else's files", async () => {
    const { various } = makeRules();
    const ownership = { index: loadOwnerIndex("L"), owners: new Map(), onlyRuleId: various.id };
    const map = await walkAudiobookFiles(libSource, SETTINGS, "folder_hierarchy", ownership);
    expect([...map.keys()].map((k) => path.relative(libSource, k).replace(/\\/g, "/")).sort())
      .toEqual(["Various/The Horus Heresy/01 - Horus Rising", "Various/The Horus Heresy/02 - False Gods"]);
  });
});

describe("a full scan with rules", () => {
  it("catalogs rule-owned books with path-derived fields, tags them with the rule, and leaves the default scanner its own", async () => {
    const { shelves, various } = makeRules();
    await scan();

    expect(live().map((i) => i.folder_path)).toEqual([
      "Loose/Some Book",
      "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings",
      "Shelves/Iain M. Banks/Culture/02 - The Player of Games",
      "Shelves/J.R.R. Tolkien/The Hobbit/Andy Serkis",
      "Shelves/J.R.R. Tolkien/The Hobbit/Rob Inglis",
      "Various/The Horus Heresy/01 - Horus Rising",
      "Various/The Horus Heresy/02 - False Gods"
    ]);

    const kings = byPath("Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings")!;
    expect(kings.scan_rule_id).toBe(shelves.id);
    expect(titleOf(kings.id)).toBe("The Way of Kings");
    expect(peopleOf(kings.id, "author")).toEqual(["Brandon Sanderson"]);
    expect(seriesOf(kings.id)).toEqual({ name: "Stormlight Archive", position: 1 });
    // Part 1 before Part 2, tracks in order within each.
    expect(trackPaths(kings.id)).toEqual([
      "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings/Part 1/001.mp3",
      "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings/Part 1/002.mp3",
      "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings/Part 1/003.mp3",
      "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings/Part 2/001.mp3",
      "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings/Part 2/002.mp3",
      "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings/Part 2/003.mp3"
    ]);

    const games = byPath("Shelves/Iain M. Banks/Culture/02 - The Player of Games")!;
    expect(trackPaths(games.id)).toHaveLength(20);

    // A4: two recordings stay two books, each with its narrator from the path.
    const serkis = byPath("Shelves/J.R.R. Tolkien/The Hobbit/Andy Serkis")!;
    const inglis = byPath("Shelves/J.R.R. Tolkien/The Hobbit/Rob Inglis")!;
    expect(titleOf(serkis.id)).toBe("The Hobbit");
    expect(peopleOf(serkis.id, "narrator")).toEqual(["Andy Serkis"]);
    expect(peopleOf(inglis.id, "narrator")).toEqual(["Rob Inglis"]);
    expect(seriesOf(serkis.id)).toBeUndefined();

    // A1: series-first shelf — the series comes from the path and, with no author in
    // the layout and no tags in these fake files, the author is NOT guessed from the
    // parent folder ("The Horus Heresy" is a series, not a person).
    const horus = byPath("Various/The Horus Heresy/01 - Horus Rising")!;
    expect(horus.scan_rule_id).toBe(various.id);
    expect(seriesOf(horus.id)).toEqual({ name: "The Horus Heresy", position: 1 });
    expect(peopleOf(horus.id, "author")).toEqual([]);

    // Outside every rule the default scanner behaves as before: the parent folder
    // is taken for the author, no rule id.
    const loose = byPath("Loose/Some Book")!;
    expect(loose.scan_rule_id).toBeNull();
    expect(peopleOf(loose.id, "author")).toEqual(["Loose"]);

    expect(getScanRule(shelves.id)?.lastScannedAt).not.toBeNull();
  });

  it("re-derives a book whose rule was edited even though its files did not change", async () => {
    const { various } = makeRules();
    await scan();
    const horus = byPath("Various/The Horus Heresy/01 - Horus Rising")!;
    expect(titleOf(horus.id)).toBe("Horus Rising");

    // Same boundary, different reading of the leaf: the number is now part of the title.
    updateScanRule(various.id, { name: "Various", layouts: ["{series}/{title}"], paths: ["Various"] });
    await scan();
    expect(byPath("Various/The Horus Heresy/01 - Horus Rising")?.id).toBe(horus.id);
    expect(titleOf(horus.id)).toBe("01 - Horus Rising");
    expect(seriesOf(horus.id)).toEqual({ name: "The Horus Heresy", position: null });
  });
});

describe("rule-scoped scan and reconcile", () => {
  it("walks only the rule's folders and soft-deletes only the rule's vanished books", async () => {
    const { various } = makeRules();
    await scan();
    const before = live().length;

    // Remove one book from the rule's shelf AND one from the default scanner's.
    fs.rmSync(path.join(libSource, "Various", "The Horus Heresy", "02 - False Gods"), { recursive: true });
    fs.rmSync(path.join(libSource, "Loose"), { recursive: true });
    await scan({ ruleId: various.id });

    expect(byPath("Various/The Horus Heresy/02 - False Gods")).toBeUndefined();
    // Not walked, so not touched: the default scanner's book survives until a full scan.
    expect(byPath("Loose/Some Book")).toBeDefined();
    expect(live().length).toBe(before - 1);
    expect(getScanRule(various.id)?.lastScannedAt).not.toBeNull();

    await scan();
    expect(byPath("Loose/Some Book")).toBeUndefined();
  });

  it("disabling a rule hands its books to the default scanner in place", async () => {
    const { various } = makeRules();
    await scan();
    const horus = byPath("Various/The Horus Heresy/01 - Horus Rising")!;
    updateScanRule(various.id, { name: "Various", layouts: ["{series}/{position} - {title}"], paths: ["Various"], enabled: false });
    await scan();
    const after = byPath("Various/The Horus Heresy/01 - Horus Rising")!;
    expect(after.id).toBe(horus.id);
    expect(after.scan_rule_id).toBeNull();
  });
});

describe("rescanSingleBook inside a rule", () => {
  it("keeps the rule's boundary and layouts (Part folders stay one book)", async () => {
    const { shelves } = makeRules();
    await scan();
    const kings = byPath("Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings")!;
    // Throw away the derived data and rescan just this book.
    db.prepare("DELETE FROM series_items WHERE item_id = ?").run(kings.id);
    db.prepare("UPDATE library_items SET scan_rule_id = NULL WHERE id = ?").run(kings.id);

    expect(await rescanSingleBook(kings.id)).toBe(kings.id);
    const after = byPath("Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings")!;
    expect(after.scan_rule_id).toBe(shelves.id);
    expect(seriesOf(kings.id)).toEqual({ name: "Stormlight Archive", position: 1 });
    expect(trackPaths(kings.id)).toHaveLength(6);
  });
});

describe("previewAudiobookRulePattern", () => {
  it("reports boundaries, tracks, layout index and what changes against today's catalog", async () => {
    // Today: the default scanner has catalogued the library, so "Part 1" and
    // "Part 2" are two separate books and the Hobbit folders are books of their own.
    await scan();
    expect(byPath("Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings/Part 1")).toBeDefined();

    const rows = await previewAudiobookRulePattern("L", ["Shelves"], ["{author}/{series}/{position} - {title}", "{author}/{title}/{narrator}"]);
    expect(rows).toEqual([
      {
        path: "Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings", matched: true, layoutIndex: 0,
        author: "Brandon Sanderson", series: "Stormlight Archive", position: 1, title: "The Way of Kings",
        narrator: undefined, year: undefined, publisher: undefined, tracks: 6, warnings: [], change: "merges:2"
      },
      {
        path: "Shelves/Iain M. Banks/Culture/02 - The Player of Games", matched: true, layoutIndex: 0,
        author: "Iain M. Banks", series: "Culture", position: 2, title: "The Player of Games",
        narrator: undefined, year: undefined, publisher: undefined, tracks: 20, warnings: [], change: "moves-from-default"
      },
      {
        path: "Shelves/J.R.R. Tolkien/The Hobbit/Andy Serkis", matched: true, layoutIndex: 1,
        author: "J.R.R. Tolkien", series: undefined, position: undefined, title: "The Hobbit",
        narrator: "Andy Serkis", year: undefined, publisher: undefined, tracks: 1, warnings: [], change: "moves-from-default"
      },
      {
        path: "Shelves/J.R.R. Tolkien/The Hobbit/Rob Inglis", matched: true, layoutIndex: 1,
        author: "J.R.R. Tolkien", series: undefined, position: undefined, title: "The Hobbit",
        narrator: "Rob Inglis", year: undefined, publisher: undefined, tracks: 1, warnings: [], change: "moves-from-default"
      }
    ]);
    // Nothing was written.
    expect(byPath("Shelves/Brandon Sanderson/Stormlight Archive/01 - The Way of Kings")).toBeUndefined();
  });
});
