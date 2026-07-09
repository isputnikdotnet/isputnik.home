import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { createGallerySetShare, loadGallerySetItems, loadGallerySetFiles } from "../src/modules/library/shared/shares.js";
import { resolveShareLink } from "../src/modules/library/shared/share-access.js";
import { getGalleryAsset, getGalleryAssetUnscoped, resolveGalleryScopeLibraryIds } from "../src/modules/library/gallery/catalog.js";
import { canUserAccessBook, getLibraryForBook } from "../src/modules/library/shared/library-access.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { resetDb, makeUser, makeLibrary, grant, makeShare } from "./helpers/seed.js";

function asset(relativePath: string) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`,
    relativePath,
    fileName: relativePath.split("/").pop()!,
    extension,
    kind: kindForExtension(extension)!,
    size: 1000,
    modifiedAtMs: Date.parse("2024-06-01T00:00:00Z")
  };
}

// u1 curates GAL (manager); u2 can only view it. PRIV is invisible to both.
const curator = { id: "u1", role: "member" };
const viewer = { id: "u2", role: "member" };
let a = "";
let b = "";
let secret = "";

beforeEach(async () => {
  resetDb();
  makeUser("u1");
  makeUser("u2");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("user", "u1", "GAL", "manager");
  makeUser("owner");
  makeLibrary("PRIV", { createdBy: "owner", type: "gallery" });
  grant("user", "owner", "PRIV", "manager");
  a = (await ingestGalleryAsset("GAL", asset("a.jpg"), false))!;
  b = (await ingestGalleryAsset("GAL", asset("b.jpg"), false))!;
  secret = (await ingestGalleryAsset("PRIV", asset("secret.jpg"), false))!;
});

describe("gallery quick links (set shares)", () => {
  it("snapshots curate-able items in order and skips the rest", () => {
    const result = createGallerySetShare(curator, {
      itemIds: [b, a, secret, "no-such-item"],
      expiresInDays: 7,
      label: "For Dad"
    });
    expect(result).not.toBeNull();
    expect(result!.itemCount).toBe(2);
    expect(result!.skipped).toBe(2);

    // The raw token resolves to a live gallery_set link…
    const link = resolveShareLink(result!.token);
    expect(link?.module).toBe("gallery_set");

    // …whose members come back in share order (b first — input order kept).
    const items = loadGallerySetItems(result!.shareId);
    expect(items.map((item) => item.id)).toEqual([b, a]);
  });

  it("returns null when the caller can't curate anything selected", () => {
    expect(createGallerySetShare(viewer, { itemIds: [a, b], expiresInDays: 7, label: null })).toBeNull();
  });

  it("drops soft-deleted members from the public listing (and back after restore)", () => {
    const result = createGallerySetShare(curator, { itemIds: [a, b], expiresInDays: 7, label: null })!;
    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(b);
    expect(loadGallerySetItems(result.shareId).map((item) => item.id)).toEqual([a]);
    db.prepare("UPDATE library_items SET deleted_at = NULL WHERE id = ?").run(b);
    expect(loadGallerySetItems(result.shareId).map((item) => item.id)).toEqual([a, b]);
  });

  it("stops resolving once expired or revoked", () => {
    const result = createGallerySetShare(curator, { itemIds: [a], expiresInDays: 7, label: null })!;
    db.prepare("UPDATE share_links SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(result.shareId);
    expect(resolveShareLink(result.token)).toBeNull();

    const again = createGallerySetShare(curator, { itemIds: [a], expiresInDays: 7, label: null })!;
    db.prepare("UPDATE share_links SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(again.shareId);
    expect(resolveShareLink(again.token)).toBeNull();
  });

  it("lists set files in share order for the zip, dropping soft-deleted members", () => {
    const result = createGallerySetShare(curator, { itemIds: [b, a], expiresInDays: 7, label: null })!;
    expect(loadGallerySetFiles(result.shareId).map((f) => f.relative_path)).toEqual(["b.jpg", "a.jpg"]);
    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(b);
    expect(loadGallerySetFiles(result.shareId).map((f) => f.relative_path)).toEqual(["a.jpg"]);
  });

  it("hard-deleting an item cascades its membership away", () => {
    const result = createGallerySetShare(curator, { itemIds: [a, b], expiresInDays: 7, label: null })!;
    db.prepare("DELETE FROM library_items WHERE id = ?").run(b);
    expect(loadGallerySetItems(result.shareId).map((item) => item.id)).toEqual([a]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM share_link_items WHERE share_link_id = ?").get(result.shareId) as { n: number }).n).toBe(1);
  });
});

// The recipient side of "share with a user": a gallery `shares` row must open the
// share-aware asset route for a photo whose library the viewer can't browse.
describe("gallery user shares (recipient access)", () => {
  it("an item share grants a viewer a photo in a library they can't otherwise see", () => {
    const priv = getLibraryForBook(secret)!;
    // u2 has no role on PRIV, so before sharing the asset is invisible to them.
    expect(canUserAccessBook(secret, priv, viewer.id, viewer.role, "gallery")).toBe(false);
    expect(getGalleryAsset(viewer.id, resolveGalleryScopeLibraryIds(viewer, "all"), secret)).toBeNull();

    makeShare({ module: "gallery", resourceId: secret, userId: viewer.id, createdBy: "owner", expiresAt: null });

    // The share flips access on, and the unscoped loader (used by the route's
    // fallback) returns the asset.
    expect(canUserAccessBook(secret, priv, viewer.id, viewer.role, "gallery")).toBe(true);
    expect(getGalleryAssetUnscoped(viewer.id, secret)!.id).toBe(secret);
  });

  it("a share stamped with the wrong module does not open gallery access", () => {
    makeShare({ module: "audiobook", resourceId: secret, userId: viewer.id, createdBy: "owner", expiresAt: null });
    const priv = getLibraryForBook(secret)!;
    expect(canUserAccessBook(secret, priv, viewer.id, viewer.role, "gallery")).toBe(false);
  });

  it("a revoked share does not grant access", () => {
    makeShare({ module: "gallery", resourceId: secret, userId: viewer.id, createdBy: "owner", revoked: true });
    const priv = getLibraryForBook(secret)!;
    expect(canUserAccessBook(secret, priv, viewer.id, viewer.role, "gallery")).toBe(false);
  });
});
