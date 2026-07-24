# Gallery slideshows

Slideshows are the gallery's presentation feature: an ordered set of photos and
videos with transitions, timing, and music, playable full-screen in the browser and
exportable as an MP4 movie. They live under **Gallery → Slideshows**. (Albums
*organize*; slideshows *present*. Same access model as albums: every member can view,
the creator and admins can edit.)

Originally designed in [gallery-slideshows-proposal.md](gallery-slideshows-proposal.md)
(shipped in 1.9.0); this doc describes the system as of **1.11.0**.

## Building a slideshow

- **Create** one under the Slideshows tab, from a Timeline multi-select ("Add to
  slideshow"), from the photo viewer, or from a **suggestion** (below).
- **Add photos** from inside the editor: the "Add photos" button opens a folder
  browser over all gallery libraries (or one) — select across folders and add
  directly; photos already in the slideshow are marked "Added" and adds are
  idempotent.
- **Reorder** by drag (or ‹ › buttons); remove per-photo. Any content or settings
  change marks a previously rendered movie stale (back to Draft) so downloads are
  never out of date.

## Presentation settings

- **Transition**: Crossfade, Fade, Slide, Ken Burns, **Dip to black** (fade out to
  black, fade the next photo in — the classic film cut), **Random** (a different
  style at every cut), or None.
- **Seconds per photo** (1–20s) and **Transition length** (0.5–5s, default 2s) —
  the latter drives both the live player's animations and the movie's xfade
  duration, so the preview matches the export.
- **Music**: user-uploaded tracks only (the synthesized built-in beds were retired
  in 1.11.0). Preview in place; the track loops under the live slideshow and is
  muxed into the movie with a tail fade.

During live playback the previous photo is kept rendered beneath the incoming one,
so transitions genuinely blend photo-into-photo (Ken Burns holds its final zoom
across the cut; a dip-to-black fades the old photo out first). Manual arrow
browsing keeps quick animations; only playback uses the slower cinematic timings.

## Suggested slideshows

The Slideshows tab surfaces **suggestions** — moments clustered from time, GPS, and
named people ("August 24–25, 2007 · with Lucas"). Tapping one opens a **preview** of
its photos; nothing is created until you press "Create slideshow". Suggestions skip
**near-duplicate photos**: every photo gets a 64-bit perceptual fingerprint (dHash,
computed from its cached thumbnail during normal scans — `gallery_details.phash`),
and burst shots / re-takes within a few bits of an already-picked photo collapse to
one representative (`similarity.ts`; threshold 10/64 bits). Photos not yet hashed
are always kept; the nightly scan backfills the catalog.

## The rendered movie

"Render movie" encodes an MP4 (H.264/AAC, 1080p) in the background via the shared
`jobs` queue — it appears on Control panel → Tasks as **"Slideshow movie"** with live
progress, and can be cancelled there (cancel kills the ffmpeg process and returns
the slideshow to its previous state).

- **Title card**: every movie opens with a ~3s black card carrying the slideshow's
  name and photo count (drawtext with the bundled DejaVu Sans font —
  `apps/server/src/assets/fonts`, full Cyrillic coverage), cross-fading into the
  first photo with the slideshow's own transition.
- **Ken Burns exports as a crossfade** (ffmpeg's zoompan renders ~25× real-time —
  impractical); it remains a live-player effect.
- **Videos are included** (capped at 20s per clip, audio dropped — the soundtrack
  is the music bed or silence).
- **Save to a gallery library**: an admin setting on the Slideshows tab ("Save
  rendered movies to") picks a default movie library. Each successful render is
  also filed there as a real gallery video under `Slideshow movies/`. Re-renders
  overwrite the same file/item (no duplicates); renaming the slideshow moves the
  movie to the new name on the next render, retiring the old item. Deleting a
  slideshow keeps the saved movie — it's an exported asset.
- **Delete movie**: removes the rendered MP4 and any leftover temp files and
  returns the slideshow to Draft; a copy saved to a gallery library is kept.

## Implementation notes

- Core files: `apps/server/src/modules/library/gallery/slideshows.ts` (model),
  `slideshow-routes.ts` (API), `slideshow-render.ts` (ffmpeg pipeline + worker +
  library auto-save), `slideshow-settings.ts` (default movie library, in
  `app_settings`), `similarity.ts` + `media.ts#computeDhash` (near-duplicate
  detection), and on the web `GallerySlideshowEditor.tsx`, `GalleryLightbox.tsx`
  (player), `SlideshowPhotoBrowser.tsx` (folder picker).
- The `transition` CHECK constraint has been widened twice (migrations v14 → random,
  v18 → dipblack) using a no-rename table rebuild — under `foreign_keys=ON` a RENAME
  rewrites child REFERENCES clauses even with `legacy_alter_table` (measured), which
  once stranded `gallery_slideshow_items`; v15 self-heals that state.
- Render temp files (`*.mp4.tmp-*`, `*.mp4.title-*`) are swept before each render
  and by "Delete movie" — server restarts mid-render otherwise strand them.
