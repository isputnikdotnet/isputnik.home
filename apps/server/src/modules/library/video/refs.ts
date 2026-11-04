// Films and shows as home points at them: in Collections, in My list and in a
// Collection row of the video page (docs/video-home-rows-plan.md, R4). The
// catalog is the engine's, but home answers "what is this, and may this person
// see it?" from its own database (social/subjects.ts, synchronously), so each
// title home points at keeps a copy of what a card needs — its name, year,
// poster and, for access, its library. The copy is taken from the engine when a
// title is added, and again whenever it is added anywhere after.
import { db } from "../../../db.js";
import { getSections } from "../../../core/sections.js";
import { appRole } from "../../apps/access.js";
import { accessibleLibraryIds } from "../shared/library-access.js";
import type { EngineClient } from "./engine.js";
import { VIDEO_LIBRARY_TYPE, listVideoLibraries } from "./libraries.js";

export type VideoRefKind = "movies" | "shows";
/** The Collections entity types a film and a show are. */
export const VIDEO_ENTITY_TYPES = { movies: "video_movie", shows: "video_show" } as const;
export const kindOfEntityType = (entityType: string): VideoRefKind | null =>
  entityType === VIDEO_ENTITY_TYPES.movies ? "movies" : entityType === VIDEO_ENTITY_TYPES.shows ? "shows" : null;

export interface VideoRef {
  kind: VideoRefKind;
  id: string;
  libraryId: string;
  title: string;
  year: number | null;
  poster: string | null;
}

interface VideoRefRow {
  kind: VideoRefKind;
  entity_id: string;
  library_id: string;
  title: string;
  year: number | null;
  poster: string | null;
}

const fromRow = (row: VideoRefRow): VideoRef => ({ kind: row.kind, id: row.entity_id, libraryId: row.library_id, title: row.title, year: row.year, poster: row.poster });

/** Asks the engine about these titles and keeps what a card needs. A title the
 *  engine no longer has is left as it was (its card says so when opened). */
export async function refreshVideoRefs(engine: EngineClient, kind: VideoRefKind, ids: string[]): Promise<void> {
  const upsert = db.prepare(`
    INSERT INTO video_refs (kind, entity_id, library_id, title, year, poster, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT (kind, entity_id) DO UPDATE SET library_id = excluded.library_id, title = excluded.title,
      year = excluded.year, poster = excluded.poster, updated_at = excluded.updated_at
  `);
  // Home reads every library here: who may see the title is decided after, from
  // its library (visibleVideoRefs).
  const libraries = listVideoLibraries().map((row) => row.id);
  // One at a time: the engine answers each from its own SQLite in a moment, and
  // a batch is at most a page of titles.
  for (const id of [...new Set(ids)].slice(0, 200)) {
    try {
      const title = await engine.call<{ libraryId: string; title: string; year: number | null; poster?: string | null }>("GET", `/${kind}/${encodeURIComponent(id)}`, { libraries });
      upsert.run(kind, id, title.libraryId, title.title, title.year ?? null, title.poster ?? null);
    } catch {
      // Gone, or the engine is down: nothing new to keep.
    }
  }
}

/** These titles as this person may see them: only from video libraries they are
 *  let into, and only while Video is on and theirs (Security › App access). */
export function visibleVideoRefs(kind: VideoRefKind, ids: string[], user: { id: string; role: string }): Map<string, VideoRef> {
  const out = new Map<string, VideoRef>();
  if (ids.length === 0 || !getSections().video || appRole("video", user) === null) return out;
  const libraries = accessibleLibraryIds(user.id, user.role, VIDEO_LIBRARY_TYPE);
  const rows = db.prepare(`SELECT kind, entity_id, library_id, title, year, poster FROM video_refs WHERE kind = ? AND entity_id IN (${ids.map(() => "?").join(", ")})`)
    .all(kind, ...ids) as VideoRefRow[];
  for (const row of rows) if (libraries.has(row.library_id)) out.set(row.entity_id, fromRow(row));
  return out;
}

/** A video library is gone: so are home's pointers at what was in it. */
export function forgetVideoLibrary(libraryId: string): void {
  db.transaction(() => {
    for (const [kind, entityType] of Object.entries(VIDEO_ENTITY_TYPES)) {
      db.prepare(`DELETE FROM collection_items WHERE entity_type = ? AND entity_id IN (SELECT entity_id FROM video_refs WHERE kind = ? AND library_id = ?)`)
        .run(entityType, kind, libraryId);
      db.prepare(`DELETE FROM video_my_list WHERE kind = ? AND entity_id IN (SELECT entity_id FROM video_refs WHERE kind = ? AND library_id = ?)`)
        .run(kind, kind, libraryId);
    }
    db.prepare("DELETE FROM video_refs WHERE library_id = ?").run(libraryId);
  })();
}

/** The href home's screens open a title at. */
export const videoTitleHref = (kind: VideoRefKind, id: string) => `/${kind}/${encodeURIComponent(id)}`;
