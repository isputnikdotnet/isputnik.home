// Who may see a file in App files — docs/system-data-plan.md, phase 4 (decisions
// 22-24).
//
// App files holds what the app keeps for what the family makes: story recordings,
// voice notes, family-tree uploads, slideshow movies and music. It has no access
// rules of its own. Admins see all of it; anyone else sees a file because they can
// see something that owns it:
//
//   a story's block, chapter hero or cover    whoever can see the story
//   a story collection's cover                whoever can see the collection
//   a voice note's audio                      whoever can see the photo, and who recorded it
//   a slideshow's member, cover, cards, clip  whoever can see the slideshow
//     or saved movie
//   uploaded music                            every signed-in member (the music picker's audience)
//   a family-tree photo, event photo or       every signed-in member (the family tree has
//     portrait                                no read scoping)
//
// A file owned by several things is visible through any of them; a file owned by
// nothing (an orphan, or something put there by hand) is for admins only.
//
// The rule is one SQL subquery, so a query that hydrates items asks it inline
// rather than item by item. The library-level override (system-library-access.ts)
// takes App files out of every non-admin library scope, so a query that does not
// ask shows none of it: the safe default. The surfaces whose owners are checked
// first (stories, slideshows, albums, the family tree, the viewer) ask through
// `galleryScopeSql`, which reads the rule attached to a scope list by
// `withAppFileOwners` — `resolveGalleryScopeLibraryIds` attaches it for every
// non-admin reachable scope.
import { db } from "../../../db.js";
import { resolveObjectRole, type AuthUser } from "../../../core/permissions.js";
import { canManageCollection, visibleCollectionIds } from "../../stories/collection-access.js";
import { systemLibraryId } from "./system-libraries.js";
import type { LibraryRow } from "../../../db/rows.js";

type User = Pick<AuthUser, "id" | "role">;

interface AppFilesRule {
  libraryId: string;
  /** Parameters for VISIBLE_APP_FILES_SQL, in order. */
  params: unknown[];
}

// The user a scope list was resolved for; the rule itself is worked out the first
// time a query asks, since most scope lists (every browse) never do.
const scopeUsers = new WeakMap<readonly string[], { user: User; libraryId: string; rule?: AppFilesRule }>();

// The ids of App files items a user may see. Parameters (in order): user id,
// managed collection ids (JSON), user id, visible collection ids (JSON), user id,
// the user's other gallery libraries (JSON), user id, the same libraries (JSON),
// visible collection ids (JSON).
const VISIBLE_APP_FILES_SQL = `
  WITH
    af_stories AS (
      SELECT s.id, s.cover_item_id FROM stories s
      WHERE s.deleted_at IS NULL
        AND (s.status = 'published' OR s.created_by = ? OR s.collection_id IN (SELECT value FROM json_each(?)))
        AND (s.collection_id IS NULL OR s.created_by = ? OR s.collection_id IN (SELECT value FROM json_each(?)))
    ),
    af_slideshows AS (
      SELECT g.* FROM gallery_slideshows g
      WHERE g.created_by = ?
        OR EXISTS (
          SELECT 1 FROM gallery_slideshow_items si
          JOIN library_items lsi ON lsi.id = si.item_id AND lsi.deleted_at IS NULL
          WHERE si.slideshow_id = g.id AND lsi.library_id IN (SELECT value FROM json_each(?))
        )
    )
  SELECT item_id FROM family_tree_photos
  UNION SELECT item_id FROM family_tree_event_photos
  UNION SELECT portrait_item_id FROM family_tree_persons WHERE portrait_item_id IS NOT NULL
  UNION SELECT item_id FROM gallery_music_tracks WHERE item_id IS NOT NULL
  UNION SELECT v.audio_item_id FROM gallery_voice_notes v
    JOIN library_items photo ON photo.id = v.item_id AND photo.deleted_at IS NULL
    WHERE v.recorded_by = ? OR photo.library_id IN (SELECT value FROM json_each(?))
  UNION SELECT b.entity_id FROM story_blocks b
    JOIN story_chapters c ON c.id = b.chapter_id
    JOIN af_stories s ON s.id = c.story_id
    WHERE b.entity_type = 'gallery' AND b.entity_id IS NOT NULL
  -- A photo group's members are owned by their story exactly as a single photo
  -- block's is; they just live in story_block_items.
  UNION SELECT bi.item_id FROM story_block_items bi
    JOIN story_blocks b ON b.id = bi.block_id
    JOIN story_chapters c ON c.id = b.chapter_id
    JOIN af_stories s ON s.id = c.story_id
  UNION SELECT c.hero_item_id FROM story_chapters c JOIN af_stories s ON s.id = c.story_id WHERE c.hero_item_id IS NOT NULL
  UNION SELECT cover_item_id FROM af_stories WHERE cover_item_id IS NOT NULL
  UNION SELECT cover_item_id FROM story_collections
    WHERE cover_item_id IS NOT NULL AND id IN (SELECT value FROM json_each(?))
  UNION SELECT movie_item_id FROM af_slideshows WHERE movie_item_id IS NOT NULL
  UNION SELECT cover_item_id FROM af_slideshows WHERE cover_item_id IS NOT NULL
  UNION SELECT title_photo_item_id FROM af_slideshows WHERE title_photo_item_id IS NOT NULL
  UNION SELECT closing_photo_item_id FROM af_slideshows WHERE closing_photo_item_id IS NOT NULL
  UNION SELECT outro_item_id FROM af_slideshows WHERE outro_item_id IS NOT NULL
  UNION SELECT si.item_id FROM gallery_slideshow_items si JOIN af_slideshows g ON g.id = si.slideshow_id`;

