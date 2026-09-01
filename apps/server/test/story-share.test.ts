import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db.js";
import { EVERYONE_GROUP_ID } from "../src/core/permissions.js";
import { ingestGalleryAsset } from "../src/modules/library/gallery/scanner.js";
import { kindForExtension } from "../src/modules/library/gallery/media.js";
import { createAlbum, addAlbumItems } from "../src/modules/library/gallery/albums.js";
import { resolveShareLink } from "../src/modules/library/shared/share-access.js";
import {
  createStoryShare,
  storyLinkContext,
  storyShareReach,
  loadStoryShareMediaItem,
  storyShareFiles,
  buildStorySharePayload
} from "../src/modules/stories/share.js";
import {
  BLOCK_PREVIEW_LIMIT,
  createStory,
  createBlock,
  purgeStory,
  getChapters,
  updateStory,
  updateChapter
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

// author owns the story and the link; stranger is another member; admin is an
// admin. GAL is open to everyone, PRIV only to author.
const author = { id: "author", role: "member" };
const stranger = { id: "stranger", role: "member" };
const admin = { id: "boss", role: "admin" };
let photos: string[] = [];
let secret = "";
let storyId = "";
let chapterId = "";

/** Mint a link and resolve it the way a guest request would. */
function mintLink(opts: { expandAlbums?: boolean; by?: { id: string; role: string } } = {}) {
  const made = createStoryShare(opts.by ?? author, {
    storyId,
    expiresInDays: 7,
    label: null,
    expandAlbums: opts.expandAlbums ?? false
  });
  if (typeof made === "string") throw new Error(`share refused: ${made}`);
  return { ...made, link: resolveShareLink(made.token)! };
}

beforeEach(async () => {
  resetDb();
  makeUser("author");
  makeUser("stranger");
  makeUser("boss", "admin");
  makeLibrary("GAL", { createdBy: "author", type: "gallery" });
  grant("group", EVERYONE_GROUP_ID, "GAL", "member");
  grant("user", "author", "GAL", "manager");
  makeLibrary("PRIV", { createdBy: "author", type: "gallery" });
  grant("user", "author", "PRIV", "manager");

  photos = [];
  for (let i = 0; i < 10; i += 1) {
    photos.push((await ingestGalleryAsset(
      "GAL", asset(`p${i}.jpg`, `2024-03-0${(i % 9) + 1}T10:00:00Z`), false
    ))!);
  }
  secret = (await ingestGalleryAsset("PRIV", asset("secret.jpg", "2024-04-01T10:00:00Z"), false))!;

  const story = createStory(author, "Minnesota", "Three weeks");
  storyId = story.id;
  chapterId = getChapters(storyId)[0].id;
});

describe("minting a story link", () => {
  it("lets the author and an admin, but not another member", () => {
    expect(typeof createStoryShare(author, { storyId, expiresInDays: 7, label: null, expandAlbums: false })).toBe("object");
    expect(typeof createStoryShare(admin, { storyId, expiresInDays: 7, label: null, expandAlbums: false })).toBe("object");
    expect(createStoryShare(stranger, { storyId, expiresInDays: 7, label: null, expandAlbums: false })).toBe("forbidden");
  });

  it("refuses a story that isn't there", () => {
    expect(createStoryShare(author, { storyId: "nope", expiresInDays: 7, label: null, expandAlbums: false }))
      .toBe("not_found");
  });

  it("resolves through the normal share-link path, and stops when revoked", () => {
    const { shareId, token } = mintLink();
    expect(resolveShareLink(token)?.module).toBe("story");
    db.prepare("UPDATE share_links SET revoked_at = datetime('now') WHERE id = ?").run(shareId);
    expect(resolveShareLink(token)).toBeNull();
  });
});

describe("what a link exposes", () => {
  it("serves a media block's photo", () => {
    createBlock(chapterId, storyId, "media", { entityId: photos[0] });
    const { link } = mintLink();
    expect([...storyShareReach(storyLinkContext(link)!).itemIds]).toEqual([photos[0]]);
    expect(loadStoryShareMediaItem(link, photos[0])).toBeDefined();
  });

  it("refuses an item the story doesn't show", () => {
    createBlock(chapterId, storyId, "media", { entityId: photos[0] });
    const { link } = mintLink();
    // A real, readable photo — but not one this story puts on the page.
    expect(loadStoryShareMediaItem(link, photos[1])).toBeUndefined();
  });

  it("caps an embedded album at the inline preview unless the link expands", () => {
    const album = createAlbum(author, "Trip", null);
    addAlbumItems(album.id, new Set(["GAL"]), photos);
    createBlock(chapterId, storyId, "album", { entityId: album.id });

    const narrow = mintLink({ expandAlbums: false });
    const narrowIds = storyShareReach(storyLinkContext(narrow.link)!).itemIds;
    expect(narrowIds.size).toBe(BLOCK_PREVIEW_LIMIT);

    const wide = mintLink({ expandAlbums: true });
    expect(storyShareReach(storyLinkContext(wide.link)!).itemIds.size).toBe(photos.length);

    // The photos past the preview are genuinely unreachable on the narrow link,
    // and reachable on the wide one — the option is enforced, not cosmetic.
    const beyond = photos.find((id) => !narrowIds.has(id))!;
    expect(loadStoryShareMediaItem(narrow.link, beyond)).toBeUndefined();
    expect(loadStoryShareMediaItem(wide.link, beyond)).toBeDefined();
  });

  it("never serves a photo the link's creator can't reach", () => {
    createBlock(chapterId, storyId, "media", { entityId: secret });
    // author CAN curate PRIV, so their own link serves it...
    const mine = mintLink();
    expect(loadStoryShareMediaItem(mine.link, secret)).toBeDefined();

    // ...but a link minted by an admin who is scoped out of PRIV must not.
    // Strip the author's grant and the existing link goes dark with it.
    db.prepare("DELETE FROM assignments WHERE object_id = 'PRIV'").run();
    expect(loadStoryShareMediaItem(mine.link, secret)).toBeUndefined();
  });

  // Accounts are retired by deactivating or soft-deleting them — share_links
  // has an FK on created_by, so the row never really goes away. Either way the
  // links that account handed out must stop serving.
  it("goes dead, not open, when the link's creator is deactivated", () => {
    createBlock(chapterId, storyId, "media", { entityId: photos[0] });
    const { link } = mintLink();
    db.prepare("UPDATE users SET is_active = 0 WHERE id = 'author'").run();
    expect(storyLinkContext(link)).toBeNull();
    expect(loadStoryShareMediaItem(link, photos[0])).toBeUndefined();
  });

  it("goes dead when the link's creator is soft-deleted", () => {
    createBlock(chapterId, storyId, "media", { entityId: photos[0] });
    const { link } = mintLink();
    db.prepare("UPDATE users SET deleted_at = datetime('now') WHERE id = 'author'").run();
    expect(storyLinkContext(link)).toBeNull();
  });

  it("zips only what the link exposes", () => {
    const album = createAlbum(author, "Trip", null);
    addAlbumItems(album.id, new Set(["GAL"]), photos);
    createBlock(chapterId, storyId, "album", { entityId: album.id });
    expect(storyShareFiles(mintLink({ expandAlbums: false }).link)).toHaveLength(BLOCK_PREVIEW_LIMIT);
    expect(storyShareFiles(mintLink({ expandAlbums: true }).link)).toHaveLength(photos.length);
  });
});

describe("the guest payload", () => {
  it("carries the story's words and token-scoped media, and no in-app links", () => {
    createBlock(chapterId, storyId, "text", { body: "# Heading\n\nSome prose." });
    createBlock(chapterId, storyId, "media", { entityId: photos[0], caption: "The drive" });
    const { token, link } = mintLink();

    const built = buildStorySharePayload(link, token)!;
    expect(built.payload.type).toBe("story");
    expect(built.payload.story.title).toBe("Minnesota");

    const blocks = built.payload.story.chapters[0].blocks;
    expect(blocks[0]).toMatchObject({ kind: "text", body: "# Heading\n\nSome prose." });
    const media = blocks[1] as { kind: string; asset: { fileUrl: string } };
    expect(media.kind).toBe("media");
    expect(media.asset.fileUrl).toBe(`/api/share/${token}/items/${photos[0]}/file`);

    // Nothing in the payload should point back into the app — a guest has no
    // session and every such link would bounce them to a sign-in screen.
    expect(JSON.stringify(built.payload)).not.toContain("/gallery/");
    expect(JSON.stringify(built.payload)).not.toContain("/stories/");
  });

  it("drops a block whose photo the creator can no longer reach", () => {
    createBlock(chapterId, storyId, "text", { body: "still here" });
    createBlock(chapterId, storyId, "media", { entityId: secret });
    const { token, link } = mintLink();
    db.prepare("DELETE FROM assignments WHERE object_id = 'PRIV'").run();

    const blocks = buildStorySharePayload(link, token)!.payload.story.chapters[0].blocks;
    expect(blocks.map((block) => block.kind)).toEqual(["text"]);
  });

  it("reports an album's full visible count while serving only the preview", () => {
    const album = createAlbum(author, "Trip", null);
    addAlbumItems(album.id, new Set(["GAL"]), photos);
    createBlock(chapterId, storyId, "album", { entityId: album.id });
    const { token, link } = mintLink({ expandAlbums: false });

    const block = buildStorySharePayload(link, token)!.payload.story.chapters[0].blocks[0] as {
      kind: string; itemCount: number; items: unknown[];
    };
    expect(block.kind).toBe("album");
    expect(block.itemCount).toBe(photos.length);
    expect(block.items).toHaveLength(BLOCK_PREVIEW_LIMIT);
  });

  it("is live — a block added after the link was minted shows up", () => {
    const { token, link } = mintLink();
    expect(buildStorySharePayload(link, token)!.payload.story.chapters[0].blocks).toHaveLength(0);
    createBlock(chapterId, storyId, "text", { body: "written later" });
    expect(buildStorySharePayload(link, token)!.payload.story.chapters[0].blocks).toHaveLength(1);
  });
});

describe("cleanup", () => {
  it("takes its links with the story", () => {
    const { token } = mintLink();
    purgeStory(storyId);
    expect(resolveShareLink(token)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM share_links WHERE module = 'story'").get()).toEqual({ n: 0 });
  });
});

describe("guest chapter pages", () => {
  it("carries chapter identity, standfirst, hero and the story's front-page fields", () => {
    updateStory(storyId, { chapterNoun: "Day", intro: "How we remember it.", rating: 5, coverItemId: photos[0] });
    updateChapter(chapterId, storyId, { title: "The drive north", standfirst: "Out before dawn.", heroItemId: photos[1] });
    createBlock(chapterId, storyId, "media", { entityId: photos[2] });

    const { payload } = buildStorySharePayload(mintLink().link)!;
    expect(payload.story.chapterNoun).toBe("Day");
    expect(payload.story.intro).toBe("How we remember it.");
    expect(payload.story.rating).toBe(5);
    expect(payload.story.cover?.id).toBe(photos[0]);
    const [chapter] = payload.story.chapters;
    expect(chapter.id).toBe(chapterId);
    expect(chapter.standfirst).toBe("Out before dawn.");
    expect(chapter.hero?.id).toBe(photos[1]);
    // Hero and cover URLs are token-scoped like everything else a guest sees.
    expect(chapter.hero?.previewUrl).toContain("/api/share/");
    expect(payload.story.cover?.previewUrl).toContain("/api/share/");
    // And the token actually serves them: they joined the link's reach.
    const link = mintLink().link;
    expect(loadStoryShareMediaItem(link, photos[0])).toBeDefined();
    expect(loadStoryShareMediaItem(link, photos[1])).toBeDefined();
  });

  it("drops a hero or cover the creator can no longer reach, and never serves it", () => {
    updateStory(storyId, { coverItemId: secret });
    updateChapter(chapterId, storyId, { heroItemId: secret });
    createBlock(chapterId, storyId, "media", { entityId: photos[0] });
    // Take PRIV away from the author — the link keeps working, minus PRIV.
    db.prepare("DELETE FROM assignments WHERE object_id = 'PRIV'").run();

    const link = mintLink().link;
    const { payload } = buildStorySharePayload(link)!;
    expect(payload.story.cover).toBeNull();
    expect(payload.story.chapters[0].hero).toBeNull();
    expect(loadStoryShareMediaItem(link, secret)).toBeUndefined();
  });
});
