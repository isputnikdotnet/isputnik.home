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

describe("part folders (3.62.1)", () => {
  it("folds '(Часть_1)' / '(Часть_2)' subfolders into the parent book, tracks in part order", async () => {
    // The exact shape reported: one book split into two part folders whose
    // tracks each restart at 0001.
    const book = "Эрих_Мария_Ремарк_-_Три_товарища_(Максим_Пинскер)";
    for (const part of ["Эрих_Мария_Ремарк_-_ Три_товарища_(Часть_1)", "Эрих_Мария_Ремарк_-_ Три_товарища_(Часть_2)"]) {
      fs.mkdirSync(path.join(root, book, part), { recursive: true });
      for (const f of ["0001.mp3", "0002.mp3"]) fs.writeFileSync(path.join(root, book, part, f), "x");
    }
    const map = await walkAudiobookFiles(root, settings, "folder_hierarchy");
    expect(summarize(map)[book]).toBe(4);
    const files = map.get(path.join(root, book))!;
    expect(files.map((f) => f.discHint).sort()).toEqual([1, 1, 2, 2]);
  });

  it("recognises the common spellings of a part marker and nothing else", async () => {
    const { discNumberFromFolderName } = await import("../src/modules/library/audiobook/scanner.js");
    for (const [name, n] of [
      ["CD 1", 1], ["cd2", 2], ["Disc 3", 3], ["Part 1", 1], ["Часть 2", 2], ["Диск 3", 3],
      ["Три товарища (Часть_1)", 1], ["Book - Part 2", 2], ["Book_pt.3", 3], ["Book [Disc 4]", 4]
    ] as const) {
      expect(discNumberFromFolderName(name), name).toBe(n);
    }
    for (const name of ["Karlson", "Chapter 12", "Party 2", "Volume 3", "1984", "Часть первая"]) {
      expect(discNumberFromFolderName(name), name).toBeNull();
    }
  });

  it("keeps a part folder directly under the library root as its own book", async () => {
    fs.mkdirSync(path.join(root, "Some Novel Part 1"));
    fs.mkdirSync(path.join(root, "Some Novel Part 2"));
    fs.writeFileSync(path.join(root, "Some Novel Part 1", "01.mp3"), "x");
    fs.writeFileSync(path.join(root, "Some Novel Part 2", "01.mp3"), "x");
    const map = await walkAudiobookFiles(root, settings, "folder_hierarchy");
    const summary = summarize(map);
    expect(summary["Some Novel Part 1"]).toBe(1);
    expect(summary["Some Novel Part 2"]).toBe(1);
    // The pre-existing root files still form the root book; nothing was folded into it.
    expect(summary["."]).toBe(3);
  });
});

describe("peopleFromTags", () => {
  it("moves a 'Читает:' album artist to the narrators and keeps a composer that repeats the author out of them", async () => {
    const { peopleFromTags } = await import("../src/modules/library/audiobook/scanner.js");
    expect(peopleFromTags({ albumartist: "Читает: Максим Пинскер", artist: "Эрих Мария Ремарк", composer: ["Эрих Мария Ремарк"] }))
      .toEqual({ authors: ["Эрих Мария Ремарк"], narrators: ["Максим Пинскер"] });
    expect(peopleFromTags({ albumartists: ["Narrated by Jane Doe"], artists: ["John Smith"], composer: ["Read by Jane Doe"] }))
      .toEqual({ authors: ["John Smith"], narrators: ["Jane Doe"] });
    // The plain case is unchanged: album artist is the author, composer the narrator.
    expect(peopleFromTags({ albumartist: "Isaac Asimov", composer: ["Scott Brick"] }))
      .toEqual({ authors: ["Isaac Asimov"], narrators: ["Scott Brick"] });
  });
});