// Every App files item that SOMETHING owns, whoever may see it: the same owners as
// the rule above without the viewer's filters. What it leaves out is what only
// admins can ever see. Owners are found by reference, never by folder: a photo
// uploaded while writing a story lands in a dated folder, and belongs to the story.
const OWNED_APP_FILES_SQL = `
  SELECT item_id FROM family_tree_photos
  UNION SELECT item_id FROM family_tree_event_photos
  UNION SELECT portrait_item_id FROM family_tree_persons WHERE portrait_item_id IS NOT NULL
  UNION SELECT item_id FROM gallery_music_tracks WHERE item_id IS NOT NULL
  UNION SELECT v.audio_item_id FROM gallery_voice_notes v
    JOIN library_items photo ON photo.id = v.item_id AND photo.deleted_at IS NULL
  UNION SELECT b.entity_id FROM story_blocks b
    JOIN story_chapters c ON c.id = b.chapter_id
    JOIN stories s ON s.id = c.story_id AND s.deleted_at IS NULL
    WHERE b.entity_type = 'gallery' AND b.entity_id IS NOT NULL
  UNION SELECT bi.item_id FROM story_block_items bi
    JOIN story_blocks b ON b.id = bi.block_id
    JOIN story_chapters c ON c.id = b.chapter_id
    JOIN stories s ON s.id = c.story_id AND s.deleted_at IS NULL
  UNION SELECT c.hero_item_id FROM story_chapters c
    JOIN stories s ON s.id = c.story_id AND s.deleted_at IS NULL
    WHERE c.hero_item_id IS NOT NULL
  UNION SELECT cover_item_id FROM stories WHERE deleted_at IS NULL AND cover_item_id IS NOT NULL
  UNION SELECT cover_item_id FROM story_collections WHERE cover_item_id IS NOT NULL
  UNION SELECT movie_item_id FROM gallery_slideshows WHERE movie_item_id IS NOT NULL
  UNION SELECT cover_item_id FROM gallery_slideshows WHERE cover_item_id IS NOT NULL
  UNION SELECT title_photo_item_id FROM gallery_slideshows WHERE title_photo_item_id IS NOT NULL
  UNION SELECT closing_photo_item_id FROM gallery_slideshows WHERE closing_photo_item_id IS NOT NULL
  UNION SELECT outro_item_id FROM gallery_slideshows WHERE outro_item_id IS NOT NULL
  UNION SELECT item_id FROM gallery_slideshow_items`;

/** App files items nothing owns, so only admins see them (decision 22). */
export function unownedAppFileCount(libraryId: string | null): number {
  if (!libraryId) return 0;
  return (db.prepare(`
    SELECT COUNT(*) AS n FROM library_items
    WHERE library_id = ? AND deleted_at IS NULL AND id NOT IN (${OWNED_APP_FILES_SQL})
  `).get(libraryId) as { n: number }).n;
}

export function appFilesLibraryId(): string | null {
  return systemLibraryId("app-files");
}

