// Gallery slideshows: an ordered photo set PLUS presentation settings (transition,
// per-slide duration). Sibling of albums (see albums.ts) with the same access model:
// - every member can view; items are filtered by the VIEWER's library access
// - edit (rename, add/remove, reorder, settings, delete) = creator + admins
// - a slideshow with zero visible items is hidden from everyone except its creator
//   and admins
// Phase 1 (docs/gallery-slideshows-proposal.md): no music, no MP4 render — those
// columns exist in the schema but are left at their defaults here.
import { nanoid } from "nanoid";
import { db } from "../../../db.js";
import { ASSET_COLUMNS, ASSET_JOINS, mapAsset, type GalleryAssetRow } from "./catalog.js";

const inClause = (n: number) => Array(n).fill("?").join(", ");

// "random" varies the transition per slide boundary (both in the live player and the
// MP4 render, which picks a different xfade style at each cut). "dipblack" is the
// classic film cut: fade out to black, then fade the next slide in.
export type SlideshowTransition = "none" | "crossfade" | "fade" | "slide" | "kenburns" | "dipblack" | "random";

export interface SlideshowRow {
  id: string;
  name: string;
  source_kind: "manual" | "memory" | "album";
  source_ref: string | null;
  music_track_id: string | null;
  transition: SlideshowTransition;
  slide_seconds: number;
  transition_seconds: number;
  render_status: "draft" | "queued" | "rendering" | "ready" | "failed";
  render_job_id: string | null;
  output_storage_key: string | null;
  output_bytes: number | null;
  rendered_at: string | null;
  render_error: string | null;
  // Where the latest render was auto-saved as a gallery item (null until saved to a
  // library). See slideshow-render.ts saveMovieToLibrary and slideshow-settings.ts.
  movie_library_id: string | null;
  movie_relative_path: string | null;
  movie_item_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function getSlideshow(slideshowId: string): SlideshowRow | undefined {
  return db.prepare("SELECT * FROM gallery_slideshows WHERE id = ?").get(slideshowId) as SlideshowRow | undefined;
}

export function canEditSlideshow(slideshow: Pick<SlideshowRow, "created_by">, user: { id: string; role: string }): boolean {
  return user.role === "admin" || slideshow.created_by === user.id;
}

export function createSlideshow(
  user: { id: string },
  name: string,
  source: { kind?: "manual" | "memory" | "album"; ref?: string | null } = {}
): SlideshowRow {
  const id = nanoid(16);
  db.prepare(
    "INSERT INTO gallery_slideshows (id, name, source_kind, source_ref, created_by) VALUES (?, ?, ?, ?, ?)"
  ).run(id, name, source.kind ?? "manual", source.ref ?? null, user.id);
  return getSlideshow(id)!;
}

// A content/order/settings change makes a previously-rendered movie stale: knock a
// 'ready' render back to 'draft' (the old MP4 stays on disk until a re-render
// overwrites it, but it's no longer served — the movie endpoint requires 'ready').
const markRenderStale = (slideshowId: string) =>
  db.prepare("UPDATE gallery_slideshows SET render_status = 'draft' WHERE id = ? AND render_status = 'ready'").run(slideshowId);

const touch = (slideshowId: string) => {
  db.prepare("UPDATE gallery_slideshows SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(slideshowId);
  markRenderStale(slideshowId);
};

// Changing any presentation setting invalidates a previously rendered movie, so
// (from Phase 4) it drops back to 'draft'. Harmless in Phase 1 where nothing renders.
export function updateSlideshow(
  slideshowId: string,
  fields: { name?: string; transition?: SlideshowTransition; slideSeconds?: number; transitionSeconds?: number; musicTrackId?: string | null }
): boolean {
  const slideshow = getSlideshow(slideshowId);
  if (!slideshow) return false;
  // musicTrackId is a nullable set: `undefined` = leave alone, `null` = clear the
  // music, a value = set it (the route validates the track exists first).
  db.prepare(`
    UPDATE gallery_slideshows SET
      name = COALESCE(?, name),
      transition = COALESCE(?, transition),
      slide_seconds = COALESCE(?, slide_seconds),
      transition_seconds = COALESCE(?, transition_seconds),
      music_track_id = CASE WHEN ? THEN ? ELSE music_track_id END,
      render_status = CASE WHEN render_status = 'ready' THEN 'draft' ELSE render_status END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    fields.name ?? null,
    fields.transition ?? null,
    fields.slideSeconds ?? null,
    fields.transitionSeconds ?? null,
    fields.musicTrackId !== undefined ? 1 : 0, fields.musicTrackId ?? null,
    slideshowId
  );
  return true;
}

export function deleteSlideshow(slideshowId: string): boolean {
  return db.prepare("DELETE FROM gallery_slideshows WHERE id = ?").run(slideshowId).changes > 0;
}

// Batch add (multi-select bar / lightbox). Only gallery items in libraries the
// CALLER can access are added — others skipped and counted (the bulk contract).
// Duplicates skipped (idempotent). Appended after the current last position.
export function addSlideshowItems(
  slideshowId: string,
  accessibleLibIds: Set<string>,
  itemIds: string[]
): { added: number; skipped: number } {
  const lookup = db.prepare(`
    SELECT library_items.library_id FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
  `);
  const existing = new Set((db.prepare(
    "SELECT item_id FROM gallery_slideshow_items WHERE slideshow_id = ?"
  ).all(slideshowId) as { item_id: string }[]).map((row) => row.item_id));
  let position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM gallery_slideshow_items WHERE slideshow_id = ?"
  ).get(slideshowId) as { pos: number }).pos;

  const insert = db.prepare(
    "INSERT INTO gallery_slideshow_items (slideshow_id, item_id, position) VALUES (?, ?, ?)"
  );
  let added = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const itemId of new Set(itemIds)) {
      const row = lookup.get(itemId) as { library_id: string } | undefined;
      if (!row || !accessibleLibIds.has(row.library_id) || existing.has(itemId)) {
        skipped += 1;
        continue;
      }
      insert.run(slideshowId, itemId, position);
      position += 1;
      added += 1;
    }
    if (added > 0) touch(slideshowId);
  })();
  return { added, skipped };
}

export function removeSlideshowItems(slideshowId: string, itemIds: string[]): number {
  if (itemIds.length === 0) return 0;
  const removed = db.prepare(
    `DELETE FROM gallery_slideshow_items WHERE slideshow_id = ? AND item_id IN (${inClause(itemIds.length)})`
  ).run(slideshowId, ...itemIds).changes;
  if (removed > 0) touch(slideshowId);
  return removed;
}

// Reorder: assign integer positions from the given order. Only ids that are already
// members are repositioned; unknown ids are ignored, and members omitted from
// `orderedItemIds` keep their existing relative order after the listed ones.
export function reorderSlideshowItems(slideshowId: string, orderedItemIds: string[]): boolean {
  const members = (db.prepare(
    "SELECT item_id FROM gallery_slideshow_items WHERE slideshow_id = ? ORDER BY position ASC"
  ).all(slideshowId) as { item_id: string }[]).map((row) => row.item_id);
  const memberSet = new Set(members);
  const listed = orderedItemIds.filter((id) => memberSet.has(id));
  const listedSet = new Set(listed);
  const finalOrder = [...listed, ...members.filter((id) => !listedSet.has(id))];
  if (finalOrder.length === 0) return false;

  const update = db.prepare("UPDATE gallery_slideshow_items SET position = ? WHERE slideshow_id = ? AND item_id = ?");
  db.transaction(() => {
    finalOrder.forEach((itemId, i) => update.run(i + 1, slideshowId, itemId));
    touch(slideshowId);
  })();
  return true;
}

interface SlideshowListRow extends SlideshowRow {
  visible_count: number;
  cover_key: string | null;
}

// Slideshows the viewer should see, newest-updated first. `visible_count` counts
// only items in the viewer's accessible libraries; zero-visible slideshows are kept
// only for the creator/admin. The cover is the first (lowest-position) visible
// member with a thumbnail.
export function listSlideshows(user: { id: string; role: string }, libIds: string[]) {
  const libArgs = libIds.length > 0 ? libIds : [""];
  const libIn = inClause(libArgs.length);
  const rows = db.prepare(`
    SELECT
      gallery_slideshows.*,
      (SELECT COUNT(*) FROM gallery_slideshow_items
        JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
        WHERE gallery_slideshow_items.slideshow_id = gallery_slideshows.id
          AND library_items.library_id IN (${libIn})) AS visible_count,
      (SELECT item_metadata.cover_storage_key FROM gallery_slideshow_items
        JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
        JOIN item_metadata ON item_metadata.item_id = library_items.id
        WHERE gallery_slideshow_items.slideshow_id = gallery_slideshows.id
          AND library_items.library_id IN (${libIn})
          AND item_metadata.cover_storage_key IS NOT NULL
        ORDER BY gallery_slideshow_items.position LIMIT 1) AS cover_key
    FROM gallery_slideshows
    ORDER BY datetime(gallery_slideshows.updated_at) DESC
  `).all(...libArgs, ...libArgs) as SlideshowListRow[];

  return rows
    .filter((row) => row.visible_count > 0 || canEditSlideshow(row, user))
    .map((row) => summarize(row, row.visible_count, row.cover_key, canEditSlideshow(row, user)));
}

// Shape one slideshow for the client. Kept in one place so the list, create, and
// detail responses never drift.
export function summarize(
  row: SlideshowRow,
  itemCount: number,
  coverKey: string | null,
  canEdit: boolean
) {
  return {
    id: row.id,
    name: row.name,
    itemCount,
    coverUrl: coverKey ? `/api/library/covers/${coverKey}` : null,
    transition: row.transition,
    slideSeconds: row.slide_seconds,
    transitionSeconds: row.transition_seconds,
    musicTrackId: row.music_track_id,
    renderStatus: row.render_status,
    canEdit,
    updatedAt: row.updated_at
  };
}

// One slideshow's visible items, in presentation (position) order. Paged like the
// album detail. `dwell` is the per-slide override (null = use slide_seconds).
export function getSlideshowItems(userId: string, libIds: string[], slideshow: SlideshowRow, limit: number, offset: number) {
  if (libIds.length === 0) return { assets: [], total: 0 };
  const libIn = inClause(libIds.length);
  const where = `
    gallery_slideshow_items.slideshow_id = ?
    AND library_items.library_id IN (${libIn})
    AND library_items.deleted_at IS NULL`;
  const total = (db.prepare(`
    SELECT COUNT(*) AS n FROM gallery_slideshow_items
    JOIN library_items ON library_items.id = gallery_slideshow_items.item_id
    WHERE ${where}
  `).get(slideshow.id, ...libIds) as { n: number }).n;

  const rows = db.prepare(`
    SELECT ${ASSET_COLUMNS}, gallery_slideshow_items.dwell_seconds AS ss_dwell ${ASSET_JOINS}
    JOIN gallery_slideshow_items ON gallery_slideshow_items.item_id = library_items.id
    WHERE ${where}
    ORDER BY gallery_slideshow_items.position ASC, library_items.id ASC
    LIMIT ? OFFSET ?
  `).all(userId, slideshow.id, ...libIds, limit, offset) as (GalleryAssetRow & { ss_dwell: number | null })[];

  return {
    assets: rows.map((row) => ({ ...mapAsset(row), dwellSeconds: row.ss_dwell })),
    total
  };
}

// On-disk files for a render, in presentation order — photos AND videos (a video
// contributes its own clip, capped, with its audio dropped). Filtered by the given
// library access, like the album download. `dwell_seconds` is the per-slide override
// (null → slide default, or the clip's own length for a video).
export interface SlideshowRenderItem {
  id: string;
  kind: "photo" | "video";
  relative_path: string;
  source_path: string;
  dwell_seconds: number | null;
  duration_seconds: number | null;
}

export function getSlideshowRenderItems(libIds: string[], slideshow: SlideshowRow): SlideshowRenderItem[] {
  if (libIds.length === 0) return [];
  const libIn = inClause(libIds.length);
  return db.prepare(`
    SELECT library_items.id AS id, gallery_details.kind AS kind, gallery_details.relative_path AS relative_path,
           libraries.source_path AS source_path, gallery_slideshow_items.dwell_seconds AS dwell_seconds,
           gallery_details.duration_seconds AS duration_seconds
    FROM gallery_slideshow_items
    JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE gallery_slideshow_items.slideshow_id = ?
      AND library_items.library_id IN (${libIn})
    ORDER BY gallery_slideshow_items.position ASC, library_items.id ASC
  `).all(slideshow.id, ...libIds) as SlideshowRenderItem[];
}

// Set/reset render state. The worker moves a slideshow through queued → rendering →
// ready|failed; edits (see updateSlideshow) knock a 'ready' back to 'draft'.
export function setSlideshowRenderState(
  slideshowId: string,
  fields: {
    status: SlideshowRow["render_status"];
    jobId?: string | null;
    outputStorageKey?: string | null;
    outputBytes?: number | null;
    error?: string | null;
    renderedAt?: string | null;
  }
): void {
  db.prepare(`
    UPDATE gallery_slideshows SET
      render_status = ?,
      render_job_id = CASE WHEN ? THEN ? ELSE render_job_id END,
      output_storage_key = CASE WHEN ? THEN ? ELSE output_storage_key END,
      output_bytes = CASE WHEN ? THEN ? ELSE output_bytes END,
      render_error = ?,
      rendered_at = CASE WHEN ? THEN ? ELSE rendered_at END
    WHERE id = ?
  `).run(
    fields.status,
    fields.jobId !== undefined ? 1 : 0, fields.jobId ?? null,
    fields.outputStorageKey !== undefined ? 1 : 0, fields.outputStorageKey ?? null,
    fields.outputBytes !== undefined ? 1 : 0, fields.outputBytes ?? null,
    fields.error ?? null,
    fields.renderedAt !== undefined ? 1 : 0, fields.renderedAt ?? null,
    slideshowId
  );
}

// Record where the latest render was auto-saved as a gallery video item, so a re-render
// overwrites the same file (and updates the same catalog item) instead of duplicating it.
// Cleared by passing null everywhere (e.g. if saving to a library ever needs to reset).
export function setSlideshowMovieAsset(
  slideshowId: string,
  fields: { libraryId: string | null; relativePath: string | null; itemId: string | null }
): void {
  db.prepare(`
    UPDATE gallery_slideshows SET
      movie_library_id = ?, movie_relative_path = ?, movie_item_id = ?
    WHERE id = ?
  `).run(fields.libraryId, fields.relativePath, fields.itemId, slideshowId);
}

