import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { scanGalleryLibrary, scanSingleGalleryFile } from "../src/modules/library/gallery/scanner.js";
import { contentIdFromMakerNote, liveCandidates, readStillContentId } from "../src/modules/library/gallery/live-photos.js";
import { listMissingGalleryPhotos } from "../src/modules/library/gallery/cleanup.js";
import { moveGalleryAsset } from "../src/modules/library/gallery/move.js";
import { galleryStreamPlugin } from "../src/modules/library/gallery/stream.js";
import { trashBook, restoreTrashedItem } from "../src/modules/library/shared/trash.js";
import { thumbnailAbsolutePath, thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { bootApp } from "./helpers/boot.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";
import "./helpers/media-types.js";

// Live Photos (docs/photo-sync-plan.md, phase 5; gallery/live-photos.ts): a still and
// the short .mov with its name are ONE photo with motion, in any gallery library —
// paired by name, kept apart when Apple's content identifiers disagree or the clip is
// a real video, and the clip follows its still through the bin and a move.
//
// Fixtures are made here: no CC0 Live Photo was to be had, so a JPEG carries a
// hand-built Apple MakerNote (the identifier at tag 0x0011) and ffmpeg writes the
// clip with com.apple.quicktime.content.identifier — what an iPhone writes.

const FFMPEG = (ffmpegStatic as unknown as string | null) || "ffmpeg";
const ID = "6F1C2B3A-1111-4222-8333-944455556666";

let base = "";
const root = (id: string) => path.join(base, id);

function makeGalleryLibrary(id: string): void {
  makeLibrary(id, { createdBy: "u1", type: "gallery" });
  fs.mkdirSync(root(id), { recursive: true });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = ?").run(root(id), id);
}

/** An Apple MakerNote: "Apple iOS\0", version 1, "MM", one IFD entry (0x0011, ASCII). */
function appleMakerNote(contentId: string): Buffer {
  const header = Buffer.concat([Buffer.from("Apple iOS\0", "latin1"), Buffer.from([0x00, 0x01]), Buffer.from("MM", "latin1")]);
  const value = Buffer.from(`${contentId}\0`, "latin1");
  const ifd = Buffer.alloc(18);
  ifd.writeUInt16BE(1, 0);
  ifd.writeUInt16BE(0x0011, 2);
  ifd.writeUInt16BE(2, 4);
  ifd.writeUInt32BE(value.length, 6);
  ifd.writeUInt32BE(header.length + ifd.length, 10);
  return Buffer.concat([header, ifd, value]);
}

/** An APP1 Exif block: IFD0 { Make=Apple, ExifIFD } → ExifIFD { MakerNote }. */
function exifWithMakerNote(note: Buffer): Buffer {
  const make = Buffer.from("Apple\0", "latin1");
  const tiffHeader = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
  const ifd0 = Buffer.alloc(2 + 2 * 12 + 4);
  const makeOff = 8 + ifd0.length;
  const exifIfdOff = makeOff + make.length;
  const exifIfd = Buffer.alloc(2 + 12 + 4);
  const noteOff = exifIfdOff + exifIfd.length;
  ifd0.writeUInt16BE(2, 0);
  ifd0.writeUInt16BE(0x010f, 2); ifd0.writeUInt16BE(2, 4); ifd0.writeUInt32BE(make.length, 6); ifd0.writeUInt32BE(makeOff, 10);
  ifd0.writeUInt16BE(0x8769, 14); ifd0.writeUInt16BE(4, 16); ifd0.writeUInt32BE(1, 18); ifd0.writeUInt32BE(exifIfdOff, 22);
  exifIfd.writeUInt16BE(1, 0);
  exifIfd.writeUInt16BE(0x927c, 2); exifIfd.writeUInt16BE(7, 4); exifIfd.writeUInt32BE(note.length, 6); exifIfd.writeUInt32BE(noteOff, 10);
  return Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiffHeader, ifd0, make, exifIfd, note]);
}

