// Sharing a story: guest links (module 'story') and the public payload they
// serve. See docs/stories-proposal.md, Phase 3.
//
// A story link is LIVE, like an album link and unlike a quick set: nothing is
// snapshotted, and every request re-resolves the story as it stands. Two rules
// keep that safe:
//
// 1. Media resolves against the LINK CREATOR's current curate rights, never the
//    guest's (there isn't one) and never the author's rights at share time. If
//    the creator loses access to a library, the link stops serving its photos.
// 2. `expandAlbums` decides how far into an embedded set a guest may reach —
//    off, only the photos the story shows inline; on, the whole album. Sharing a
//    story is not the same as sharing everything it mentions.
//
// The reachable set is computed once, in JS, from the same functions the reading
// view uses. That is deliberate: the guest can open exactly what the page shows
// them and nothing else, and the two can't drift apart the way two SQL queries
// would.
import fs from "node:fs";
import path from "node:path";
import { db } from "../../db.js";
import { nanoid } from "nanoid";
import { sha256 } from "../../crypto.js";
import { addDays } from "../../auth.js";
import { curatableGalleryLibraryIds } from "../library/shared/shares.js";
import { hydrateEntities } from "../social/subjects.js";
import { getAlbum, getAlbumItems } from "../library/gallery/albums.js";
import { getSlideshow, getSlideshowItems } from "../library/gallery/slideshows.js";
import type { ResolvedShareLink } from "../library/shared/share-access.js";
import { getStoryAudio } from "./audio.js";
import {
  BLOCK_PREVIEW_LIMIT,
  getStory,
  canEditStory,
  getChapters,
  getBlocks,
  type BlockRow,
  type StoryRow
} from "./stories.js";

export const STORY_SHARE_MODULE = "story";

/** How many photos a guest can reach inside an expanded album — a bound, not a
 *  page: a story link shouldn't become an unpaginated dump of a huge album. */
const EXPANDED_LIMIT = 500;

interface ShareCreator {
  id: string;
  role: string;
}

export type StoryShareResult =
  | { shareId: string; token: string; expiresAt: string }
  | "not_found"
  | "forbidden";

/** Mint a guest link for a story. Creator or admin only, matching album links
 *  and the story's own edit rule. A draft may be shared — an author sending a
 *  link before publishing is a real thing, and they chose to. */
export function createStoryShare(
  user: ShareCreator,
  opts: { storyId: string; expiresInDays: number; label: string | null; expandAlbums: boolean }
): StoryShareResult {
  const story = getStory(opts.storyId);
  if (!story) return "not_found";
  if (!canEditStory(story, user)) return "forbidden";

  const token = nanoid(36);
  const shareId = nanoid(16);
  const expiresAt = addDays(opts.expiresInDays).toISOString();
  db.prepare(`
    INSERT INTO share_links (id, module, resource_id, token_hash, permission, label, expires_at, created_by, expand_albums)
    VALUES (?, ?, ?, ?, 'read', ?, ?, ?, ?)
  `).run(shareId, STORY_SHARE_MODULE, story.id, sha256(token), opts.label, expiresAt, user.id, opts.expandAlbums ? 1 : 0);

  return { shareId, token, expiresAt };
}

interface StoryLinkContext {
  story: StoryRow;
  /** The libraries the LINK CREATOR may curate right now. */
  libIds: string[];
  creatorId: string;
  /** The creator as a subject-hydration user — book cards resolve through
   *  the same per-user hydrator the reading view uses. */
  creator: ShareCreator;
  expandAlbums: boolean;
}

/** Resolve a story link to the story and the creator's current reach. Returns
 *  null when the story is gone or the creator's account is — a link with no
 *  vouching creator goes dead rather than open.
 *
 *  "Gone" means deactivated or soft-deleted, not just absent: accounts are
 *  retired that way (share_links.created_by has an FK, so a row is never really
 *  removed), and deactivating someone should stop the links they handed out. */
