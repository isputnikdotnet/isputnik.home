import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { queryEbookCatalog, ebookCatalogFacets } from "../src/modules/library/ebook/catalog.js";
import type { CatalogFilters } from "../src/modules/library/shared/catalog-core.js";
import { getWorkEditions, setPrimaryEdition, removeEdition } from "../src/modules/library/works.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const EMPTY_FILTERS: CatalogFilters = {
  authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], status: [], durations: []
};

function addItem(id: string, libraryId: string, type: string, title: string): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, ?, ?, 'ready')")
    .run(id, libraryId, type, `${id}.epub`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, title);
}

function credit(itemId: string, name: string): void {
  const personId = name.replace(/\W/g, "").toLowerCase();
  db.prepare("INSERT OR IGNORE INTO people (id, name, sort_name) VALUES (?, ?, ?)").run(personId, name, name.toLowerCase());
  const pid = (db.prepare("SELECT id FROM people WHERE name = ?").get(name) as { id: string }).id;
  db.prepare("INSERT OR IGNORE INTO item_people (item_id, person_id, role, sort_order) VALUES (?, ?, 'author', 0)").run(itemId, pid);
}

function groupAsWork(workId: string, members: { itemId: string; primary?: boolean }[]): void {
  db.prepare("INSERT INTO works (id) VALUES (?)").run(workId);
  for (const m of members) {
    db.prepare("INSERT INTO work_items (work_id, item_id, is_primary) VALUES (?, ?, ?)")
      .run(workId, m.itemId, m.primary ? 1 : 0);
  }
}

interface Row { id: string; editionCount: number }
function runCatalog(libIds = ["EB"]): Row[] {
  const { books } = queryEbookCatalog("u1", libIds, { q: "", sort: "title", limit: 50, offset: 0, filters: EMPTY_FILTERS });
  return books as unknown as Row[];
}
const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

// Two ebook editions of one title (Standard Ebooks + Gutenberg) plus an unrelated
// standalone ebook, all in one accessible library.
beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("EB", { createdBy: "u1", type: "ebook" });
  grant("user", "u1", "EB", "member");

  addItem("ed-primary", "EB", "ebook", "Crime and Punishment");
  addItem("ed-other", "EB", "ebook", "Crime and Punishment");
  addItem("solo", "EB", "ebook", "The Idiot");
});

describe("editions collapse in the catalog", () => {
  it("shows every book when nothing is grouped", () => {
    expect(ids(runCatalog())).toEqual(["ed-other", "ed-primary", "solo"]);
  });

  it("collapses a work to its primary edition, leaving standalone books untouched", () => {
    groupAsWork("w1", [{ itemId: "ed-primary", primary: true }, { itemId: "ed-other" }]);
    expect(ids(runCatalog())).toEqual(["ed-primary", "solo"]);
  });

  it("reports the edition count on the representative and zero on standalone books", () => {
    groupAsWork("w1", [{ itemId: "ed-primary", primary: true }, { itemId: "ed-other" }]);
    const byId = Object.fromEntries(runCatalog().map((r) => [r.id, r]));
    expect(byId["ed-primary"].editionCount).toBe(2);
    expect(byId["solo"].editionCount).toBe(0);
  });

  it("derives a new representative when the primary is soft-deleted, so siblings never vanish", () => {
    groupAsWork("w1", [{ itemId: "ed-primary", primary: true }, { itemId: "ed-other" }]);
    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'ed-primary'").run();
    expect(ids(runCatalog())).toEqual(["ed-other", "solo"]);
  });

  it("keeps a per-type representative for a cross-type work and counts editions across types", () => {
    makeLibrary("AB", { createdBy: "u1", type: "audiobook" });
    grant("user", "u1", "AB", "member");
    addItem("ab-ed", "AB", "audiobook", "Crime and Punishment");
    groupAsWork("w1", [
      { itemId: "ed-primary", primary: true },
      { itemId: "ed-other" },
      { itemId: "ab-ed", primary: true }
    ]);
    // The ebook browse still resolves to the ebook representative, never the audiobook…
    const rows = runCatalog();
    expect(ids(rows)).toEqual(["ed-primary", "solo"]);
    // …and the badge counts all three editions of the work, across both types.
    expect(rows.find((r) => r.id === "ed-primary")!.editionCount).toBe(3);
  });
});