/** A small JPEG still, with Apple's content identifier when one is given. */
async function still(libraryId: string, relativePath: string, contentId: string | null = ID, seed = 1): Promise<string> {
  const abs = path.join(root(libraryId), relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const plain = await sharp({ create: { width: 40 + seed * 4, height: 30, channels: 3, background: { r: seed * 40, g: 90, b: 140 } } }).jpeg().toBuffer();
  if (!contentId) {
    fs.writeFileSync(abs, plain);
    return abs;
  }
  const exif = exifWithMakerNote(appleMakerNote(contentId));
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(exif.length + 2, 2);
  fs.writeFileSync(abs, Buffer.concat([plain.subarray(0, 2), marker, exif, plain.subarray(2)]));
  return abs;
}

/** A clip as an iPhone writes one: QuickTime, with the content identifier. */
function clip(libraryId: string, relativePath: string, opts: { contentId?: string | null; seconds?: number; codec?: "libx264" | "mpeg4" } = {}): string {
  const abs = path.join(root(libraryId), relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const contentId = opts.contentId === undefined ? ID : opts.contentId;
  execFileSync(FFMPEG, [
    "-v", "error", "-f", "lavfi", "-i", `testsrc=size=64x48:rate=10:duration=${opts.seconds ?? 1}`,
    "-c:v", opts.codec ?? "libx264", "-pix_fmt", "yuv420p",
    ...(contentId ? ["-movflags", "use_metadata_tags", "-metadata", `com.apple.quicktime.content.identifier=${contentId}`] : []),
    "-f", "mov", "-y", abs
  ]);
  return abs;
}

type Row = { id: string; folder_path: string; deleted_at: string | null; motion_relative_path: string | null; motion_duration: number | null; motion_web_key: string | null };
function rows(libraryId: string): Row[] {
  return db.prepare(`
    SELECT li.id, li.folder_path, li.deleted_at, gd.motion_relative_path, gd.motion_duration, gd.motion_web_key
    FROM library_items li LEFT JOIN gallery_details gd ON gd.item_id = li.id
    WHERE li.library_id = ? ORDER BY li.folder_path
  `).all(libraryId) as Row[];
}
const live = (libraryId: string) => rows(libraryId).filter((row) => row.deleted_at === null);
const byPath = (libraryId: string, folderPath: string) => rows(libraryId).find((row) => row.folder_path === folderPath);

beforeEach(() => {
  resetDb();
  db.prepare("DELETE FROM jobs").run();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "live-photos-"));
  const thumbs = path.join(base, "thumbs");
  fs.mkdirSync(thumbs);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbs);
});

describe("the rule", () => {
  it("reads Apple's content identifier from a MakerNote, and nothing from anything else", async () => {
    expect(contentIdFromMakerNote(appleMakerNote(ID))).toBe(ID);
    expect(contentIdFromMakerNote(Buffer.from("Nikon\0\0\0\0\0\0\0\0\0\0\0"))).toBeNull();
    expect(contentIdFromMakerNote(null)).toBeNull();
    makeGalleryLibrary("GAL");
    expect(await readStillContentId(await still("GAL", "a.jpg"))).toBe(ID);
    expect(await readStillContentId(await still("GAL", "b.jpg", null))).toBeNull();
  });

  it("pairs by folder and name, prefers the HEIC, and leaves big clips and two clips alone", () => {
    const f = (relativePath: string, size = 1000) => ({ relativePath, extension: path.extname(relativePath).toLowerCase(), size });
    const pairs = liveCandidates([
      f("A/IMG_1.HEIC"), f("A/IMG_1.JPG"), f("A/img_1.mov"),
      f("A/IMG_2.JPG"), f("B/IMG_2.MOV"),
      f("A/IMG_3.JPG"), f("A/IMG_3.MOV", 400 * 1024 * 1024),
      f("A/IMG_4.JPG"), f("A/IMG_4.MOV"), f("A/IMG_4.mov.mov")
    ]);
    expect([...pairs].map(([s, c]) => [s, c.relativePath])).toEqual([
      ["A/IMG_1.HEIC", "A/img_1.mov"],
      ["A/IMG_4.JPG", "A/IMG_4.MOV"]
    ]);
  });
});

