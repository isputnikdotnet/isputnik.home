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
`jobs` queue — it appears on Control panel → Overview → Tasks as **"Slideshow movie"** with live
progress, and can be cancelled there (cancel kills the ffmpeg process and returns
the slideshow to its previous state).

- **Long slideshows render in batches** (`chunkSegments`, `renderInBatches`). Even from
  render-sized photos a single pass keeps every slide's decoder and filter chain alive
  at once — ~1.9 GB for 63 slides, growing with the slideshow. Past `BATCH_SIZE` (12)
  nodes the slides are rendered a dozen at a time to intermediates (crf 18, finer than
  the finished movie because they are encoded again) and then joined, so peak memory is
  a property of the batch size rather than of the slideshow: **1952 MB → 587 MB** on 63
  slides, for ~30% more wall time.

  The arithmetic comes out at exactly the same movie, which is the only reason this is
  safe. A batch rendered with the usual padding runs `sum(dwell) + T`: it ends with a
  T-long tail of its last slide, which is precisely what the next batch cross-fades
  over. Joining with the same overlap gives `sum(all dwells) + T` — the single-pass
  total — and `n-1` transitions all told. The join passes `prePadded` so those inputs
  aren't padded a second time (there is no footage past the end of a file), and each
  batch's length is **probed** rather than predicted, because the join's offsets are
  absolute times into those files. Verified end to end: both paths produce 320.00s.

- **One decoder thread per input** — the single biggest memory lever here. ffmpeg
  threads each input's decoder across every core by default and each thread holds
  frames, which with an input per slide dominates everything else. Measured on the
  six-way join: 1621 MB as-is against 541 MB with `-threads 1` per input, for 16% more
  time.

- **Photos are scaled to the canvas BEFORE ffmpeg sees them** (`prescaleSegments`,
  sharp, one photo at a time). Every slide is its own ffmpeg input and every input
  holds decoded frames at the SOURCE's resolution for the whole render, so a render's
  memory is source-megapixels × slide-count — while the movie is 1080p regardless.
  Measured over 63 slides: ~1.9 GB from 1080p sources, ~3.9 GB from 12 MP phone
  photos, and ~17 GB from a modern camera's, which is a self-hosted server falling
  over rather than rendering a movie. Feeding render-sized copies instead took the
  12 MP case from 3910 MB / 313s to 1659 MB / 58s, and the result no longer depends
  on how big the originals were. The scaled copies also carry EXIF **and** the user's
  own rotation, so movies finally show photos the way the gallery does. Videos are
  left alone — a video decodes frame by frame, so its cost doesn't grow with the
  length of the slideshow.

