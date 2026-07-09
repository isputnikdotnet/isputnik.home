import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkAudiobookFiles } from "../src/modules/library/audiobook/scanner.js";
import { normalizeLibrarySettings } from "../src/modules/library/shared/library-settings.js";

// walkAudiobookFiles reads the real filesystem, so these build a throwaway tree.
const settings = normalizeLibrarySettings("audiobook", JSON.stringify({ scan_extensions: ["mp3"] })) as never;

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kids-scan-"));
  // A flat pile of single-file audiobooks at the root, plus one real multi-file book
  // tucked in a subfolder.
  for (const name of ["Baba_Yaga.mp3", "Kolobok.mp3", "Repka.mp3"]) {
    fs.writeFileSync(path.join(root, name), "x");
  }
  fs.mkdirSync(path.join(root, "Karlson"));
  fs.writeFileSync(path.join(root, "Karlson", "01.mp3"), "x");
  fs.writeFileSync(path.join(root, "Karlson", "02.mp3"), "x");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Map the walk result to { relativeKey: fileCount } for readable assertions.
function summarize(map: Map<string, { relativePath: string }[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, files] of map) out[path.relative(root, key) || "."] = files.length;
  return out;
}

describe("audiobook grouping modes", () => {
  it("file_per_book: each loose root file is its own book; a subfolder stays one book", async () => {
    const map = await walkAudiobookFiles(root, settings, "file_per_book");
    expect(summarize(map)).toEqual({
      "Baba_Yaga.mp3": 1,
      "Kolobok.mp3": 1,
      "Repka.mp3": 1,
      Karlson: 2
    });
    // A single-file book keys off the file itself (so folder_path becomes the filename).
    expect(map.has(path.join(root, "Baba_Yaga.mp3"))).toBe(true);
  });

  it("folder_hierarchy (default): loose root files all collapse into one root book", async () => {
    const map = await walkAudiobookFiles(root, settings, "folder_hierarchy");
    expect(summarize(map)).toEqual({
      ".": 3,       // the three root files merged into a single book (the reported bug)
      Karlson: 2
    });
  });
});