describe("scanning a library", () => {
  it("makes a still and its clip one photo with motion", async () => {
    makeGalleryLibrary("GAL");
    await still("GAL", "Camera/IMG_0001.JPG");
    clip("GAL", "Camera/IMG_0001.MOV");
    await still("GAL", "Camera/IMG_0002.JPG", null, 2);
    await scanGalleryLibrary("GAL");

    expect(live("GAL").map((row) => row.folder_path)).toEqual(["Camera/IMG_0001.JPG", "Camera/IMG_0002.JPG"]);
    const photo = byPath("GAL", "Camera/IMG_0001.JPG")!;
    expect(photo.motion_relative_path).toBe("Camera/IMG_0001.MOV");
    expect(photo.motion_duration).toBeCloseTo(1, 0);
    // H.264 plays everywhere: no copy.
    expect(photo.motion_web_key).toBeNull();
    // Never an item, so never "missing".
    expect(byPath("GAL", "Camera/IMG_0001.MOV")).toBeUndefined();
    expect(listMissingGalleryPhotos().items).toEqual([]);

    // A rescan with nothing changed reads nothing and changes nothing.
    await scanGalleryLibrary("GAL");
    expect(byPath("GAL", "Camera/IMG_0001.JPG")!.motion_relative_path).toBe("Camera/IMG_0001.MOV");
  });

  it("keeps them apart when the identifiers disagree, or the clip is a video of its own", async () => {
    makeGalleryLibrary("GAL");
    await still("GAL", "IMG_0010.JPG", ID);
    clip("GAL", "IMG_0010.MOV", { contentId: "00000000-0000-4000-8000-000000000000" });
    await still("GAL", "IMG_0011.JPG", null, 2);
    clip("GAL", "IMG_0011.MOV", { contentId: null, seconds: 8 });
    // One identifier missing (an edited or exported copy) is no objection.
    await still("GAL", "IMG_0012.JPG", null, 3);
    clip("GAL", "IMG_0012.MOV");
    await scanGalleryLibrary("GAL");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["IMG_0010.JPG", "IMG_0010.MOV", "IMG_0011.JPG", "IMG_0011.MOV", "IMG_0012.JPG"]);
    expect(byPath("GAL", "IMG_0012.JPG")!.motion_relative_path).toBe("IMG_0012.MOV");
  });

  it("retires a clip that was catalogued as a video before, without calling it missing", async () => {
    makeGalleryLibrary("GAL");
    clip("GAL", "IMG_0020.MOV");
    await scanGalleryLibrary("GAL");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["IMG_0020.MOV"]);
    await still("GAL", "IMG_0020.JPG");
    await scanGalleryLibrary("GAL");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["IMG_0020.JPG"]);
    expect(byPath("GAL", "IMG_0020.JPG")!.motion_relative_path).toBe("IMG_0020.MOV");
    expect(listMissingGalleryPhotos().items).toEqual([]);
  });

  it("makes an H.264 copy of a clip a browser may not play", async () => {
    makeGalleryLibrary("GAL");
    await still("GAL", "IMG_0030.JPG");
    clip("GAL", "IMG_0030.MOV", { codec: "mpeg4" });
    await scanGalleryLibrary("GAL");
    const photo = byPath("GAL", "IMG_0030.JPG")!;
    expect(photo.motion_web_key).toMatch(/-motion\.mp4$/);
    expect(fs.existsSync(thumbnailAbsolutePath(photo.motion_web_key!))).toBe(true);
  });
});

describe("one file at a time (a phone's upload)", () => {
  it("pairs a clip that arrives after its still", async () => {
    makeGalleryLibrary("GAL");
    await still("GAL", "Phone/IMG_0040.JPG");
    const stillId = await scanSingleGalleryFile("GAL", "Phone/IMG_0040.JPG");
    clip("GAL", "Phone/IMG_0040.MOV");
    expect(await scanSingleGalleryFile("GAL", "Phone/IMG_0040.MOV")).toBe(stillId);
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["Phone/IMG_0040.JPG"]);
    expect(byPath("GAL", "Phone/IMG_0040.JPG")!.motion_relative_path).toBe("Phone/IMG_0040.MOV");
  });

  it("pairs a still that arrives after its clip, retiring the video item", async () => {
    makeGalleryLibrary("GAL");
    clip("GAL", "Phone/IMG_0041.MOV");
    await scanSingleGalleryFile("GAL", "Phone/IMG_0041.MOV");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["Phone/IMG_0041.MOV"]);
    await still("GAL", "Phone/IMG_0041.JPG");
    await scanSingleGalleryFile("GAL", "Phone/IMG_0041.JPG");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["Phone/IMG_0041.JPG"]);
    expect(byPath("GAL", "Phone/IMG_0041.JPG")!.motion_relative_path).toBe("Phone/IMG_0041.MOV");
  });
});

