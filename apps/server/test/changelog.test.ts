// The changelog is data (src/changelog.json) checked as it loads, so a slip in a
// release's entry stops the boot with the entry named instead of reaching the
// About page, Home's "what's new" note or a GitHub Release as garbage.
import { describe, expect, it } from "vitest";
import { parseChangelog, VERSION_UPDATES } from "../src/changelog.js";

const entry = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  label: `Release ${version}`,
  changes: ["Something **bold** and `code` — with “quotes”."],
  ...extra
});
const parse = (data: unknown) => parseChangelog(JSON.stringify(data), "changelog.json");

describe("changelog.json", () => {
  it("loads the shipped file, newest first", () => {
    expect(VERSION_UPDATES.length).toBeGreaterThan(300);
    expect(VERSION_UPDATES.at(-1)?.version).toBe("0.1.0");
  });

  it("keeps Markdown and Unicode exactly as written", () => {
    expect(parse([entry("1.0.0")])[0].changes[0]).toBe("Something **bold** and `code` — with “quotes”.");
  });

  it.each([
    ["broken JSON", "[{", /not valid JSON/],
    ["not an array", JSON.stringify({ version: "1.0.0" }), /non-empty array/],
    ["an empty list", "[]", /non-empty array/],
    ["a misspelt field", JSON.stringify([entry("1.0.0", { change: [] })]), /entry 0 has unknown field\(s\) change/],
    ["a bad version", JSON.stringify([entry("1.0")]), /entry 0: "version"/],
    ["an empty label", JSON.stringify([entry("1.0.0", { label: " " })]), /entry 0 \(1\.0\.0\): "label"/],
    ["no changes", JSON.stringify([entry("1.0.0", { changes: [] })]), /"changes" must be a non-empty array/],
    ["a change that is not text", JSON.stringify([entry("1.0.0", { changes: ["ok", 3] })]), /changes\[1\] must be non-empty text/],
    ["oldest first", JSON.stringify([entry("1.0.0"), entry("1.1.0")]), /entry 1 \(1\.1\.0\) is listed below 1\.0\.0/],
    ["a version twice", JSON.stringify([entry("1.0.0"), entry("1.0.0")]), /entry 1 \(1\.0\.0\) is listed below 1\.0\.0/],
    ["10 sorted as text", JSON.stringify([entry("1.9.0"), entry("1.10.0")]), /entry 1 \(1\.10\.0\)/]
  ])("refuses %s, naming the file", (_case, text, message) => {
    expect(() => parseChangelog(text, "changelog.json")).toThrow(message);
    expect(() => parseChangelog(text, "changelog.json")).toThrow(/^changelog\.json: /);
  });

  it("accepts a well-formed newest-first list", () => {
    expect(parse([entry("1.10.0"), entry("1.9.0"), entry("0.1.0")]).map((u) => u.version)).toEqual(["1.10.0", "1.9.0", "0.1.0"]);
  });
});
