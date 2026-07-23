import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { createAlbum, addAlbumItems, removeAlbumItems, getAlbum } from "../src/modules/library/gallery/albums.js";
import {
  createGalleryAlbumShare,
  loadAlbumShareItems,
  curatableGalleryLibraryIds
} from "../src/modules/library/shared/shares.js";
import { resolveShareLink } from "../src/modules/library/shared/share-access.js";
import {
  canUserAccessBook,
  userHasGalleryAlbumShareForItem,
  getLibraryForBook
} from "../src/modules/library/shared/library-access.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(relativePath: string, takenAtIso: string) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`,
    relativePath,
    fileName: relativePath.split("/").pop()!,
    extension,
    kind: kindForExtension(extension)!,
    size: 1000,
    modifiedAtMs: Date.parse(takenAtIso)
  };
}

function albumShare(albumId: string, userId: string, createdBy: string, opts: { expiresAt?: string | null } = {}) {
  db.prepare(
    "INSERT INTO shares (id, module, resource_id, user_id, created_by, expires_at) VALUES (?, 'gallery_album', ?, ?, ?, ?)"
  ).run(`as-${albumId}-${userId}`, albumId, userId, createdBy, opts.expiresAt ?? null);
}

// u1 owns everything as manager (curates GAL + PRIV2) but is only a plain member
// of MIX (view, no curate). u2 is a member of GAL only. boss is an admin.
const u1 = { id: "u1", role: "member" as const };
const u2 = { id: "u2", role: "member" as const };
const boss = { id: "boss", role: "admin" as const };
let a = "";  // GAL   — u1 curates, u2 can view
let b = "";  // GAL
let p = "";  // PRIV2 — u1 curates, u2 cannot see at all
let m = "";  // MIX   — u1 can VIEW but not curate
let album = ""; // [a, b, p, m], created by u1

beforeEach(async () => {
  resetDb();
  makeUser("u1");
  makeUser("u2");
  makeUser("boss", "admin");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("user", "u1", "GAL", "manager");
  makeLibrary("PRIV2", { createdBy: "u1", type: "gallery" });
  grant("user", "u1", "PRIV2", "manager");
  makeLibrary("MIX", { createdBy: "u1", type: "gallery" });
  grant("user", "u1", "MIX", "member");

  a = (await ingestGalleryAsset("GAL", asset("a.jpg", "2024-01-01T00:00:00Z"), false))!;
  b = (await ingestGalleryAsset("GAL", asset("b.jpg", "2024-02-01T00:00:00Z"), false))!;
  p = (await ingestGalleryAsset("PRIV2", asset("p.jpg", "2024-03-01T00:00:00Z"), false))!;
  m = (await ingestGalleryAsset("MIX", asset("m.jpg", "2024-04-01T00:00:00Z"), false))!;

  album = createAlbum(u1, "Trip", null).id;
  // u1 can access all three libraries, so all four items go in.
  addAlbumItems(album, new Set(["GAL", "PRIV2", "MIX"]), [a, b, p, m]);
});

describe("live album resolution (creator-curate bound)", () => {
  it("exposes only members in libraries the creator can curate, in album order", () => {
    // u1 curates GAL + PRIV2 but not MIX, so m drops; the rest come chronologically.
    const libIds = curatableGalleryLibraryIds(u1);
    expect(new Set(libIds)).toEqual(new Set(["GAL", "PRIV2"]));
    expect(loadAlbumShareItems(album, "taken_at", libIds).map((i) => i.id)).toEqual([a, b, p]);
  });

  it("tracks membership changes live (no snapshot)", () => {
    const libIds = curatableGalleryLibraryIds(u1);
    removeAlbumItems(album, [a]);
    expect(loadAlbumShareItems(album, "taken_at", libIds).map((i) => i.id)).toEqual([b, p]);
    addAlbumItems(album, new Set(["GAL"]), [a]);
    expect(loadAlbumShareItems(album, "taken_at", libIds).map((i) => i.id)).toEqual([a, b, p]);
  });

  it("drops soft-deleted members (and restores them)", () => {
    const libIds = curatableGalleryLibraryIds(u1);
    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(b);
    expect(loadAlbumShareItems(album, "taken_at", libIds).map((i) => i.id)).toEqual([a, p]);
    db.prepare("UPDATE library_items SET deleted_at = NULL WHERE id = ?").run(b);
    expect(loadAlbumShareItems(album, "taken_at", libIds).map((i) => i.id)).toEqual([a, b, p]);
  });
});

