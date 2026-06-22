import { describe, expect, it } from "vitest";
import { matchPattern, validatePattern } from "../src/modules/library/shared/scan-rule-pattern.js";

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
