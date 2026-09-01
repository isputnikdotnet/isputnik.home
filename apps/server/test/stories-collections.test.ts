// Story collections (stories v2 step 6): the shelf's access rows and — the
// part that must never drift — the visibility override: a story on a
// restricted shelf is invisible to non-members everywhere (list, direct view,
// send-to hydration), author aside. The rules live in collection-access.ts +
// canViewStory/listStories; these pin them.
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { hydrateEntities } from "../src/modules/social/subjects.js";
import {
  canContributeToCollection,
  canManageCollection,
  canViewCollection,
  visibleCollectionIds
} from "../src/modules/stories/collection-access.js";
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections
} from "../src/modules/stories/collections.js";
import {
  canEditStory,
  canViewStory,
  createStory,
  getStory,
  listStories,
  updateStory
} from "../src/modules/stories/stories.js";
import { resetDb, makeUser, makeGroup, addToGroup, grant } from "./helpers/seed.js";

const owner = { id: "owner", role: "member" };
const viewer = { id: "viewer", role: "member" };
const outsider = { id: "outsider", role: "member" };
const admin = { id: "boss", role: "admin" };

function restrict(collectionId: string): void {
  db.prepare(
    "DELETE FROM assignments WHERE subject_type = 'group' AND subject_id = ? AND object_type = 'story_collection' AND object_id = ?"
  ).run(EVERYONE_GROUP_ID, collectionId);
}

beforeEach(() => {
  resetDb();
  makeUser("owner");
  makeUser("viewer");
  makeUser("outsider");
  makeUser("boss", "admin");
});

describe("collection access", () => {
  it("seeds the creator as manager and Everyone as viewer", () => {
    const shelf = createCollection(owner, "Family Story", null);
    expect(canManageCollection(owner, shelf.id)).toBe(true);
    expect(canViewCollection(viewer, shelf.id)).toBe(true);
    expect(canContributeToCollection(viewer, shelf.id)).toBe(false);
  });

  it("restricting removes it (and its role) from everyone but the listed", () => {
    const shelf = createCollection(owner, "Trips", null);
    restrict(shelf.id);
    grant("user", "viewer", shelf.id, "viewer", "story_collection");

    expect(canViewCollection(viewer, shelf.id)).toBe(true);
    expect(canViewCollection(outsider, shelf.id)).toBe(false);
    expect(canViewCollection(admin, shelf.id)).toBe(true); // admins always
    expect(visibleCollectionIds(outsider)).toEqual([]);
    expect(visibleCollectionIds(admin)).toBeNull(); // unrestricted
    expect(listCollections(outsider, []).map((c) => c.id)).toEqual([]);
    expect(listCollections(viewer, []).map((c) => c.id)).toEqual([shelf.id]);
  });

  it("a deny row beats the Everyone baseline", () => {
    const shelf = createCollection(owner, "Family Story", null);
    grant("user", "outsider", shelf.id, "deny", "story_collection");
    expect(canViewCollection(outsider, shelf.id)).toBe(false);
    expect(canViewCollection(viewer, shelf.id)).toBe(true);
  });

  it("group grants reach the group's members", () => {
    const shelf = createCollection(owner, "Trips", null);
    restrict(shelf.id);
    makeGroup("kids", "owner");
    addToGroup("kids", "viewer");
    grant("group", "kids", shelf.id, "contributor", "story_collection");
    expect(canContributeToCollection(viewer, shelf.id)).toBe(true);
    expect(canViewCollection(outsider, shelf.id)).toBe(false);
  });
});

