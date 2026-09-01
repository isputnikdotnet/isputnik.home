import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { createAlbum, addAlbumItems, deleteAlbum } from "../src/modules/library/gallery/albums.js";
import { hydrateEntities, isSubjectEntityType, COLLECTABLE_ENTITY_TYPES } from "../src/modules/social/subjects.js";
import { setEntityTags, getEntityTags, deleteEntityTags } from "../src/modules/library/audiobook/categorize.js";
import { deleteStoryBlocksForResource, deleteStoryBlocksForLibrary } from "../src/modules/stories/cleanup.js";
import {
  STORY_ENTITY_TYPE,
  createStory,
  updateStory,
  deleteStory,
  listStories,
  setStorySaved,
  isStorySaved,
  storyRefMatches,
  canEditStory,
  canViewStory,
  getStory,
  getStoryTags,
  getChapters,
  createChapter,
  updateChapter,
  deleteChapter,
  reorderChapters,
  createBlock,
  getBlocks,
  updateBlock,
  deleteBlock,
  reorderBlocks,
  galleryAssetsByIds,
  blockPreviewAssets
} from "../src/modules/stories/stories.js";
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

// author writes the stories; viewer is a plain member; admin is an admin.
// GAL is open to everyone, PRIV only to author — so PRIV photos are invisible
// to viewer, which is what makes "a story never widens access" testable.
const author = { id: "author", role: "member" };
const viewer = { id: "viewer", role: "member" };
const admin = { id: "boss", role: "admin" };
const GAL_LIBS = ["GAL", "PRIV"];
let open = "";
let secret = "";

