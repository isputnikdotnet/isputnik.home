import { nanoid } from "nanoid";
import { db } from "../../db.js";
import type { ChapterRow } from "./stories.js";
import type { StoryRow } from "../../db/rows.js";

export function touchStory(storyId: string): void {
  db.prepare("UPDATE stories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(storyId);
}

export function getChapters(storyId: string): ChapterRow[] {
  return db.prepare(
    "SELECT * FROM story_chapters WHERE story_id = ? ORDER BY position ASC"
  ).all(storyId) as ChapterRow[];
}

export function getChapter(chapterId: string): ChapterRow | undefined {
  return db.prepare("SELECT * FROM story_chapters WHERE id = ?").get(chapterId) as ChapterRow | undefined;
}

export interface ChapterFields {
  title?: string | null;
  date?: string | null;
  endDate?: string | null;
  dateApprox?: boolean;
  place?: string | null;
  placeLat?: number | null;
  placeLng?: number | null;
  description?: string | null;
  standfirst?: string | null;
  heroItemId?: string | null;
  heroMap?: boolean;
}

export function nextPosition(table: "story_chapters" | "story_blocks", column: "story_id" | "chapter_id", parentId: string): number {
  return (db.prepare(
    `SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM ${table} WHERE ${column} = ?`
  ).get(parentId) as { pos: number }).pos;
}

export function createChapter(storyId: string, fields: ChapterFields, actorId?: string): ChapterRow {
  const id = nanoid(16);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO story_chapters
        (id, story_id, position, title, date, end_date, date_approx, place, place_lat, place_lng, description, standfirst, hero_item_id, hero_map)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      storyId,
      nextPosition("story_chapters", "story_id", storyId),
      fields.title ?? null,
      fields.date ?? null,
      fields.endDate ?? null,
      fields.dateApprox ? 1 : 0,
      fields.place ?? null,
      fields.placeLat ?? null,
      fields.placeLng ?? null,
      fields.description ?? null,
      fields.standfirst ?? null,
      fields.heroItemId ?? null,
      fields.heroMap ? 1 : 0
    );
    // A chapter added to a story the house has already been shown is news to
    // the house; one added while drafting is not — the publish is. Recorded
    // here so every way of adding a chapter counts, whoever adds it.
    const status = db.prepare("SELECT status FROM stories WHERE id = ?").get(storyId) as Pick<StoryRow, "status"> | undefined;
    if (status?.status === "published") {
      db.prepare("INSERT INTO story_updates (id, story_id, chapter_id, actor_id) VALUES (?, ?, ?, ?)")
        .run(nanoid(16), storyId, id, actorId ?? null);
    }
    touchStory(storyId);
  })();
  return getChapter(id)!;
}

export function updateChapter(chapterId: string, storyId: string, fields: ChapterFields): void {
  const set = (key: keyof ChapterFields) => (fields[key] !== undefined ? 1 : 0);
  db.transaction(() => {
    db.prepare(`
      UPDATE story_chapters SET
        title       = CASE WHEN ? THEN ? ELSE title END,
        date        = CASE WHEN ? THEN ? ELSE date END,
        end_date    = CASE WHEN ? THEN ? ELSE end_date END,
        date_approx = COALESCE(?, date_approx),
        place       = CASE WHEN ? THEN ? ELSE place END,
        place_lat   = CASE WHEN ? THEN ? ELSE place_lat END,
        place_lng   = CASE WHEN ? THEN ? ELSE place_lng END,
        description = CASE WHEN ? THEN ? ELSE description END,
        standfirst  = CASE WHEN ? THEN ? ELSE standfirst END,
        hero_item_id = CASE WHEN ? THEN ? ELSE hero_item_id END,
        hero_map    = COALESCE(?, hero_map)
      WHERE id = ?
    `).run(
      set("title"), fields.title ?? null,
      set("date"), fields.date ?? null,
      set("endDate"), fields.endDate ?? null,
      fields.dateApprox === undefined ? null : fields.dateApprox ? 1 : 0,
      set("place"), fields.place ?? null,
      set("placeLat"), fields.placeLat ?? null,
      set("placeLng"), fields.placeLng ?? null,
      set("description"), fields.description ?? null,
      set("standfirst"), fields.standfirst ?? null,
      set("heroItemId"), fields.heroItemId ?? null,
      fields.heroMap === undefined ? null : fields.heroMap ? 1 : 0,
      chapterId
    );
    touchStory(storyId);
  })();
}

/** Delete a chapter and its blocks. The last chapter can't go — a story always
 *  has one (see createStory); the route turns that into a 400. */
export function deleteChapter(chapterId: string, storyId: string): boolean {
  const remaining = (db.prepare(
    "SELECT COUNT(*) AS n FROM story_chapters WHERE story_id = ?"
  ).get(storyId) as { n: number }).n;
  if (remaining <= 1) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM story_chapters WHERE id = ?").run(chapterId);
    touchStory(storyId);
  })();
  return true;
}

export function reorderChapters(storyId: string, orderedIds: string[]): void {
  const owned = new Set(getChapters(storyId).map((row) => row.id));
  const setPosition = db.prepare("UPDATE story_chapters SET position = ? WHERE id = ? AND story_id = ?");
  db.transaction(() => {
    let pos = 1;
    for (const id of orderedIds) {
      if (owned.has(id)) setPosition.run(pos++, id, storyId);
    }
    touchStory(storyId);
  })();
}
