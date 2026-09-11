// Embedded chapters in an m4b (audiobook/mp4-chapters.ts), read by random access.
//
// The reader exists because of one real-world layout: Audible files put `mdat` (the
// media, chapter titles included) BEFORE `moov` (the index saying where those
// titles are). A single forward pass — what music-metadata does — has walked past
// the titles by the time it learns where they were, so those books scanned with no
// chapters. The fixtures are that layout and the ordinary one, the same book both
// ways, made with the bundled ffmpeg and committed (1.7 KB each):
//
//   ffmpeg -f lavfi -i anullsrc=r=8000:cl=mono -i meta.txt -map 0:a -map_metadata 1
//          -map_chapters 1 -t 6 -c:a alac -fflags +bitexact [-movflags +faststart]
//          -f ipod chapters-{mdat,moov}-first.m4b
//
// with meta.txt an FFMETADATA1 file of three chapters: "Пролог" 0–2 s, "Chapter One:
// The Road" 2–4.5 s, "Epilogue" 4.5–6 s. ffmpeg writes both a QuickTime chapter
// track and a Nero `chpl` list, so the fallback can be exercised by knocking the
// first out. ALAC, not AAC: ffmpeg's AAC encoder is unreliable on synthetic input.
//
// And the other half of the contract: chapter reading is best-effort and must never
// fail a scan, so a damaged file gives [] rather than an exception.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMp4ChapterContainer, readMp4Chapters } from "../src/modules/library/audiobook/mp4-chapters.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MDAT_FIRST = path.join(here, "fixtures", "chapters-mdat-first.m4b");
const MOOV_FIRST = path.join(here, "fixtures", "chapters-moov-first.m4b");

const EXPECTED = [
  { title: "Пролог", startSeconds: 0, endSeconds: 2 },
  { title: "Chapter One: The Road", startSeconds: 2, endSeconds: 4.5 },
  { title: "Epilogue", startSeconds: 4.5, endSeconds: 6 }
];