export function storyLinkContext(link: ResolvedShareLink): StoryLinkContext | null {
  const story = getStory(link.resource_id);
  // A story in the Recycle Bin serves nothing — its guest links go dark with
  // it, and come back to life if it is restored.
  if (!story || story.deleted_at) return null;
  const creator = db.prepare(
    "SELECT id, role FROM users WHERE id = ? AND is_active = 1 AND deleted_at IS NULL"
  ).get(link.created_by) as ShareCreator | undefined;
  if (!creator) return null;
  const row = db.prepare("SELECT expand_albums FROM share_links WHERE id = ?")
    .get(link.id) as { expand_albums: number } | undefined;
  return {
    story,
    libIds: curatableGalleryLibraryIds(creator),
    creatorId: creator.id,
    creator,
    expandAlbums: (row?.expand_albums ?? 0) === 1
  };
}

type ShareAsset = ReturnType<typeof getAlbumItems>["assets"][number];

/** Photos a block contributes to the link: the media block's own item, or the
 *  set's members — capped at the inline preview unless the link expands. */
function blockAssets(block: BlockRow, ctx: StoryLinkContext): ShareAsset[] {
  if (!block.entity_id) return [];
  const limit = ctx.expandAlbums ? EXPANDED_LIMIT : BLOCK_PREVIEW_LIMIT;

  if (block.kind === "album") {
    const album = getAlbum(block.entity_id);
    return album ? getAlbumItems(ctx.creatorId, ctx.libIds, album, limit, 0).assets : [];
  }
  if (block.kind === "slideshow") {
    const slideshow = getSlideshow(block.entity_id);
    return slideshow
      ? getSlideshowItems(ctx.creatorId, ctx.libIds, slideshow, limit, 0)
          .assets.map(({ dwellSeconds: _dwell, ...asset }) => asset)
      : [];
  }
  if (block.kind === "media") {
    return ctx.libIds.length === 0 ? [] : mediaAssetById(ctx, block.entity_id);
  }
  // A gallery-backed recording (v2 audio block) joins the link's reach like a
  // photo would, so the token-scoped item routes serve it — "recordings stream
  // through the token from day one". Legacy 'story_audio' blocks serve through
  // their own /api/share/:token/audio route instead and contribute no items.
  if (block.kind === "audio" && block.entity_type === "gallery") {
    return ctx.libIds.length === 0 ? [] : mediaAssetById(ctx, block.entity_id);
  }
  return [];
}

/** One gallery item as a share asset, bounded by the creator's libraries. */
function mediaAssetById(ctx: StoryLinkContext, itemId: string): ShareAsset[] {
  const row = db.prepare(`
    SELECT
      library_items.id,
      item_metadata.title,
      library_items.folder_path,
      gallery_details.kind,
      gallery_details.width,
      gallery_details.height,
      gallery_details.rotation,
      gallery_details.duration_seconds,
      gallery_details.taken_at
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
      AND library_items.library_id IN (${ctx.libIds.map(() => "?").join(", ")})
  `).get(itemId, ...ctx.libIds) as {
    id: string; title: string | null; folder_path: string; kind: string;
    width: number | null; height: number | null; rotation: number | null;
    duration_seconds: number | null; taken_at: string | null;
  } | undefined;
  if (!row) return [];
  const swap = row.rotation === 90 || row.rotation === 270;
  return [{
    id: row.id,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    kind: row.kind as "photo" | "video" | "audio",
    width: swap ? row.height : row.width,
    height: swap ? row.width : row.height,
    durationSeconds: row.duration_seconds,
    takenAt: row.taken_at
  } as ShareAsset];
}

/**
 * Every item id this link may serve, and the assets each block shows. Computed
 * from the same helpers the reading view uses, so the guest's reach is exactly
 * what their page displays. Chapter heroes and the story cover join the reach
 * the same way — they are what the guest's front page and chapter pages
 * render, all bounded by the creator's current libraries.
 */
