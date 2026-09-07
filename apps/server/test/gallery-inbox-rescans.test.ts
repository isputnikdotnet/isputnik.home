import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { createJob } from "../src/modules/library/gallery/duplicates/jobs.js";
import { runJobScan, listJobResults, INBOX_KEEPER_REASON } from "../src/modules/library/gallery/duplicates/job-scan.js";
import {
  findInboxRescans,
  fingerprintGap,
  gridScore,
  rescanCandidates,
  rotateGrid,
  RESCAN_GATE_BITS
} from "../src/modules/library/gallery/duplicates/inbox-rescans.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// The Photo Inbox's second look (inbox-rescans.ts): the same print scanned twice
// lands a dozen fingerprint bits from its twin — far outside the near tier — so a
// wide gate proposes candidates and the pictures themselves settle it.

const INBOX_POLICY = JSON.stringify({ mode: "managed", inbox: true });
const GRID = 128;
let base = "";
let thumbs = "";

const root = (id: string) => path.join(base, id);

function makeGalleryLibrary(id: string, policyJson = "{}"): void {
  makeLibrary(id, { createdBy: "u1", type: "gallery", policyJson });
  fs.mkdirSync(root(id), { recursive: true });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = ?").run(root(id), id);
  grant("group", EVERYONE_GROUP_ID, id, "member");
}

/** A picture with real structure — soft bands crossed by two hard blocks, so a crop
 *  of it is recognisably the same scene and a different seed is a different scene. */
function pattern(width: number, height: number, seed: number): Buffer {
  const data = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      let value = 128
        + 60 * Math.sin((u * 6 + seed) * Math.PI)
        + 45 * Math.cos((v * 4 + seed * 2) * Math.PI)
        + 25 * Math.sin((u * 17 + v * 11 + seed) * Math.PI);
      if (u > 0.2 + seed * 0.05 && u < 0.45 && v > 0.3 && v < 0.75) value = 30;
      if (u > 0.6 && u < 0.8 && v > 0.15 + seed * 0.05 && v < 0.5) value = 225;
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return data;
}

type Scan = { crop?: number; brighten?: number; contrast?: number };

/** That picture as a scanner left it: framed a few percent differently (a hand-placed
 *  print never lands twice the same) and graded to that scanner's own taste. */
function scanOf(width: number, height: number, seed: number, opts: Scan) {
  let image = sharp(pattern(width, height, seed), { raw: { width, height, channels: 1 } });
  if (opts.crop) {
    const w = Math.round(width * opts.crop);
    const h = Math.round(height * opts.crop);
    image = image.extract({
      left: Math.round((width - w) * 0.7), top: Math.round((height - h) * 0.3), width: w, height: h
    });
  }
  if (opts.brighten || opts.contrast) image = image.linear(opts.contrast ?? 1, opts.brighten ?? 0);
  return image;
}

async function grid(width: number, height: number, seed: number, opts: Scan = {}): Promise<Uint8Array> {
  const { data } = await scanOf(width, height, seed, opts)
    .grayscale().resize(GRID, GRID, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, data.length);
}

/** A preview file in the thumbnail store, as a scan of that pattern would leave one. */
async function preview(key: string, width: number, height: number, seed: number, opts: Scan = {}): Promise<string> {
  const absolute = path.join(thumbs, key);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  await scanOf(width, height, seed, opts).png().toFile(absolute);
  return key;
}

/** The same fingerprint with `bits` of it flipped — a twin at a known distance. */
function apart(hex: string, bits: number): string {
  let value = BigInt(`0x${hex}`);
  for (let i = 0; i < bits; i += 1) value ^= 1n << BigInt((i * 3) % 64);
  return value.toString(16).padStart(16, "0");
}

