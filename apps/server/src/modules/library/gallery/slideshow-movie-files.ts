import fs from "node:fs";
import path from "node:path";
import { db } from "../../../db.js";
import { validateLibrarySource } from "../shared/library-source.js";
import { normaliseRelativePath } from "../shared/storage-roots.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import {
  setSlideshowMovieAsset,
  setSlideshowRenderState,
  type MovieConflictPolicy,
  type SlideshowRow
} from "./slideshows.js";
import { scanSingleGalleryFile } from "./scanner.js";

// ── Auto-save the rendered movie into a gallery library ──────────────────────
// A slideshow can name a library to file its finished movie into, so the movie becomes a
// durable, browsable gallery asset — not just the copy in the thumbnail store the editor
// streams. The choice is per slideshow and off by default (movie_target_library_id).

// Rendered movies live under this fixed subfolder of the target library (they carry no
// capture date, so a dated folder like uploads use would just scatter them).
const MOVIE_SUBFOLDER = "Slideshow movies";

// The stem a movie is filed under: an explicit Rename if there is one, otherwise the
// slideshow's own name. Exported for the conflict preview, which has to show the exact
// filename BEFORE anything is written.
export function movieStemFor(slideshow: Pick<SlideshowRow, "name" | "movie_file_stem">): string {
  return safeMovieStem(slideshow.movie_file_stem || slideshow.name);
}

export function safeMovieStem(raw: string): string {
  return Array.from(raw)
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .join("")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .replace(/[\s.]+$/g, "") || "slideshow";
}

// The library-relative path a render is saved to. It follows the slideshow's CURRENT name
// unless Rename set a stem: the same name lands on the stored path and overwrites in place
// (same catalog item, no duplicate); after a rename the movie saves under the new name and
// saveMovieToLibrary retires the old file/item. The slideshow's own stored file never
// counts as a collision — reaching it just means overwrite.
//
// `policy` decides what a collision with SOMEONE ELSE'S file does: "keep_both" numbers
// this movie out of the way, "overwrite" takes the name. Overwrite is only ever offered
// for a file that is not a catalogued item belonging to something else — that check is
// saveMovieToLibrary's, because it needs the database. Pure + injectable so the logic is
// testable without touching the disk or the encoder.
export function movieRelativePathFor(
  slideshow: Pick<SlideshowRow, "name" | "movie_file_stem" | "movie_library_id" | "movie_relative_path">,
  libraryId: string,
  exists: (relativePath: string) => boolean,
  policy: MovieConflictPolicy = "keep_both"
): string {
  const own = slideshow.movie_library_id === libraryId ? slideshow.movie_relative_path : null;
  const stem = movieStemFor(slideshow);
  const first = `${MOVIE_SUBFOLDER}/${stem}.mp4`;
  // Overwrite means "take the name" — no numbering, whatever is sitting there.
  if (policy === "overwrite") return first;

  // Otherwise disambiguate with " (2)", " (3)", … Mirrors uniqueGalleryFileName.
  let relativePath = first;
  let counter = 2;
  while (relativePath !== own && exists(relativePath)) {
    relativePath = `${MOVIE_SUBFOLDER}/${stem} (${counter}).mp4`;
    counter += 1;
  }
  return relativePath;
}

/**
 * Whether a path in a library is a catalogued item that is NOT this slideshow's own movie
 * — someone's actual video that happens to share the name. Overwriting one would destroy
 * it and tombstone their item, so it is refused outright rather than confirmed away.
 * Returns the offending item's id, or null when the name is free or already ours.
 */
export function foreignItemAt(
  libraryId: string,
  relativePath: string,
  ownItemId: string | null
): string | null {
  const row = db.prepare(`
    SELECT library_items.id AS id
    FROM gallery_details
    JOIN library_items ON library_items.id = gallery_details.item_id
    WHERE library_items.library_id = ?
      AND gallery_details.relative_path = ?
      AND library_items.deleted_at IS NULL
  `).get(libraryId, relativePath) as { id: string } | undefined;
  if (!row) return null;
  return row.id === ownItemId ? null : row.id;
}

/**
 * Copy a finished render (the thumbnail-store MP4 at `storageKey`) into the slideshow's
 * chosen library and catalog it as a video item. No target = nothing to do, which is the
 * default. Best-effort by contract: the caller treats any throw as "not saved" and leaves
 * the render 'ready' regardless — but the REASON is recorded on the slideshow so the
 * editor can say why instead of silently not saving.
 *
 * Re-renders reuse the slideshow's stored path so the same file is overwritten and the
 * SAME catalog item is updated (ingestGalleryAsset keys on library_id + relative_path) —
 * no duplicate items.
 */