describe("getWorkEditions (switcher payload)", () => {
  const member = { id: "u1", role: "member" };

  it("returns the work's editions, primary first", () => {
    groupAsWork("w1", [{ itemId: "ed-other" }, { itemId: "ed-primary", primary: true }]);
    const work = getWorkEditions("w1", member)!;
    expect(work.editions.map((e) => e.id)).toEqual(["ed-primary", "ed-other"]);
    expect(work.editions[0].isPrimary).toBe(true);
    expect(work.editions[0].title).toBe("Crime and Punishment");
  });

  it("drops editions in libraries the user can't access", () => {
    makeLibrary("EB2", { createdBy: "u1", type: "ebook" }); // intentionally not granted to u1
    addItem("ed-hidden", "EB2", "ebook", "Crime and Punishment");
    groupAsWork("w1", [{ itemId: "ed-primary", primary: true }, { itemId: "ed-hidden" }]);
    const work = getWorkEditions("w1", member)!;
    expect(work.editions.map((e) => e.id)).toEqual(["ed-primary"]);
  });

  it("returns null for an unknown work", () => {
    expect(getWorkEditions("nope", member)).toBeNull();
  });
});

describe("work mutations (set primary / remove edition)", () => {
  const member = { id: "u1", role: "member" };

  it("moves the primary preference to another edition", () => {
    groupAsWork("w1", [{ itemId: "ed-primary", primary: true }, { itemId: "ed-other" }]);
    setPrimaryEdition("w1", "ed-other", "ebook");
    const work = getWorkEditions("w1", member)!;
    expect(work.editions[0].id).toBe("ed-other"); // the primary sorts first
    expect(work.editions.find((e) => e.id === "ed-primary")!.isPrimary).toBe(false);
  });

  it("removing one of three editions keeps the work and promotes a primary", () => {
    addItem("ed-third", "EB", "ebook", "Crime and Punishment");
    groupAsWork("w1", [{ itemId: "ed-primary", primary: true }, { itemId: "ed-other" }, { itemId: "ed-third" }]);
    expect(removeEdition("w1", "ed-primary")).toEqual({ remaining: 2, dissolved: false });
    const work = getWorkEditions("w1", member)!;
    expect(work.editions).toHaveLength(2);
    expect(work.editions.some((e) => e.isPrimary)).toBe(true); // a new primary took over
  });

  it("removing down to one edition dissolves the work", () => {
    groupAsWork("w1", [{ itemId: "ed-primary", primary: true }, { itemId: "ed-other" }]);
    expect(removeEdition("w1", "ed-other")).toEqual({ remaining: 0, dissolved: true });
    expect(getWorkEditions("w1", member)).toBeNull();
    // both books are standalone again, so both reappear in browse
    expect(ids(runCatalog())).toEqual(["ed-other", "ed-primary", "solo"]);
  });
});

describe("facets respect the editions collapse", () => {
  it("lists both editions' authors before grouping", () => {
    credit("ed-primary", "Primary Author");
    credit("ed-other", "Hidden Translator");
    const authors = ebookCatalogFacets(["EB"]).authors;
    expect(authors).toContain("Primary Author");
    expect(authors).toContain("Hidden Translator");
  });

  it("drops a hidden edition's unique author once grouped", () => {
    credit("ed-primary", "Primary Author");
    credit("ed-other", "Hidden Translator");
    groupAsWork("w1", [{ itemId: "ed-primary", primary: true }, { itemId: "ed-other" }]);
    const authors = ebookCatalogFacets(["EB"]).authors;
    expect(authors).toContain("Primary Author");      // the visible representative
    expect(authors).not.toContain("Hidden Translator"); // the collapsed edition
  });
});
