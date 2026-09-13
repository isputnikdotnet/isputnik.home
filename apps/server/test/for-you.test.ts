import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { countUnseenForYou, dismissDelivery, loadForYouRows, markForYouSeen } from "../src/modules/social/for-you.js";
import { markGalleryAssetReviewed } from "../src/modules/library/gallery/edit.js";
import { thumbnailPathSettingKey } from "../src/modules/library/shared/thumbnail.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// For you (docs/for-you-plan.md): one list of what is waiting on a person —
// something sent, and a delivery into an Inbox they look after — and the dot
// that counts what they have not looked at.

const ADMIN = { id: "admin", role: "admin" };
const HELPER = { id: "helper", role: "member" };
const INBOX_POLICY = JSON.stringify({ mode: "managed" });

let base = "";

function makePhoto(libraryId: string, id: string, relativePath: string, discoveredAt = "2026-09-01T10:00:00.000Z"): void {
  db.prepare(
    "INSERT INTO library_items (id, library_id, type, folder_path, status, discovered_at) VALUES (?, ?, 'gallery', ?, 'ready', ?)"
  ).run(id, libraryId, relativePath, discoveredAt);
  db.prepare("INSERT INTO item_metadata (item_id, source, title) VALUES (?, 'scan', ?)").run(id, id);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path, size) VALUES (?, 'photo', ?, 9)").run(id, relativePath);
}

function sendBook(to: string, id: string, title: string, createdAt: string): void {
  makeLibrary(`lib-${id}`, { createdBy: "admin", type: "ebook" });
  grant("group", EVERYONE_GROUP_ID, `lib-${id}`, "member");
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path) VALUES (?, ?, 'ebook', ?)").run(id, `lib-${id}`, `/x/${id}`);
  db.prepare("INSERT INTO item_metadata (item_id, title) VALUES (?, ?)").run(id, title);
  db.prepare(`
    INSERT INTO recommendations (id, from_user_id, to_user_id, entity_type, entity_id, subject_title, from_name, created_at)
    VALUES (?, 'admin', ?, 'ebook', ?, ?, 'admin', ?)
  `).run(`rec-${id}`, to, id, title, createdAt);
}

beforeEach(() => {
  resetDb();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "for-you-"));
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(thumbnailPathSettingKey, base);
  makeUser("admin", "admin");
  makeUser("helper", "member");
  makeLibrary("inbox", { createdBy: "admin", type: "gallery", policyJson: INBOX_POLICY, role: "inbox" });
  grant("group", EVERYONE_GROUP_ID, "inbox", "viewer");
  db.prepare("UPDATE libraries SET source_path = ? WHERE id = 'inbox'").run(base);
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe("what is waiting", () => {
  it("is empty for someone nothing was sent to and who looks after no Inbox", () => {
    expect(loadForYouRows(HELPER)).toEqual([]);
    expect(countUnseenForYou(HELPER)).toBe(0);
  });

  it("lists a delivery per Inbox folder for whoever may write there, newest first, with sent cards", () => {
    makePhoto("inbox", "a1", "Box A/001.jpg", "2026-09-01T10:00:00.000Z");
    makePhoto("inbox", "a2", "Box A/002.jpg", "2026-09-01T10:00:00.000Z");
    makePhoto("inbox", "b1", "Box B/001.jpg", "2026-09-03T10:00:00.000Z");
    sendBook("admin", "book-1", "The Hobbit", "2026-09-02T10:00:00.000Z");

    const rows = loadForYouRows(ADMIN);
    expect(rows.map((row) => row.kind === "sent" ? `sent:${row.title}` : `delivery:${row.folder}`))
      .toEqual(["delivery:Box B", "sent:The Hobbit", "delivery:Box A"]);
    const boxA = rows.find((row) => row.kind === "delivery" && row.folder === "Box A");
    expect(boxA).toMatchObject({ count: 2, reviewed: 0, canReview: true, seen: false, viaLink: false, who: null });
  });

  it("names the drop link a delivery came through", () => {
    makePhoto("inbox", "c1", "Cousin Anna/001.jpg");
    db.prepare(`
      INSERT INTO share_links (id, module, resource_id, token_hash, permission, label, expires_at, created_by)
      VALUES ('lnk', 'gallery-inbox', 'inbox', 'hash', 'edit', 'Cousin Anna', '2030-01-01T00:00:00.000Z', 'admin')
    `).run();
    db.prepare("INSERT INTO share_link_drops (id, share_link_id, item_id, file_name, size_bytes) VALUES ('d1', 'lnk', 'c1', '001.jpg', 9)").run();
    const [row] = loadForYouRows(ADMIN);
    expect(row).toMatchObject({ kind: "delivery", viaLink: true, who: "Cousin Anna" });
  });

  it("for someone who may only write, a fully noted delivery is done; for the reviewer it waits", () => {
    grant("user", "helper", "inbox", "contributor");
    makePhoto("inbox", "a1", "Box A/001.jpg");
    expect(loadForYouRows(HELPER)).toHaveLength(1);
    expect(loadForYouRows(HELPER)[0]).toMatchObject({ kind: "delivery", canReview: false });
    markGalleryAssetReviewed("a1", "helper");
    expect(loadForYouRows(HELPER)).toHaveLength(0);
    expect(loadForYouRows(ADMIN)).toHaveLength(1);
  });

  it("is hidden from someone who can only look", () => {
    makePhoto("inbox", "a1", "Box A/001.jpg");
    expect(loadForYouRows(HELPER)).toHaveLength(0);
  });
});

