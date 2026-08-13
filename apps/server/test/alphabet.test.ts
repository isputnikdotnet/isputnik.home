// The alphabet index behind the A–Z strip: how a title or name gets its bucket
// and sort key, and how the catalog filters on them.
//
// The catalog half exists because SQLite can't do this itself — UPPER() is
// ASCII-only and there is no custom-collation API — so the bucket is stored on
// write and the tests below are what catch a regression to "derive it in SQL",
// which passes for Latin and silently drops every Cyrillic title.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { alphaFieldsFor } from "../src/modules/library/shared/alphabet.js";
import { applyItemAlphaIndex, backfillAlphaKeys } from "../src/modules/library/shared/alphabet-index.js";
import { queryCatalog, catalogFacets } from "../src/modules/library/audiobook/catalog.js";
import { listPeopleByRole } from "../src/modules/library/audiobook/people.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

const reader = { id: "reader", role: "member" };

const EMPTY_FILTERS = {
  libraries: [], authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], status: [], durations: []
};

// A book with a title, indexed the way the scanner would index it.
function makeBook(id: string, title: string, library = "AUDIO"): string {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'audiobook', ?, 'ready')"
  ).run(id, library, `/${id}`);
  db.prepare("INSERT INTO item_metadata (item_id, source, title, sort_title) VALUES (?, 'scan', ?, ?)")
    .run(id, title, title);
  applyItemAlphaIndex(id);
  return id;
}

function titlesFor(letter: string | null): string[] {
  const { books } = queryCatalog(reader.id, ["AUDIO"], {
    q: "", sort: "title", limit: 50, offset: 0, letter, filters: EMPTY_FILTERS
  }) as { books: { title: string }[] };
  return books.map((book) => book.title);
}

describe("alphaFieldsFor", () => {
  it("detects the script of the first meaningful character", () => {
    expect(alphaFieldsFor("Stephen King")).toMatchObject({ alphaKey: "S", alphaScript: "latin" });
    expect(alphaFieldsFor("Лев Толстой")).toMatchObject({ alphaKey: "Л", alphaScript: "cyrillic" });
    expect(alphaFieldsFor("村上春樹")).toMatchObject({ alphaKey: "#", alphaScript: "other" });
  });

  it("files digits, symbols and empty titles under #", () => {
    expect(alphaFieldsFor("1984").alphaKey).toBe("#");
    expect(alphaFieldsFor("!!!").alphaKey).toBe("#");
    expect(alphaFieldsFor(null).alphaKey).toBe("#");
  });

  it("steps over leading punctuation to reach the letter a reader files by", () => {
    expect(alphaFieldsFor("«Война и мир»").alphaKey).toBe("В");
    expect(alphaFieldsFor("'Salem's Lot").alphaKey).toBe("S");
  });

  it("folds accents and the stroked letters NFD can't decompose", () => {
    expect(alphaFieldsFor("Ángela Vallvey").alphaKey).toBe("A");
    expect(alphaFieldsFor("Łem").alphaKey).toBe("L");
    expect(alphaFieldsFor("Øst").alphaKey).toBe("O");
  });

  it("folds non-Russian Cyrillic onto the nearest Russian bucket", () => {
    // Ukrainian І and Belarusian Ў would otherwise land in "#" beside the digits.
    expect(alphaFieldsFor("Іван Франко").alphaKey).toBe("И");
    expect(alphaFieldsFor("Ўладзімір").alphaKey).toBe("У");
  });

  it("gives Ё its own bucket but sorts it as Е", () => {
    expect(alphaFieldsFor("Ёлка").alphaKey).toBe("Ё");
    // Sorted: Егор < Ёлка < Жук. By raw code point Ё (U+0401) would come first.
    const keys = ["Ёлка", "Егор", "Жук"].map((value) => alphaFieldsFor(value).sortKey);
    expect([...keys].sort()).toEqual([
      alphaFieldsFor("Егор").sortKey,
      alphaFieldsFor("Ёлка").sortKey,
      alphaFieldsFor("Жук").sortKey
    ]);
  });
});

