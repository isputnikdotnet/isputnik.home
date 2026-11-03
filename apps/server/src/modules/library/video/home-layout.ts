// The video page's rows (docs/video-home-rows-plan.md). A row is a saved query —
// "the newest films", "Comedy in Kids" — never a list of titles: each screen asks
// the engine for a row's titles itself, through the gateway and as the person
// looking, so a row can never show what that person may not see. Home keeps
// only which rows there are, in what order, and what each asks for.
//
// One layout for the household today (owner ''); a person's own copy joins it
// keyed by their id.
import { z } from "zod";
import { db } from "../../../db.js";

/** Enough for a long page; more is a list, not a home. */
export const VIDEO_ROWS_MAX = 15;

const HOUSEHOLD = "";

const libraryId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const common = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  /** Left out: the screen names it from what it asks for, in the viewer's language. */
  title: z.string().trim().min(1).max(80).optional(),
  hidden: z.boolean().optional()
};

export const videoRowSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("continue") }),
  z.object({
    ...common,
    type: z.literal("titles"),
    kind: z.enum(["all", "movies", "shows"]).default("all"),
    libraries: z.array(libraryId).max(50).default([]),
    genres: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    sort: z.enum(["added", "title", "year"]).default("added")
  }),
  z.object({ ...common, type: z.literal("sets") })
]);
export type VideoRow = z.infer<typeof videoRowSchema>;

export const videoLayoutSchema = z.object({
  rows: z.array(videoRowSchema).max(VIDEO_ROWS_MAX)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "Two rows have the same id")
});

/** The page as it was before rows could be chosen: what nobody has changed shows. */
export const DEFAULT_VIDEO_ROWS: VideoRow[] = [
  { id: "continue", type: "continue" },
  { id: "new-movies", type: "titles", kind: "movies", libraries: [], genres: [], sort: "added" },
  { id: "new-shows", type: "titles", kind: "shows", libraries: [], genres: [], sort: "added" },
  { id: "sets", type: "sets" }
];

/** The household's rows, and whether anyone has changed them. A row this version
 *  cannot read (a later one wrote it) is left out rather than failing the page. */
export function getVideoLayout(): { rows: VideoRow[]; custom: boolean } {
  const stored = db.prepare("SELECT rows FROM video_home_layouts WHERE owner = ?").get(HOUSEHOLD) as { rows: string } | undefined;
  if (!stored) return { rows: DEFAULT_VIDEO_ROWS, custom: false };
  let raw: unknown;
  try {
    raw = JSON.parse(stored.rows);
  } catch {
    return { rows: DEFAULT_VIDEO_ROWS, custom: false };
  }
  const rows = (Array.isArray(raw) ? raw : []).flatMap((row) => {
    const parsed = videoRowSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  return { rows, custom: true };
}

export function saveVideoLayout(rows: VideoRow[], userId: string): void {
  db.prepare(`
    INSERT INTO video_home_layouts (owner, rows, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (owner) DO UPDATE SET rows = excluded.rows, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(HOUSEHOLD, JSON.stringify(rows), userId);
}

/** Back to the default rows. */
export function resetVideoLayout(): void {
  db.prepare("DELETE FROM video_home_layouts WHERE owner = ?").run(HOUSEHOLD);
}