export function storyShareReach(ctx: StoryLinkContext): {
  byBlock: Map<string, ShareAsset[]>;
  itemIds: Set<string>;
  heroByChapter: Map<string, ShareAsset>;
  cover: ShareAsset | null;
} {
  const byBlock = new Map<string, ShareAsset[]>();
  const itemIds = new Set<string>();
  for (const block of getBlocks(ctx.story.id)) {
    const assets = blockAssets(block, ctx);
    if (assets.length === 0) continue;
    byBlock.set(block.id, assets);
    for (const asset of assets) itemIds.add(asset.id);
  }
  const heroByChapter = new Map<string, ShareAsset>();
  let cover: ShareAsset | null = null;
  if (ctx.libIds.length > 0) {
    for (const chapter of getChapters(ctx.story.id)) {
      if (!chapter.hero_item_id) continue;
      const [asset] = mediaAssetById(ctx, chapter.hero_item_id);
      if (asset) {
        heroByChapter.set(chapter.id, asset);
        itemIds.add(asset.id);
      }
    }
    if (ctx.story.cover_item_id) {
      cover = mediaAssetById(ctx, ctx.story.cover_item_id)[0] ?? null;
      if (cover) itemIds.add(cover.id);
    }
  }
  return { byBlock, itemIds, heroByChapter, cover };
}

/** One reachable item with everything the media routes need. Membership in the
 *  link's reach IS the authorization — an item the story doesn't show 404s. */
export function loadStoryShareMediaItem(link: ResolvedShareLink, itemId: string) {
  const ctx = storyLinkContext(link);
  if (!ctx || ctx.libIds.length === 0) return undefined;
  if (!storyShareReach(ctx).itemIds.has(itemId)) return undefined;

  return db.prepare(`
    SELECT
      library_items.folder_path,
      gallery_details.kind,
      gallery_details.relative_path,
      gallery_details.mime_type,
      item_metadata.title,
      item_metadata.cover_storage_key,
      gallery_details.preview_storage_key,
      libraries.source_path
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
      AND library_items.library_id IN (${ctx.libIds.map(() => "?").join(", ")})
  `).get(itemId, ...ctx.libIds) as {
    folder_path: string;
    kind: string;
    relative_path: string;
    mime_type: string | null;
    title: string | null;
    cover_storage_key: string | null;
    preview_storage_key: string | null;
    source_path: string;
  } | undefined;
}

/** On-disk paths for every photo a story link exposes — the "download all" zip. */
export function storyShareFiles(link: ResolvedShareLink): {
  id: string; title: string | null; folder_path: string; relative_path: string; kind: string; source_path: string;
}[] {
  const ctx = storyLinkContext(link);
  if (!ctx || ctx.libIds.length === 0) return [];
  const ids = [...storyShareReach(ctx).itemIds];
  if (ids.length === 0) return [];
  return db.prepare(`
    SELECT
      library_items.id,
      item_metadata.title,
      library_items.folder_path,
      gallery_details.relative_path,
      gallery_details.kind,
      libraries.source_path
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE library_items.id IN (${ids.map(() => "?").join(", ")})
      AND library_items.deleted_at IS NULL
      AND library_items.library_id IN (${ctx.libIds.map(() => "?").join(", ")})
  `).all(...ids, ...ctx.libIds) as {
    id: string; title: string | null; folder_path: string; relative_path: string; kind: string; source_path: string;
  }[];
}

// A guest sees no hrefs into the app — every link would 404 them at a sign-in
// screen. Blocks carry their content and token-scoped media URLs, nothing else.
function shareAssetView(asset: ShareAsset, token: string) {
  return {
    id: asset.id,
    title: asset.title,
    kind: asset.kind,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    coverUrl: `/api/share/${token}/items/${asset.id}/cover`,
    previewUrl: `/api/share/${token}/items/${asset.id}/preview`,
    fileUrl: `/api/share/${token}/items/${asset.id}/file`,
    downloadUrl: `/api/share/${token}/items/${asset.id}/download`
  };
}