describe("catalog letter filter", () => {
  beforeEach(() => {
    resetDb();
    makeUser("reader");
    makeUser("owner");
    makeLibrary("AUDIO", { createdBy: "owner", type: "audiobook" });
    grant("group", EVERYONE_GROUP_ID, "AUDIO", "member");
  });

  it("returns only the chosen bucket, in both scripts", () => {
    makeBook("b1", "Beloved");
    makeBook("b2", "Dune");
    makeBook("b3", "Белые ночи");
    makeBook("b4", "Бесы");

    expect(titlesFor("B")).toEqual(["Beloved"]);
    // The one a SQL-side UPPER() would silently return empty.
    expect(titlesFor("Б").sort()).toEqual(["Белые ночи", "Бесы"]);
    expect(titlesFor(null)).toHaveLength(4);
  });

  it("collects everything that isn't a letter under #", () => {
    makeBook("b1", "1984");
    makeBook("b2", "Dune");

    expect(titlesFor("#")).toEqual(["1984"]);
  });

  it("honours an administrator's override of the bucket", () => {
    makeBook("b1", "The Hobbit");
    db.prepare("UPDATE item_metadata SET alpha_override = 'T' WHERE item_id = 'b1'").run();

    expect(titlesFor("H")).toEqual([]);
    expect(titlesFor("T")).toEqual(["The Hobbit"]);
  });

  it("narrows to the chosen libraries, and can never widen past the scope", () => {
    makeLibrary("SECOND", { createdBy: "owner", type: "audiobook" });
    grant("group", EVERYONE_GROUP_ID, "SECOND", "member");
    makeBook("b1", "Dune");
    makeBook("b2", "Solaris", "SECOND");

    const inLibs = (libIds: string[], filterIds: string[]) => (queryCatalog(reader.id, libIds, {
      q: "", sort: "title", limit: 50, offset: 0, letter: null,
      filters: { ...EMPTY_FILTERS, libraries: filterIds }
    }) as { books: { title: string }[] }).books.map((b) => b.title);

    expect(inLibs(["AUDIO", "SECOND"], [])).toEqual(["Dune", "Solaris"]);
    expect(inLibs(["AUDIO", "SECOND"], ["SECOND"])).toEqual(["Solaris"]);
    expect(inLibs(["AUDIO", "SECOND"], ["AUDIO", "SECOND"])).toEqual(["Dune", "Solaris"]);
    // The scope is the ceiling: naming a library access didn't resolve returns
    // nothing rather than reaching into it.
    expect(inLibs(["AUDIO"], ["SECOND"])).toEqual([]);
  });

  it("offers exactly the scope's letters as facets", () => {
    makeBook("b1", "Dune");
    makeBook("b2", "Бесы");
    makeBook("b3", "1984");

    expect(catalogFacets(["AUDIO"]).letters.sort()).toEqual(["#", "D", "Б"].sort());
    expect(catalogFacets([]).letters).toEqual([]);
  });

  it("orders Cyrillic titles by letter, not by code point", () => {
    makeBook("b1", "Ёлка");
    makeBook("b2", "Абрамов");
    makeBook("b3", "Жук");

    // NOCASE alone would put Ёлка (U+0401) first, above Абрамов.
    expect(titlesFor(null)).toEqual(["Абрамов", "Ёлка", "Жук"]);
  });

  it("indexes rows the columns were added to empty (migration 34, then startup)", () => {
    makeBook("b1", "Бесы");
    db.prepare("UPDATE item_metadata SET alpha_key = NULL, alpha_script = NULL, sort_key = NULL").run();
    expect(titlesFor("Б")).toEqual([]);

    expect(backfillAlphaKeys()).toBe(1);
    expect(titlesFor("Б")).toEqual(["Бесы"]);
    // And a second boot has nothing left to do.
    expect(backfillAlphaKeys()).toBe(0);
  });
});

describe("people index", () => {
  beforeEach(() => {
    resetDb();
    makeUser("reader");
    makeUser("owner");
    makeLibrary("AUDIO", { createdBy: "owner", type: "audiobook" });
    grant("group", EVERYONE_GROUP_ID, "AUDIO", "member");
  });

  function credit(name: string, sortName: string | null = null, role: "author" | "narrator" = "author"): void {
    const itemId = `i-${name}-${role}`;
    db.prepare(
      "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'AUDIO', 'audiobook', ?, 'ready')"
    ).run(itemId, `/${itemId}`);
    db.prepare("INSERT OR IGNORE INTO people (id, name, sort_name) VALUES (?, ?, ?)").run(`p-${name}`, name, sortName);
    db.prepare("INSERT INTO item_people (item_id, person_id, role, sort_order) VALUES (?, ?, ?, 0)")
      .run(itemId, `p-${name}`, role);
  }

  const authorNamed = (name: string) => listPeopleByRole(reader.id, reader.role, "author").find((a) => a.name === name)!;

  it("indexes a person under both their first name and their surname", () => {
    credit("Ursula K. Le Guin");
    expect(authorNamed("Ursula K. Le Guin")).toMatchObject({ alphaKey: "U", alphaKeyLast: "G" });
  });

  it("prefers a curated 'Surname, First' sort name over guessing the last word", () => {
    credit("J. R. R. Tolkien", "Tolkien, J. R. R.");
    expect(authorNamed("J. R. R. Tolkien").alphaKeyLast).toBe("T");
  });

  it("looks past a generational suffix for the surname", () => {
    credit("Martin Luther King Jr.");
    expect(authorNamed("Martin Luther King Jr.").alphaKeyLast).toBe("K");
  });

  it("indexes narrators the same way, on their own list", () => {
    credit("Стивен Фрай", null, "narrator");
    const narrators = listPeopleByRole(reader.id, reader.role, "narrator");
    expect(narrators.map((n) => n.name)).toEqual(["Стивен Фрай"]);
    expect(narrators[0].alphaKey).toBe("С");
    expect(listPeopleByRole(reader.id, reader.role, "author")).toEqual([]);
  });
});
