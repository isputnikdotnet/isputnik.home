import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { getGalleryAsset, resolveGalleryScopeLibraryIds } from "../src/modules/library/gallery/catalog.js";
import {
  createGalleryPerson,
  findGalleryPersonByName,
  listGalleryPeople,
  getGalleryPersonPhotos,
  tagAssetPerson,
  untagAssetPerson,
  reassignPersonPhotos,
  deleteGalleryPerson,
  renameGalleryPerson,
  setGalleryPersonHidden
} from "../src/modules/library/gallery/people.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

function asset(relativePath: string, modifiedMs: number) {
  const extension = `.${relativePath.split(".").pop()}`;
  return {
    absolutePath: `/src/GAL/${relativePath}`,
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

beforeEach(() => {
  resetDb();
  makeUser("u1");
  makeLibrary("GAL", { createdBy: "u1", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
});

describe("gallery people — manual whole-photo tagging", () => {
  it("tags photos and lists people with a distinct-item count and a cover", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T + DAY), false);
    const b = await ingestGalleryAsset("GAL", asset("b.jpg", T + 2 * DAY), false);
    const mum = createGalleryPerson("Mum");

    expect(tagAssetPerson(a, mum.id)).toBe(true);
    expect(tagAssetPerson(b, mum.id)).toBe(true);
    // Re-tagging the same photo is idempotent — still one appearance per item.
    expect(tagAssetPerson(a, mum.id)).toBe(true);

    const people = listGalleryPeople(["GAL"]);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: mum.id, name: "Mum", faceCount: 2 });

    const photos = getGalleryPersonPhotos("u1", ["GAL"], mum.id, 50, 0);
    expect(photos?.total).toBe(2);
    // Newest-first by taken date.
    expect(photos?.assets.map((p) => p.title)).toEqual(["b.jpg", "a.jpg"]);
  });

  it("attaches a photo's people to the asset detail and removes them on untag", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    const dad = createGalleryPerson("Dad");
    tagAssetPerson(a, dad.id);

    const detail = getGalleryAsset("u1", ["GAL"], a) as { people?: { id: string; name: string }[] };
    expect(detail.people).toEqual([{ id: dad.id, name: "Dad" }]);

    untagAssetPerson(a, dad.id);
    const after = getGalleryAsset("u1", ["GAL"], a) as { people?: unknown[] };
    expect(after.people).toEqual([]);
    // A person with no remaining photos drops out of the People list.
    expect(listGalleryPeople(["GAL"])).toHaveLength(0);
  });

  it("hides a person from the list when hidden, and rename takes effect", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    const p = createGalleryPerson("Temp");
    tagAssetPerson(a, p.id);

    expect(renameGalleryPerson(p.id, "Grandma")).toBe(true);
    expect(listGalleryPeople(["GAL"])[0]?.name).toBe("Grandma");

    setGalleryPersonHidden(p.id, true);
    expect(listGalleryPeople(["GAL"])).toHaveLength(0);
    expect(listGalleryPeople(["GAL"], true)).toHaveLength(1); // includeHidden
  });

  it("deleting a person untags its photos but keeps the assets", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    const p = createGalleryPerson("X");
    tagAssetPerson(a, p.id);

    expect(deleteGalleryPerson(p.id)).toBe(true);
    expect(listGalleryPeople(["GAL"])).toHaveLength(0);
    // The asset is still there, just untagged.
    expect((getGalleryAsset("u1", ["GAL"], a) as { people?: unknown[] }).people).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) c FROM gallery_faces").get() as { c: number }).c).toBe(0);
  });

  it("finds a person by name case-insensitively (so tag-by-name links, not duplicates)", () => {
    const made = createGalleryPerson("Grandma");
    expect(findGalleryPersonByName("grandma")?.id).toBe(made.id);
    expect(findGalleryPersonByName("GRANDMA")?.id).toBe(made.id);
    expect(findGalleryPersonByName("Grandpa")).toBeNull();
  });

  it("scopes a person's photos to libraries the viewer can access", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    makeLibrary("PRIV", { createdBy: "u1", type: "gallery" });
    grant("user", "u1", "PRIV", "manager");
    const secret = await ingestGalleryAsset("PRIV", asset("secret.jpg", T + DAY), false);
    makeUser("u2");

    const p = createGalleryPerson("Shared");
    tagAssetPerson(a, p.id);
    tagAssetPerson(secret, p.id);

    // u1 sees both libraries' photos for this person.
    const ownerLibs = resolveGalleryScopeLibraryIds({ id: "u1", role: "member" }, "all");
    expect(getGalleryPersonPhotos("u1", ownerLibs, p.id, 50, 0)?.total).toBe(2);

    // u2 (no grant on PRIV) only sees the GAL photo.
    const strangerLibs = resolveGalleryScopeLibraryIds({ id: "u2", role: "member" }, "all");
    const seen = getGalleryPersonPhotos("u2", strangerLibs, p.id, 50, 0);
    expect(seen?.total).toBe(1);
    expect(seen?.assets.map((x) => x.title)).toEqual(["a.jpg"]);
  });
});

