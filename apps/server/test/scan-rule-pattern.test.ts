import { describe, expect, it } from "vitest";
import {
  matchPattern, matchLayouts, validatePattern, validateLayouts, expandOptionalSections, normaliseAuthorName, patternDepth
} from "../src/modules/library/shared/scan-rule-pattern.js";

describe("matchPattern", () => {
  it("captures author, series, position and title from a full pattern", () => {
    expect(matchPattern("{author}/{series}/{position}. {title}", "Isaac Asimov/Foundation/01. Foundation"))
      .toEqual({ matched: true, author: "Isaac Asimov", series: "Foundation", position: 1, title: "Foundation" });
  });

  it("captures a whole-segment token", () => {
    expect(matchPattern("{title}", "Вне закона")).toEqual({ matched: true, title: "Вне закона" });
  });

  it("discards an {ignore} level (e.g. a universe folder)", () => {
    expect(matchPattern("{ignore}/{series}/{position}. {title}", "Universe/Earth/3. Book"))
      .toEqual({ matched: true, series: "Earth", position: 3, title: "Book" });
  });

  it("does not strip ordinals implicitly — the pattern must say so", () => {
    expect(matchPattern("{series}", "1. Foo")).toEqual({ matched: true, series: "1. Foo" });
    expect(matchPattern("{ignore}. {series}", "1. Foo")).toEqual({ matched: true, series: "Foo" });
  });

  it("requires the literal separators to be present", () => {
    expect(matchPattern("{author} - {title}", "Orwell - 1984"))
      .toEqual({ matched: true, author: "Orwell", title: "1984" });
    expect(matchPattern("{author} - {title}", "Orwell, 1984")).toEqual({ matched: false });
  });

  it("accepts decimal positions and flexible whitespace", () => {
    expect(matchPattern("{series}/{position}. {title}", "S/2.5. Novella"))
      .toEqual({ matched: true, series: "S", position: 2.5, title: "Novella" });
    expect(matchPattern("{position}. {title}", "1.  Foundation"))
      .toEqual({ matched: true, position: 1, title: "Foundation" });
  });

  it("treats a digit-ordinal dot as a separator even without the trailing space", () => {
    // Real FB2 libraries mix "1. Title" and "1.Title"; both map under "{position}. {title}".
    expect(matchPattern("{series}/{position}. {title}", "Эпоха мертвых/1.Начало"))
      .toEqual({ matched: true, series: "Эпоха мертвых", position: 1, title: "Начало" });
    expect(matchPattern("{position}. {title}", "10.Title")).toEqual({ matched: true, position: 10, title: "Title" });
  });

  it("keeps a decimal position intact when relaxing the ordinal space", () => {
    // The relaxed (space-less) boundary only fires before a NON-digit, so the dot
    // inside a decimal is never mistaken for the separator.
    expect(matchPattern("{series}/{position}. {title}", "S/2.5.Novella"))
      .toEqual({ matched: true, series: "S", position: 2.5, title: "Novella" });
  });

  it("requires the depth to match exactly", () => {
    expect(matchPattern("{author}/{title}", "A/B/C")).toEqual({ matched: false });
    expect(matchPattern("{author}/{series}/{title}", "A/B")).toEqual({ matched: false });
  });
});

describe("validatePattern", () => {
  it("accepts a well-formed pattern", () => {
    expect(validatePattern("{author}/{series}/{position}. {title}", "ebook")).toEqual([]);
  });

  it("rejects unknown tokens, ebook narrators, duplicates, adjacency, traversal, empty", () => {
    expect(validatePattern("{author}/{foo}", "ebook")).toContain("Unknown token {foo}.");
    expect(validatePattern("{narrator}/{title}", "ebook")).toContain("{narrator} is only valid for audiobook rules.");
    expect(validatePattern("{narrator}/{title}", "audiobook")).toEqual([]);
    expect(validatePattern("{title}/{title}", "ebook")).toContain("Token {title} is used more than once.");
    expect(validatePattern("{author}{title}", "ebook")).toContain("{author} and {title} need a separator between them.");
    expect(validatePattern("../{title}", "ebook")).toContain("Pattern must not contain '..'.");
    expect(validatePattern("   ", "ebook")).toEqual(["Enter a pattern."]);
  });
});