/** The public page's payload: the story as it stands, for this link. */
export function buildStorySharePayload(link: ResolvedShareLink, token: string) {
  const ctx = storyLinkContext(link);
  if (!ctx) return null;

  const meta = db.prepare(`
    SELECT share_links.label, share_links.expires_at, users.display_name AS shared_by
    FROM share_links LEFT JOIN users ON users.id = share_links.created_by
    WHERE share_links.id = ?
  `).get(link.id) as { label: string | null; expires_at: string; shared_by: string | null };

  const { byBlock, heroByChapter, cover } = storyShareReach(ctx);
  const blocks = getBlocks(ctx.story.id);
  const byChapter = new Map<string, typeof blocks>();
  for (const block of blocks) {
    const list = byChapter.get(block.chapter_id) ?? [];
    list.push(block);
    byChapter.set(block.chapter_id, list);
  }

  let photoCount = 0;
  // The chapter id is a bare handle for the guest page's own navigation
  // (?chapter=…) — it links to nothing inside the app.
  const chapters = getChapters(ctx.story.id).map((chapter) => ({
    id: chapter.id,
    title: chapter.title,
    date: chapter.date,
    endDate: chapter.end_date,
    dateApprox: chapter.date_approx === 1,
    place: chapter.place,
    placeLat: chapter.place_lat,
    placeLng: chapter.place_lng,
    standfirst: chapter.standfirst,
    description: chapter.description,
    hero: (() => {
      const asset = heroByChapter.get(chapter.id);
      return asset ? shareAssetView(asset, token) : null;
    })(),
    blocks: (byChapter.get(chapter.id) ?? [])
      .map((block) => {
        const assets = byBlock.get(block.id) ?? [];
        photoCount += assets.length;
        return storyShareBlock(block, assets, token, ctx);
      })
      .filter((block): block is NonNullable<typeof block> => block !== null)
  }));

  return {
    payload: {
      type: "story" as const,
      share: { label: meta.label, expiresAt: meta.expires_at, sharedBy: meta.shared_by },
      story: {
        title: ctx.story.title,
        subtitle: ctx.story.subtitle,
        chapterNoun: ctx.story.chapter_noun,
        intro: ctx.story.intro,
        rating: ctx.story.rating,
        cover: cover ? shareAssetView(cover, token) : null,
        expandAlbums: ctx.expandAlbums,
        chapters
      }
    },
    title: ctx.story.title,
    photoCount
  };
}