beforeEach(async () => {
  resetDb();
  makeUser("author");
  makeUser("viewer");
  makeUser("boss", "admin");
  makeLibrary("GAL", { createdBy: "author", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  makeLibrary("PRIV", { createdBy: "author", type: "gallery" });
  grant("user", "author", "PRIV", "manager");
  open = (await ingestGalleryAsset("GAL", asset("open.jpg", "2024-03-01T10:00:00Z"), false))!;
  secret = (await ingestGalleryAsset("PRIV", asset("secret.jpg", "2024-04-01T10:00:00Z"), false))!;
});

describe("story creation", () => {
  it("gives every story exactly one chapter to start", () => {
    const story = createStory(author, "Minnesota", null);
    const chapters = getChapters(story.id);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBeNull();
    expect(chapters[0].date).toBeNull();
  });

  it("starts as a draft", () => {
    expect(createStory(author, "Minnesota", null).status).toBe("draft");
  });
});

describe("visibility", () => {
  it("hides a draft from other members but not from its author or an admin", () => {
    const story = createStory(author, "Draft story", null);
    expect(canViewStory(story, author)).toBe(true);
    expect(canViewStory(story, admin)).toBe(true);
    expect(canViewStory(story, viewer)).toBe(false);
  });

  it("shows a published story to everyone", () => {
    const story = createStory(author, "Published", null);
    updateStory(story.id, { status: "published" });
    expect(canViewStory(getStory(story.id)!, viewer)).toBe(true);
  });

  it("lists published stories for a member and drafts only for their owner", () => {
    const draft = createStory(author, "Draft", null);
    const live = createStory(author, "Live", null);
    updateStory(live.id, { status: "published" });

    const forViewer = listStories(viewer, GAL_LIBS).map((row) => row.id);
    expect(forViewer).toContain(live.id);
    expect(forViewer).not.toContain(draft.id);

    const forAuthor = listStories(author, GAL_LIBS).map((row) => row.id);
    expect(forAuthor).toEqual(expect.arrayContaining([draft.id, live.id]));
    expect(listStories(admin, GAL_LIBS).map((row) => row.id)).toContain(draft.id);
  });
});

describe("edit rights", () => {
  it("allows the creator and admins, not other members", () => {
    const story = createStory(author, "Minnesota", null);
    expect(canEditStory(story, author)).toBe(true);
    expect(canEditStory(story, admin)).toBe(true);
    expect(canEditStory(story, viewer)).toBe(false);
  });
});

describe("chapters", () => {
  it("keeps the last chapter", () => {
    const story = createStory(author, "Minnesota", null);
    const [only] = getChapters(story.id);
    expect(deleteChapter(only.id, story.id)).toBe(false);
    expect(getChapters(story.id)).toHaveLength(1);
  });

  it("deletes a chapter once there is a spare, taking its blocks with it", () => {
    const story = createStory(author, "Minnesota", null);
    const first = getChapters(story.id)[0];
    const second = createChapter(story.id, { title: "Two" });
    createBlock(second.id, story.id, "text", { body: "gone with it" });

    expect(deleteChapter(second.id, story.id)).toBe(true);
    expect(getChapters(story.id).map((row) => row.id)).toEqual([first.id]);
    expect(getBlocks(story.id)).toHaveLength(0);
  });

  it("stores partial dates and the approximate flag", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    updateChapter(chapter.id, story.id, { date: "2004", endDate: "2004-07", dateApprox: true });
    const [updated] = getChapters(story.id);
    expect(updated.date).toBe("2004");
    expect(updated.end_date).toBe("2004-07");
    expect(updated.date_approx).toBe(1);
  });

  it("reorders chapters", () => {
    const story = createStory(author, "Minnesota", null);
    const first = getChapters(story.id)[0];
    const second = createChapter(story.id, { title: "Two" });
    reorderChapters(story.id, [second.id, first.id]);
    expect(getChapters(story.id).map((row) => row.id)).toEqual([second.id, first.id]);
  });
});

describe("blocks", () => {
  it("stamps the entity type from the block kind, and leaves text/map unreferenced", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    const media = createBlock(chapter.id, story.id, "media", { entityId: open });
    const text = createBlock(chapter.id, story.id, "text", { body: "hello", entityId: open });

    expect(media.entity_type).toBe("gallery");
    expect(media.entity_id).toBe(open);
    // A text block carries no reference even when one is passed in.
    expect(text.entity_type).toBeNull();
    expect(text.entity_id).toBeNull();
  });

  it("maps every reference kind to its subject type", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    const kinds = ["media", "album", "slideshow", "person", "quote"] as const;
    const made = kinds.map((kind) => createBlock(chapter.id, story.id, kind, { entityId: "x" }));
    expect(made.map((block) => block.entity_type)).toEqual([
      "gallery", "gallery_album", "gallery_slideshow", "family_tree_person", "quote"
    ]);
  });

  it("reorders blocks and moves them between chapters in one call", () => {
    const story = createStory(author, "Minnesota", null);
    const first = getChapters(story.id)[0];
    const second = createChapter(story.id, { title: "Two" });
    const a = createBlock(first.id, story.id, "text", { body: "a" });
    const b = createBlock(first.id, story.id, "text", { body: "b" });

    reorderBlocks(story.id, first.id, [b.id, a.id]);
    expect(getBlocks(story.id).map((row) => row.id)).toEqual([b.id, a.id]);

    // Reparenting: every id named lands in the target chapter.
    reorderBlocks(story.id, second.id, [a.id]);
    const blocks = getBlocks(story.id);
    expect(blocks.find((row) => row.id === a.id)!.chapter_id).toBe(second.id);
    expect(blocks.find((row) => row.id === b.id)!.chapter_id).toBe(first.id);
    // Chapter order drives block order across the story.
    expect(blocks.map((row) => row.id)).toEqual([b.id, a.id]);
  });

  it("updates only the fields it is given", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    const block = createBlock(chapter.id, story.id, "media", { entityId: open, caption: "first" });
    updateBlock(block.id, story.id, { layout: "wide" });
    const [updated] = getBlocks(story.id);
    expect(updated.caption).toBe("first");
    expect(updated.layout).toBe("wide");
    expect(updated.entity_id).toBe(open);
  });

  it("deletes one block without touching its siblings", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    const a = createBlock(chapter.id, story.id, "text", { body: "a" });
    createBlock(chapter.id, story.id, "text", { body: "b" });
    expect(deleteBlock(a.id, story.id)).toBe(true);
    expect(getBlocks(story.id).map((row) => row.body)).toEqual(["b"]);
  });
});

