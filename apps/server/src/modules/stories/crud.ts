import { nanoid } from "nanoid";
import { db } from "../../db.js";
import { deleteEntityTags } from "../library/shared/tagging.js";
import { deleteSharesForResource } from "../library/shared/share-access.js";
import { getTrashRetentionDays } from "../library/shared/trash-settings.js";
import { deleteStoryAudioFiles } from "./audio.js";
import { getStory } from "./access.js";
import { RECIPE_CHAPTERS, STORY_ENTITY_TYPE, type StoryKind, type StoryRow, type StoryStatus } from "./stories.js";
import type { StoryRow as DbStoryRow, UserRow } from "../../db/rows.js";

// Every story owns at least one chapter, so the reader, the editor and (later)
// the player only ever handle one shape. A story that needs no structure just
// leaves its single chapter untitled and undated, and the UI hides the chapter
// chrome — "flat journal page" and "chaptered documentary" are the same rows.
/** How many chapters a journal's date range may seed — a month of days. A
 *  longer trip gets the range on chapter one and adds days by hand. */
export const MAX_SEEDED_DAYS = 31;

const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createStory(
  user: { id: string },
  title: string,
  subtitle: string | null,
  collectionId: string | null = null,
  opts: {
    kind?: StoryKind;
    /** review kind, started from a book page or the picker: the card to seed. */
    reviewOf?: { entityType: string; entityId: string } | null;
    /** Seeds the first chapter's date (any kind); with endDate on a journal,
     *  seeds one chapter per day when both are full dates. Partial dates
     *  ("2004", "2004-07") land as-is on chapter one. */
    date?: string | null;
    endDate?: string | null;
    place?: string | null;
    /** Recipe kind: the head facts, and (from a link) the text to seed the
     *  Ingredients / Method / Notes chapters with instead of empty blocks. */
    servings?: string | null;
    cookMinutes?: number | null;
    recipe?: RecipeSeed | null;
  } = {}
): StoryRow {
  const id = nanoid(16);
  const kind = opts.kind ?? "free";
  // The kind's whole template power, exercised once at creation: a travel
  // journal counts its days, a review opens on the book it judges. From here
  // on the story is just a story — everything seeded is an ordinary field.
  const chapterNoun = kind === "journal" ? "Day" : null;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO stories (id, title, subtitle, created_by, collection_id, kind, chapter_noun, servings, cook_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, subtitle, user.id, collectionId, kind, chapterNoun, opts.servings ?? null, opts.cookMinutes ?? null);
    const chapterId = nanoid(16);
    db.prepare("INSERT INTO story_chapters (id, story_id, position) VALUES (?, ?, 1)")
      .run(chapterId, id);

    // A journal with a full from–to range opens with its days already laid
    // out: Day 1 … Day N, each dated — the Polarsteps shape, built in one go.
    let seededDays = false;
    if (kind === "journal" && opts.date && opts.endDate
      && FULL_DATE.test(opts.date) && FULL_DATE.test(opts.endDate)) {
      const start = Date.parse(`${opts.date}T00:00:00Z`);
      const end = Date.parse(`${opts.endDate}T00:00:00Z`);
      const days = Math.round((end - start) / 86_400_000) + 1;
      if (days >= 2 && days <= MAX_SEEDED_DAYS) {
        db.prepare("UPDATE story_chapters SET date = ? WHERE id = ?").run(opts.date, chapterId);
        const insert = db.prepare("INSERT INTO story_chapters (id, story_id, position, date) VALUES (?, ?, ?, ?)");
        for (let day = 1; day < days; day += 1) {
          insert.run(nanoid(16), id, day + 1, new Date(start + day * 86_400_000).toISOString().slice(0, 10));
        }
        seededDays = true;
      }
    }
    if (!seededDays && (opts.date || opts.place)) {
      db.prepare("UPDATE story_chapters SET date = ?, end_date = ?, place = ? WHERE id = ?")
        .run(opts.date ?? null, opts.endDate ?? null, opts.place ?? null, chapterId);
    }

    if (kind === "review" && opts.reviewOf) {
      db.prepare(`
        INSERT INTO story_blocks (id, chapter_id, position, kind, entity_type, entity_id)
        VALUES (?, ?, 1, 'book', ?, ?)
      `).run(nanoid(16), chapterId, opts.reviewOf.entityType, opts.reviewOf.entityId);
    }

    // A recipe opens as Ingredients / Method / Notes, each with an empty
    // paragraph waiting, so the editor lands on a shape instead of a blank.
    // Chapter one (already made, carrying the date/place) becomes the first
    // of them; the rest are appended after it. Imported from a link, the
    // same three chapters open already written: the ingredients as one list,
    // one paragraph per step, and the source linked from Notes.
    if (kind === "recipe") {
      const setTitle = db.prepare("UPDATE story_chapters SET title = ? WHERE id = ?");
      const insertChapter = db.prepare("INSERT INTO story_chapters (id, story_id, position, title) VALUES (?, ?, ?, ?)");
      const insertText = db.prepare("INSERT INTO story_blocks (id, chapter_id, position, kind, body) VALUES (?, ?, ?, 'text', ?)");
      const bodies = recipeChapterBodies(opts.recipe ?? null);
      RECIPE_CHAPTERS.forEach((title, index) => {
        let target = chapterId;
        if (index === 0) {
          setTitle.run(title, chapterId);
        } else {
          target = nanoid(16);
          insertChapter.run(target, id, index + 1, title);
        }
        bodies[index].forEach((body, position) => insertText.run(nanoid(16), target, position + 1, body));
      });
    }
  })();
  return getStory(id)!;
}

