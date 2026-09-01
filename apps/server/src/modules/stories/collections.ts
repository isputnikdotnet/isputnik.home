// Story collections: the shelf above stories ("Family Story", "Trips").
// Deliberately LIGHT — title, cover, description, access, member stories; the
// collection page derives its year-spine timeline from the stories' own
// chapter dates, so nothing is ever entered twice. Access lives in
// collection-access.ts; visibility of the stories INSIDE a collection is
// enforced in listStories/canViewStory, not here.
import { nanoid } from "nanoid";
import { db } from "../../db.js";
import {
  canContributeToCollection,
  canManageCollection,
  deleteCollectionAccess,
  seedCollectionAccess,
  visibleCollectionIds
} from "./collection-access.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

export interface CollectionRow {
  id: string;
  title: string;
  description: string | null;
  cover_item_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function getCollection(collectionId: string): CollectionRow | undefined {
  return db.prepare("SELECT * FROM story_collections WHERE id = ?").get(collectionId) as CollectionRow | undefined;
}

export function createCollection(user: { id: string }, title: string, description: string | null): CollectionRow {
  const id = nanoid(16);
  db.transaction(() => {
    db.prepare("INSERT INTO story_collections (id, title, description, created_by) VALUES (?, ?, ?, ?)")
      .run(id, title, description, user.id);
    seedCollectionAccess(id, user.id);
  })();
  return getCollection(id)!;
}

export function updateCollection(
  collectionId: string,
  fields: { title?: string; description?: string | null; coverItemId?: string | null }
): void {
  db.prepare(`
    UPDATE story_collections SET
      title         = COALESCE(?, title),
      description   = CASE WHEN ? THEN ? ELSE description END,
      cover_item_id = CASE WHEN ? THEN ? ELSE cover_item_id END,
      updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    fields.title ?? null,
    fields.description !== undefined ? 1 : 0,
    fields.description ?? null,
    fields.coverItemId !== undefined ? 1 : 0,
    fields.coverItemId ?? null,
    collectionId
  );
}

/** Delete the shelf, never the stories: `stories.collection_id` is ON DELETE
 *  SET NULL, so its members become standalone (today's album rules). The
 *  assignments rows have no FK and are cleaned here. */
export function deleteCollection(collectionId: string): boolean {
  let removed = false;
  db.transaction(() => {
    removed = db.prepare("DELETE FROM story_collections WHERE id = ?").run(collectionId).changes > 0;
    if (removed) deleteCollectionAccess(collectionId);
  })();
  return removed;
}

interface CollectionListRow extends CollectionRow {
  story_count: number;
  first_date: string | null;
  last_date: string | null;
  cover_key: string | null;
}

/** The collections this viewer may see, as shelf cards: derived date span and
 *  story count (their visible stories: published plus their own drafts), and
 *  a cover — the chosen one, else the first member story's own card cover. */
export function listCollections(user: { id: string; role: string }, libIds: string[]) {
  const visible = visibleCollectionIds(user);
  if (visible !== null && visible.length === 0) return [];
  const libArgs = libIds.length > 0 ? libIds : [""];
  const libIn = inClause(libArgs.length);
  // A story counts toward its collection's card by the same rule it lists:
  // published, or the viewer's own, or the viewer is an admin.
  const storyVisible = "(stories.status = 'published' OR stories.created_by = ? OR ? = 'admin')";
  const rows = db.prepare(`
    SELECT
      story_collections.*,
      (SELECT COUNT(*) FROM stories
        WHERE stories.collection_id = story_collections.id AND ${storyVisible}) AS story_count,
      (SELECT MIN(story_chapters.date) FROM story_chapters
        JOIN stories ON stories.id = story_chapters.story_id
        WHERE stories.collection_id = story_collections.id AND story_chapters.date IS NOT NULL
          AND ${storyVisible}) AS first_date,
      (SELECT MAX(COALESCE(story_chapters.end_date, story_chapters.date)) FROM story_chapters
        JOIN stories ON stories.id = story_chapters.story_id
        WHERE stories.collection_id = story_collections.id AND story_chapters.date IS NOT NULL
          AND ${storyVisible}) AS last_date,
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = story_collections.cover_item_id
            AND library_items.deleted_at IS NULL AND library_items.library_id IN (${libIn})),
        (SELECT item_metadata.cover_storage_key FROM stories
          JOIN story_chapters ON story_chapters.story_id = stories.id
          JOIN story_blocks ON story_blocks.chapter_id = story_chapters.id
          JOIN library_items ON library_items.id = story_blocks.entity_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE stories.collection_id = story_collections.id AND ${storyVisible}
            AND story_blocks.entity_type = 'gallery' AND story_blocks.kind = 'media'
            AND library_items.library_id IN (${libIn})
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY story_chapters.position, story_blocks.position LIMIT 1)
      ) AS cover_key
    FROM story_collections
    ${visible === null ? "" : `WHERE story_collections.id IN (${inClause(visible.length)})`}
    ORDER BY story_collections.title COLLATE NOCASE
  `).all(
    // count · first_date · last_date, then the chosen cover's library bound,
    // then the fallback cover's visibility + library bound, then the id list.
    user.id, user.role, user.id, user.role, user.id, user.role,
    ...libArgs,
    user.id, user.role, ...libArgs,
    ...(visible ?? [])
  ) as CollectionListRow[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    storyCount: row.story_count,
    firstDate: row.first_date,
    lastDate: row.last_date,
    coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
    canContribute: canContributeToCollection(user, row.id),
    canManage: canManageCollection(user, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}