describe("a story never widens access", () => {
  it("reports a photo from a library the viewer can't reach as unavailable", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    createBlock(chapter.id, story.id, "media", { entityId: secret });

    // The author can see it; the plain member can't, even though the story is
    // the same rows for both.
    expect(hydrateEntities([{ entityType: "gallery", entityId: secret }], author)
      .get(`gallery:${secret}`)?.available).toBe(true);
    expect(hydrateEntities([{ entityType: "gallery", entityId: secret }], viewer)
      .get(`gallery:${secret}`)?.available).toBeUndefined();
  });

  it("filters block assets by the viewer's libraries", () => {
    expect([...galleryAssetsByIds(author.id, GAL_LIBS, [open, secret]).keys()].sort())
      .toEqual([open, secret].sort());
    // viewer's scope is GAL only — the PRIV photo simply isn't there.
    expect([...galleryAssetsByIds(viewer.id, ["GAL"], [open, secret]).keys()]).toEqual([open]);
  });

  it("previews an album with only the photos the viewer can see", () => {
    const album = createAlbum(author, "Trip", null);
    addAlbumItems(album.id, new Set(GAL_LIBS), [open, secret]);
    expect(blockPreviewAssets("album", album.id, author.id, GAL_LIBS)).toHaveLength(2);
    expect(blockPreviewAssets("album", album.id, viewer.id, ["GAL"]).map((row) => row.id)).toEqual([open]);
  });
});

describe("list covers", () => {
  it("falls back to the first visible photo when no cover is set", () => {
    // Ingest doesn't build thumbnails in tests, so stamp the keys the cover
    // query reads — the point here is which photo it picks, not the file.
    db.prepare("UPDATE item_metadata SET cover_storage_key = 'open-key' WHERE item_id = ?").run(open);
    db.prepare("UPDATE item_metadata SET cover_storage_key = 'secret-key' WHERE item_id = ?").run(secret);

    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    createBlock(chapter.id, story.id, "text", { body: "no picture here" });
    createBlock(chapter.id, story.id, "media", { entityId: open });
    updateStory(story.id, { status: "published" });

    const row = listStories(viewer, ["GAL"]).find((entry) => entry.id === story.id)!;
    expect(row.coverUrl).toBe("/api/library/covers/open-key");
  });

  it("won't use a photo the viewer can't reach as the cover", () => {
    db.prepare("UPDATE item_metadata SET cover_storage_key = 'secret-key' WHERE item_id = ?").run(secret);
    const story = createStory(author, "Private pictures", null);
    const chapter = getChapters(story.id)[0];
    createBlock(chapter.id, story.id, "media", { entityId: secret });
    updateStory(story.id, { status: "published" });

    // The author sees the fallback cover; a member without PRIV gets no cover
    // rather than a thumbnail of something they may not see.
    expect(listStories(author, GAL_LIBS).find((entry) => entry.id === story.id)!.coverUrl)
      .toBe("/api/library/covers/secret-key");
    expect(listStories(viewer, ["GAL"]).find((entry) => entry.id === story.id)!.coverUrl).toBeNull();
  });

  it("reports the chapter date span", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    updateChapter(chapter.id, story.id, { date: "2004-07" });
    const second = createChapter(story.id, { date: "2006", endDate: "2007" });
    expect(second.date).toBe("2006");

    const row = listStories(author, GAL_LIBS).find((entry) => entry.id === story.id)!;
    expect(row.firstDate).toBe("2004-07");
    expect(row.lastDate).toBe("2007");
    expect(row.chapterCount).toBe(2);
  });
});

