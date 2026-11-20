// Stories' numbers for the control panel's Stories Overview (owner, 2026-11-19):
// how many stories, recipes and shelves there are, and how much narration was
// recorded. Registered into the core status registry from storiesPlugin, so core/
// never touches the stories tables (core/status-contributors.ts).

import { db } from "../../db.js";
import { registerStatusContributor } from "../../core/status-contributors.js";

function storyStats() {
  const stories = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS published,
      COALESCE(SUM(CASE WHEN kind = 'recipe' THEN 1 ELSE 0 END), 0) AS recipes
    FROM stories
    WHERE deleted_at IS NULL
  `).get() as { total: number; published: number; recipes: number };
  const collections = (db.prepare("SELECT COUNT(*) AS n FROM story_collections").get() as { n: number }).n;
  const recordings = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(duration_seconds, 0)), 0) AS seconds
    FROM story_audio
    JOIN stories ON stories.id = story_audio.story_id AND stories.deleted_at IS NULL
  `).get() as { n: number; seconds: number };
  return {
    stories: stories.total,
    published: stories.published,
    recipes: stories.recipes,
    collections,
    recordings: recordings.n,
    recordingSeconds: Math.round(recordings.seconds)
  };
}

// One function for every registration: the registry refuses a second, different
// contributor for the same key, and a plugin may be registered more than once.
const contribute = () => ({ storyStats: storyStats() });

export function registerStoryStats(): void {
  registerStatusContributor("stories", ["storyStats"], contribute);
}