function storyShareBlock(block: BlockRow, assets: ShareAsset[], token: string, ctx: StoryLinkContext) {
  if (block.kind === "text") {
    return { kind: "text" as const, body: block.body ?? "" };
  }

  if (block.kind === "map") {
    if (block.lat == null || block.lng == null) return null;
    return {
      kind: "map" as const,
      lat: block.lat,
      lng: block.lng,
      zoom: block.zoom,
      label: block.label,
      caption: block.caption
    };
  }

  if (block.kind === "media") {
    // A photo the creator can no longer reach simply drops out — the story keeps
    // its shape, and the guest is never shown a broken frame.
    if (assets.length === 0) return null;
    return {
      kind: "media" as const,
      caption: block.caption,
      layout: block.layout,
      asset: shareAssetView(assets[0], token)
    };
  }

  if (block.kind === "album" || block.kind === "slideshow") {
    if (assets.length === 0) return null;
    const total = block.kind === "album"
      ? albumVisibleCount(block.entity_id!, ctx)
      : slideshowVisibleCount(block.entity_id!, ctx);
    return {
      kind: block.kind,
      title: setName(block.kind, block.entity_id!),
      caption: block.caption,
      itemCount: total,
      // What the guest may actually open. With expandAlbums off this is the
      // inline strip, which is the whole point of the option.
      items: assets.map((asset) => shareAssetView(asset, token))
    };
  }

  if (block.kind === "person") {
    const person = db.prepare(
      "SELECT name, birth_date, death_date FROM family_tree_persons WHERE id = ?"
    ).get(block.entity_id ?? "") as { name: string; birth_date: string | null; death_date: string | null } | undefined;
    if (!person) return null;
    return {
      kind: "person" as const,
      name: person.name,
      birthDate: person.birth_date,
      deathDate: person.death_date,
      caption: block.caption
    };
  }

  // Narration travels with a shared story: it was recorded for this story, and
  // a story read without the voice is a different thing. Gallery-backed
  // recordings (v2) stream through the token item routes; legacy story-owned
  // clips keep their dedicated audio route until the one-time import runs.
  if (block.kind === "audio") {
    if (block.entity_type === "gallery") {
      if (assets.length === 0) return null;
      const clip = assets[0];
      return {
        kind: "audio" as const,
        title: clip.title,
        durationSeconds: clip.durationSeconds,
        url: `/api/share/${token}/items/${clip.id}/file`,
        caption: block.caption
      };
    }
    const clip = block.entity_id ? getStoryAudio(block.entity_id) : undefined;
    if (!clip || clip.story_id !== ctx.story.id) return null;
    return {
      kind: "audio" as const,
      title: clip.title,
      durationSeconds: clip.duration_seconds,
      url: `/api/share/${token}/audio/${clip.id}`,
      caption: block.caption
    };
  }

  // A book card for a guest is text only: title and author, no cover (there is
  // no token-scoped route for book covers) and no in-app link (a guest has no
  // account to open it with). Resolved against the CREATOR's current library
  // access through the same hydrator the reading view uses.
  if (block.kind === "book") {
    if (!block.entity_type || !block.entity_id) return null;
    const view = hydrateEntities([{ entityType: block.entity_type, entityId: block.entity_id }], ctx.creator)
      .get(`${block.entity_type}:${block.entity_id}`);
    if (!view?.available) return null;
    return {
      kind: "book" as const,
      title: view.title,
      author: view.subtitle ?? null,
      bookType: block.entity_type,
      caption: block.caption
    };
  }

  if (block.kind === "quote") {
    const quote = db.prepare(`
      SELECT quotes.text, quotes.source_title, quotes.person_name,
             speaker.name AS live_person_name
      FROM quotes
      LEFT JOIN family_tree_persons AS speaker ON speaker.id = quotes.family_tree_person_id
      WHERE quotes.id = ?
    `).get(block.entity_id ?? "") as {
      text: string; source_title: string | null; person_name: string | null; live_person_name: string | null;
    } | undefined;
    if (!quote) return null;
    return {
      kind: "quote" as const,
      text: quote.text,
      attribution: quote.live_person_name ?? quote.person_name ?? quote.source_title,
      caption: block.caption
    };
  }

  return null;
}

function setName(kind: "album" | "slideshow", id: string): string | null {
  const table = kind === "album" ? "gallery_albums" : "gallery_slideshows";
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id) as { name: string } | undefined;
  return row?.name ?? null;
}

function albumVisibleCount(albumId: string, ctx: StoryLinkContext): number {
  const album = getAlbum(albumId);
  return album ? getAlbumItems(ctx.creatorId, ctx.libIds, album, 1, 0).total : 0;
}

function slideshowVisibleCount(slideshowId: string, ctx: StoryLinkContext): number {
  const slideshow = getSlideshow(slideshowId);
  return slideshow ? getSlideshowItems(ctx.creatorId, ctx.libIds, slideshow, 1, 0).total : 0;
}

/** A shared story's title, for naming its zip and its activity entries. */
export function storyShareTitle(storyId: string): string | null {
  return getStory(storyId)?.title ?? null;
}

/** Absolute path for a shared file, or null when it isn't really there. */
export function storyShareFilePath(file: { source_path: string; relative_path: string }): string | null {
  const filePath = path.join(file.source_path, ...file.relative_path.split("/"));
  return fs.existsSync(filePath) ? filePath : null;
}
