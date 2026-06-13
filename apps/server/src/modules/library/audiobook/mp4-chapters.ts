import fs from "node:fs";

// Raw chapter as read from the container; offsets are seconds within the file.
export interface RawChapter {
  title: string;
  startSeconds: number;
  endSeconds: number | null;
}

interface Atom {
  type: string;
  start: number; // first byte of payload (after the header)
  end: number;   // one past the last byte of the atom
}

const MP4_CHAPTER_EXTENSIONS = new Set([".m4b", ".m4a", ".mp4", ".m4v"]);

export function isMp4ChapterContainer(extension: string): boolean {
  return MP4_CHAPTER_EXTENSIONS.has(extension.toLowerCase());
}

/**
 * Read embedded chapters from an MP4/m4b/m4a file using random access.
 *
 * Unlike a single forward pass (what music-metadata does), seeking lets us read
 * the chapter track even when `mdat` precedes `moov` — the common Audible layout
 * where the titles live in `mdat` at offsets only known after parsing `moov`.
 *
 * Tries the QuickTime `chap` text track first, then falls back to Nero `chpl`.
 * Returns [] for files with neither (and never throws — chapter reading is
 * best-effort and must not fail a scan).
 */
export function readMp4Chapters(filePath: string): RawChapter[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const fileSize = fs.fstatSync(fd).size;
    const reader = new Mp4Reader(fd, fileSize);
    return reader.readChapterTrack() ?? reader.readNeroChapters() ?? [];
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

class Mp4Reader {
  constructor(private readonly fd: number, private readonly fileSize: number) {}

  private read(pos: number, len: number): Buffer {
    const buf = Buffer.alloc(len);
    const got = fs.readSync(this.fd, buf, 0, len, pos);
    return got === len ? buf : buf.subarray(0, got);
  }

  // Iterate the atoms directly inside [start, end). Handles 64-bit sizes.
  private *atoms(start: number, end: number): Generator<Atom> {
    let pos = start;
    while (pos + 8 <= end) {
      const header = this.read(pos, 16);
      if (header.length < 8) return;
      let size = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (header.length < 16) return;
        size = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos; // extends to the end of the container
      }
      if (size < headerSize || pos + size > end) return;
      yield { type, start: pos + headerSize, end: pos + size };
      pos += size;
    }
  }

  private first(start: number, end: number, type: string): Atom | null {
    for (const atom of this.atoms(start, end)) {
      if (atom.type === type) return atom;
    }
    return null;
  }

  private all(start: number, end: number, type: string): Atom[] {
    const out: Atom[] = [];
    for (const atom of this.atoms(start, end)) {
      if (atom.type === type) out.push(atom);
    }
    return out;
  }

  // ── QuickTime chapter text track ──────────────────────────────────────────
  readChapterTrack(): RawChapter[] | null {
    const moov = this.first(0, this.fileSize, "moov");
    if (!moov) return null;

    const traks = this.all(moov.start, moov.end, "trak");
    const chapterTrackId = this.findChapterTrackId(traks);
    if (chapterTrackId == null) return null;

    const chapterTrak = traks.find((trak) => this.trackId(trak) === chapterTrackId);
    if (!chapterTrak) return null;

    const mdia = this.first(chapterTrak.start, chapterTrak.end, "mdia");
    if (!mdia) return null;
    const mdhd = this.first(mdia.start, mdia.end, "mdhd");
    const minf = this.first(mdia.start, mdia.end, "minf");
    if (!mdhd || !minf) return null;
    const stbl = this.first(minf.start, minf.end, "stbl");
    if (!stbl) return null;

    const timescale = this.mediaTimescale(mdhd);
    if (!timescale) return null;

    const stts = this.first(stbl.start, stbl.end, "stts");
    const stsz = this.first(stbl.start, stbl.end, "stsz");
    const stsc = this.first(stbl.start, stbl.end, "stsc");
    const stco = this.first(stbl.start, stbl.end, "stco") ?? this.first(stbl.start, stbl.end, "co64");
    if (!stts || !stsz || !stco) return null;

    const durations = this.sampleDurations(stts);
    const sizes = this.sampleSizes(stsz);
    const offsets = this.sampleOffsets(stsc, stco, sizes);
    const count = Math.min(sizes.length, offsets.length);
    if (count === 0) return null;

    const chapters: RawChapter[] = [];
    let elapsed = 0; // in track time units
    for (let i = 0; i < count; i += 1) {
      const startSeconds = elapsed / timescale;
      elapsed += durations[i] ?? 0;
      const endSeconds = durations[i] != null ? elapsed / timescale : null;
      const title = this.readTextSample(offsets[i], sizes[i]);
      chapters.push({ title, startSeconds, endSeconds });
    }
    return chapters.length ? chapters : null;
  }

  private findChapterTrackId(traks: Atom[]): number | null {
    for (const trak of traks) {
      const tref = this.first(trak.start, trak.end, "tref");
      if (!tref) continue;
      const chap = this.first(tref.start, tref.end, "chap");
      if (chap && chap.end - chap.start >= 4) {
        return this.read(chap.start, 4).readUInt32BE(0);
      }
    }
    return null;
  }

  private trackId(trak: Atom): number | null {
    const tkhd = this.first(trak.start, trak.end, "tkhd");
    if (!tkhd) return null;
    const version = this.read(tkhd.start, 1).readUInt8(0);
    // tkhd: version(1)+flags(3)+create+modify(8 or 16)+trackId(4)
    const offset = version === 1 ? tkhd.start + 4 + 16 : tkhd.start + 4 + 8;
    return this.read(offset, 4).readUInt32BE(0);
  }

  private mediaTimescale(mdhd: Atom): number {
    const version = this.read(mdhd.start, 1).readUInt8(0);
    const offset = version === 1 ? mdhd.start + 4 + 16 : mdhd.start + 4 + 8;
    return this.read(offset, 4).readUInt32BE(0);
  }

  private sampleDurations(stts: Atom): number[] {
    const entryCount = this.read(stts.start + 4, 4).readUInt32BE(0);
    const table = this.read(stts.start + 8, entryCount * 8);
    const durations: number[] = [];
    for (let i = 0; i < entryCount; i += 1) {
      const count = table.readUInt32BE(i * 8);
      const duration = table.readUInt32BE(i * 8 + 4);
      for (let j = 0; j < count; j += 1) durations.push(duration);
    }
    return durations;
  }

  private sampleSizes(stsz: Atom): number[] {
    const uniformSize = this.read(stsz.start + 4, 4).readUInt32BE(0);
    const sampleCount = this.read(stsz.start + 8, 4).readUInt32BE(0);
    if (uniformSize !== 0) return new Array(sampleCount).fill(uniformSize);
    const table = this.read(stsz.start + 12, sampleCount * 4);
    const sizes: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) sizes.push(table.readUInt32BE(i * 4));
    return sizes;
  }

  // Map each sample to its absolute file offset via stsc (sample-to-chunk) + chunk
  // offsets. Chapter tracks are usually one-sample-per-chunk, but this handles the
  // general case so packed chapter tracks still resolve correctly.
  private sampleOffsets(stsc: Atom | null, stco: Atom, sizes: number[]): number[] {
    const is64 = stco.type === "co64";
    const chunkCount = this.read(stco.start + 4, 4).readUInt32BE(0);
    const chunkTable = this.read(stco.start + 8, chunkCount * (is64 ? 8 : 4));
    const chunkOffsets: number[] = [];
    for (let i = 0; i < chunkCount; i += 1) {
      chunkOffsets.push(is64 ? Number(chunkTable.readBigUInt64BE(i * 8)) : chunkTable.readUInt32BE(i * 4));
    }

    // stsc runs: [firstChunk, samplesPerChunk]. Default to 1 sample/chunk if absent.
    const runs: { firstChunk: number; samplesPerChunk: number }[] = [];
    if (stsc) {
      const entryCount = this.read(stsc.start + 4, 4).readUInt32BE(0);
      const table = this.read(stsc.start + 8, entryCount * 12);
      for (let i = 0; i < entryCount; i += 1) {
        runs.push({
          firstChunk: table.readUInt32BE(i * 12),
          samplesPerChunk: table.readUInt32BE(i * 12 + 4)
        });
      }
    }
    if (runs.length === 0) runs.push({ firstChunk: 1, samplesPerChunk: 1 });

    const offsets: number[] = [];
    let sampleIndex = 0;
    for (let r = 0; r < runs.length && sampleIndex < sizes.length; r += 1) {
      const run = runs[r];
      const lastChunk = r + 1 < runs.length ? runs[r + 1].firstChunk - 1 : chunkCount;
      for (let chunk = run.firstChunk; chunk <= lastChunk && sampleIndex < sizes.length; chunk += 1) {
        let offset = chunkOffsets[chunk - 1];
        if (offset == null) break;
        for (let s = 0; s < run.samplesPerChunk && sampleIndex < sizes.length; s += 1) {
          offsets.push(offset);
          offset += sizes[sampleIndex];
          sampleIndex += 1;
        }
      }
    }
    return offsets;
  }

  // A QuickTime text sample: 2-byte length, then the title bytes, then optional
  // formatting atoms we ignore. A leading BOM marks UTF-16.
  private readTextSample(offset: number, size: number): string {
    const buf = this.read(offset, Math.min(size, 2048));
    if (buf.length < 2) return "";
    const length = Math.min(buf.readUInt16BE(0), buf.length - 2);
    const text = buf.subarray(2, 2 + length);
    if (length >= 2 && text[0] === 0xfe && text[1] === 0xff) return text.swap16().toString("utf16le", 2).trim();
    if (length >= 2 && text[0] === 0xff && text[1] === 0xfe) return text.toString("utf16le", 2).trim();
    return text.toString("utf8").trim();
  }

  // ── Nero `chpl` fallback (moov/udta/chpl) ─────────────────────────────────
  readNeroChapters(): RawChapter[] | null {
    const moov = this.first(0, this.fileSize, "moov");
    if (!moov) return null;
    const udta = this.first(moov.start, moov.end, "udta");
    if (!udta) return null;
    const chpl = this.first(udta.start, udta.end, "chpl");
    if (!chpl) return null;

    const payload = this.read(chpl.start, chpl.end - chpl.start);
    if (payload.length < 5) return null;
    const version = payload.readUInt8(0);
    // version(1) + flags(3); version>0 adds a 4-byte field before the count.
    let pos = 4 + (version > 0 ? 4 : 0);
    if (pos >= payload.length) return null;
    const count = payload.readUInt8(pos);
    pos += 1;

    const raw: { startSeconds: number; title: string }[] = [];
    for (let i = 0; i < count && pos + 9 <= payload.length; i += 1) {
      const start = Number(payload.readBigUInt64BE(pos)); // 100-nanosecond units
      pos += 8;
      const titleLen = payload.readUInt8(pos);
      pos += 1;
      if (pos + titleLen > payload.length) break;
      const title = payload.toString("utf8", pos, pos + titleLen).trim();
      pos += titleLen;
      raw.push({ startSeconds: start / 10_000_000, title });
    }
    if (raw.length === 0) return null;

    return raw.map((chapter, i) => ({
      title: chapter.title,
      startSeconds: chapter.startSeconds,
      endSeconds: raw[i + 1]?.startSeconds ?? null
    }));
  }
}
