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
import type { CardFont, CardSize } from "./slideshow-title-card.js";
import { entityTagsByIds } from "../audiobook/categorize.js";

const SLIDESHOW_TAG_TYPE = "gallery_slideshow";

const inClause = (n: number) => Array(n).fill("?").join(", ");

// "random" varies the transition per slide boundary (both in the live player and the
// MP4 render, which picks a different xfade style at each cut). "dipblack" is the
// classic film cut: fade out to black, then fade the next slide in.
export type SlideshowTransition = "none" | "crossfade" | "fade" | "slide" | "kenburns" | "dipblack" | "random";

// The opening card of the rendered movie. 'count' subtitles it with the photo count
// (what every movie said before these settings existed), 'custom' with the user's own
// line, 'none' with nothing. The background is black, one of the slideshow's own
// photos (sharp or blurred), or a collage tiled from several of them.
export type SlideshowSubtitleMode = "count" | "custom" | "none";
export type SlideshowTitleBackground = "black" | "photo" | "blur" | "collage";

/**
 * What to do when the movie's filename is already taken in the target library.
 * "keep_both" numbers the new file (" (2)"); "overwrite" replaces it — but only ever a
 * file that is not a catalogued item belonging to something else (see saveMovieToLibrary),
 * so this can never quietly destroy a video someone filmed.
 */
export type MovieConflictPolicy = "overwrite" | "keep_both";

