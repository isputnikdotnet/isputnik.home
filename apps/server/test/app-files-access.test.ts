import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { canUserAccessBook, canUserAccessLibrary } from "../src/modules/library/shared/library-access.js";
import { resolveGalleryBrowseLibraryIds, resolveGalleryScopeLibraryIds } from "../src/modules/library/gallery/catalog-scope.js";
import { getGalleryAssets } from "../src/modules/library/gallery/catalog-asset.js";
import { appFileItemForThumbnail, canSeeAppFile } from "../src/modules/library/gallery/app-files-access.js";
import { galleryAssetsByIds } from "../src/modules/stories/blocks.js";
import { listSlideshows } from "../src/modules/library/gallery/slideshows.js";
import { setSystemLibraryRole } from "../src/modules/library/gallery/system-libraries.js";
import { libraryMembersPlugin } from "../src/modules/library/shared/members.js";
import { up as migrateAppFilesAccess } from "../src/db/migrations/077-app-files-access.js";
import { grant, makeLibrary, makeUser, resetDb } from "./helpers/seed.js";
import { bootApp } from "./helpers/boot.js";

// App files access (docs/system-data-plan.md, phase 4, decisions 22-24): the
// library has no access rules; admins see every file, anyone else sees a file
// through something that owns it.

const ADMIN = { id: "admin", role: "admin" };
const MIA = { id: "mia", role: "member" };
const OLGA = { id: "olga", role: "member" };

function item(id: string, libraryId: string, folder = "x"): string {
  db.prepare("INSERT INTO library_items (id, library_id, type, folder_path, status) VALUES (?, ?, 'gallery', ?, 'ready')").run(id, libraryId, `${folder}/${id}.jpg`);
  db.prepare("INSERT INTO gallery_details (item_id, kind, relative_path) VALUES (?, 'photo', ?)").run(id, `${folder}/${id}.jpg`);
  db.prepare("INSERT INTO item_metadata (item_id, cover_storage_key) VALUES (?, ?)").run(id, `${libraryId}/aa/${id}-cover.webp`);
  return id;
}

function story(id: string, opts: { createdBy: string; status: "published" | "draft"; collectionId?: string; itemId: string }): void {
  db.prepare("INSERT INTO stories (id, title, status, created_by, collection_id) VALUES (?, ?, ?, ?, ?)").run(id, id, opts.status, opts.createdBy, opts.collectionId ?? null);
  db.prepare("INSERT INTO story_chapters (id, story_id, position) VALUES (?, ?, 1)").run(`${id}-ch`, id);
  db.prepare("INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id) VALUES (?, ?, 1, 'audio', 'gallery', ?)").run(`${id}-b`, `${id}-ch`, opts.itemId);
}

