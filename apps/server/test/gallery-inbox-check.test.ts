import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { activeJob, createJob, getJob } from "../src/modules/library/gallery/duplicates/jobs.js";
import { runJobScan, listJobResults, INBOX_KEEPER_REASON } from "../src/modules/library/gallery/duplicates/job-scan.js";
import { replaceWithInboxCopy, replaceLargerSweep } from "../src/modules/library/gallery/duplicates/job-replace.js";
import { inboxCheckView, queueInboxCheck } from "../src/modules/library/gallery/duplicates/inbox-check.js";
import { groupNearIdentical } from "../src/modules/library/gallery/duplicates/items.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// The Photo Inbox check (docs/photo-inbox-proposal.md, phase 2): a cleanup whose
// candidates are one library's photos. Asymmetric — the collection is never
// compared with itself — and the library's copy is the keeper.

const INBOX_POLICY = JSON.stringify({ mode: "managed", inbox: true });
let base = "";

const root = (id: string) => path.join(base, id);

function makeGalleryLibrary(id: string, policyJson = "{}"): void {
  makeLibrary(id, { createdBy: "u1", type: "gallery", policyJson });
  fs.mkdirSync(root(id), { recursive: true });
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = ?").run(root(id), id);
  grant("group", EVERYONE_GROUP_ID, id, "member");
}

