// Whether a video's index sits in front, and who may be offered the rewrite that
// puts it there. The box reader works on hand-built headers — a real MP4's first
// bytes are exactly this and nothing more — so these never need a video file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import {
  FASTSTART_JOB_TYPE,
  enqueueFaststartJobs,
  faststartBacklogCount,
  listFaststartCandidates,
  readFaststart
} from "../src/modules/library/gallery/faststart.js";
import { resetDb, makeUser, makeLibrary } from "./helpers/seed.js";

let dir: string;

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "faststart-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A file of top-level boxes: [type, payload length]. Enough for the reader,
 *  which only ever looks at the 8- or 16-byte headers. */
function writeBoxes(name: string, boxes: [string, number][]): string {
  const parts: Buffer[] = [];
  for (const [type, payload] of boxes) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload, 0);
    header.write(type, 4, 4, "latin1");
    parts.push(header, Buffer.alloc(payload));
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

describe("reading where the MP4 index sits", () => {
  it("says yes when moov comes before the picture data", async () => {
    const file = writeBoxes("front.mp4", [["ftyp", 24], ["moov", 64], ["mdat", 512]]);
    expect(await readFaststart(file, ".mp4")).toBe(true);
  });

  it("says no when moov comes after it — what most editors write", async () => {
    const file = writeBoxes("back.mp4", [["ftyp", 24], ["free", 0], ["mdat", 4096], ["moov", 128]]);
    expect(await readFaststart(file, ".mp4")).toBe(false);
  });

  it("walks a 64-bit mdat without reading it", async () => {
    // `mdat` with a 32-bit size of 1 and its real length in the next 8 bytes, the
    // form every file over 4 GB uses.
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write("mdat", 4, 4, "latin1");
    header.writeBigUInt64BE(16n + 32n, 8);
    const ftyp = Buffer.alloc(8);
    ftyp.writeUInt32BE(8, 0);
    ftyp.write("ftyp", 4, 4, "latin1");
    const file = path.join(dir, "large.mp4");
    fs.writeFileSync(file, Buffer.concat([ftyp, header, Buffer.alloc(32)]));
    expect(await readFaststart(file, ".mp4")).toBe(false);
  });

  it("has no opinion about containers without boxes, or files it cannot read", async () => {
    const file = writeBoxes("clip.webm", [["ftyp", 8], ["moov", 8]]);
    expect(await readFaststart(file, ".webm")).toBeNull();
    expect(await readFaststart(path.join(dir, "gone.mp4"), ".mp4")).toBeNull();
    fs.writeFileSync(path.join(dir, "junk.mp4"), Buffer.alloc(4));
    expect(await readFaststart(path.join(dir, "junk.mp4"), ".mp4")).toBeNull();
  });

  it("gives up rather than trusting a nonsense box size", async () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(2, 0); // smaller than its own header
    header.write("ftyp", 4, 4, "latin1");
    const file = path.join(dir, "bad.mp4");
    fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(64)]));
    expect(await readFaststart(file, ".mp4")).toBeNull();
  });
});

/** A gallery video whose index is at the back (faststart = 0) unless told otherwise. */
function makeVideo(itemId: string, libraryId: string, opts: { faststart?: number | null; relativePath?: string; size?: number } = {}): void {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')")
    .run(itemId, libraryId, opts.relativePath ?? `${itemId}.mp4`);
  db.prepare(
    "INSERT INTO gallery_details (item_id, kind, relative_path, size, faststart) VALUES (?, 'video', ?, ?, ?)"
  ).run(itemId, opts.relativePath ?? `${itemId}.mp4`, opts.size ?? 1000, opts.faststart === undefined ? 0 : opts.faststart);
}

describe("the backlog of videos to optimise", () => {
  it("holds only videos whose index is at the back", () => {
    const lib = makeLibrary("gal", { createdBy: "admin", type: "gallery" });
    makeVideo("back", lib);
    makeVideo("front", lib, { faststart: 1 });
    makeVideo("unknown", lib, { faststart: null }); // webm, or never probed
    db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES ('photo', ?, 'gallery', 'p.jpg', 'ready')").run(lib);
    db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, faststart) VALUES ('photo', 'photo', 'p.jpg', 0)").run();

    expect(faststartBacklogCount()).toBe(1);
    expect(listFaststartCandidates().map((c) => c.itemId)).toEqual(["back"]);
  });

  it("leaves out a deleted video", () => {
    const lib = makeLibrary("gal", { createdBy: "admin", type: "gallery" });
    makeVideo("gone", lib);
    db.prepare("UPDATE library_items SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'gone'").run();
    expect(faststartBacklogCount()).toBe(0);
  });

  it("lists a video in a read-only library, but will not rewrite it", () => {
    const lib = makeLibrary("ext", { createdBy: "admin", type: "gallery", policyJson: JSON.stringify({ mode: "external" }) });
    makeVideo("readonly", lib);

    const [candidate] = listFaststartCandidates();
    expect(candidate.blocked).toBe("library");
    expect(enqueueFaststartJobs("all")).toBe(0);
    expect(enqueueFaststartJobs(["readonly"])).toBe(0);
  });

  it("lists a video under a folder lock, but will not rewrite it", () => {
    const lib = makeLibrary("gal", { createdBy: "admin", type: "gallery" });
    makeVideo("locked", lib, { relativePath: "Holidays/2019/clip.mp4" });
    db.prepare("INSERT INTO library_folder_locks (library_id, folder_path, locked_by) VALUES (?, 'Holidays', 'admin')").run(lib);

    const [candidate] = listFaststartCandidates();
    expect(candidate.blocked).toBe("locked");
    expect(enqueueFaststartJobs("all")).toBe(0);
  });

  it("queues what it may, once, and reports each video as queued afterwards", () => {
    const lib = makeLibrary("gal", { createdBy: "admin", type: "gallery" });
    makeVideo("one", lib, { size: 9000 });
    makeVideo("two", lib, { size: 100 });

    // Biggest first: the long wait is the one worth fixing soonest.
    expect(listFaststartCandidates().map((c) => c.itemId)).toEqual(["one", "two"]);

    expect(enqueueFaststartJobs(["one"])).toBe(1);
    expect(enqueueFaststartJobs(["one"])).toBe(0); // already lined up
    expect(listFaststartCandidates().find((c) => c.itemId === "one")?.queued).toBe(true);

    expect(enqueueFaststartJobs("all")).toBe(1); // only "two" is left
    const jobs = db.prepare("SELECT payload FROM jobs WHERE type = ?").all(FASTSTART_JOB_TYPE) as { payload: string }[];
    expect(jobs.map((j) => (JSON.parse(j.payload) as { itemId: string }).itemId).sort()).toEqual(["one", "two"]);
  });
});