export interface SlideshowRow {
  id: string;
  name: string;
  source_kind: "manual" | "memory" | "album";
  source_ref: string | null;
  music_track_id: string | null;
  transition: SlideshowTransition;
  slide_seconds: number;
  transition_seconds: number;
  title_enabled: number; // 1 = the movie opens on a title card
  title_text: string | null; // NULL = the slideshow's name
  title_subtitle_mode: SlideshowSubtitleMode;
  title_subtitle: string | null;
  title_seconds: number;
  title_background: SlideshowTitleBackground;
  title_photo_item_id: string | null;
  card_font: CardFont; // which bundled face the cards' text is set in (both cards)
  card_size: CardSize; // small | medium | large; medium = the pre-3.26 card
  closing_enabled: number; // 1 = the movie ends on a closing card (default 0)
  closing_text: string | null; // NULL = "The End"
  closing_lines: string | null; // up to six newline-separated credit lines
  closing_seconds: number;
  closing_background: SlideshowTitleBackground;
  closing_photo_item_id: string | null;
  // The post-credit clip: a gallery video that plays last, after the closing card.
  outro_item_id: string | null;
  outro_sound: number; // 1 = the clip's own audio plays, music pausing under it
  cover_item_id: string | null;
  render_status: "draft" | "queued" | "rendering" | "ready" | "failed";
  render_stale: number; // 1 = a 'ready' movie predates the current settings/content
  render_job_id: string | null;
  output_storage_key: string | null;
  output_bytes: number | null;
  rendered_at: string | null;
  render_error: string | null;
  // Saving the movie into a library, chosen per slideshow. Target NULL = don't save.
  // See slideshow-render.ts saveMovieToLibrary.
  movie_target_library_id: string | null;
  movie_on_conflict: MovieConflictPolicy;
  movie_file_stem: string | null;
  movie_save_error: string | null;
  // Where the latest render actually landed (null until saved to a library).
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

// A content/order/settings change makes a previously-rendered movie out of date. The
// movie stays 'ready' (visible + playable) but is flagged stale so the editor prompts a
// re-render; a fresh render clears the flag (setSlideshowRenderState).
const markRenderStale = (slideshowId: string) =>
  db.prepare("UPDATE gallery_slideshows SET render_stale = 1 WHERE id = ? AND render_status = 'ready'").run(slideshowId);

const touch = (slideshowId: string) => {
  db.prepare("UPDATE gallery_slideshows SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(slideshowId);
  markRenderStale(slideshowId);
};

// Changing any presentation setting marks a previously rendered movie out of date (it
// stays visible until re-rendered). Harmless before anything is rendered.
export interface SlideshowUpdate {
  name?: string;
  transition?: SlideshowTransition;
  slideSeconds?: number;
  transitionSeconds?: number;
  musicTrackId?: string | null;
  titleEnabled?: boolean;
  titleText?: string | null;
  titleSubtitleMode?: SlideshowSubtitleMode;
  titleSubtitle?: string | null;
  titleSeconds?: number;
  titleBackground?: SlideshowTitleBackground;
  titlePhotoItemId?: string | null;
  cardFont?: CardFont;
  cardSize?: CardSize;
  closingEnabled?: boolean;
  closingText?: string | null;
  closingLines?: string | null;
  closingSeconds?: number;
  closingBackground?: SlideshowTitleBackground;
  closingPhotoItemId?: string | null;
  outroItemId?: string | null;
  outroSound?: boolean;
  // null clears the target, which turns saving to a library off.
  movieTargetLibraryId?: string | null;
  movieOnConflict?: MovieConflictPolicy;
  // null clears a Rename, putting the file back on the slideshow's own name.
  movieFileStem?: string | null;
  coverItemId?: string | null;
}

// Fields that change only WHERE the finished movie is filed, never a frame of it. An
// edit confined to these must not flag the rendered movie out of date: choosing a
// library is not a reason to re-encode three minutes of video.
const FILING_ONLY_FIELDS: (keyof SlideshowUpdate)[] = ['movieTargetLibraryId', 'movieOnConflict', 'movieFileStem'];

export function updateSlideshow(slideshowId: string, fields: SlideshowUpdate): boolean {
  const slideshow = getSlideshow(slideshowId);
  if (!slideshow) return false;
  const touchesContent = Object.keys(fields).some((key) => !FILING_ONLY_FIELDS.includes(key as keyof SlideshowUpdate));
  // A cover must be a member of the slideshow (or null to fall back to the first
  // slide) — same rule as gallery_albums.cover_item_id.
  if (fields.coverItemId) {
    const member = db.prepare(
      "SELECT 1 FROM gallery_slideshow_items WHERE slideshow_id = ? AND item_id = ?"
    ).get(slideshowId, fields.coverItemId);
    if (!member) return false;
  }
  // musicTrackId is a nullable set: `undefined` = leave alone, `null` = clear the
  // music, a value = set it (the route validates the track exists first). The
  // nullable title fields follow the same shape — `null` there means "fall back to
  // the default" (the slideshow's name, no subtitle line, the first slide).
  db.prepare(`
    UPDATE gallery_slideshows SET
      name = COALESCE(?, name),
      transition = COALESCE(?, transition),
      slide_seconds = COALESCE(?, slide_seconds),
      transition_seconds = COALESCE(?, transition_seconds),
      music_track_id = CASE WHEN ? THEN ? ELSE music_track_id END,
      title_enabled = COALESCE(?, title_enabled),
      title_text = CASE WHEN ? THEN ? ELSE title_text END,
      title_subtitle_mode = COALESCE(?, title_subtitle_mode),
      title_subtitle = CASE WHEN ? THEN ? ELSE title_subtitle END,
      title_seconds = COALESCE(?, title_seconds),
      title_background = COALESCE(?, title_background),
      title_photo_item_id = CASE WHEN ? THEN ? ELSE title_photo_item_id END,
      card_font = COALESCE(?, card_font),
      card_size = COALESCE(?, card_size),
      closing_enabled = COALESCE(?, closing_enabled),
      closing_text = CASE WHEN ? THEN ? ELSE closing_text END,
      closing_lines = CASE WHEN ? THEN ? ELSE closing_lines END,
      closing_seconds = COALESCE(?, closing_seconds),
      closing_background = COALESCE(?, closing_background),
      closing_photo_item_id = CASE WHEN ? THEN ? ELSE closing_photo_item_id END,
      outro_item_id = CASE WHEN ? THEN ? ELSE outro_item_id END,
      outro_sound = COALESCE(?, outro_sound),
      movie_target_library_id = CASE WHEN ? THEN ? ELSE movie_target_library_id END,
      movie_on_conflict = COALESCE(?, movie_on_conflict),
      movie_file_stem = CASE WHEN ? THEN ? ELSE movie_file_stem END,
      cover_item_id = CASE WHEN ? THEN ? ELSE cover_item_id END,
      render_stale = CASE WHEN ? AND render_status = 'ready' THEN 1 ELSE render_stale END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    fields.name ?? null,
    fields.transition ?? null,
    fields.slideSeconds ?? null,
    fields.transitionSeconds ?? null,
    fields.musicTrackId !== undefined ? 1 : 0, fields.musicTrackId ?? null,
    fields.titleEnabled === undefined ? null : fields.titleEnabled ? 1 : 0,
    fields.titleText !== undefined ? 1 : 0, fields.titleText ?? null,
    fields.titleSubtitleMode ?? null,
    fields.titleSubtitle !== undefined ? 1 : 0, fields.titleSubtitle ?? null,
    fields.titleSeconds ?? null,
    fields.titleBackground ?? null,
    fields.titlePhotoItemId !== undefined ? 1 : 0, fields.titlePhotoItemId ?? null,
    fields.cardFont ?? null,
    fields.cardSize ?? null,
    fields.closingEnabled === undefined ? null : fields.closingEnabled ? 1 : 0,
    fields.closingText !== undefined ? 1 : 0, fields.closingText ?? null,
    fields.closingLines !== undefined ? 1 : 0, fields.closingLines ?? null,
    fields.closingSeconds ?? null,
    fields.closingBackground ?? null,
    fields.closingPhotoItemId !== undefined ? 1 : 0, fields.closingPhotoItemId ?? null,
    fields.outroItemId !== undefined ? 1 : 0, fields.outroItemId ?? null,
    fields.outroSound === undefined ? null : fields.outroSound ? 1 : 0,
    fields.movieTargetLibraryId !== undefined ? 1 : 0, fields.movieTargetLibraryId ?? null,
    fields.movieOnConflict ?? null,
    fields.movieFileStem !== undefined ? 1 : 0, fields.movieFileStem ?? null,
    fields.coverItemId !== undefined ? 1 : 0, fields.coverItemId ?? null,
    touchesContent ? 1 : 0,
    slideshowId
  );
  return true;
}

// The card's two lines, as the render (and the editor's preview) will draw them.
// `itemCount` is what a 'count' subtitle counts. Pure, so the preview and the movie
// can never disagree about what the card says.
export function titleCardLines(
  slideshow: Pick<SlideshowRow, "name" | "title_text" | "title_subtitle_mode" | "title_subtitle">,
  itemCount: number
): { title: string; subtitle: string | null } {
  const title = (slideshow.title_text ?? "").trim() || slideshow.name;
  if (slideshow.title_subtitle_mode === "none") return { title, subtitle: null };
  if (slideshow.title_subtitle_mode === "custom") {
    const custom = (slideshow.title_subtitle ?? "").trim();
    return { title, subtitle: custom || null };
  }
  return { title, subtitle: `${itemCount} photo${itemCount === 1 ? "" : "s"}` };
}

// The closing card's lines, same contract as titleCardLines: pure, so the editor's
// preview and the movie can never disagree. No subtitle MODES here — the closing
// card is an end title plus free credit lines, and a photo count makes no sense at
// the end. `subtitle` carries the newline-separated credits (the drawer splits).
export function closingCardLines(
  slideshow: Pick<SlideshowRow, "closing_text" | "closing_lines">
): { title: string; subtitle: string | null } {
  const title = (slideshow.closing_text ?? "").trim() || "The End";
  const lines = (slideshow.closing_lines ?? "").trim();
  return { title, subtitle: lines || null };
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
// only for the creator/admin. The cover prefers the explicit cover item, else the
// first (lowest-position) visible member with a thumbnail.
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
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = gallery_slideshows.cover_item_id AND library_items.deleted_at IS NULL
            AND library_items.library_id IN (${libIn})),
        (SELECT item_metadata.cover_storage_key FROM gallery_slideshow_items
          JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE gallery_slideshow_items.slideshow_id = gallery_slideshows.id
            AND library_items.library_id IN (${libIn})
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY gallery_slideshow_items.position LIMIT 1)
      ) AS cover_key
    FROM gallery_slideshows
    ORDER BY datetime(gallery_slideshows.updated_at) DESC
  `).all(...libArgs, ...libArgs, ...libArgs) as SlideshowListRow[];

  const visible = rows.filter((row) => row.visible_count > 0 || canEditSlideshow(row, user));
  const tags = entityTagsByIds(SLIDESHOW_TAG_TYPE, visible.map((row) => row.id));
  return visible.map((row) => ({
    ...summarize(row, row.visible_count, row.cover_key, canEditSlideshow(row, user)),
    tags: tags.get(row.id) ?? []
  }));
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
  /** The user's own rotation, applied when the render scales the photo down. */
  rotation: number | null;
}

export function getSlideshowRenderItems(libIds: string[], slideshow: SlideshowRow): SlideshowRenderItem[] {
  if (libIds.length === 0) return [];
  const libIn = inClause(libIds.length);
  return db.prepare(`
    SELECT library_items.id AS id, gallery_details.kind AS kind, gallery_details.relative_path AS relative_path,
           libraries.source_path AS source_path, gallery_slideshow_items.dwell_seconds AS dwell_seconds,
           gallery_details.duration_seconds AS duration_seconds,
           gallery_details.rotation AS rotation
    FROM gallery_slideshow_items
    JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE gallery_slideshow_items.slideshow_id = ?
      AND library_items.library_id IN (${libIn})
      -- The renderer knows photo (still) and video (clip) slides only; an audio
      -- member (added via album bulk-add or a future picker) is simply skipped.
      AND gallery_details.kind != 'audio'
    ORDER BY gallery_slideshow_items.position ASC, library_items.id ASC
  `).all(slideshow.id, ...libIds) as SlideshowRenderItem[];
}

// One gallery VIDEO by id, in the same shape the render items use — for the
// opening/closing clips, which need not be slideshow members. Filtered by the
// given library access and by kind, so an id that stopped being reachable (or was
// never a video) resolves to null and the render simply goes on without it.
export function getClipRenderItem(libIds: string[], itemId: string | null): SlideshowRenderItem | null {
  if (!itemId || libIds.length === 0) return null;
  const libIn = inClause(libIds.length);
  const row = db.prepare(`
    SELECT library_items.id AS id, gallery_details.kind AS kind, gallery_details.relative_path AS relative_path,
           libraries.source_path AS source_path, NULL AS dwell_seconds,
           gallery_details.duration_seconds AS duration_seconds,
           gallery_details.rotation AS rotation
    FROM library_items
    JOIN gallery_details ON gallery_details.item_id = library_items.id
    JOIN libraries ON libraries.id = library_items.library_id
    WHERE library_items.id = ? AND library_items.deleted_at IS NULL
      AND gallery_details.kind = 'video'
      AND library_items.library_id IN (${libIn})
  `).get(itemId, ...libIds) as SlideshowRenderItem | undefined;
  return row ?? null;
}

// Set/reset render state. The worker moves a slideshow through queued → rendering →
// ready|failed; edits (see updateSlideshow) flag a 'ready' movie stale. Every transition
// here reflects a fresh/absent render, so the stale flag always clears.
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
      render_stale = 0,
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
// Why the last save into a library failed, or null when it worked. Kept on the slideshow
// so the editor can explain a movie that rendered fine but never reached the library.
export function setSlideshowSaveError(slideshowId: string, error: string | null): void {
  db.prepare('UPDATE gallery_slideshows SET movie_save_error = ? WHERE id = ?').run(error, slideshowId);
}

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