describe("layouts and optional sections (docs/scan-layout-plan.md)", () => {
  it("E1 — an optional series section inside the file name", () => {
    const layout = "{position} - <{series}_>{title}";
    expect(matchPattern(layout, "004 - The Old Republic_Revan"))
      .toEqual({ matched: true, position: 4, series: "The Old Republic", title: "Revan" });
    expect(matchPattern(layout, "009 - Knight Errant"))
      .toEqual({ matched: true, position: 9, title: "Knight Errant" });
  });

  it("E2 — fallback layouts cover series books and standalone books at different depths", () => {
    const layouts = ["{author}/{series}/{position} - {title}", "{author}/{title}"];
    expect(matchLayouts(layouts, "Arthur Conan Doyle/Sherlock Holmes/01 - A Study in Scarlet"))
      .toEqual({ matched: true, layoutIndex: 0, author: "Arthur Conan Doyle", series: "Sherlock Holmes", position: 1, title: "A Study in Scarlet" });
    expect(matchLayouts(layouts, "Arthur Conan Doyle/The Lost World"))
      .toEqual({ matched: true, layoutIndex: 1, author: "Arthur Conan Doyle", title: "The Lost World" });
    expect(matchLayouts(layouts, "Magazines/Analog/2019/Analog 2019-03")).toEqual({ matched: false, layoutIndex: null });
  });

  it("E3 — series first, author at the end of the file name", () => {
    expect(matchPattern("{series}/{position} - {title} - {author}", "Star Trek/001 - Title One - Author A"))
      .toEqual({ matched: true, series: "Star Trek", position: 1, title: "Title One", author: "Author A" });
  });

  it("E4 — trailing publisher and year are captured or skipped, and 'Last, First' is turned around", () => {
    expect(matchPattern("{author} - {title} ({publisher}, {year})", "Doyle, Arthur Conan - A Study in Scarlet (Penguin, 2003)"))
      .toEqual({ matched: true, author: "Arthur Conan Doyle", title: "A Study in Scarlet", publisher: "Penguin", year: 2003 });
    expect(matchPattern("{author} - {title} ({ignore})", "Doyle, Arthur Conan - A Study in Scarlet (Penguin, 2003)"))
      .toEqual({ matched: true, author: "Arthur Conan Doyle", title: "A Study in Scarlet" });
    expect(normaliseAuthorName("Smith, John & Doe, Jane")).toBe("Smith, John & Doe, Jane");
  });

  it("E5 — a numeric folder is only a position when the pattern says so", () => {
    expect(matchPattern("{author}/{title} ({ignore})/{ignore}", "Arthur Conan Doyle/A Study in Scarlet (1044)/A Study in Scarlet"))
      .toEqual({ matched: true, author: "Arthur Conan Doyle", title: "A Study in Scarlet" });
  });

  it("drops a non-numeric position or a non-year with a warning instead of failing the match", () => {
    expect(matchPattern("{position} - {title}", "one - Foo"))
      .toEqual({ matched: true, title: "Foo", warnings: ['"one" is not a number, so the position was dropped.'] });
    expect(matchPattern("{title} ({year})", "Foo (nineteen)"))
      .toEqual({ matched: true, title: "Foo", warnings: ['"nineteen" is not a four-digit year, so it was dropped.'] });
  });

  it("expands optional sections most-complete first and validates their shape", () => {
    expect(expandOptionalSections("{author}/<{series}/>{title}")).toEqual(["{author}/{series}/{title}", "{author}/{title}"]);
    expect(expandOptionalSections("<a><b>x")).toEqual(["abx", "ax", "bx", "x"]);
    expect(validatePattern("{position} - <{series}_{title}", "ebook")).toEqual(["Optional sections need a matching < and >."]);
    expect(validatePattern("{a}<<{b}>>", "ebook")).toEqual(["Optional sections cannot be nested."]);
    expect(validatePattern("{position}<{series}>{title}", "ebook"))
      .toEqual([
        "{position} and {series} need a separator between them.",
        "{series} and {title} need a separator between them.",
        "{position} and {title} need a separator between them. (with an optional section left out)"
      ]);
    expect(validatePattern("{author} - {title} [{narrator}]", "audiobook")).toEqual([]);
  });

  it("validateLayouts numbers errors when a rule holds several layouts", () => {
    expect(validateLayouts(["{author}/{title}", "{title}/{title}"], "ebook")).toEqual(["Layout 2: Token {title} is used more than once."]);
    expect(validateLayouts([], "ebook")).toEqual(["Enter a pattern."]);
  });

  it("patternDepth reports the deepest variant", () => {
    expect(patternDepth("{author}/<{series}/>{title}")).toBe(3);
    expect(patternDepth("{title}")).toBe(1);
  });
});