beforeEach(() => {
  resetDb();
  // Tables resetDb leaves alone.
  for (const table of ["gallery_voice_notes", "gallery_music_tracks", "gallery_slideshow_items", "gallery_slideshows", "family_tree_photos", "family_tree_persons", "story_blocks", "story_chapters", "stories", "story_collections"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  makeUser("admin", "admin");
  makeUser("mia");
  makeUser("olga");
  makeLibrary("GAL", { createdBy: "admin", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  makeLibrary("PRIV", { createdBy: "admin", type: "gallery" });
  grant("user", "olga", "PRIV", "viewer");
  makeLibrary("HOUSE", { createdBy: "admin", type: "gallery", role: "app-files" });
  // Left over from before 4.6: ignored now.
  grant("group", EVERYONE_GROUP_ID, "HOUSE", "member");

  item("p1", "GAL");
  item("p2", "PRIV");

  // A published story's recording, a draft's, and one on a shelf only Olga may see.
  story("s-pub", { createdBy: "olga", status: "published", itemId: item("rec-pub", "HOUSE", "Story recordings") });
  story("s-draft", { createdBy: "olga", status: "draft", itemId: item("rec-draft", "HOUSE", "Story recordings") });
  db.prepare("INSERT INTO story_collections (id, title, created_by) VALUES ('shelf', 'Shelf', 'admin')").run();
  grant("user", "olga", "shelf", "viewer", "story_collection");
  story("s-shelf", { createdBy: "admin", status: "published", collectionId: "shelf", itemId: item("rec-shelf", "HOUSE", "Story recordings") });

  // Voice notes: on a photo everyone sees, and on Olga's private photo.
  item("vn-open", "HOUSE", "Voice notes");
  db.prepare("INSERT INTO gallery_voice_notes (id, item_id, audio_item_id, recorded_by) VALUES ('v1', 'p1', 'vn-open', 'olga')").run();
  item("vn-private", "HOUSE", "Voice notes");
  db.prepare("INSERT INTO gallery_voice_notes (id, item_id, audio_item_id, recorded_by) VALUES ('v2', 'p2', 'vn-private', 'olga')").run();

  // The family tree and music: every member.
  item("tree", "HOUSE", "Family tree");
  db.prepare("INSERT INTO family_tree_persons (id, name) VALUES ('gran', 'Gran')").run();
  db.prepare("INSERT INTO family_tree_photos (person_id, item_id, position) VALUES ('gran', 'tree', 1)").run();
  item("song", "HOUSE", "Slideshow music");
  db.prepare("INSERT INTO gallery_music_tracks (id, title, storage_key, item_id) VALUES ('t1', 'Song', '', 'song')").run();

  // Slideshow movies: one whose slideshow everyone sees, one only Olga's photo is in.
  item("movie-open", "HOUSE", "Slideshow movies");
  db.prepare("INSERT INTO gallery_slideshows (id, name, created_by, movie_item_id) VALUES ('ss1', 'Open', 'olga', 'movie-open')").run();
  db.prepare("INSERT INTO gallery_slideshow_items (slideshow_id, item_id, position) VALUES ('ss1', 'p1', 1)").run();
  item("movie-private", "HOUSE", "Slideshow movies");
  db.prepare("INSERT INTO gallery_slideshows (id, name, created_by, movie_item_id) VALUES ('ss2', 'Private', 'olga', 'movie-private')").run();
  db.prepare("INSERT INTO gallery_slideshow_items (slideshow_id, item_id, position) VALUES ('ss2', 'p2', 1)").run();

  // Owned by nothing.
  item("orphan", "HOUSE", "Story recordings");
});

const ALL = ["rec-pub", "rec-draft", "rec-shelf", "vn-open", "vn-private", "tree", "song", "movie-open", "movie-private", "orphan"];

describe("who sees a file", () => {
  it("is admins for every file, including orphans", () => {
    expect(ALL.filter((id) => canSeeAppFile(ADMIN, id))).toEqual(ALL);
    expect(canUserAccessLibrary({ id: "HOUSE" }, ADMIN.id, ADMIN.role)).toBe(true);
  });

  it("is anyone else through what owns it, never the library itself", () => {
    expect(canUserAccessLibrary({ id: "HOUSE" }, MIA.id, MIA.role)).toBe(false);
    expect(ALL.filter((id) => canSeeAppFile(MIA, id))).toEqual(["rec-pub", "vn-open", "tree", "song", "movie-open"]);
    // Olga wrote the draft, reads the shelf, recorded both notes and made both slideshows.
    expect(ALL.filter((id) => canSeeAppFile(OLGA, id))).toEqual(["rec-pub", "rec-draft", "rec-shelf", "vn-open", "vn-private", "tree", "song", "movie-open", "movie-private"]);
  });

  it("answers the same through the item check the stream and viewer use", () => {
    expect(canUserAccessBook("rec-pub", { id: "HOUSE" }, MIA.id, MIA.role, "gallery")).toBe(true);
    expect(canUserAccessBook("rec-draft", { id: "HOUSE" }, MIA.id, MIA.role, "gallery")).toBe(false);
  });

  it("follows an owner going away", () => {
    db.prepare("UPDATE stories SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 's-pub'").run();
    expect(canSeeAppFile(MIA, "rec-pub")).toBe(false);
  });

  it("finds a thumbnail's item for the covers route", () => {
    expect(appFileItemForThumbnail("HOUSE/aa/tree-cover.webp")).toBe("tree");
    expect(appFileItemForThumbnail("GAL/aa/p1-cover.webp")).toBeNull();
  });
});

describe("the scopes", () => {
  it("never browses App files for a member, even when named", () => {
    expect(resolveGalleryBrowseLibraryIds(MIA)).toEqual(["GAL"]);
    expect(resolveGalleryBrowseLibraryIds(MIA, ["HOUSE"])).toEqual([]);
  });

  it("hydrates by id only the files whose owners the viewer can see", () => {
    const scope = resolveGalleryScopeLibraryIds(MIA);
    expect(scope).toEqual(["GAL"]);
    expect(getGalleryAssets(MIA.id, scope, ["p1", ...ALL]).map((asset) => asset.id)).toEqual(["p1", "rec-pub", "vn-open", "tree", "song", "movie-open"]);
    expect([...galleryAssetsByIds(MIA.id, scope, ["rec-pub", "rec-draft"]).keys()]).toEqual(["rec-pub"]);
    // A copy of the list carries no rule: none of App files, never all of it.
    expect(getGalleryAssets(MIA.id, [...scope], ["rec-pub", "p1"]).map((asset) => asset.id)).toEqual(["p1"]);
  });

  it("counts a slideshow's App files members for whoever can see them", () => {
    db.prepare("INSERT INTO gallery_slideshows (id, name, created_by) VALUES ('ss3', 'Tree', 'admin')").run();
    db.prepare("INSERT INTO gallery_slideshow_items (slideshow_id, item_id, position) VALUES ('ss3', 'tree', 1), ('ss3', 'orphan', 2)").run();
    const tree = listSlideshows(MIA, resolveGalleryScopeLibraryIds(MIA)).find((show) => show.id === "ss3");
    expect(tree?.itemCount).toBe(1);
  });
});

describe("library rules", () => {
  it("migration 77 removes App files' grants and owner", () => {
    db.prepare("UPDATE libraries SET owner_id = 'mia', owner_type = 'user' WHERE id = 'HOUSE'").run();
    migrateAppFilesAccess(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'library' AND object_id = 'HOUSE'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT owner_id FROM libraries WHERE id = 'HOUSE'").get()).toEqual({ owner_id: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'library' AND object_id = 'GAL'").get()).toEqual({ n: 1 });
  });

  it("a library becoming App files gives up its grants", () => {
    setSystemLibraryRole("app-files", "PRIV");
    expect(db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = 'library' AND object_id = 'PRIV'").get()).toEqual({ n: 0 });
  });

  it("refuses the library members editor", async () => {
    const { app, signIn } = await bootApp({ plugins: [libraryMembersPlugin] }) as { app: FastifyInstance; signIn: (id: string) => Promise<string> };
    const cookie = await signIn("admin");
    expect((await app.inject({ method: "GET", url: "/api/library/libraries/HOUSE/members", headers: { cookie } })).statusCode).toBe(403);
  });
});