describe("the visibility override", () => {
  it("hides a restricted shelf's stories everywhere, author aside", () => {
    const shelf = createCollection(owner, "Trips", null);
    restrict(shelf.id);
    grant("user", "viewer", shelf.id, "viewer", "story_collection");

    const story = createStory(owner, "Vienna", null, shelf.id);
    updateStory(story.id, { status: "published" });
    const fresh = getStory(story.id)!;

    // The list — the rule every surface (index, tags, back-links) shares.
    expect(listStories(viewer, []).map((s) => s.id)).toContain(story.id);
    expect(listStories(outsider, []).map((s) => s.id)).not.toContain(story.id);
    expect(listStories(owner, []).map((s) => s.id)).toContain(story.id); // author
    expect(listStories(admin, []).map((s) => s.id)).toContain(story.id);

    // The direct view.
    expect(canViewStory(fresh, viewer)).toBe(true);
    expect(canViewStory(fresh, outsider)).toBe(false);
    expect(canViewStory(fresh, owner)).toBe(true);
    expect(canViewStory(fresh, admin)).toBe(true);

    // Send-to / notes hydration.
    const key = `story:${story.id}`;
    expect(hydrateEntities([{ entityType: "story", entityId: story.id }], viewer).get(key)?.available).toBe(true);
    expect(hydrateEntities([{ entityType: "story", entityId: story.id }], outsider).get(key)).toBeUndefined();
  });

  it("an open shelf changes nothing about who sees its stories", () => {
    const shelf = createCollection(owner, "Family Story", null);
    const story = createStory(owner, "Minnesota", null, shelf.id);
    updateStory(story.id, { status: "published" });
    expect(listStories(outsider, []).map((s) => s.id)).toContain(story.id);
  });

  it("lets a collection manager edit member stories, but not view-only members", () => {
    const shelf = createCollection(owner, "Trips", null);
    grant("user", "viewer", shelf.id, "manager", "story_collection");
    const story = createStory(owner, "Vienna", null, shelf.id);
    const fresh = getStory(story.id)!;
    expect(canEditStory(fresh, viewer)).toBe(true);
    expect(canEditStory(fresh, outsider)).toBe(false);
    // Off the shelf, the manager's power ends.
    updateStory(story.id, { collectionId: null });
    expect(canEditStory(getStory(story.id)!, viewer)).toBe(false);
  });
});

describe("upgrading a v57 database", () => {
  // The bug this pins: schema.sql executes on every boot BEFORE migrations,
  // so an index there on a migration-added column aborts the whole schema
  // pass on an upgraded database — while every fresh-DB test stays green.
  // idx_stories_collection therefore lives in migration 58 only.
  it("adds the collection column and index without tripping over schema.sql", () => {
    const scratch = new Database(":memory:");
    migrate(scratch);
    // Shape the database the way 3.45.0 left it: no story_collections, no
    // stories.collection_id, no index. FKs off for the drop/recreate.
    scratch.pragma("foreign_keys = OFF");
    scratch.exec("DROP INDEX IF EXISTS idx_stories_collection");
    scratch.exec("DROP TABLE story_collections");
    scratch.exec("ALTER TABLE stories DROP COLUMN collection_id");
    scratch.pragma("user_version = 57");
    scratch.pragma("foreign_keys = ON");

    expect(() => migrate(scratch)).not.toThrow();
    const columns = (scratch.pragma("table_info(stories)") as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("collection_id");
    expect(scratch.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'idx_stories_collection'").get())
      .toEqual({ n: 1 });
    expect(scratch.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'story_collections'").get())
      .toEqual({ n: 1 });
    scratch.close();
  });
});

describe("deleting a shelf", () => {
  it("frees its stories and cleans its assignments", () => {
    const shelf = createCollection(owner, "Trips", null);
    const story = createStory(owner, "Vienna", null, shelf.id);
    expect(deleteCollection(shelf.id)).toBe(true);
    expect(getCollection(shelf.id)).toBeUndefined();
    expect(getStory(story.id)!.collection_id).toBeNull();
    expect(db.prepare(
      "SELECT COUNT(*) n FROM assignments WHERE object_type = 'story_collection' AND object_id = ?"
    ).get(shelf.id)).toEqual({ n: 0 });
  });
});
