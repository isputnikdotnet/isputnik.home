import { describe, expect, it } from "vitest";
import { trimChars, trimWhere } from "../src/core/trim.js";

describe("trimChars", () => {
  it("drops the run at both ends and leaves the middle alone", () => {
    expect(trimChars("//a//b//", "/")).toBe("a//b");
    expect(trimChars(" ,; Negril, Jamaica ;", " ,;")).toBe("Negril, Jamaica");
    expect(trimChars("abc", "/")).toBe("abc");
  });

  it("trims one side when asked", () => {
    expect(trimChars("//a//", "/", "end")).toBe("//a");
    expect(trimChars("//a//", "/", "start")).toBe("a//");
    expect(trimChars("7FG40000", "0", "end")).toBe("7FG4");
  });

  it("returns an empty string when nothing else is there", () => {
    expect(trimChars("////", "/")).toBe("");
    expect(trimChars("////", "/", "end")).toBe("");
    expect(trimChars("", "/")).toBe("");
  });

  // The regex this replaced (/\/+$/) retries the run from each of its characters
  // when the run stops short of the end — seconds of CPU on a megabyte of slashes.
  it("stays quick on a long run that does not reach the end", () => {
    const hostile = `${"/".repeat(1_000_000)}x`;
    const started = performance.now();
    expect(trimChars(hostile, "/", "end")).toBe(hostile);
    expect(trimChars(hostile, "/")).toBe("x");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("trimWhere", () => {
  it("takes any test of a character", () => {
    expect(trimWhere("  12ab34 ", (char) => char === " " || (char >= "0" && char <= "9"))).toBe("ab");
  });
});
