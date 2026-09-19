import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { deleteStoryBlocksForResource, deleteStoryBlocksForLibrary } from "../src/modules/stories/cleanup.js";
import { GALLERY_ENTITY_TYPE, PHOTO_GROUP_MAX } from "../src/modules/stories/stories.js";
import { createStory } from "../src/modules/stories/crud.js";
import { listStories } from "../src/modules/stories/list.js";
import { getChapters } from "../src/modules/stories/chapters.js";
import { createBlock, getBlock, getBlocks, updateBlock, deleteBlock, blockItemsByIds } from "../src/modules/stories/blocks.js";
import { galleryItemsAreReachable } from "../src/modules/stories/route-shared.js";
import { resetDb, makeUser, makeLibrary, grant } from "./helpers/seed.js";

// A photo GROUP: one block holding several photos in an authored order, with a
// layout of its own. What makes it worth its own table (story_block_items) is
// that "these belong together, laid out like this" is said rather than guessed
// from a run of single-photo blocks — so these tests pin the order, the per-
// photo captions, who may put a photo on a plate, and what a purge does to one.

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

const author = { id: "author", role: "member" };
const viewer = { id: "viewer", role: "member" };
let one = "";
let two = "";
let three = "";
let secret = "";

beforeEach(async () => {
  resetDb();
  makeUser("author");
  makeUser("viewer");
  makeLibrary("GAL", { createdBy: "author", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  // PRIV is the author's alone, so `secret` is a photo viewer cannot reach.
  makeLibrary("PRIV", { createdBy: "author", type: "gallery" });
  grant("user", "author", "PRIV", "manager");
  one = (await ingestGalleryAsset("GAL", asset("one.jpg", "2024-03-01T10:00:00Z"), false))!;
  two = (await ingestGalleryAsset("GAL", asset("two.jpg", "2024-03-02T10:00:00Z"), false))!;
  three = (await ingestGalleryAsset("GAL", asset("three.jpg", "2024-03-03T10:00:00Z"), false))!;
  secret = (await ingestGalleryAsset("PRIV", asset("secret.jpg", "2024-04-01T10:00:00Z"), false))!;
});

/** A story with one chapter, and that chapter's id. */
function chapter() {
  const story = createStory(author, "Alps in summer", null);
  return { storyId: story.id, chapterId: getChapters(story.id)[0].id };
}

function group(items: { itemId: string; caption?: string | null }[], layout = "mosaic") {
  const { storyId, chapterId } = chapter();
  const block = createBlock(chapterId, storyId, "photos", {
    layout,
    items: items.map((item) => ({ itemId: item.itemId, caption: item.caption ?? null }))
  });
  return { storyId, chapterId, blockId: block.id };
}

describe("a photo group's members", () => {
  it("keeps the photos in the order they were arranged, not the order they were taken", () => {
    const { blockId } = group([{ itemId: three }, { itemId: one }, { itemId: two }]);
    expect(blockItemsByIds([blockId]).get(blockId)?.map((item) => item.itemId))
      .toEqual([three, one, two]);
  });

  it("holds no single reference of its own — the members are the block's content", () => {
    const { blockId } = group([{ itemId: one }, { itemId: two }]);
    const block = getBlock(blockId)!;
    expect(block.entity_id).toBeNull();
    expect(block.entity_type).toBeNull();
    expect(block.layout).toBe("mosaic");
  });

  it("carries a line per photo, apart from the group's own caption", () => {
    const { blockId } = group([
      { itemId: one, caption: "Dad on the balcony" },
      { itemId: two }
    ]);
    expect(blockItemsByIds([blockId]).get(blockId)).toEqual([
      { itemId: one, caption: "Dad on the balcony" },
      { itemId: two, caption: null }
    ]);
  });

  it("replaces the whole list on an update, so reordering and removing are one write", () => {
    const { storyId, blockId } = group([{ itemId: one }, { itemId: two }, { itemId: three }]);
    updateBlock(blockId, storyId, { items: [{ itemId: two, caption: "The good one" }, { itemId: one, caption: null }] });
    expect(blockItemsByIds([blockId]).get(blockId)).toEqual([
      { itemId: two, caption: "The good one" },
      { itemId: one, caption: null }
    ]);
  });

  it("empties the group on an empty list, and leaves it alone when none is sent", () => {
    const { storyId, blockId } = group([{ itemId: one }, { itemId: two }]);
    updateBlock(blockId, storyId, { caption: "Just the caption" });
    expect(blockItemsByIds([blockId]).get(blockId)).toHaveLength(2);
    updateBlock(blockId, storyId, { items: [] });
    expect(blockItemsByIds([blockId]).get(blockId)).toBeUndefined();
  });

  it("keeps the first place a photo was put when the same one is sent twice", () => {
    const { blockId } = group([
      { itemId: one, caption: "first" },
      { itemId: two },
      { itemId: one, caption: "again" }
    ]);
    expect(blockItemsByIds([blockId]).get(blockId)).toEqual([
      { itemId: one, caption: "first" },
      { itemId: two, caption: null }
    ]);
  });

  it("stops at the cap, so one plate can never become an album", () => {
    const { blockId } = group(
      Array.from({ length: PHOTO_GROUP_MAX + 10 }, (_, index) => ({ itemId: index === 0 ? one : `made-up-${index}` }))
    );
    expect(blockItemsByIds([blockId]).get(blockId)).toHaveLength(PHOTO_GROUP_MAX);
  });

  it("ignores a member list sent for any other kind of block", () => {
    const { storyId, chapterId } = chapter();
    const block = createBlock(chapterId, storyId, "media", { entityId: one, items: [{ itemId: two, caption: null }] });
    expect(blockItemsByIds([block.id]).get(block.id)).toBeUndefined();
    expect(getBlock(block.id)!.entity_id).toBe(one);
  });

  it("takes its members with it when the block goes", () => {
    const { storyId, blockId } = group([{ itemId: one }, { itemId: two }]);
    deleteBlock(blockId, storyId);
    expect(blockItemsByIds([blockId]).get(blockId)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_block_items").get()).toEqual({ n: 0 });
  });
});

describe("who may put a photo on a plate", () => {
  it("accepts photos the author can reach", () => {
    expect(galleryItemsAreReachable([one, two, secret], author)).toBe(true);
  });

  it("refuses the whole list when one photo is out of reach — a group is no backdoor", () => {
    expect(galleryItemsAreReachable([one, secret], viewer)).toBe(false);
    expect(galleryItemsAreReachable([one, two], viewer)).toBe(true);
  });

  it("refuses a photo that does not exist", () => {
    expect(galleryItemsAreReachable(["made-up"], author)).toBe(false);
  });
});

describe("when a photo in a group is purged", () => {
  it("drops that photo out and leaves the rest of the plate standing", () => {
    const { blockId } = group([{ itemId: one }, { itemId: two }, { itemId: three }]);
    deleteStoryBlocksForResource(GALLERY_ENTITY_TYPE, two);
    expect(getBlock(blockId)).toBeDefined();
    expect(blockItemsByIds([blockId]).get(blockId)?.map((item) => item.itemId)).toEqual([one, three]);
  });

  it("removes the block once its last photo is gone — an empty plate draws nothing", () => {
    const { blockId } = group([{ itemId: one }]);
    deleteStoryBlocksForResource(GALLERY_ENTITY_TYPE, one);
    expect(getBlock(blockId)).toBeUndefined();
  });

  it("leaves a group in another library alone when one library is deleted", () => {
    const { blockId } = group([{ itemId: one }, { itemId: secret }]);
    deleteStoryBlocksForLibrary(GALLERY_ENTITY_TYPE, "PRIV");
    expect(blockItemsByIds([blockId]).get(blockId)?.map((item) => item.itemId)).toEqual([one]);
  });

  it("does not touch groups when a non-gallery resource is purged", () => {
    const { blockId } = group([{ itemId: one }, { itemId: two }]);
    deleteStoryBlocksForResource("gallery_album", one);
    expect(blockItemsByIds([blockId]).get(blockId)).toHaveLength(2);
  });
});

describe("a story's derived cover", () => {
  it("falls back to the first photo of a group, in reading order", () => {
    // The cover comes from the photo's own artwork, so give both members some:
    // the plate's FIRST photo is the one that should win, not the earliest taken.
    db.prepare("UPDATE item_metadata SET cover_storage_key = 'two-key' WHERE item_id = ?").run(two);
    db.prepare("UPDATE item_metadata SET cover_storage_key = 'one-key' WHERE item_id = ?").run(one);
    const { storyId } = group([{ itemId: two }, { itemId: one }]);
    const listed = listStories(author, ["GAL"]).find((story) => story.id === storyId);
    expect(listed?.coverUrl).toBe("/api/library/covers/two-key");
  });

  it("never lends a group's photo to a story that only holds a recording", () => {
    // An audio block is entity_type 'gallery' too; its embedded art must not
    // become a story's card, which is why the fallback names the kinds.
    db.prepare("UPDATE item_metadata SET cover_storage_key = 'one-key' WHERE item_id = ?").run(one);
    const { storyId, chapterId } = chapter();
    createBlock(chapterId, storyId, "audio", { entityId: one });
    const listed = listStories(author, ["GAL"]).find((story) => story.id === storyId);
    expect(listed?.coverUrl).toBeNull();
  });
});

describe("the group alongside the rest of a story", () => {
  it("is one block, however many photos it holds", () => {
    const { storyId } = group([{ itemId: one }, { itemId: two }, { itemId: three }]);
    const blocks = getBlocks(storyId);
    expect(blocks.filter((block) => block.kind === "photos")).toHaveLength(1);
  });

  it("remembers which plate it wears", () => {
    const { storyId, blockId } = group([{ itemId: one }, { itemId: two }], "grid");
    expect(getBlock(blockId)!.layout).toBe("grid");
    updateBlock(blockId, storyId, { layout: "stack" });
    expect(getBlock(blockId)!.layout).toBe("stack");
  });
});