let scratch: string;
beforeAll(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mp4-chapters-")); });
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

// ── A small atom walker, for looking at and damaging the fixtures ────────────

interface Box { type: string; at: number; start: number; end: number }

function children(buf: Buffer, parent: { start: number; end: number }): Box[] {
  const out: Box[] = [];
  let pos = parent.start;
  while (pos + 8 <= parent.end) {
    const size = buf.readUInt32BE(pos);
    if (size < 8) break;
    out.push({ type: buf.toString("latin1", pos + 4, pos + 8), at: pos, start: pos + 8, end: pos + size });
    pos += size;
  }
  return out;
}

function child(buf: Buffer, parent: { start: number; end: number }, type: string): Box {
  const found = children(buf, parent).find((box) => box.type === type);
  if (!found) throw new Error(`no ${type} atom`);
  return found;
}

const root = (buf: Buffer) => ({ start: 0, end: buf.length });

/** The chapter track: the trak whose handler is 'text'. */
function chapterStbl(buf: Buffer): Box {
  const moov = child(buf, root(buf), "moov");
  const trak = children(buf, moov).filter((box) => box.type === "trak").find((candidate) => {
    const hdlr = child(buf, child(buf, candidate, "mdia"), "hdlr");
    return buf.toString("latin1", hdlr.start + 8, hdlr.start + 12) === "text";
  });
  if (!trak) throw new Error("no chapter track");
  return child(buf, child(buf, child(buf, trak, "mdia"), "minf"), "stbl");
}

/** Rename an atom in place — same length, so every offset stays valid. */
function rename(buf: Buffer, box: Box, type: string): void {
  buf.write(type, box.at + 4, "latin1");
}

function withBytes(name: string, damage: (buf: Buffer) => void, source = MDAT_FIRST): string {
  const buf = Buffer.from(fs.readFileSync(source));
  damage(buf);
  const file = path.join(scratch, name);
  fs.writeFileSync(file, buf);
  return file;
}

const knockOutChapterTrack = (buf: Buffer) => {
  const moov = child(buf, root(buf), "moov");
  for (const trak of children(buf, moov).filter((box) => box.type === "trak")) {
    const tref = children(buf, trak).find((box) => box.type === "tref");
    if (tref) rename(buf, child(buf, tref, "chap"), "xxxx");
  }
};

const knockOutNero = (buf: Buffer) => {
  const moov = child(buf, root(buf), "moov");
  rename(buf, child(buf, child(buf, moov, "udta"), "chpl"), "xxxx");
};

// ── The layouts ──────────────────────────────────────────────────────────────

describe("reading the chapter track", () => {
  it("has fixtures in the two layouts it claims", () => {
    const order = (file: string) => children(fs.readFileSync(file), root(fs.readFileSync(file)))
      .map((box) => box.type).filter((type) => type === "mdat" || type === "moov");
    expect(order(MDAT_FIRST)).toEqual(["mdat", "moov"]);
    expect(order(MOOV_FIRST)).toEqual(["moov", "mdat"]);
  });

  it("reads an Audible-style file, mdat before moov", () => {
    expect(readMp4Chapters(MDAT_FIRST)).toEqual(EXPECTED);
  });

  it("reads the ordinary layout, moov first", () => {
    expect(readMp4Chapters(MOOV_FIRST)).toEqual(EXPECTED);
  });
});

describe("the Nero fallback", () => {
  it("reads chpl when there is no chapter track", () => {
    const file = withBytes("nero-only.m4b", knockOutChapterTrack);

    // chpl stores starts only: each chapter ends where the next begins, and the
    // last one's end is unknown.
    expect(readMp4Chapters(file)).toEqual([
      { title: "Пролог", startSeconds: 0, endSeconds: 2 },
      { title: "Chapter One: The Road", startSeconds: 2, endSeconds: 4.5 },
      { title: "Epilogue", startSeconds: 4.5, endSeconds: null }
    ]);
  });

  it("finds nothing when a file has neither", () => {
    const file = withBytes("no-chapters.m4b", (buf) => { knockOutChapterTrack(buf); knockOutNero(buf); });

    expect(readMp4Chapters(file)).toEqual([]);
  });

  it("falls back when the chapter track's sample sizes are implausible", () => {
    // A size table claiming millions of samples is a misread, not a book: the reader
    // refuses to allocate for it and uses the other list.
    const file = withBytes("bad-stsz.m4b", (buf) => {
      const stsz = child(buf, chapterStbl(buf), "stsz");
      buf.writeUInt32BE(0, stsz.start + 4); // not a uniform size…
      buf.writeUInt32BE(5_000_000, stsz.start + 8); // …and far too many samples
    });

    expect(readMp4Chapters(file).map((chapter) => chapter.title)).toEqual(EXPECTED.map((chapter) => chapter.title));
  });

  it("falls back when the chapter track's sample-to-chunk table is implausible", () => {
    // The same guard as the size, duration and chunk tables. Without it the reader
    // sizes a buffer from the claimed count (12 bytes an entry — at 0xFFFFFFFF that
    // is a 51 GB request), and a count merely too big for the file throws past the
    // fallback, so the book loses the chapters its chpl list still had.
    const file = withBytes("bad-stsc.m4b", (buf) => {
      const stsc = child(buf, chapterStbl(buf), "stsc");
      buf.writeUInt32BE(200_000, stsc.start + 4);
    });

    expect(readMp4Chapters(file).map((chapter) => chapter.title)).toEqual(EXPECTED.map((chapter) => chapter.title));
  });
});

describe("a file that is not what it says", () => {
  it.each([
    ["cut off halfway", (buf: Buffer) => buf.subarray(0, Math.floor(buf.length / 2))],
    ["cut off inside moov", (buf: Buffer) => buf.subarray(0, child(buf, root(buf), "moov").start + 40)],
    ["empty", () => Buffer.alloc(0)],
    ["text", () => Buffer.from("not an mp4 at all, just words\n".repeat(20))],
    ["an atom claiming to be bigger than the file", (buf: Buffer) => {
      const copy = Buffer.from(buf);
      copy.writeUInt32BE(0x7fffffff, child(copy, root(copy), "moov").at);
      return copy;
    }]
  ])("gives [] rather than throwing: %s", (name, make) => {
    const file = path.join(scratch, `broken-${name.replace(/\W+/g, "-")}.m4b`);
    fs.writeFileSync(file, make(fs.readFileSync(MDAT_FIRST)));

    expect(() => readMp4Chapters(file)).not.toThrow();
    expect(readMp4Chapters(file)).toEqual([]);
  });

  it("gives [] for a path that isn't there", () => {
    expect(readMp4Chapters(path.join(scratch, "missing.m4b"))).toEqual([]);
  });
});

describe("which files it reads", () => {
  it.each([[".m4b", true], [".M4B", true], [".m4a", true], [".mp4", true], [".m4v", true], [".mp3", false], [".flac", false], ["", false]])(
    "%s → %s",
    (extension, expected) => {
      expect(isMp4ChapterContainer(extension)).toBe(expected);
    }
  );
});
