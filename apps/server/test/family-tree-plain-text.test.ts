import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "../src/modules/familytree/plain-text.js";

// A bio is markdown in the app and plain text in a GEDCOM NOTE: the marks the
// editor's buttons write come off, the words and line breaks stay.

describe("markdownToPlainText", () => {
  it("takes off what the editor's buttons write", () => {
    const bio = [
      "## Early years",
      "Born in **Minsk**, the *youngest* of five.",
      "> Never late, never early.",
      "- joiner",
      "1. Keswick",
      "See [the parish record](https://example.org/r/1) and ~~1902~~ 1901."
    ].join("\n");
    expect(markdownToPlainText(bio)).toBe([
      "Early years",
      "Born in Minsk, the youngest of five.",
      "Never late, never early.",
      "- joiner",
      "1. Keswick",
      "See the parish record (https://example.org/r/1) and 1902 1901."
    ].join("\n"));
  });

  it("leaves text that was never markdown as it was", () => {
    const note = "Worked at plant_no_4, 2*3 shifts a week.\nMoved in 1951 - to Kyiv.";
    expect(markdownToPlainText(note)).toBe(note);
  });

  it("drops the backslash from an escaped mark", () => {
    expect(markdownToPlainText(String.raw`5 \* 3 and \_name\_`)).toBe("5 * 3 and _name_");
  });
});