function makePhoto(libraryId: string, id: string, relativePath: string, opts: {
  phash?: string; previewKey?: string; width?: number; height?: number
} = {}): void {
  const absolute = path.join(root(libraryId), relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `BYTES-${id}`);
  const stat = fs.statSync(absolute);
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')"
  ).run(id, libraryId, relativePath);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, modified_at, phash, preview_storage_key, width, height)
    VALUES (?, 'photo', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, relativePath, stat.size, stat.mtime.toISOString(),
    opts.phash ?? null, opts.previewKey ?? null, opts.width ?? null, opts.height ?? null
  );
}

beforeEach(() => {
  resetDb();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-rescans-"));
  thumbs = path.join(base, "thumbs");
  fs.mkdirSync(thumbs);
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, thumbs);
  makeGalleryLibrary("GAL");
  makeGalleryLibrary("INBOX", INBOX_POLICY);
});

describe("comparing the pictures", () => {
  it("knows one photograph re-cropped and re-toned from a different photograph", async () => {
    const original = await grid(600, 400, 1);
    const rescanned = await grid(600, 400, 1, { crop: 0.9, brighten: 24, contrast: 0.8 });
    const another = await grid(600, 400, 2);

    expect(gridScore(rescanned, original)).toBeGreaterThan(0.9);
    expect(gridScore(another, original)).toBeLessThan(0.9);
  });

  it("finds a print fed in sideways", async () => {
    const original = await grid(600, 400, 1);
    const sideways = rotateGrid(await grid(600, 400, 1, { brighten: 15 }));

    expect(gridScore(sideways, original)).toBeGreaterThan(0.9);
    // Upright-only is what a re-run from the preferences page can do; it must not
    // claim a match it never tested for.
    expect(gridScore(sideways, original, 1)).toBeLessThan(0.9);
  });

  it("measures a fingerprint gap across every variant a photo answers to", () => {
    expect(fingerprintGap(["ffffffffffffffff"], ["ffffffffffffffff"])).toBe(0);
    expect(fingerprintGap(["0000000000000000"], ["000000000000000f"])).toBe(4);
    expect(fingerprintGap(["0000000000000000", "00000000000000ff"], ["00000000000000ff"])).toBe(0);
    expect(fingerprintGap(["not a hash"], ["0000000000000000"])).toBe(64);
  });
});

describe("looking for the photograph an Inbox photo already is", () => {
  it("matches a re-scan the near tier is far too tight for, and leaves strangers alone", async () => {
    const seen = "ffff0000ffff0000";
    const incoming = [
      { itemId: "in", phash: seen, previewKey: await preview("in.png", 600, 400, 1, { crop: 0.9, brighten: 24, contrast: 0.8 }) }
    ];
    const library = [
      // Thirteen bits from the incoming photo — four times the near tier's window.
      { itemId: "twin", phash: apart(seen, 13), previewKey: await preview("twin.png", 600, 400, 1) },
      // Exactly as far by fingerprint, and a different photograph.
      { itemId: "stranger", phash: apart(seen, 13), previewKey: await preview("stranger.png", 600, 400, 2) }
    ];
    expect(fingerprintGap([incoming[0].phash], [library[0].phash])).toBe(13);

    const matches = await findInboxRescans(incoming, library);
    expect(matches.map((match) => match.libraryItemId)).toEqual(["twin"]);
    expect(matches[0]).toMatchObject({ incomingId: "in", distance: 13 });
    expect(matches[0].score).toBeGreaterThan(0.9);
  });

  it("never looks past the gate — a twin too far by fingerprint is not proposed", async () => {
    const incoming = [
      { itemId: "in", phash: "0000000000000000", previewKey: await preview("in.png", 600, 400, 1, { crop: 0.9 }) }
    ];
    const library = [
      { itemId: "twin", phash: apart("0000000000000000", 20), previewKey: await preview("twin.png", 600, 400, 1) }
    ];
    expect(fingerprintGap([incoming[0].phash], [library[0].phash])).toBeGreaterThan(RESCAN_GATE_BITS);
    expect(await findInboxRescans(incoming, library)).toEqual([]);
  });

  it("reads a library's photos through the rotations an Inbox photo answers to", async () => {
    const seen = "ffff0000ffff0000";
    const sideways = await preview("in.png", 600, 400, 1, { brighten: 15 });
    const incoming = [{ itemId: "in", phash: apart(seen, 24), previewKey: sideways, variants: [seen] }];
    const library = [{ itemId: "twin", phash: seen, previewKey: await preview("twin.png", 600, 400, 1) }];

    // The photo's own fingerprint is nowhere near; the variant is what opens the gate.
    expect(fingerprintGap([incoming[0].phash], [library[0].phash])).toBeGreaterThan(RESCAN_GATE_BITS);
    const matches = await findInboxRescans(incoming, library);
    expect(matches.map((match) => match.libraryItemId)).toEqual(["twin"]);
    expect(matches[0].distance).toBe(0);
  });

  it("reads the candidates of a library, skipping what it cannot judge", async () => {
    makePhoto("GAL", "g1", "kept/1.jpg", { phash: "ffff0000ffff0000", previewKey: "g1.png" });
    makePhoto("GAL", "g2", "kept/2.jpg", { phash: null as unknown as string, previewKey: "g2.png" });
    makePhoto("GAL", "g3", "kept/3.jpg", { phash: "ffff0000ffff0001" });
    db.prepare("UPDATE library_items SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'g1'").run();
    makePhoto("GAL", "g4", "kept/4.jpg", { phash: "ffff0000ffff0002", previewKey: "g4.png" });

    expect(rescanCandidates(["GAL"]).map((row) => row.itemId)).toEqual(["g4"]);
    expect(rescanCandidates([])).toEqual([]);
  });
});

