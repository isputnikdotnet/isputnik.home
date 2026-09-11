// Who may see and edit a story, and the story a chapter or block belongs to —
// every chapter/block write authorizes through these.
import { db } from "../../db.js";
import { canManageCollection, canViewCollection } from "./collection-access.js";
import type { StoryRow } from "./stories.js";

export function getStory(storyId: string): StoryRow | undefined {
  return db.prepare("SELECT * FROM stories WHERE id = ?").get(storyId) as StoryRow | undefined;
}

export function canEditStory(
  story: Pick<StoryRow, "created_by" | "collection_id" | "deleted_at">,
  user: { id: string; role: string }
): boolean {
  // A story in the Recycle Bin is not edited, it is restored — from the bin.
  if (story.deleted_at) return false;
  if (user.role === "admin" || story.created_by === user.id) return true;
  // A collection manager edits every story on their shelf.
  return story.collection_id != null && canManageCollection(user, story.collection_id);
}

/** A draft is visible only to the people who could edit it — and a story in a
 *  restricted collection only to that collection's members. The author always
 *  sees their own story, or an access change could take their writing away.
 *  A story in the Recycle Bin is visible to nobody here — it exists only on
 *  the bin's own page until restored. */
export function canViewStory(story: StoryRow, user: { id: string; role: string }): boolean {
  if (story.deleted_at) return false;
  const base = story.status === "published" || canEditStory(story, user);
  if (!base) return false;
  if (story.collection_id == null || story.created_by === user.id || user.role === "admin") return true;
  return canViewCollection(user, story.collection_id);
}

/** The story a chapter belongs to — every chapter/block write authorizes through this. */
export function storyOfChapter(chapterId: string): StoryRow | undefined {
  return db.prepare(`
    SELECT stories.* FROM stories
    JOIN story_chapters ON story_chapters.story_id = stories.id
    WHERE story_chapters.id = ?
  `).get(chapterId) as StoryRow | undefined;
}

export function storyOfBlock(blockId: string): StoryRow | undefined {
  return db.prepare(`
    SELECT stories.* FROM stories
    JOIN story_chapters ON story_chapters.story_id = stories.id
    JOIN story_blocks ON story_blocks.chapter_id = story_chapters.id
    WHERE story_blocks.id = ?
  `).get(blockId) as StoryRow | undefined;
}