describe("tags", () => {
  it("stores and reads a story's tags", () => {
    const story = createStory(author, "Minnesota", null);
    setEntityTags(STORY_ENTITY_TYPE, story.id, ["Family", "Minnesota", "2004"]);
    // Sorted by display name, case-insensitively.
    expect(getStoryTags(story.id)).toEqual(["2004", "Family", "Minnesota"]);
  });

  it("replaces the whole set rather than merging", () => {
    const story = createStory(author, "Minnesota", null);
    setEntityTags(STORY_ENTITY_TYPE, story.id, ["Family", "Minnesota"]);
    setEntityTags(STORY_ENTITY_TYPE, story.id, ["Vacation"]);
    expect(getStoryTags(story.id)).toEqual(["Vacation"]);
  });

  it("carries tags on the list, batched", () => {
    const a = createStory(author, "One", null);
    const b = createStory(author, "Two", null);
    setEntityTags(STORY_ENTITY_TYPE, a.id, ["Family"]);
    const rows = listStories(author, GAL_LIBS);
    expect(rows.find((row) => row.id === a.id)!.tags).toEqual(["Family"]);
    expect(rows.find((row) => row.id === b.id)!.tags).toEqual([]);
  });

  it("filters the list by tag, keeping the draft visibility rule", () => {
    const mine = createStory(author, "Mine", null);
    const published = createStory(author, "Published", null);
    setEntityTags(STORY_ENTITY_TYPE, mine.id, ["Family"]);
    setEntityTags(STORY_ENTITY_TYPE, published.id, ["Family"]);
    updateStory(published.id, { status: "published" });

    const tagId = (db.prepare("SELECT id FROM tags WHERE key = 'family'").get() as { id: string }).id;
    expect(listStories(author, GAL_LIBS, tagId).map((row) => row.id).sort())
      .toEqual([mine.id, published.id].sort());
    // The other member sees only the published one, tag or no tag.
    expect(listStories(viewer, ["GAL"], tagId).map((row) => row.id)).toEqual([published.id]);
  });

  it("drops the tag rows when the story is deleted", () => {
    const story = createStory(author, "Minnesota", null);
    setEntityTags(STORY_ENTITY_TYPE, story.id, ["Family"]);
    deleteStory(story.id);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM taggables WHERE entity_type = ?"
    ).get(STORY_ENTITY_TYPE)).toEqual({ n: 0 });
  });
});

// Albums and slideshows became taggable so a tag can join a story to the sets
// it embeds. Same table, same helpers — this guards the wiring, not the helpers.
describe("taggable albums and slideshows", () => {
  it("tags an album and reads it back", () => {
    const album = createAlbum(author, "Trip", null);
    setEntityTags("gallery_album", album.id, ["Minnesota", "Family"]);
    expect(getEntityTags("gallery_album", album.id)).toEqual(["Family", "Minnesota"]);
  });

  it("keeps each set's tags to itself", () => {
    const a = createAlbum(author, "One", null);
    const b = createAlbum(author, "Two", null);
    setEntityTags("gallery_album", a.id, ["Minnesota"]);
    expect(getEntityTags("gallery_album", b.id)).toEqual([]);
  });

  it("drops an album's tags when the album goes", () => {
    const album = createAlbum(author, "Trip", null);
    setEntityTags("gallery_album", album.id, ["Minnesota"]);
    deleteAlbum(album.id);
    deleteEntityTags("gallery_album", album.id);
    expect(getEntityTags("gallery_album", album.id)).toEqual([]);
  });
});