function makePhoto(
  libraryId: string,
  id: string,
  relativePath: string,
  opts: { hash?: string | null; phash?: string | null; bytes?: string; width?: number; height?: number } = {}
): string {
  const absolute = path.join(root(libraryId), relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, opts.bytes ?? `BYTES-${id}`);
  const stat = fs.statSync(absolute);
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')"
  ).run(id, libraryId, relativePath);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  db.prepare(`
    INSERT INTO gallery_details (item_id, kind, relative_path, size, modified_at, content_hash, content_hash_at, phash, width, height)
    VALUES (?, 'photo', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, relativePath, stat.size, stat.mtime.toISOString(),
    opts.hash ?? null, opts.hash ? stat.mtime.toISOString() : null, opts.phash ?? null,
    opts.width ?? null, opts.height ?? null
  );
  return id;
}

function inboxJob(): string {
  const created = createJob({
    ownerUserId: "u1",
    libraryIds: ["GAL"],
    duplicateType: "inbox",
    inboxLibraryId: "INBOX",
    mediaType: "photo"
  });
  if (!created.ok) throw new Error(created.refused);
  return created.job.id;
}

beforeEach(() => {
  resetDb();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-check-"));
  fs.mkdirSync(path.join(base, "thumbs"));
  makeUser("u1", "admin");
  db.prepare("INSERT OR REPLACE INTO storage_roots (id, name, path, created_by) VALUES ('sr1', 'test', ?, 'u1')").run(base);
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(thumbnailPathSettingKey, path.join(base, "thumbs"));
  makeGalleryLibrary("GAL");
  makeGalleryLibrary("INBOX", INBOX_POLICY);
});

describe("the job scope", () => {
  it("stores an Inbox check as a files job that names its Inbox, and always reads the Inbox", () => {
    const id = inboxJob();
    const job = getJob(id)!;
    expect(job.duplicateType).toBe("inbox");
    expect(job.inboxLibraryId).toBe("INBOX");
    expect(job.libraries.map((library) => library.libraryId).sort()).toEqual(["GAL", "INBOX"]);
    const stored = db.prepare("SELECT duplicate_type FROM duplicate_jobs WHERE id = ?").get(id) as { duplicate_type: string };
    expect(stored.duplicate_type).toBe("files");
  });

  it("refuses an Inbox check without an Inbox", () => {
    const outcome = createJob({ ownerUserId: "u1", libraryIds: ["GAL"], duplicateType: "inbox", inboxLibraryId: "GAL" });
    expect(outcome).toMatchObject({ ok: false, refused: "no_inbox" });
  });
});

describe("asymmetric grouping", () => {
  it("links a pair only when one side is a candidate, and matches through variants", () => {
    const rows = [
      { itemId: "in", phash: "ffffffffffffffff" },
      { itemId: "out", phash: "00000000000000ff" },
      // Near "out" in the collection — but the collection never links with itself.
      { itemId: "other", phash: "00000000000000fe" },
      { itemId: "far", phash: "0f00000000000000" }
    ];
    const plain = groupNearIdentical(rows, new Set(), () => true, { candidates: new Set(["in"]) });
    expect(plain.components).toEqual([]);
    const turned = groupNearIdentical(rows, new Set(), () => true, {
      candidates: new Set(["in"]),
      variants: new Map([["in", ["00000000000000ff"]]])
    });
    // Both library photos sit within reach of the turned fingerprint; "far" never joins.
    expect(turned.components).toEqual([["in", "other", "out"]]);
    expect(turned.distance("in", "out")).toBe(0);
    expect(turned.distance("in", "other")).toBe(1);
  });
});

describe("the snapshot", () => {
  it("pairs an incoming copy with the library's, keeps the library's, and never compares the library with itself", () => {
    makePhoto("INBOX", "a1", "box/1.jpg", { hash: "H1", bytes: "SAME" });
    makePhoto("GAL", "g1", "kept/1.jpg", { hash: "H1", bytes: "SAME" });
    // Two library copies of something the Inbox does not hold: not this job's business.
    makePhoto("GAL", "g2", "a/2.jpg", { hash: "H2", bytes: "TWICE" });
    makePhoto("GAL", "g3", "b/2.jpg", { hash: "H2", bytes: "TWICE" });
    // Two incoming copies of each other, nothing in the library: nothing to say either.
    makePhoto("INBOX", "a2", "box/3.jpg", { hash: "H3", bytes: "DUP" });
    makePhoto("INBOX", "a3", "box/4.jpg", { hash: "H3", bytes: "DUP" });
    // A near match, upright.
    makePhoto("INBOX", "n1", "box/5.jpg", { phash: "0000000000000001", width: 4000, height: 3000 });
    makePhoto("GAL", "k1", "kept/5.jpg", { phash: "0000000000000000", width: 1000, height: 750 });
    // Two near library photos with no incoming twin.
    makePhoto("GAL", "k2", "kept/6.jpg", { phash: "ff00000000000000" });
    makePhoto("GAL", "k3", "kept/7.jpg", { phash: "ff00000000000001" });

    const id = inboxJob();
    const outcome = runJobScan(id, "u1");
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toMatchObject({ photoSets: 1, nearSets: 1 });

    const results = listJobResults(id, 50, 0, {});
    expect(results).toHaveLength(2);
    const exact = results.find((result) => result.tier === "exact")!;
    expect(exact.keeperReason).toBe(INBOX_KEEPER_REASON);
    expect(exact.keeperConfidence).toBe("evidence");
    expect(exact.members.map((member) => [member.itemId, member.role])).toEqual(expect.arrayContaining([["g1", "keep"], ["a1", "delete"]]));
    const near = results.find((result) => result.tier === "near")!;
    expect(near.members.find((member) => member.itemId === "k1")?.role).toBe("keep");
    expect(near.members.find((member) => member.itemId === "n1")).toMatchObject({ role: "delete", distance: 1 });
    expect(getJob(id)!.status).toBe("review");
  });

  it("matches a sideways scan through its rotated fingerprints", () => {
    makePhoto("INBOX", "s1", "box/s.jpg", { phash: "ffffffffffffffff" });
    makePhoto("GAL", "u1p", "kept/u.jpg", { phash: "00000000000000ff" });
    const id = inboxJob();
    const outcome = runJobScan(id, "u1", { nearVariants: new Map([["s1", ["00000000000000fe"]]]) });
    expect(outcome.ok && outcome.summary?.nearSets).toBe(1);
  });
});

describe("replace", () => {
  it("puts the incoming file in the library item's place and retires the Inbox row", async () => {
    makePhoto("INBOX", "n1", "box/5.jpg", { phash: "0000000000000001", bytes: "BIGSCAN", width: 4000, height: 3000 });
    makePhoto("GAL", "k1", "kept/5.jpg", { phash: "0000000000000000", bytes: "small", width: 1000, height: 750 });
    const id = inboxJob();
    runJobScan(id, "u1");
    const result = listJobResults(id, 50, 0, {})[0];
    const incoming = result.members.find((member) => member.itemId === "n1")!;

    const outcome = await replaceWithInboxCopy(id, "u1", result.id, incoming.id);
    expect(outcome.ok).toBe(true);

    const kept = db.prepare("SELECT li.folder_path FROM library_items li WHERE li.id = 'k1' AND li.deleted_at IS NULL").get() as { folder_path: string };
    expect(fs.readFileSync(path.join(root("GAL"), kept.folder_path), "utf8")).toBe("BIGSCAN");
    expect(db.prepare("SELECT 1 FROM library_items WHERE id = 'n1'").get()).toBeUndefined();
    expect(fs.existsSync(path.join(root("INBOX"), "box", "5.jpg"))).toBe(false);
    const after = listJobResults(id, 50, 0, { resultId: result.id })[0];
    expect(after.status).toBe("resolved");
    // The library's old file was set aside, not destroyed.
    expect(fs.existsSync(outcome.ok ? outcome.job.keptAt : "")).toBe(true);
  });

  it("refuses to replace with the library's own copy, and sweeps only larger incoming ones", async () => {
    makePhoto("INBOX", "n1", "box/5.jpg", { phash: "0000000000000001", width: 4000, height: 3000 });
    makePhoto("GAL", "k1", "kept/5.jpg", { phash: "0000000000000000", width: 1000, height: 750 });
    makePhoto("INBOX", "n2", "box/6.jpg", { phash: "ff00000000000001", width: 800, height: 600 });
    makePhoto("GAL", "k2", "kept/6.jpg", { phash: "ff00000000000000", width: 1000, height: 750 });
    const id = inboxJob();
    runJobScan(id, "u1");
    const results = listJobResults(id, 50, 0, {});
    const first = results.find((result) => result.members.some((member) => member.itemId === "k1"))!;
    const keeper = first.members.find((member) => member.itemId === "k1")!;
    expect(await replaceWithInboxCopy(id, "u1", first.id, keeper.id)).toMatchObject({ ok: false, refused: "member_not_incoming" });

    const swept = await replaceLargerSweep(id, "u1");
    expect(swept.ok && swept.job).toMatchObject({ results: 2, replaced: 1, skipped: 1, failed: 0 });
    expect(db.prepare("SELECT 1 FROM library_items WHERE id = 'n1'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM library_items WHERE id = 'n2'").get()).toBeDefined();
  });
});

describe("queueing a check", () => {
  it("starts one for a non-empty Inbox, reports it running, and yields to another cleanup", () => {
    expect(queueInboxCheck("INBOX")).toMatchObject({ queued: false, reason: "empty" });
    makePhoto("INBOX", "a1", "box/1.jpg", { hash: "H1" });

    const started = queueInboxCheck("INBOX");
    expect(started.queued).toBe(true);
    const job = activeJob()!;
    expect(job.inboxLibraryId).toBe("INBOX");
    expect(job.status).toBe("scanning");
    expect(job.ownerUserId).toBe("u1");
    expect(queueInboxCheck("INBOX")).toMatchObject({ queued: false, reason: "running" });
    expect(inboxCheckView("INBOX", "u1")).toMatchObject({ check: { jobId: job.id, status: "scanning", isOwner: true }, blockedBy: null });
    expect(queueInboxCheck("GAL")).toMatchObject({ queued: false, reason: "not_inbox" });
  });

  it("does not start when someone else's cleanup holds the slot", () => {
    makePhoto("INBOX", "a1", "box/1.jpg", { hash: "H1" });
    const other = createJob({ ownerUserId: "u1", libraryIds: ["GAL"], duplicateType: "files" });
    expect(other.ok).toBe(true);
    expect(queueInboxCheck("INBOX")).toMatchObject({ queued: false, reason: "busy" });
    expect(inboxCheckView("INBOX", "u1")).toEqual({ check: null, blockedBy: "other_job" });
  });
});
