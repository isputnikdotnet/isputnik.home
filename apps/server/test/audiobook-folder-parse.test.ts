import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFolderName, findFolderCover } from "../src/modules/library/audiobook/scanner.js";

describe("parseFolderName", () => {
  it("returns the whole name as title when there is no author separator", () => {
    expect(parseFolderName("Дзікае паляванне караля Стаха")).toEqual({ title: "Дзікае паляванне караля Стаха" });
  });

  it("splits Author - Title", () => {
    expect(parseFolderName("Уладзімір Караткевіч - Чазенія")).toEqual({
      title: "Чазенія",
      authors: ["Уладзімір Караткевіч"]
    });
  });

  it("extracts a [Narrator] suffix", () => {
    expect(parseFolderName("Короткевич Владимир - Дикая охота короля Стаха [Иван Литвинов]")).toEqual({
      title: "Дикая охота короля Стаха",
      authors: ["Короткевич Владимир"],
      narrators: ["Иван Литвинов"]
    });
  });

  it("extracts a (Year) and [Narrator] in either order", () => {
    const expected = { title: "Some Book", authors: ["Jane Doe"], narrators: ["Reader One"], year: 2005 };
    expect(parseFolderName("Jane Doe - Some Book (2005) [Reader One]")).toEqual(expected);
    expect(parseFolderName("Jane Doe - Some Book [Reader One] (2005)")).toEqual(expected);
  });

  it("splits multiple authors and narrators", () => {
    expect(parseFolderName("A. One, B. Two - Title [Reader A, Reader B]")).toEqual({
      title: "Title",
      authors: ["A. One", "B. Two"],
      narrators: ["Reader A", "Reader B"]
    });
  });

  it("keeps subtitle dashes in the title (splits on the first separator only)", () => {
    expect(parseFolderName("Author - Title - Subtitle")).toEqual({
      title: "Title - Subtitle",
      authors: ["Author"]
    });
  });

  it("treats a bare leading number as an ordering prefix, not an author", () => {
    expect(parseFolderName("1 - ЦЫГАНСКІ КАРОЛЬ")).toEqual({ title: "ЦЫГАНСКІ КАРОЛЬ" });
  });

  it("ignores an empty narrator bracket", () => {
    expect(parseFolderName("Author - Title []")).toEqual({ title: "Title", authors: ["Author"] });
  });
});

describe("findFolderCover", () => {
  const settings = { cover_filenames: ["cover", "folder", "artwork"] } as unknown as Parameters<typeof findFolderCover>[1];
  let dir = "";
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const mk = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "isputnik-cover-")));
  const write = (filePath: string, bytes = 16) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.alloc(bytes));
  };

  it("finds a named .tif cover in the book folder", () => {
    const root = mk();
    write(path.join(root, "cover.tif"));
    write(path.join(root, "00001.mp3"));
    expect(findFolderCover(root, settings)).toBe(path.join(root, "cover.tif"));
  });

  it("prefers a named cover in the book folder over a sidecar Covers/ folder", () => {
    const root = mk();
    write(path.join(root, "folder.png"));
    write(path.join(root, "Covers", "cover.jpg"));
    expect(findFolderCover(root, settings)).toBe(path.join(root, "folder.png"));
  });

  it("falls back to a named cover inside a Covers/ subfolder", () => {
    const root = mk();
    write(path.join(root, "Covers", "cover.jpg"));
    expect(findFolderCover(root, settings)).toBe(path.join(root, "Covers", "cover.jpg"));
  });

  it("uses the largest image as a fallback, tiff included", () => {
    const root = mk();
    write(path.join(root, "small.jpg"), 16);
    write(path.join(root, "big.tif"), 4096);
    expect(findFolderCover(root, settings)).toBe(path.join(root, "big.tif"));
  });

  it("returns null when there is no usable image", () => {
    const root = mk();
    write(path.join(root, "00001.mp3"));
    expect(findFolderCover(root, settings)).toBeNull();
  });
});