describe("as a subject (Send to, Notes)", () => {
  it("hydrates a published story for any member", () => {
    const story = createStory(author, "Minnesota", "Three weeks");
    updateStory(story.id, { status: "published" });
    const view = hydrateEntities([{ entityType: "story", entityId: story.id }], viewer).get(`story:${story.id}`);
    expect(view?.available).toBe(true);
    expect(view?.title).toBe("Minnesota");
    expect(view?.subtitle).toBe("Three weeks");
    expect(view?.href).toBe(`/stories/${story.id}`);
    expect(view?.playable).toBe(false);
  });

  it("hides a draft from other members, like every other read path", () => {
    const story = createStory(author, "Draft", null);
    expect(hydrateEntities([{ entityType: "story", entityId: story.id }], author)
      .get(`story:${story.id}`)?.available).toBe(true);
    expect(hydrateEntities([{ entityType: "story", entityId: story.id }], viewer)
      .get(`story:${story.id}`)).toBeUndefined();
  });

  it("is not collectable — a collection offers playback a story hasn't got", () => {
    expect(COLLECTABLE_ENTITY_TYPES).not.toContain("story");
    expect(isSubjectEntityType("story")).toBe(true);
  });
});

describe("cleanup of dangling references", () => {
  it("sweeps blocks when the album they point at is deleted", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    const album = createAlbum(author, "Trip", null);
    addAlbumItems(album.id, new Set(GAL_LIBS), [open]);
    createBlock(chapter.id, story.id, "album", { entityId: album.id });
    createBlock(chapter.id, story.id, "text", { body: "stays" });

    deleteAlbum(album.id);
    deleteStoryBlocksForResource("gallery_album", album.id);

    expect(getBlocks(story.id).map((row) => row.kind)).toEqual(["text"]);
  });

  it("sweeps media blocks when a whole gallery library goes", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    createBlock(chapter.id, story.id, "media", { entityId: secret });
    createBlock(chapter.id, story.id, "media", { entityId: open });

    deleteStoryBlocksForLibrary("gallery", "PRIV");

    expect(getBlocks(story.id).map((row) => row.entity_id)).toEqual([open]);
  });

  it("takes chapters and blocks with the story", () => {
    const story = createStory(author, "Minnesota", null);
    const chapter = getChapters(story.id)[0];
    createBlock(chapter.id, story.id, "text", { body: "gone" });

    deleteStory(story.id);

    expect(getStory(story.id)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_chapters").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_blocks").get()).toEqual({ n: 0 });
  });
});

describe("ratings and book blocks (v2 step 4)", () => {
  it("stores and clears a star rating", () => {
    const story = createStory(author, "The Master and Margarita, read at last", null);
    expect(getStory(story.id)!.rating).toBeNull();
    updateStory(story.id, { rating: 4 });
    expect(getStory(story.id)!.rating).toBe(4);
    // Patching another field leaves the stars alone.
    updateStory(story.id, { subtitle: "A review" });
    expect(getStory(story.id)!.rating).toBe(4);
    updateStory(story.id, { rating: null });
    expect(getStory(story.id)!.rating).toBeNull();
  });

  it("refuses stars outside 1..5 at the schema", () => {
    const story = createStory(author, "Impossible", null);
    expect(() =>
      db.prepare("UPDATE stories SET rating = 9 WHERE id = ?").run(story.id)
    ).toThrow();
  });

  it("stores whichever book type the picker chose on a book block", () => {
    const story = createStory(author, "Summer reading", null);
    const chapterId = getChapters(story.id)[0].id;
    const asEbook = createBlock(chapterId, story.id, "book", { entityId: "b1", entityType: "ebook" });
    const asAudio = createBlock(chapterId, story.id, "book", { entityId: "b2", entityType: "audiobook" });
    expect(asEbook.entity_type).toBe("ebook");
    expect(asAudio.entity_type).toBe("audiobook");
    // Patching the reference keeps the chosen type — kind and type are settled
    // at creation.
    updateBlock(asEbook.id, story.id, { entityId: "b3" });
    expect(getBlocks(story.id).find((row) => row.id === asEbook.id)!.entity_type).toBe("ebook");
  });
});