describe("the clip follows its still", () => {
  it("into the bin and back", async () => {
    makeGalleryLibrary("GAL");
    await still("GAL", "IMG_0050.JPG");
    clip("GAL", "IMG_0050.MOV");
    await scanGalleryLibrary("GAL");
    trashBook(byPath("GAL", "IMG_0050.JPG")!.id, "u1");
    expect(fs.existsSync(path.join(root("GAL"), "IMG_0050.MOV"))).toBe(false);
    const binned = db.prepare("SELECT id, back_path FROM trashed_items").get() as { id: string; back_path: string | null };
    expect(binned.back_path).toBe("IMG_0050.MOV");

    await restoreTrashedItem(binned.id, true);
    await scanGalleryLibrary("GAL");
    expect(live("GAL").map((row) => row.folder_path)).toEqual(["IMG_0050.JPG"]);
    expect(byPath("GAL", "IMG_0050.JPG")!.motion_relative_path).toBe("IMG_0050.MOV");
  });

  it("into another library, under the still's new name", async () => {
    makeGalleryLibrary("GAL");
    makeGalleryLibrary("DEST");
    await still("GAL", "IMG_0060.JPG");
    clip("GAL", "IMG_0060.MOV");
    await still("DEST", "Kept/IMG_0060.JPG", null, 4); // the name is taken there
    await scanGalleryLibrary("GAL");
    await scanGalleryLibrary("DEST");
    const moved = moveGalleryAsset(byPath("GAL", "IMG_0060.JPG")!.id, { libraryId: "DEST", folder: "Kept" });
    expect(moved.ok).toBe(true);
    const arrived = live("DEST").find((row) => row.motion_relative_path)!;
    expect(arrived.folder_path).toBe("Kept/IMG_0060 (2).JPG");
    expect(arrived.motion_relative_path).toBe("Kept/IMG_0060 (2).MOV");
    expect(fs.existsSync(path.join(root("DEST"), "Kept", "IMG_0060 (2).MOV"))).toBe(true);
    // And a rescan there agrees.
    await scanGalleryLibrary("DEST");
    expect(live("DEST").map((row) => row.folder_path)).toEqual(["Kept/IMG_0060 (2).JPG", "Kept/IMG_0060.JPG"]);
  });
});

describe("playing it", () => {
  it("serves the motion to whoever may see the photo, and says so on the asset", async () => {
    makeGalleryLibrary("GAL");
    await still("GAL", "IMG_0070.JPG");
    clip("GAL", "IMG_0070.MOV");
    await scanGalleryLibrary("GAL");
    const id = byPath("GAL", "IMG_0070.JPG")!.id;
    grant("group", EVERYONE_GROUP_ID, "GAL", "member");
    const booted = await bootApp({ plugins: [galleryStreamPlugin] });
    try {
      const me = booted.as(await booted.signIn("u1"));
      const res = await me.get(`/api/library/gallery/assets/${id}/motion`);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("video/quicktime");
      expect(Number(res.headers["content-length"])).toBe(fs.statSync(path.join(root("GAL"), "IMG_0070.MOV")).size);
      const ranged = await me.get(`/api/library/gallery/assets/${id}/motion`, undefined, { range: "bytes=0-99" });
      expect(ranged.statusCode).toBe(206);
      // A photo without motion has none to serve.
      await still("GAL", "IMG_0071.JPG", null, 2);
      await scanGalleryLibrary("GAL");
      expect((await me.get(`/api/library/gallery/assets/${byPath("GAL", "IMG_0071.JPG")!.id}/motion`)).statusCode).toBe(404);
    } finally {
      await booted.app.close();
    }
  });
});
