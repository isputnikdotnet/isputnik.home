import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { createGalleryPerson, tagAssetPerson } from "../src/modules/library/gallery/people.js";
import { createFamilyPerson, updateFamilyPerson } from "../src/modules/familytree/persons.js";
import {
  attachFamilyPhotos,
  detachFamilyPhoto,
  attachedFamilyPhotoIds,
  getFamilyPersonPhotos
} from "../src/modules/familytree/photos.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(lib: string, relativePath: string, modifiedMs: number) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/${lib}/${relativePath}`,
    relativePath,
    fileName: relativePath.split("/").pop()!,
    extension,
    kind: kindForExtension(extension)!,
    size: 1000,
    modifiedAtMs: modifiedMs
  };
}

const T = Date.parse("2024-01-01T00:00:00Z");
const DAY = 86_400_000;
const admin = { id: "admin", role: "admin" };
const member = { id: "u2", role: "member" };

beforeEach(() => {
  resetDb();
  makeUser("admin", "admin");
  makeUser("u2");
  // GAL is visible to everyone; PRIV only to the admin. The explicit grant
  // matters: even server admins can't see a library nobody was granted.
  makeLibrary("GAL", { createdBy: "admin", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  makeLibrary("PRIV", { createdBy: "admin", type: "gallery" });
  grant("user", "admin", "PRIV", "manager");
});

describe("family tree photo attachments", () => {
  it("attaches in order, is idempotent, and detaches", async () => {
    const a = await ingestGalleryAsset("GAL", asset("GAL", "a.jpg", T), false);
    const b = await ingestGalleryAsset("GAL", asset("GAL", "b.jpg", T + DAY), false);
    const p = createFamilyPerson({ name: "Anna" }, "admin");

    expect(attachFamilyPhotos(p.id, [a, b], "admin")).toEqual({ attached: 2 });
    // Re-attaching is a no-op and keeps the original order.
    expect(attachFamilyPhotos(p.id, [a], "admin")).toEqual({ attached: 0 });
    expect(attachedFamilyPhotoIds(p.id)).toEqual([a, b]);

    expect(detachFamilyPhoto(p.id, a)).toBe(true);
    expect(detachFamilyPhoto(p.id, a)).toBe(false);
    expect(attachedFamilyPhotoIds(p.id)).toEqual([b]);
  });

  it("rejects unknown persons and non-gallery items", async () => {
    const a = await ingestGalleryAsset("GAL", asset("GAL", "a.jpg", T), false);
    const p = createFamilyPerson({ name: "Anna" }, "admin");
    expect(attachFamilyPhotos("missing", [a], "admin")).toEqual({ error: "person_not_found" });
    expect(attachFamilyPhotos(p.id, [a, "missing"], "admin"))
      .toEqual({ error: "item_not_found", itemId: "missing" });
    // A failed batch attaches nothing.
    expect(attachedFamilyPhotoIds(p.id)).toEqual([]);
  });

  it("scopes the listing to the viewer's accessible libraries", async () => {
    const pub = await ingestGalleryAsset("GAL", asset("GAL", "pub.jpg", T), false);
    const secret = await ingestGalleryAsset("PRIV", asset("PRIV", "secret.jpg", T + DAY), false);
    const p = createFamilyPerson({ name: "Anna" }, "admin");
    attachFamilyPhotos(p.id, [pub, secret], "admin");

    // The admin sees both, in attachment order.
    const forAdmin = getFamilyPersonPhotos(admin, p.id, 50, 0)!;
    expect(forAdmin.total).toBe(2);
    expect(forAdmin.assets.map((x) => x.id)).toEqual([pub, secret]);
    expect(forAdmin.assets.every((x) => x.attached)).toBe(true);

    // A member never learns the private photo exists — not even in the total.
    const forMember = getFamilyPersonPhotos(member, p.id, 50, 0)!;
    expect(forMember.total).toBe(1);
    expect(forMember.assets.map((x) => x.id)).toEqual([pub]);

    expect(getFamilyPersonPhotos(member, "missing", 50, 0)).toBeNull();
  });

  it("surfaces linked face-cluster photos after the attached ones, deduped", async () => {
    const attached = await ingestGalleryAsset("GAL", asset("GAL", "attached.jpg", T), false);
    const tagged = await ingestGalleryAsset("GAL", asset("GAL", "tagged.jpg", T + DAY), false);
    const both = await ingestGalleryAsset("GAL", asset("GAL", "both.jpg", T + 2 * DAY), false);

    const cluster = createGalleryPerson("Anna cluster");
    tagAssetPerson(tagged, cluster.id);
    tagAssetPerson(both, cluster.id);

    const p = createFamilyPerson({ name: "Anna" }, "admin");
    updateFamilyPerson(p.id, { galleryPersonId: cluster.id });
    attachFamilyPhotos(p.id, [attached, both], "admin");

    const result = getFamilyPersonPhotos(member, p.id, 50, 0)!;
    // Attached (curated order) first; the cluster adds only the not-yet-attached
    // photo, so `both` appears once.
    expect(result.total).toBe(3);
    expect(result.assets.map((x) => x.id)).toEqual([attached, both, tagged]);
    expect(result.assets.map((x) => x.attached)).toEqual([true, true, false]);

    // Paging spans the merged listing.
    const page2 = getFamilyPersonPhotos(member, p.id, 2, 2)!;
    expect(page2.assets.map((x) => x.id)).toEqual([tagged]);

    // Unlinking the cluster drops the auto photos.
    updateFamilyPerson(p.id, { galleryPersonId: null });
    expect(getFamilyPersonPhotos(member, p.id, 50, 0)!.total).toBe(2);
  });

  it("cascades attachments away when the item row is deleted", async () => {
    const a = await ingestGalleryAsset("GAL", asset("GAL", "a.jpg", T), false);
    const p = createFamilyPerson({ name: "Anna" }, "admin");
    attachFamilyPhotos(p.id, [a], "admin");

    db.prepare("DELETE FROM library_items WHERE id = ?").run(a);
    expect(attachedFamilyPhotoIds(p.id)).toEqual([]);
  });

  it("hides soft-deleted items from the listing", async () => {
    const a = await ingestGalleryAsset("GAL", asset("GAL", "a.jpg", T), false);
    const p = createFamilyPerson({ name: "Anna" }, "admin");
    attachFamilyPhotos(p.id, [a], "admin");

    db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(a);
    const result = getFamilyPersonPhotos(admin, p.id, 50, 0)!;
    expect(result.total).toBe(0);
    expect(result.assets).toEqual([]);
  });
});
