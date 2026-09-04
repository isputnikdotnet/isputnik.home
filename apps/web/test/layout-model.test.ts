import { describe, expect, it } from "vitest";
import {
  applyPreset, draftFromExample, groupsOf, humanize, joinAt, patternOf, problemsOf, splitGroup, splitPieces, textDraft, exampleDepth
} from "../src/features/control/layout/layout-model";

describe("splitPieces", () => {
  it("splits on the separators file names use and keeps them as literals", () => {
    expect(splitPieces("01 - A Study in Scarlet").map((t) => t.text)).toEqual(["01", " - ", "A Study in Scarlet"]);
    expect(splitPieces("Doyle - Title (Penguin, 2003)").map((t) => t.text)).toEqual(["Doyle", " - ", "Title", " (", "Penguin, 2003", ")"]);
    expect(splitPieces("01. Title").map((t) => t.text)).toEqual(["01", ". ", "Title"]);
    // An initials dot is not an ordinal.
    expect(splitPieces("J.R.R. Tolkien").map((t) => t.text)).toEqual(["J.R.R. Tolkien"]);
  });
});

describe("draftFromExample + patternOf", () => {
  it("labels an ebook example the obvious way and generates the pattern", () => {
    const draft = draftFromExample({ anchor: "", path: "Arthur Conan Doyle/Sherlock Holmes/01 - A Study in Scarlet.epub" }, "ebook");
    expect(draft.boundary).toBe(3);
    expect(patternOf(draft)).toBe("{author}/{series}/{position} - {title}");
  });

  it("guesses the folder right above a numbered leaf as the series, even at depth two", () => {
    const draft = draftFromExample({ anchor: "Arthur Conan Doyle", path: "Sherlock Holmes/01 - A Study in Scarlet.epub" }, "ebook");
    expect(patternOf(draft)).toBe("{series}/{position} - {title}");
    const plain = draftFromExample({ anchor: "", path: "Arthur Conan Doyle/The Lost World.epub" }, "ebook");
    expect(patternOf(plain)).toBe("{author}/{title}");
  });

  it("puts the audiobook boundary above disc-like folders and never labels the file", () => {
    const draft = draftFromExample({ anchor: "Shelves", path: "Brandon Sanderson/Stormlight Archive/01 - The Way of Kings/Part 1/001.mp3" }, "audiobook");
    expect(draft.boundary).toBe(3);
    expect(patternOf(draft)).toBe("{author}/{series}/{position} - {title}");
    expect(exampleDepth(draft.example!, "audiobook")).toBe(3);
  });

  it("joining a separator folds the next piece into the group and drops its role", () => {
    const draft = draftFromExample({ anchor: "", path: "Doyle - A Study - In Scarlet.epub" }, "ebook");
    expect(patternOf(draft)).toBe("{author} - {title} - {ignore}");
    const seg = draft.segments[0];
    seg.roles = { 0: "author", 2: "title", 4: "skip" };
    expect(patternOf(draft)).toBe("{author} - {title} - {ignore}");
    joinAt(seg, 3);
    expect(groupsOf(seg).map((g) => g.text)).toEqual(["Doyle", "A Study - In Scarlet"]);
    expect(patternOf(draft)).toBe("{author} - {title}");
    splitGroup(seg, 2);
    expect(groupsOf(seg).map((g) => g.text)).toEqual(["Doyle", "A Study", "In Scarlet"]);
  });
});

describe("applyPreset", () => {
  it("lays roles over pieces, joining the surplus into the last role", () => {
    const draft = draftFromExample({ anchor: "", path: "Isaac Asimov/Foundation/01 - Foundation - Extra.epub" }, "ebook");
    applyPreset(draft, "{author}/{series}/{position} - {title}", "ebook");
    expect(patternOf(draft)).toBe("{author}/{series}/{position} - {title}");
    applyPreset(draft, "{author}/{ignore}/{title}", "ebook");
    expect(patternOf(draft)).toBe("{author}/{ignore}/{title}");
  });

  it("moves the audiobook boundary to the preset's depth", () => {
    const draft = draftFromExample({ anchor: "", path: "J.R.R. Tolkien/The Hobbit/Andy Serkis/The Hobbit.m4b" }, "audiobook");
    applyPreset(draft, "{author}/{title}", "audiobook");
    expect(draft.boundary).toBe(2);
    expect(patternOf(draft)).toBe("{author}/{title}");
    applyPreset(draft, "{author}/{title}/{narrator}", "audiobook");
    expect(draft.boundary).toBe(3);
    expect(patternOf(draft)).toBe("{author}/{title}/{narrator}");
  });
});

describe("problemsOf + humanize + text mode", () => {
  it("flags a duplicated role and a position without a series", () => {
    const draft = draftFromExample({ anchor: "", path: "A/01 - B.epub" }, "ebook");
    draft.segments[0].roles = { 0: "title" };
    expect(problemsOf(draft, "ebook")).toEqual([
      { kind: "error", code: "duplicate", role: "title", count: 2 },
      { kind: "warning", code: "positionWithoutSeries" }
    ]);
    draft.segments[0].roles = { 0: "author" };
    draft.segments[1].roles = { 0: "position", 2: "title" };
    expect(problemsOf(draft, "ebook")).toEqual([{ kind: "warning", code: "positionWithoutSeries" }]);
  });

  it("a text draft is used verbatim", () => {
    const draft = textDraft("{position} - <{series}_>{title}");
    expect(patternOf(draft)).toBe("{position} - <{series}_>{title}");
    expect(humanize("{author}/{series}/{position} - {title}")).toBe("Author / Series / 01 - Title");
    expect(humanize("{author}/{title}", { "{author}": "Автор", "{title}": "Название" })).toBe("Автор / Название");
  });
});

describe("leaf guesses", () => {
  it("reads 'X - Y' as author and title when no folder above is the author", () => {
    const flat = draftFromExample({ anchor: "", path: "Arthur Conan Doyle - The Hound of the Baskervilles/01.mp3" }, "audiobook");
    expect(patternOf(flat)).toBe("{author} - {title}");
    const nested = draftFromExample({ anchor: "", path: "Arthur Conan Doyle/Sherlock Holmes - Volume One.epub" }, "ebook");
    expect(patternOf(nested)).toBe("{author}/{title} - {ignore}");
  });
});