// Moving individual photos out of a cluster: the fix for a group that swept in a
// stranger, where merging the whole cluster would be wrong.
describe("gallery people — moving individual photos", () => {
  it("moves only the picked photos and leaves the rest with the source", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    const b = await ingestGalleryAsset("GAL", asset("b.jpg", T + DAY), false);
    const c = await ingestGalleryAsset("GAL", asset("c.jpg", T + 2 * DAY), false);
    const cluster = createGalleryPerson("Cluster");
    const stranger = createGalleryPerson("Stranger");
    for (const id of [a, b, c]) tagAssetPerson(id, cluster.id);

    expect(reassignPersonPhotos(cluster.id, stranger.id, [b])).toBe(1);

    expect(getGalleryPersonPhotos("u1", ["GAL"], cluster.id, 50, 0)?.assets.map((p) => p.title))
      .toEqual(["c.jpg", "a.jpg"]);
    expect(getGalleryPersonPhotos("u1", ["GAL"], stranger.id, 50, 0)?.assets.map((p) => p.title))
      .toEqual(["b.jpg"]);
  });

  it("excludes the source from a photo it no longer appears in, so a rescan can't undo the move", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    const cluster = createGalleryPerson("Cluster");
    const stranger = createGalleryPerson("Stranger");
    tagAssetPerson(a, cluster.id);
    // A prior "not this person" on the target must not survive being told otherwise.
    db.prepare("INSERT INTO gallery_face_exclusions (item_id, person_id) VALUES (?, ?)").run(a, stranger.id);

    reassignPersonPhotos(cluster.id, stranger.id, [a]);

    const excluded = db.prepare("SELECT person_id FROM gallery_face_exclusions WHERE item_id = ?")
      .all(a) as { person_id: string }[];
    expect(excluded.map((row) => row.person_id)).toEqual([cluster.id]);
  });

  it("leaves everyone else in the photo alone", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    const cluster = createGalleryPerson("Cluster");
    const stranger = createGalleryPerson("Stranger");
    const bystander = createGalleryPerson("Bystander");
    tagAssetPerson(a, cluster.id);
    tagAssetPerson(a, bystander.id);

    reassignPersonPhotos(cluster.id, stranger.id, [a]);

    const rows = db.prepare(
      "SELECT person_id FROM gallery_faces WHERE item_id = ? AND assignment != 'rejected'"
    ).all(a) as { person_id: string }[];
    expect(rows.map((row) => row.person_id).sort()).toEqual([bystander.id, stranger.id].sort());
    // ...and the bystander keeps this photo, with no exclusion written against them.
    expect(getGalleryPersonPhotos("u1", ["GAL"], bystander.id, 50, 0)?.total).toBe(1);
    const excluded = db.prepare("SELECT person_id FROM gallery_face_exclusions WHERE item_id = ?")
      .all(a) as { person_id: string }[];
    expect(excluded.map((row) => row.person_id)).toEqual([cluster.id]);
  });

  it("refuses a move to itself or to an unknown person", async () => {
    const a = await ingestGalleryAsset("GAL", asset("a.jpg", T), false);
    const cluster = createGalleryPerson("Cluster");
    tagAssetPerson(a, cluster.id);

    expect(reassignPersonPhotos(cluster.id, cluster.id, [a])).toBeNull();
    expect(reassignPersonPhotos(cluster.id, "nope", [a])).toBeNull();
    expect(getGalleryPersonPhotos("u1", ["GAL"], cluster.id, 50, 0)?.total).toBe(1);
  });
});