/** What a link import hands createStory: already-clean text, nothing else. */
export interface RecipeSeed {
  ingredients: string[];
  steps: string[];
  sourceUrl: string | null;
}

/** The text blocks each seeded recipe chapter opens with, in chapter order
 *  (Ingredients / Method / Notes). No seed = one empty paragraph each. */
function recipeChapterBodies(seed: RecipeSeed | null): string[][] {
  if (!seed) return RECIPE_CHAPTERS.map(() => [""]);
  const ingredients = seed.ingredients.map((line) => `- ${line}`).join("\n");
  const steps = seed.steps.length > 0 ? seed.steps : [""];
  let notes = "";
  if (seed.sourceUrl) {
    let host = seed.sourceUrl;
    try { host = new URL(seed.sourceUrl).hostname.replace(/^www\./, ""); } catch { /* keep the raw text */ }
    notes = `Source: [${host}](${seed.sourceUrl})`;
  }
  return [[ingredients], steps, [notes]];
}

export interface StoryUpdate {
  title?: string;
  subtitle?: string | null;
  status?: StoryStatus;
  coverItemId?: string | null;
  chapterNoun?: string | null;
  intro?: string | null;
  rating?: number | null;
  servings?: string | null;
  cookMinutes?: number | null;
  authorName?: string | null;
  collectionId?: string | null;
}

