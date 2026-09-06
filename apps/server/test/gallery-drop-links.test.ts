import { beforeEach, describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { createDropLink, dropLinkView, listDropLinks, DROP_LINK_MODULE } from "../src/modules/library/gallery/drop-links.js";
import { listPhotoInboxes } from "../src/modules/library/gallery/inbox.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// Drop links (docs/photo-inbox-proposal.md, phase 3): a guest link that uploads
// into a Photo Inbox under a quota the server enforces. The upload itself streams
// multipart and is exercised by hand; what is tested here is everything the
// quota and the link's life rest on.

const ADMIN = { id: "u1", role: "admin" };
const MEMBER = { id: "u2", role: "member" };
const INBOX_POLICY = JSON.stringify({ mode: "managed", inbox: true, maxUploadMB: 5 });

function landed(linkId: string, itemId: string | null, bytes: number): void {
  db.prepare("INSERT INTO share_link_drops (id, share_link_id, item_id, file_name, size_bytes) VALUES (?, ?, ?, ?, ?)")
    .run(nanoid(16), linkId, itemId, "x.jpg", bytes);
}

function makePhoto(id: string, relativePath: string): string {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, 'INBOX', 'gallery', ?, 'ready')")
    .run(id, relativePath);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path) VALUES (?, 'photo', ?)").run(id, relativePath);
  return id;
}

beforeEach(() => {
  resetDb();
  makeUser("u1", "admin");
  makeUser("u2", "member");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  makeLibrary("INBOX", { createdBy: "u1", type: "gallery", policyJson: INBOX_POLICY });
  grant("group", EVERYONE_GROUP_ID, "INBOX", "member");
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("minting", () => {
  it("stores only the hash, on the Inbox, with its quota", () => {
    const made = createDropLink(ADMIN, { libraryId: "INBOX", label: "Grandma's box", expiresInDays: 14, maxFiles: 200, maxBytes: 1000, oneTime: true });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.token.length).toBeGreaterThanOrEqual(30);
    const row = db.prepare("SELECT module, resource_id, token_hash, max_files, max_bytes, one_time FROM share_links WHERE id = ?")
      .get(made.link.id) as { module: string; resource_id: string; token_hash: string; max_files: number; max_bytes: number; one_time: number };
    expect(row).toMatchObject({ module: DROP_LINK_MODULE, resource_id: "INBOX", max_files: 200, max_bytes: 1000, one_time: 1 });
    expect(row.token_hash).not.toContain(made.token);
    expect(made.link).toMatchObject({ label: "Grandma's box", status: "active", used: { files: 0, bytes: 0 }, oneTime: true });
  });

  it("refuses a library that is not an Inbox, and a member who cannot review it", () => {
    expect(createDropLink(ADMIN, { libraryId: "GAL", label: null, expiresInDays: 7, maxFiles: null, maxBytes: null, oneTime: false }))
      .toMatchObject({ ok: false, status: 404 });
    expect(createDropLink(MEMBER, { libraryId: "INBOX", label: null, expiresInDays: 7, maxFiles: null, maxBytes: null, oneTime: false }))
      .toMatchObject({ ok: false, status: 403 });
    expect(listDropLinks(MEMBER, "INBOX")).toBeNull();
  });
});

describe("the public view", () => {
  it("resolves a live token to what the page needs, and nothing for a bad one", () => {
    const made = createDropLink(ADMIN, { libraryId: "INBOX", label: "Cousins", expiresInDays: 7, maxFiles: 3, maxBytes: 3 * 1024 * 1024, oneTime: false });
    if (!made.ok) throw new Error();
    const view = dropLinkView(made.token)!;
    expect(view).toMatchObject({
      label: "Cousins", inboxName: "INBOX", sharedBy: "u1", remainingFiles: 3, remainingBytes: 3 * 1024 * 1024, open: true, oneTime: false
    });
    // The per-file cap is the smaller of the library's own and what the link has left.
    expect(view.maxFileBytes).toBe(3 * 1024 * 1024);
    expect(view.accept.length).toBeGreaterThan(0);
    expect(dropLinkView("not-a-token")).toBeNull();
  });

  it("counts every batch against the quota and closes when it is used up", () => {
    const made = createDropLink(ADMIN, { libraryId: "INBOX", label: null, expiresInDays: 7, maxFiles: 2, maxBytes: 1000, oneTime: false });
    if (!made.ok) throw new Error();
    landed(made.link.id, null, 600);
    let view = dropLinkView(made.token)!;
    expect(view).toMatchObject({ remainingFiles: 1, remainingBytes: 400, maxFileBytes: 400, open: true });
    landed(made.link.id, null, 400);
    view = dropLinkView(made.token)!;
    expect(view).toMatchObject({ remainingFiles: 0, remainingBytes: 0, open: false });
    expect(listDropLinks(ADMIN, "INBOX")![0].used).toEqual({ files: 2, bytes: 1000 });
  });

  it("is gone once revoked, and a used one-time link reads as closed", () => {
    const made = createDropLink(ADMIN, { libraryId: "INBOX", label: null, expiresInDays: 7, maxFiles: null, maxBytes: null, oneTime: true });
    if (!made.ok) throw new Error();
    landed(made.link.id, null, 10);
    db.prepare("UPDATE share_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(made.link.id);
    expect(dropLinkView(made.token)).toBeNull();
    expect(listDropLinks(ADMIN, "INBOX")![0].status).toBe("closed");
  });
});

describe("the review", () => {
  it("marks a delivery that came in through a link", () => {
    const made = createDropLink(ADMIN, { libraryId: "INBOX", label: "Cousins", expiresInDays: 7, maxFiles: null, maxBytes: null, oneTime: false });
    if (!made.ok) throw new Error();
    landed(made.link.id, makePhoto("d1", "Cousins/2026-09-06/1.jpg"), 10);
    makePhoto("s1", "scanner/2.jpg");
    const deliveries = listPhotoInboxes(ADMIN)[0].deliveries;
    expect(deliveries.find((delivery) => delivery.folder === "Cousins")?.viaLink).toBe(true);
    expect(deliveries.find((delivery) => delivery.folder === "scanner")?.viaLink).toBe(false);
  });
});