describe("back-links (v2 step 5)", () => {
  it("finds the stories referencing an entity, with the usual visibility", () => {
    const review = createStory(author, "Review of a book", null);
    updateStory(review.id, { status: "published" });
    createBlock(getChapters(review.id)[0].id, review.id, "book", { entityId: "b1", entityType: "ebook" });
    // A draft referencing the same book is the author's business only.
    const draft = createStory(author, "Half-written review", null);
    createBlock(getChapters(draft.id)[0].id, draft.id, "book", { entityId: "b1", entityType: "ebook" });

    const ref = { entityTypes: ["audiobook", "ebook"], entityIds: ["b1"] };
    expect(listStories(viewer, GAL_LIBS, undefined, ref).map((s) => s.id)).toEqual([review.id]);
    expect(new Set(listStories(author, GAL_LIBS, undefined, ref).map((s) => s.id)))
      .toEqual(new Set([review.id, draft.id]));
    // A different entity finds nothing.
    expect(listStories(viewer, GAL_LIBS, undefined, { entityTypes: ["ebook"], entityIds: ["b2"] })).toHaveLength(0);

    // The edition note: which of the queried entities the story referenced.
    const matches = storyRefMatches([review.id], ["audiobook", "ebook"], ["b1"]);
    expect(matches.get(review.id)).toEqual({ entityType: "ebook", entityId: "b1" });
  });

  it("finds stories through album and person blocks too", () => {
    const story = createStory(author, "Minnesota", null);
    updateStory(story.id, { status: "published" });
    const chapterId = getChapters(story.id)[0].id;
    db.prepare("INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id) VALUES ('alb1', ?, 1, 'album', 'gallery_album', 'A1')").run(chapterId);
    db.prepare("INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id) VALUES ('per1', ?, 2, 'person', 'family_tree_person', 'P1')").run(chapterId);

    expect(listStories(viewer, GAL_LIBS, undefined, { entityTypes: ["gallery_album"], entityIds: ["A1"] }).map((s) => s.id))
      .toEqual([story.id]);
    expect(listStories(viewer, GAL_LIBS, undefined, { entityTypes: ["family_tree_person"], entityIds: ["P1"] }).map((s) => s.id))
      .toEqual([story.id]);
  });
});

describe("story kinds (v2 step 7)", () => {
  it("defaults to free with no template applied", () => {
    const story = createStory(author, "Plain", null);
    expect(story.kind).toBe("free");
    expect(story.chapter_noun).toBeNull();
    expect(getBlocks(story.id)).toHaveLength(0);
  });

  it("a journal counts its days", () => {
    const story = createStory(author, "Vienna trip", null, null, { kind: "journal" });
    expect(story.kind).toBe("journal");
    expect(story.chapter_noun).toBe("Day");
  });

  it("a review from a book page opens on that book's card", () => {
    const story = createStory(author, "12 Rules for Life", null, null, {
      kind: "review",
      reviewOf: { entityType: "audiobook", entityId: "bk1" }
    });
    expect(story.kind).toBe("review");
    const blocks = getBlocks(story.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("book");
    expect(blocks[0].entity_type).toBe("audiobook");
    expect(blocks[0].entity_id).toBe("bk1");
    // The review then shows on the book page via the ordinary back-links.
    updateStory(story.id, { status: "published" });
    expect(listStories(viewer, GAL_LIBS, undefined, { entityTypes: ["audiobook", "ebook"], entityIds: ["bk1"] })
      .map((s) => s.id)).toEqual([story.id]);
  });

  it("never gates anything: a memory can still become a chaptered epic", () => {
    const story = createStory(author, "That evening", null, null, { kind: "memory" });
    createChapter(story.id, { title: "Part 2" });
    createBlock(getChapters(story.id)[0].id, story.id, "media", { entityId: open });
    expect(getChapters(story.id)).toHaveLength(2);
  });
});

describe("creation seeding (friendlier New story)", () => {
  it("a memory opens dated and placed", () => {
    const story = createStory(author, "That evening", null, null, {
      kind: "memory", date: "2004-07", place: "Duluth"
    });
    const [chapter] = getChapters(story.id);
    expect(chapter.date).toBe("2004-07");
    expect(chapter.place).toBe("Duluth");
  });

  it("a journal with a full range lays out one dated chapter per day", () => {
    const story = createStory(author, "Vienna", null, null, {
      kind: "journal", date: "2026-04-18", endDate: "2026-04-21"
    });
    const chapters = getChapters(story.id);
    expect(chapters.map((c) => c.date)).toEqual(["2026-04-18", "2026-04-19", "2026-04-20", "2026-04-21"]);
    expect(story.chapter_noun).toBe("Day");
  });

  it("caps the day layout at a month and falls back to a range", () => {
    const story = createStory(author, "The long year", null, null, {
      kind: "journal", date: "2026-01-01", endDate: "2026-03-01"
    });
    const chapters = getChapters(story.id);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].date).toBe("2026-01-01");
    expect(chapters[0].end_date).toBe("2026-03-01");
  });

  it("keeps a partial date as a range on chapter one, never guessing days", () => {
    const story = createStory(author, "Summer", null, null, {
      kind: "journal", date: "2004-07", endDate: "2004-08"
    });
    const chapters = getChapters(story.id);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].date).toBe("2004-07");
    expect(chapters[0].end_date).toBe("2004-08");
  });
});

