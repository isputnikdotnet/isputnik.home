import { describe, expect, it } from "vitest";
import { applyMark } from "../src/shared/MarkdownEditor";

// The toolbar's whole job is this function: what the marks do to a selection,
// and where the cursor lands afterwards.
const BOLD = { before: "**", after: "**" };
const LINK = { before: "[", after: "](https://)" };
const BULLET = { prefix: "- " };
const NUMBER = { prefix: "1. ", ordered: true as const };

describe("applyMark", () => {
  it("wraps the selection and keeps it selected", () => {
    const out = applyMark("one two three", 4, 7, BOLD);
    expect(out.value).toBe("one **two** three");
    expect(out.value.slice(out.start, out.end)).toBe("two");
  });

  it("unwraps a selection that already carries the mark", () => {
    const value = "one **two** three";
    const out = applyMark(value, 6, 9, BOLD);
    expect(out.value).toBe("one two three");
    expect(out.value.slice(out.start, out.end)).toBe("two");
  });

  it("parks the cursor between the marks when nothing is selected", () => {
    const out = applyMark("", 0, 0, BOLD);
    expect(out.value).toBe("****");
    expect(out.start).toBe(2);
    expect(out.end).toBe(2);
  });

  it("leaves the link's href ready to be typed over", () => {
    const out = applyMark("see the map", 4, 11, LINK);
    expect(out.value).toBe("see [the map](https://)");
  });

  it("bullets every line the selection touches, even partly", () => {
    const out = applyMark("first\nsecond\nthird", 3, 8, BULLET);
    expect(out.value).toBe("- first\n- second\nthird");
  });

  it("takes the bullets off again when every line has one", () => {
    const out = applyMark("- first\n- second", 0, 16, BULLET);
    expect(out.value).toBe("first\nsecond");
  });

  it("numbers a list in order", () => {
    const out = applyMark("first\nsecond\nthird", 0, 18, NUMBER);
    expect(out.value).toBe("1. first\n2. second\n3. third");
  });

  it("unnumbers a list whatever its numbers say", () => {
    const out = applyMark("1. first\n2. second", 0, 18, NUMBER);
    expect(out.value).toBe("first\nsecond");
  });

  it("marks the line the cursor sits on when nothing is selected", () => {
    const out = applyMark("first\nsecond", 8, 8, BULLET);
    expect(out.value).toBe("first\n- second");
  });
});