describe("createGalleryAlbumShare (guest link)", () => {
  it("mints a live gallery_album link for the album's owner", () => {
    const result = createGalleryAlbumShare(u1, { albumId: album, expiresInDays: 7, label: "Our trip" });
    expect(typeof result).toBe("object");
    const link = resolveShareLink((result as { token: string }).token);
    expect(link?.module).toBe("gallery_album");
    expect(link?.resource_id).toBe(album);
    expect(link?.created_by).toBe("u1");
  });

  it("lets an admin share someone else's album", () => {
    expect(typeof createGalleryAlbumShare(boss, { albumId: album, expiresInDays: 7, label: null })).toBe("object");
  });

  it("refuses a non-owner, a missing album, and an album with nothing curatable", () => {
    expect(createGalleryAlbumShare(u2, { albumId: album, expiresInDays: 7, label: null })).toBe("forbidden");
    expect(createGalleryAlbumShare(u1, { albumId: "nope", expiresInDays: 7, label: null })).toBe("not_found");

    const onlyMix = createAlbum(u1, "MIX only", null).id;
    addAlbumItems(onlyMix, new Set(["MIX"]), [m]); // u1 can't curate MIX → nothing to share
    expect(createGalleryAlbumShare(u1, { albumId: onlyMix, expiresInDays: 7, label: null })).toBe("empty");
  });
});

describe("per-user album access (recipient reach)", () => {
  it("grants a recipient the curatable members they couldn't otherwise see, and denies the rest", () => {
    // Before sharing: u2 can't see p (PRIV2) or m (MIX).
    expect(canUserAccessBook(p, getLibraryForBook(p)!, u2.id, u2.role, "gallery")).toBe(false);
    expect(canUserAccessBook(m, getLibraryForBook(m)!, u2.id, u2.role, "gallery")).toBe(false);

    albumShare(album, u2.id, u1.id);

    // p is now reachable (in the album, and u1 curates PRIV2)…
    expect(userHasGalleryAlbumShareForItem(p, u2.id)).toBe(true);
    expect(canUserAccessBook(p, getLibraryForBook(p)!, u2.id, u2.role, "gallery")).toBe(true);
    // …but m stays hidden: u1 can't curate MIX, so the share can't hand it out.
    expect(userHasGalleryAlbumShareForItem(m, u2.id)).toBe(false);
    expect(canUserAccessBook(m, getLibraryForBook(m)!, u2.id, u2.role, "gallery")).toBe(false);
  });

  it("follows the album live — dropping a photo revokes the recipient's reach to it", () => {
    albumShare(album, u2.id, u1.id);
    expect(userHasGalleryAlbumShareForItem(p, u2.id)).toBe(true);
    removeAlbumItems(album, [p]);
    expect(userHasGalleryAlbumShareForItem(p, u2.id)).toBe(false);
  });

  it("does not grant access once revoked or expired", () => {
    albumShare(album, u2.id, u1.id);
    db.prepare("UPDATE shares SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE module = 'gallery_album' AND resource_id = ? AND user_id = ?").run(album, u2.id);
    expect(userHasGalleryAlbumShareForItem(p, u2.id)).toBe(false);

    db.prepare("UPDATE shares SET revoked_at = NULL, expires_at = '2020-01-01T00:00:00.000Z' WHERE module = 'gallery_album' AND resource_id = ? AND user_id = ?").run(album, u2.id);
    expect(userHasGalleryAlbumShareForItem(p, u2.id)).toBe(false);
  });

  it("a wrong-module share does not open album access", () => {
    db.prepare("INSERT INTO shares (id, module, resource_id, user_id, created_by) VALUES ('x','gallery',?,?, 'u1')").run(album, u2.id);
    expect(userHasGalleryAlbumShareForItem(p, u2.id)).toBe(false);
  });
});