describe("favorites", () => {
  it("saves per user, idempotently both ways", () => {
    const story = createStory(author, "Keeper", null);
    updateStory(story.id, { status: "published" });

    setStorySaved(story.id, viewer.id, true);
    setStorySaved(story.id, viewer.id, true);
    expect(isStorySaved(story.id, viewer.id)).toBe(true);
    expect(isStorySaved(story.id, author.id)).toBe(false);

    setStorySaved(story.id, viewer.id, false);
    setStorySaved(story.id, viewer.id, false);
    expect(isStorySaved(story.id, viewer.id)).toBe(false);
  });

  it("flags saved stories in the list for the saving user only", () => {
    const story = createStory(author, "Keeper", null);
    updateStory(story.id, { status: "published" });
    setStorySaved(story.id, viewer.id, true);

    const forViewer = listStories(viewer, GAL_LIBS).find((row) => row.id === story.id);
    const forAuthor = listStories(author, GAL_LIBS).find((row) => row.id === story.id);
    expect(forViewer?.saved).toBe(true);
    expect(forAuthor?.saved).toBe(false);
  });

  it("goes away with the story", () => {
    const story = createStory(author, "Doomed", null);
    setStorySaved(story.id, author.id, true);
    deleteStory(story.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM story_saves").get()).toEqual({ n: 0 });
  });
});

describe("card geography", () => {
  it("counts pinned chapters and surfaces the first named place", () => {
    const story = createStory(author, "Road trip", null);
    updateStory(story.id, { status: "published" });
    const [first] = getChapters(story.id);
    updateChapter(first.id, story.id, { place: "Duluth, MN", placeLat: 46.78, placeLng: -92.1 });
    const second = createChapter(story.id, { place: "Ely, MN", placeLat: 47.9, placeLng: -91.86 });
    createChapter(story.id, { place: "Named but unpinned" });

    const card = listStories(viewer, GAL_LIBS).find((row) => row.id === story.id)!;
    expect(second).toBeTruthy();
    expect(card.placesCount).toBe(2);
    expect(card.firstPlace).toBe("Duluth, MN");
  });

  it("leaves both empty on a story with no places", () => {
    const story = createStory(author, "Homebody", null);
    updateStory(story.id, { status: "published" });
    const card = listStories(viewer, GAL_LIBS).find((row) => row.id === story.id)!;
    expect(card.placesCount).toBe(0);
    expect(card.firstPlace).toBeNull();
  });
});