export async function saveMovieToLibrary(
  slideshow: SlideshowRow,
  storageKey: string
): Promise<{ saved: boolean; itemId: string | null; error: string | null }> {
  const libId = slideshow.movie_target_library_id;
  if (!libId) return { saved: false, itemId: null, error: null };

  const library = db.prepare("SELECT id, source_path FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libId) as { id: string; source_path: string } | undefined;
  if (!library) {
    return { saved: false, itemId: null, error: "The library this movie saves to no longer exists." };
  }

  const root = validateLibrarySource(library.source_path); // throws on an unusable mount

  const relativePath = movieRelativePathFor(
    slideshow,
    libId,
    (rel) => fs.existsSync(path.join(root, ...rel.split("/"))),
    slideshow.movie_on_conflict
  );

  // The one thing overwrite must never do. A name can come to belong to a real video
  // between choosing the library and rendering — someone drops a clip in, or a scan picks
  // one up — so the check is here, at the moment of writing, not only in the dialog.
  const foreign = foreignItemAt(libId, relativePath, slideshow.movie_item_id);
  if (foreign) {
    return {
      saved: false,
      itemId: null,
      error: `"${relativePath.split("/").pop()}" is already a video in that library. Rename the movie or choose "Keep both".`
    };
  }

  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(thumbnailAbsolutePath(storageKey), target);

  const itemId = await scanSingleGalleryFile(libId, normaliseRelativePath(relativePath));
  if (!itemId) return { saved: false, itemId: null, error: "The movie was copied but could not be catalogued." };

  // A previous save under another name (slideshow renamed) or in another library is now
  // stale: best-effort remove the old file and soft-delete its catalog item right away
  // (same tombstone the scanner uses), so the Timeline doesn't show a broken tile until
  // the nightly scan reconciles it.
  const staleLibraryId = slideshow.movie_library_id;
  const stalePath = slideshow.movie_relative_path;
  if (staleLibraryId && stalePath && (staleLibraryId !== libId || stalePath !== relativePath)) {
    try {
      const old = db.prepare("SELECT source_path FROM libraries WHERE id = ? AND type = 'gallery'")
        .get(staleLibraryId) as { source_path: string } | undefined;
      if (old) {
        const oldRoot = staleLibraryId === libId ? root : validateLibrarySource(old.source_path);
        fs.rmSync(path.join(oldRoot, ...stalePath.split("/")), { force: true });
      }
      if (slideshow.movie_item_id && slideshow.movie_item_id !== itemId) {
        db.prepare("UPDATE library_items SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
          .run(slideshow.movie_item_id);
      }
    } catch { /* best-effort — a leftover file/tile is reaped by the nightly scan */ }
  }

  setSlideshowMovieAsset(slideshow.id, { libraryId: libId, relativePath, itemId });
  return { saved: true, itemId, error: null };
}

// Delete a slideshow's rendered movie: the MP4 in the thumbnail store plus any leftover
// temp files from interrupted renders, then reset the render state to 'draft' so the
// editor shows the 'Render movie' button again. Best-effort on the filesystem (an
// unconfigured store or already-missing files aren't errors). Does NOT touch a copy
// already saved into a gallery library — that's a separate, kept asset.
export function deleteSlideshowRender(slideshow: SlideshowRow): void {
  try {
    // The render always writes to a deterministic key, so temp files can be swept even
    // when output_storage_key was never set (only failed renders ran).
    const storageKey = slideshow.output_storage_key
      ?? thumbnailStorageKey("slideshows", slideshow.id, `${slideshow.id}.mp4`);
    const finalPath = thumbnailAbsolutePath(storageKey);
    const dir = path.dirname(finalPath);
    fs.rmSync(finalPath, { force: true });
    // Sweep sibling temp files from interrupted/failed renders: `<name>.mp4.tmp-*.mp4`
    // encodes, `<name>.mp4.title-*.png` title cards and `<name>.mp4.slide-*.jpg`
    // render-sized photos (normally removed in the render's finally; a crash can
    // strand them).
    const prefixes = ["tmp-", "title-", "slide-", "batch-"].map((kind) => `${path.basename(finalPath)}.${kind}`);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (prefixes.some((prefix) => entry.startsWith(prefix))) fs.rmSync(path.join(dir, entry), { force: true });
      }
    }
  } catch { /* best-effort file cleanup */ }
  setSlideshowRenderState(slideshow.id, {
    status: "draft", jobId: null, outputStorageKey: null, outputBytes: null, renderedAt: null, error: null
  });
}