describe("Not now on a delivery", () => {
  it("hides the row until more photos arrive in it, and leaves the Inbox alone", () => {
    makePhoto("inbox", "a1", "Box A/001.jpg", "2026-09-01T10:00:00.000Z");
    expect(loadForYouRows(ADMIN)).toHaveLength(1);
    expect(dismissDelivery(ADMIN, "inbox", "Box A")).toBe(true);
    expect(loadForYouRows(ADMIN)).toHaveLength(0);
    expect(countUnseenForYou(ADMIN)).toBe(0);
    // A delivery that is not waiting cannot be dismissed.
    expect(dismissDelivery(ADMIN, "inbox", "Box Z")).toBe(false);

    // Something new lands in the same delivery: back, and unseen again.
    db.prepare("UPDATE inbox_delivery_seen SET dismissed_at = '2026-09-01T12:00:00.000Z', seen_at = '2026-09-01T12:00:00.000Z'").run();
    makePhoto("inbox", "a2", "Box A/002.jpg", "2026-09-05T10:00:00.000Z");
    expect(loadForYouRows(ADMIN)).toHaveLength(1);
    expect(countUnseenForYou(ADMIN)).toBe(1);
  });
});

describe("the dot", () => {
  it("counts unseen cards and deliveries, clears on looking, and lights again when a delivery grows", () => {
    makePhoto("inbox", "a1", "Box A/001.jpg", "2026-09-01T10:00:00.000Z");
    sendBook("admin", "book-1", "The Hobbit", "2026-09-02T10:00:00.000Z");
    expect(countUnseenForYou(ADMIN)).toBe(2);

    markForYouSeen(ADMIN);
    expect(countUnseenForYou(ADMIN)).toBe(0);
    expect(loadForYouRows(ADMIN).every((row) => row.kind === "sent" ? row.seen : row.seen)).toBe(true);

    // A later arrival into the same delivery is new again.
    db.prepare("UPDATE inbox_delivery_seen SET seen_at = '2026-09-01T12:00:00.000Z'").run();
    makePhoto("inbox", "a2", "Box A/002.jpg", "2026-09-05T10:00:00.000Z");
    expect(countUnseenForYou(ADMIN)).toBe(1);
  });
});