describe("the check's snapshot", () => {
  it("writes a match as a review set the library's copy keeps", async () => {
    makePhoto("INBOX", "in", "2026/1.jpg", { phash: "ffff0000ffff0000", previewKey: "in.png", width: 3900, height: 2700 });
    makePhoto("GAL", "twin", "kept/1.png", { phash: apart("ffff0000ffff0000", 13), previewKey: "twin.png", width: 8100, height: 5800 });
    const created = createJob({
      ownerUserId: "u1", libraryIds: ["GAL", "INBOX"], duplicateType: "inbox", inboxLibraryId: "INBOX", mediaType: "photo"
    });
    if (!created.ok) throw new Error(created.refused);

    // Nothing links these two without the second look: 13 bits is outside the tier.
    expect(runJobScan(created.job.id, "u1").summary).toMatchObject({ nearSets: 0, results: 0 });

    const outcome = runJobScan(created.job.id, "u1", {
      rescans: [{ incomingId: "in", libraryItemId: "twin", distance: 13, score: 0.94 }]
    });
    expect(outcome.summary).toMatchObject({ nearSets: 1, results: 1 });

    const [result] = listJobResults(created.job.id);
    expect(result.keeperReason).toBe(INBOX_KEEPER_REASON);
    expect(result.matchConfidence).toBe("likely");
    const roles = Object.fromEntries(result.members.map((member) => [member.itemId, member.role]));
    expect(roles).toEqual({ twin: "keep", in: "delete" });
  });

  it("respects a pair the reviewer has already told it to forget", async () => {
    makePhoto("INBOX", "in", "2026/1.jpg", { phash: "ffff0000ffff0000", previewKey: "in.png" });
    makePhoto("GAL", "twin", "kept/1.png", { phash: apart("ffff0000ffff0000", 13), previewKey: "twin.png" });
    db.prepare("INSERT INTO gallery_duplicate_ignores (item_a, item_b) VALUES (?, ?)").run(...["in", "twin"].sort());
    const created = createJob({
      ownerUserId: "u1", libraryIds: ["GAL", "INBOX"], duplicateType: "inbox", inboxLibraryId: "INBOX", mediaType: "photo"
    });
    if (!created.ok) throw new Error(created.refused);

    const outcome = runJobScan(created.job.id, "u1", {
      rescans: [{ incomingId: "in", libraryItemId: "twin", distance: 13, score: 0.94 }]
    });
    expect(outcome.summary).toMatchObject({ nearSets: 0, results: 0 });
  });
});