- **Title card**: unless it is switched off, a movie opens on a card carrying the
  slideshow's name and photo count, cross-fading into the first photo with the
  slideshow's own transition.

  Everything about it is per-slideshow (the `title_*` columns, migration 33, edited
  through the editor's **Title card** dialog): whether there is one at all, its
  title and second line (photo count / a line of your own / nothing), how long it
  holds (1–15s), and **what the words sit on** —

  | Background | What it draws |
  | --- | --- |
  | `black` | The original card: white text on an opaque black frame. |
  | `photo` | One of the slideshow's own slides, cover-cropped to the frame. |
  | `blur` | The same slide, blurred (σ 24) — colour and mood, no competing subject. |
  | `collage` | Up to 12 of its photos, spread evenly across the slideshow, tiled on a landscape-leaning grid. |

  **Lettering** (the `card_font` / `card_size` columns, migration 43): the card's text
  can be set in one of five bundled faces — Classic (DejaVu Sans, the face every
  earlier movie used), Serif (DejaVu Serif), Bold (DejaVu Sans Bold), Script
  (Marck Script) and Typewriter (PT Mono) — at Small / Medium / Large
  (×0.72 / ×1 / ×1.35, applied to the title and second line together; shrink-to-fit
  still wins, so a long title never leaves the frame). Faces that run optically
  small or large at equal point size carry a per-face nudge (`CARD_FONT_OPTICAL`)
  so every style *looks* the same size. A face earns its place by passing two
  checks — full Cyrillic coverage, and looking right under the drawer's unshaped
  character-by-character layout — and one that fails is replaced, not
  special-cased (PT Serif failed: its '6' parsed to a broken fragment through
  opentype.js, so the serif style is DejaVu Serif; see
  `apps/server/src/assets/fonts/README.md`). The editor's font chips render in the
  real faces via copies under `apps/web/public/fonts/`, and a style whose server
  file goes missing falls back to Classic rather than costing the card.

  Anything but `black` is drawn under a 45% black scrim, and the glyphs carry a dark
  outline — white text has to survive landing on a bright sky in a photo nobody chose
  for its contrast. Only PHOTOS can be a background: sharp reads stills, and a video
  frame would have to be decoded first, so a slideshow of nothing but videos falls
  back to the black card. So does a chosen photo that has since left the slideshow —
  it drops to the first slide, because the setting still means "a photo".

  The defaults reproduce the fixed card 3.1.x drew, so an untouched slideshow renders
  the same movie it always did.

- **Closing card** (the `closing_*` columns, migration 44; edited on the same
  dialog's **Closing card** tab): the movie can end on a second card — an end title
  ("The End" unless renamed, `closingCardLines`) over the same background choices,
  plus up to **six lines of credits** (`closing_lines`, newline-separated; capped at
  120 chars/line and 500 in all by the route, and again by the drawer's
  `splitCardLines`). It is **off by default** — an untouched slideshow still ends on
  its last photo. The card is appended as the last node, so batching, transitions
  and cancel treat it exactly like a slide. With music set, the **fade-out anchors
  to the card**: instead of the fixed 2-second tail, the fade starts where the card
  starts and runs up to 8 s (`BuildOptions.closingDwell`, applied where the music is
  muxed — the single pass or the batch join) — the slides end at full volume, the
  credits play the music down, the movie ends in silence.

  Multi-line text also reaches the **opening** card: "My own line" is now "My own
  lines", the same six-line/500-char contract. One line keeps the exact geometry
  drawtext produced (bit-for-bit with every older card); two or more switch to a
  centred block where all lines share one fitted size, so a long credit shrinks
  them together instead of rippling the block through several sizes. Scrolling
  credits are deliberately not offered — an animated roll needs per-frame
  generation, the cost class that kept Ken Burns out of exports.

- **Opening and closing clips** (`intro_item_id` / `outro_item_id`, migration 45):
  a gallery **video** that plays before everything else (a home-video "studio
  logo") and/or after the last photo, before the closing card — final order
  *intro clip → title card → slides → outro clip → closing card*. Chosen on the
  matching tab of the same dialog, through the folder browser in a single-pick
  videos-only mode (`GalleryFolderPicker pick="video"`), from **any** accessible
  gallery library — deliberately not just slideshow members, since an intro is
  usually shot for the purpose. Each becomes an ordinary video segment: its own
  length capped at 20 s, audio dropped (the soundtrack stays the music bed), and
  the music's fade still anchors to the closing *card*, so an outro clip plays
  under full music. A clip that has been deleted (`ON DELETE SET NULL`), moved out
  of reach, or lost its file is **skipped with a warning** — it costs the clip,
  never the movie. The detail response resolves each id to a summary
  (`introClip`/`outroClip`: title, thumb, length) against the viewer's access.

  The editor previews the card through `GET …/slideshows/:id/title-card.png`, which
  runs the SAME code the render does (`slideshowTitleCardPreview`) and only scales the
  result down. Choosing a background you cannot see is guesswork; this is a picture of
  the actual first three seconds.

  **It is drawn before ffmpeg runs**, by `slideshow-title-card.ts`: the text becomes
  glyph outlines from the bundled DejaVu Sans (`apps/server/src/assets/fonts`, full
  Cyrillic coverage) via opentype.js, those become an SVG of `<path>`s, and sharp
  rasterises a 1920×1080 PNG that enters the filtergraph as an ordinary still —
  normalised exactly like a photo.

  It used to be ffmpeg's `drawtext`, and that cost every Linux user their whole
  movie: `ffmpeg-static` ships a different binary per platform, and the Linux one
  (John Van Sickle 7.0.2) has no `drawtext` despite linking libfreetype, while the
  Windows build used in development (gyan 6.1.1) does. ffmpeg parses the whole graph
  before encoding, so the card failed the render outright with "Filter not found".
  Drawing it here removes the dependency instead of working around it — no optional
  filter, no system fonts, no fontconfig, the same card on every platform — and a
  title too wide for the frame now shrinks to fit instead of running off both edges.

  Note glyphs are laid out character by character with kerning rather than through
  opentype's own text shaping: its shaper throws on DejaVu Sans's `ccmp` table
  ("substitutionType : 62 lookupType: 6 … is not yet supported").

  What ffmpeg still has to provide is probed once per process (`ffmpegFilters` /
  `capabilitiesFrom`): without `xfade` the slides are concatenated with hard cuts
  rather than the render failing. An unprobeable ffmpeg is assumed capable.
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
