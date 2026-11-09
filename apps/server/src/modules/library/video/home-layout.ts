// The video page's rows (docs/video-home-rows-plan.md). A row is a saved query —
// "the newest films", "Comedy in Kids" — never a list of titles: each screen asks
// the engine for a row's titles itself, through the gateway and as the person
// looking, so a row can never show what that person may not see. Home keeps
// only which rows there are, in what order, and what each asks for.
//
// A Collection row is the one kind that points at something hand-picked: a
// Collection of the person saving it (lists.ts says who may read it after).
//
// Two layers: the household's rows (an admin's), and a person's own copy, which
// they make by customising and drop with "Use the household's rows". Someone
// with no copy follows the household's as it changes.
import { z } from "zod";
import { db } from "../../../db.js";
import { getProfileRowsJson, setProfileRowsJson, type ViewingProfile } from "../../profiles/store.js";

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
  z.object({ ...common, type: z.literal("sets") }),
  /** A Collection's films and shows, in its order (lists.ts). */
  z.object({ ...common, type: z.literal("collection"), collectionId: z.string().min(1).max(64) }),
  /** The viewer's own My list. */
  z.object({ ...common, type: z.literal("mylist") })
]);
export type VideoRow = z.infer<typeof videoRowSchema>;

export const videoLayoutSchema = z.object({
  rows: z.array(videoRowSchema).max(VIDEO_ROWS_MAX)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, "Two rows have the same id"),
  /** Whose rows: the person's own, or (admins) the household's. Left out is the
   *  household's, as 4.63 sent it. */
  scope: z.enum(["mine", "everyone", "profile"]).default("everyone"),
  /** With scope "profile": which of the person's viewing profiles. */
  profileId: z.string().min(1).max(64).optional()
}).refine((layout) => layout.scope !== "profile" || layout.profileId, "A profile's rows name the profile");
export type VideoLayoutScope = "mine" | "everyone";

/** The page as it was before rows could be chosen: what nobody has changed shows. */
export const DEFAULT_VIDEO_ROWS: VideoRow[] = [
  { id: "continue", type: "continue" },
  { id: "new-movies", type: "titles", kind: "movies", libraries: [], genres: [], sort: "added" },
  { id: "new-shows", type: "titles", kind: "shows", libraries: [], genres: [], sort: "added" },
  { id: "sets", type: "sets" }
];

/** Stored rows, minus any this version cannot read (a later one wrote them):
 *  left out rather than failing the page. */
function readRows(json: string): VideoRow[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  return (Array.isArray(raw) ? raw : []).flatMap((row) => {
    const parsed = videoRowSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The household's rows, and whether anyone has changed them. */
export function getHouseholdLayout(): { rows: VideoRow[]; custom: boolean } {
  const stored = db.prepare("SELECT rows FROM video_home_layouts WHERE owner = ?").get(HOUSEHOLD) as { rows: string } | undefined;
  const rows = stored ? readRows(stored.rows) : null;
  return rows ? { rows, custom: true } : { rows: DEFAULT_VIDEO_ROWS, custom: false };
}

/** A person's own rows, or null when they follow the household's. */
export function getPersonalRows(userId: string): VideoRow[] | null {
  const stored = db.prepare("SELECT rows FROM video_home_user_layouts WHERE user_id = ?").get(userId) as { rows: string } | undefined;
  return stored ? readRows(stored.rows) : null;
}

/** What a person's page shows: their own rows, else the household's. */
export function getVideoLayout(userId: string): { rows: VideoRow[]; custom: boolean; mine: boolean } {
  const household = getHouseholdLayout();
  const own = getPersonalRows(userId);
  return own ? { rows: own, custom: household.custom, mine: true } : { ...household, mine: false };
}

// ── A viewing profile's page (docs/tv-profiles-plan.md) ─────────────────────
// A third layer above the two: a profile's own rows, else its owner's page.

/** A profile's own rows, or null when it follows its owner's page. */
export function getProfileRows(profileId: string, userId: string): VideoRow[] | null {
  const json = getProfileRowsJson(profileId, userId);
  return json === null ? null : readRows(json);
}

/** Rows a profile can show: one naming only libraries outside it is dropped, one
 *  naming some keeps those. The engine narrows anyway; this keeps a Kids page from
 *  drawing a row that can only ever come back empty. */
export function narrowRows(rows: VideoRow[], profile: ViewingProfile | null): VideoRow[] {
  if (!profile?.libraries) return rows;
  const allowed = new Set(profile.libraries);
  return rows.flatMap((row) => {
    if (row.type !== "titles" || row.libraries.length === 0) return [row];
    const kept = row.libraries.filter((id) => allowed.has(id));
    return kept.length > 0 ? [{ ...row, libraries: kept }] : [];
  });
}

/** What a profile's page shows: its own rows, else its owner's page. */
export function getProfileLayout(profile: ViewingProfile): { rows: VideoRow[]; custom: boolean; mine: boolean; own: boolean } {
  const owner = getVideoLayout(profile.userId);
  const own = getProfileRows(profile.id, profile.userId);
  return { ...owner, rows: narrowRows(own ?? owner.rows, profile), own: own !== null };
}

export function saveProfileRows(profileId: string, userId: string, rows: VideoRow[] | null): boolean {
  return setProfileRowsJson(profileId, userId, rows === null ? null : JSON.stringify(rows));
}

export function saveVideoLayout(scope: VideoLayoutScope, rows: VideoRow[], userId: string): void {
  if (scope === "mine") {
    db.prepare(`
      INSERT INTO video_home_user_layouts (user_id, rows, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT (user_id) DO UPDATE SET rows = excluded.rows, updated_at = excluded.updated_at
    `).run(userId, JSON.stringify(rows));
    return;
  }
  db.prepare(`
    INSERT INTO video_home_layouts (owner, rows, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (owner) DO UPDATE SET rows = excluded.rows, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(HOUSEHOLD, JSON.stringify(rows), userId);
}

/** Mine: back to following the household's rows. Everyone: back to the default rows. */
export function resetVideoLayout(scope: VideoLayoutScope, userId: string): void {
  if (scope === "mine") db.prepare("DELETE FROM video_home_user_layouts WHERE user_id = ?").run(userId);
  else db.prepare("DELETE FROM video_home_layouts WHERE owner = ?").run(HOUSEHOLD);
}