export function updateStory(storyId: string, fields: StoryUpdate): void {
  db.prepare(`
    UPDATE stories SET
      title         = COALESCE(?, title),
      subtitle      = CASE WHEN ? THEN ? ELSE subtitle END,
      status        = COALESCE(?, status),
      -- Stamped on the way from draft to published (the row's old status is
      -- what the CASE sees), cleared on the way back, untouched otherwise: a
      -- second PATCH saying 'published' does not make the story news again.
      published_at  = CASE
        WHEN ? = 'published' AND status != 'published' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHEN ? = 'draft' THEN NULL
        ELSE published_at END,
      cover_item_id = CASE WHEN ? THEN ? ELSE cover_item_id END,
      chapter_noun  = CASE WHEN ? THEN ? ELSE chapter_noun END,
      intro         = CASE WHEN ? THEN ? ELSE intro END,
      rating        = CASE WHEN ? THEN ? ELSE rating END,
      servings      = CASE WHEN ? THEN ? ELSE servings END,
      cook_minutes  = CASE WHEN ? THEN ? ELSE cook_minutes END,
      author_name   = CASE WHEN ? THEN ? ELSE author_name END,
      collection_id = CASE WHEN ? THEN ? ELSE collection_id END,
      updated_at    = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    fields.title ?? null,
    fields.subtitle !== undefined ? 1 : 0,
    fields.subtitle ?? null,
    fields.status ?? null,
    fields.status ?? null,
    fields.status ?? null,
    fields.coverItemId !== undefined ? 1 : 0,
    fields.coverItemId ?? null,
    fields.chapterNoun !== undefined ? 1 : 0,
    fields.chapterNoun ?? null,
    fields.intro !== undefined ? 1 : 0,
    fields.intro ?? null,
    fields.rating !== undefined ? 1 : 0,
    fields.rating ?? null,
    fields.servings !== undefined ? 1 : 0,
    fields.servings ?? null,
    fields.cookMinutes !== undefined ? 1 : 0,
    fields.cookMinutes ?? null,
    fields.authorName !== undefined ? 1 : 0,
    fields.authorName ?? null,
    fields.collectionId !== undefined ? 1 : 0,
    fields.collectionId ?? null,
    storyId
  );
}

/** Move a story to the Recycle Bin. Everything stays — chapters, blocks,
 *  tags, favorites, guest links — so a restore brings the story back exactly
 *  as it was; while it sits in the bin nothing serves it (canViewStory says
 *  no, and guest links resolve to nothing). The purge date is stamped from
 *  the bin's retention NOW, the same promise trashed_items makes: changing
 *  the setting later never re-times what is already in the bin. */
export function softDeleteStory(storyId: string): boolean {
  const retention = getTrashRetentionDays();
  return db.prepare(`
    UPDATE stories SET
      deleted_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      purge_after = ${retention > 0 ? "strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)" : "NULL"}
    WHERE id = ? AND deleted_at IS NULL
  `).run(...(retention > 0 ? [`+${retention} days`] : []), storyId).changes > 0;
}

/** Bring a story back from the Recycle Bin, exactly as it was. */
export function restoreStory(storyId: string): boolean {
  return db.prepare(
    "UPDATE stories SET deleted_at = NULL, purge_after = NULL WHERE id = ? AND deleted_at IS NOT NULL"
  ).run(storyId).changes > 0;
}

/** Permanent removal — the Recycle Bin's "delete forever" and the auto-purge. */
export function purgeStory(storyId: string): boolean {
  let removed = false;
  db.transaction(() => {
    // taggables is polymorphic with no FK, so the story's tags are dropped here
    // — the same contract every other taggable type follows. Guest links point
    // at the story the same way and go with it, or they'd linger as dead URLs.
    deleteEntityTags(STORY_ENTITY_TYPE, storyId);
    deleteSharesForResource(STORY_ENTITY_TYPE, storyId);
    // Narration rows cascade with the story; their FILES would not.
    deleteStoryAudioFiles(storyId);
    // Chapters cascade, and blocks cascade from chapters.
    removed = db.prepare("DELETE FROM stories WHERE id = ?").run(storyId).changes > 0;
  })();
  return removed;
}

/** stories.* plus the owning account's name. The bin shows it as who deleted the
 *  story: there is no deleted_by column, and only the owner (or an admin) can
 *  delete one — so the account is the right name here, not the byline. */
type DeletedStoryRow = StoryRow & {
  owner_name: UserRow["display_name"] | null;
  chapter_count: number;
  cover_key: string | null;
};

/** The bin's story rows, newest deletion first — the Recycle Bin page. The
 *  cover lookup is UNBOUNDED by library access on purpose: this feeds an
 *  admin-only route, and it's the same thumbnail the story's card showed. */
export function listDeletedStories() {
  const rows = db.prepare(`
    SELECT stories.*, users.display_name AS owner_name,
      (SELECT COUNT(*) FROM story_chapters WHERE story_chapters.story_id = stories.id) AS chapter_count,
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = stories.cover_item_id AND library_items.deleted_at IS NULL),
        (SELECT item_metadata.cover_storage_key FROM story_blocks
          JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
          JOIN library_items ON library_items.id = story_blocks.entity_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE story_chapters.story_id = stories.id
            AND story_blocks.entity_type = 'gallery' AND story_blocks.kind = 'media'
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY story_chapters.position, story_blocks.position LIMIT 1)
      ) AS cover_key
    FROM stories
    LEFT JOIN users ON users.id = stories.created_by
    WHERE stories.deleted_at IS NOT NULL
    ORDER BY stories.deleted_at DESC
  `).all() as DeletedStoryRow[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    kind: row.kind,
    chapterCount: row.chapter_count,
    // Named authorName on the wire for the bin page; it is the OWNER's name.
    authorName: row.owner_name,
    coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
    deletedAt: row.deleted_at,
    purgesAt: row.purge_after
  }));
}

/** Purge every binned story that has outlived its promised window. Run by the
 *  same scheduled job that purges expired trashed_items. */
export function purgeExpiredStories(): { purged: number } {
  const rows = db.prepare(
    "SELECT id FROM stories WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  ).all() as Pick<DbStoryRow, "id">[];
  for (const row of rows) purgeStory(row.id);
  return { purged: rows.length };
}

/** Mark or unmark a story as one of the user's favorites. Idempotent both
 *  ways — saving twice or unsaving a story never saved is fine. */
export function setStorySaved(storyId: string, userId: string, saved: boolean): void {
  if (saved) {
    db.prepare(
      "INSERT OR IGNORE INTO story_saves (story_id, user_id) VALUES (?, ?)"
    ).run(storyId, userId);
  } else {
    db.prepare("DELETE FROM story_saves WHERE story_id = ? AND user_id = ?").run(storyId, userId);
  }
}

export function isStorySaved(storyId: string, userId: string): boolean {
  return db.prepare(
    "SELECT 1 FROM story_saves WHERE story_id = ? AND user_id = ?"
  ).get(storyId, userId) !== undefined;
}