function ruleFor(user: User, libraryId: string): AppFilesRule {
  const collections = visibleCollectionIds(user);
  const visible = collections ?? (db.prepare("SELECT id FROM story_collections").all() as { id: string }[]).map((row) => row.id);
  const managed = visible.filter((id) => canManageCollection(user, id));
  // The user's other gallery libraries: what a voice note's photo, or a slideshow's
  // ordinary members, must sit in. Resolved through core so the Inbox's reviewers
  // count, without this module depending on library-access (which depends on it).
  const others = (db.prepare("SELECT id FROM libraries WHERE type = 'gallery' AND id != ?").all(libraryId) as Pick<LibraryRow, "id">[])
    .map((row) => row.id)
    .filter((id) => resolveObjectRole("library", id, user as AuthUser) !== null);
  const libs = JSON.stringify(others);
  const visibleJson = JSON.stringify(visible);
  return {
    libraryId,
    params: [user.id, JSON.stringify(managed), user.id, visibleJson, user.id, libs, user.id, libs, visibleJson]
  };
}

/** Attach the App files rule for `user` to a scope list, so `galleryScopeSql` lets
 *  through the App files items they may see. A no-op for admins (App files is
 *  already in their scope) and when there is no App files library. Returns the
 *  same array. Copies (filter, map, spread) do not carry the rule: they fall back
 *  to showing no App files items, never to showing all. */
export function withAppFileOwners<T extends string[]>(user: User, libIds: T): T {
  if (user.role === "admin") return libIds;
  const libraryId = appFilesLibraryId();
  if (!libraryId || libIds.includes(libraryId)) return libIds;
  scopeUsers.set(libIds, { user, libraryId });
  return libIds;
}

/** A WHERE fragment for "this row's item is in the scope": in one of its libraries,
 *  or an App files item the scope's user may see. `alias` names the library_items
 *  table in the query. Place the params where the fragment goes. */
export function galleryScopeSql(libIds: readonly string[], alias = "library_items"): { sql: string; params: unknown[] } {
  const entry = scopeUsers.get(libIds);
  if (entry && !entry.rule) entry.rule = ruleFor(entry.user, entry.libraryId);
  const rule = entry?.rule;
  const inScope = `${alias}.library_id IN (SELECT value FROM json_each(?))`;
  if (!rule) return { sql: inScope, params: [JSON.stringify(libIds)] };
  return {
    sql: `(${inScope} OR (${alias}.library_id = ? AND ${alias}.id IN (${VISIBLE_APP_FILES_SQL})))`,
    params: [JSON.stringify(libIds), rule.libraryId, ...rule.params]
  };
}

/** One App files item, checked for `user`: admins yes; anyone else through its owners. */
export function canSeeAppFile(user: User, itemId: string): boolean {
  if (user.role === "admin") return true;
  const libraryId = appFilesLibraryId();
  if (!libraryId) return false;
  const row = db.prepare("SELECT library_id FROM library_items WHERE id = ? AND deleted_at IS NULL").get(itemId) as { library_id: string } | undefined;
  if (row?.library_id !== libraryId) return false;
  const rule = ruleFor(user, libraryId);
  return db.prepare(`SELECT 1 AS ok WHERE ? IN (${VISIBLE_APP_FILES_SQL})`).get(itemId, ...rule.params) != null;
}

/** `libIds` plus App files, for a query over items an owner the viewer can see
 *  already holds: a visible story's cover and blocks, a family member's photos.
 *  A new array; the caller has done the owner check. */
export function withAppFilesLibrary(libIds: readonly string[]): string[] {
  const libraryId = appFilesLibraryId();
  return libraryId && !libIds.includes(libraryId) ? [...libIds, libraryId] : [...libIds];
}

/** The App files item a thumbnail belongs to (its cover or its preview), for the
 *  covers route, which is addressed by storage key rather than by item. */
export function appFileItemForThumbnail(storageKey: string): string | null {
  const libraryId = appFilesLibraryId();
  if (!libraryId) return null;
  const row = db.prepare(`
    SELECT li.id FROM library_items li
    LEFT JOIN item_metadata m ON m.item_id = li.id
    LEFT JOIN gallery_details g ON g.item_id = li.id
    WHERE li.library_id = ? AND li.deleted_at IS NULL
      AND (m.cover_storage_key = ? OR g.preview_storage_key = ?)
    LIMIT 1
  `).get(libraryId, storageKey, storageKey) as { id: string } | undefined;
  return row?.id ?? null;
}

export function isAppFilesLibrary(libraryId: string | null | undefined): boolean {
  return Boolean(libraryId) && libraryId === appFilesLibraryId();
}
