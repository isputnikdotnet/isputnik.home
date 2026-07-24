# Gallery: Custom Slideshows & rich Memories — proposal

Status: **ALL PHASES BUILT** — 1 (editor + live preview), 2 (music), 3 (rich
Memories), 4 (MP4 render). The system has since grown well past this proposal
(title cards, dip-to-black/random transitions, transition-length control,
save-to-library, suggestion previews, near-duplicate filtering, folder-browser
adds — shipped through 1.11.0); the current behavior is documented in
[gallery-slideshows.md](gallery-slideshows.md). Companion to
[gallery-library.md](gallery-library.md) (what ships today) and successor to
[gallery-memories-albums-proposal.md](gallery-memories-albums-proposal.md),
whose Phase-5 in-browser slideshow **shipped in 1.8.23**. This proposal
deliberately **revisits two things that earlier plan set aside**:

- it **revives MP4 movie export**, which that doc dropped from scope
  ("*If revisited later: it fits the existing background-jobs + Tasks-page
  infrastructure, and ffmpeg is already a gallery dependency*"), and
- it **enriches Memories** from the shipped date-only "On this day" match into
  event / location / person clustering.

## Goal

Let a user turn a set of photos into a **saved, customizable, rendered
slideshow movie** — pick the photos, set their order, choose music, a transition
style, and a per-slide duration, then export a real `.mp4` they can play,
download, and share. Complement that with **Memories**: on-demand *suggested*
slideshows the gallery assembles from related photos (same time / place /
people), so a good movie is one tap away with zero manual curation.

This is the "highlight movie" experience of Amazon Photos / Google Photos,
scoped to a private self-hosted family library — which removes the usual
licensing constraint on music and lets user-supplied audio be a first-class
source.

### How it relates to what already exists

The primitives are largely built; this feature composes them rather than
replacing anything.

| Existing piece | Role in this feature |
| --- | --- |
| `GalleryLightbox` auto-advance slideshow (1.8.23) | the **live preview / editor player** — no encode needed to see a slideshow |
| `gallery_albums` + `gallery_album_items` (`position REAL`) | the "specific photos, in an order" model a slideshow's item list mirrors |
| `gallery_details.taken_at` / `gps_lat,gps_lng` / `gallery_people.centroid` | the signals Memories clusters on — all already indexed |
| generic `jobs` table + worker + [`job-progress.ts`](../apps/server/src/modules/library/shared/job-progress.ts) + Tasks page | the async **render pipeline** host (progress, ETA, retry, failure surface) |
| bundled `ffmpeg-static` invoked via `spawn` in [`media.ts`](../apps/server/src/modules/library/gallery/media.ts) | the **encoder** — no new binary or dependency |

Nothing here is a new top-level media type; it is a gallery-native entity under
`modules/library/gallery/`, alongside the faces and albums tables, and every
read filters items by the viewer's library access (the collections-hydrator
pattern).

## Decisions taken (this proposal's scope)

1. **Output = rendered MP4 file.** The finished slideshow is a real encoded
   video, not only a live in-browser experience. Live playback still exists —
   it is the *editor preview* (cheap, reuses the lightbox) — but the deliverable
   is a downloadable/shareable `.mp4`.
2. **Music = both bundled and user-uploaded.** Ship a small curated
   royalty-free starter set (one-tap "add music", zero setup) *and* let users
   upload their own tracks.
3. **Memories = on-demand / suggested.** Candidates are computed when the user
   opens the Memories surface (or hits "Surprise me"); nothing is persisted or
   scheduled until the user saves or renders one. No background generation job,
   no notification surface in v1.

## Data model

New tables (new tables auto-apply from `schema.sql`; no `migrations[]` entry —
the no-migration-in-dev rule). A new **column** on an existing table would need a
migration, but this design adds none.

```sql
-- A saved slideshow: an ordered photo set PLUS presentation settings and the
-- state of its most recent render. Gallery-native, spans all gallery libraries;
-- items are access-filtered per viewer on read.
CREATE TABLE IF NOT EXISTS gallery_slideshows (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  -- Where this slideshow came from, so a customized Memory remembers its origin
  -- and a "regenerate" can re-run the same query. 'manual' = built by hand.
  source_kind    TEXT NOT NULL DEFAULT 'manual'
                   CHECK (source_kind IN ('manual', 'memory', 'album')),
  source_ref     TEXT,                     -- album id / memory descriptor (nullable)
  music_track_id TEXT REFERENCES gallery_music_tracks(id) ON DELETE SET NULL,
  transition     TEXT NOT NULL DEFAULT 'crossfade'
                   CHECK (transition IN ('none','crossfade','fade','slide','kenburns')),
  slide_seconds  REAL NOT NULL DEFAULT 4,  -- default per-slide dwell
  -- Render state of the LATEST export. The MP4 lives at output_storage_key.
  render_status  TEXT NOT NULL DEFAULT 'draft'
                   CHECK (render_status IN ('draft','queued','rendering','ready','failed')),
  render_job_id  TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  output_storage_key TEXT,                 -- generated MP4; regenerated on re-render
  output_bytes   INTEGER,
  rendered_at    TEXT,
  render_error   TEXT,
  created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Ordered membership. Mirrors gallery_album_items so drag-reorder works the
-- same way (position REAL lets a drag insert between neighbors). A per-item
-- dwell override lets one slide linger longer than slide_seconds.
CREATE TABLE IF NOT EXISTS gallery_slideshow_items (
  slideshow_id  TEXT NOT NULL REFERENCES gallery_slideshows(id) ON DELETE CASCADE,
  item_id       TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position      REAL NOT NULL,
  dwell_seconds REAL,                       -- NULL = use slideshow.slide_seconds
  PRIMARY KEY (slideshow_id, item_id)
);

-- Music tracks. Bundled royalty-free tracks (builtin=1, shipped with the app)
-- and user uploads share one table; user tracks flow through the existing
-- upload path and are stored like other assets.
CREATE TABLE IF NOT EXISTS gallery_music_tracks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  artist       TEXT,
  builtin      INTEGER NOT NULL DEFAULT 0,  -- 1 = shipped starter track (undeletable)
  storage_key  TEXT NOT NULL,               -- file location (or bundled asset path)
  duration_seconds REAL,
  uploaded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL for builtin
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

Deletion semantics: deleting a slideshow cascades its items and removes the
rendered MP4 (cleanup, mirroring how face crops / previews are reclaimed);
deleting a music track that a slideshow references sets `music_track_id` NULL
(the slideshow keeps playing, silent, until re-edited); a `builtin` track cannot
be deleted.

## Memories (on-demand suggestions)

An endpoint that clusters the viewer's *accessible* gallery items into candidate
"moments" and returns the top N as **proposed** slideshows (never persisted
until saved). Pure SQL + a scoring pass over columns already indexed — no ML, no
new tables, no background job.

`GET /api/library/gallery/memories/suggestions` →
`[{ title, subtitle, cover_item_id, item_ids: [...], signals: {...} }]`

Clustering heuristic (composable, cheap):

- **Time** — sort accessible items by `taken_at`; split into moments on a
  gap > *T* (e.g. 6h intra-day, or a day boundary for multi-day trips).
- **Location** — within a time cluster, keep items whose GPS is within *R* km of
  the cluster centroid (items lacking GPS stay by time alone). Reverse-geocoding
  is **not** required for v1 — a coordinate cluster titles as "A day out" and can
  gain a place name later.
- **People** — a cluster gains a "with Mum & Dad" subtitle when
  `gallery_people` membership is dense across its items; a person-scoped memory
  ("A year with Emma") is the same query filtered to one `gallery_people.id`.
- **Scoring / titling** — prefer clusters with more items, tighter time/space,
  and recognizable people; title from the dominant signal
  (`On this day · 2019` reuses the shipped date match; `A day in <month>`;
  `<Person>`). Drop clusters below a minimum item count so a movie is worth
  watching.

The existing **shipped date-only Memories** ("On this day") becomes one signal
feeding this richer surface rather than a separate mechanism. A "Surprise me"
action just returns the current top suggestion. Selecting a suggestion opens the
**slideshow editor** pre-filled with its items — from there the user customizes
and renders.

## The MP4 render pipeline (the heavy part)

The bulk of the effort and the main risk. It rides the existing generic `jobs`
table + worker, so progress/ETA/retry/failure all surface on the Tasks page for
free via [`job-progress.ts`](../apps/server/src/modules/library/shared/job-progress.ts).

**Flow**

1. `POST /api/library/gallery/slideshows/:id/render` validates the slideshow
   (≥1 accessible photo), sets `render_status='queued'`, inserts a
   `type='gallery-slideshow-render'` job, stores its id in `render_job_id`.
2. The worker claims the job, sets `rendering`, resolves the ordered item files
   (skipping items the *creator* can no longer access), builds the ffmpeg
   command, and encodes to a temp file, writing progress as segments complete.
3. On success: move the MP4 to `output_storage_key`, set `ready`, `rendered_at`,
   `output_bytes`. On failure: `failed` + `render_error`; the job's `attempts`
   / `max_attempts` give one bounded retry.
4. The finished MP4 streams via the existing hijack + `pipe(reply.raw)` path
   (the binary-streaming convention), with a `download` variant.

**ffmpeg command (bundled `ffmpeg-static`, `spawn` — same as `media.ts`)**

- **Normalize every input** to a common canvas first (`scale` + `pad`), because
  portrait phone photos sit next to landscape shots — this is the fiddly core.
- **Ken Burns** via `zoompan`; **transitions** via `xfade` between adjacent
  slide segments; **concat** the segments.
- **Per-slide duration** from `dwell_seconds ?? slide_seconds`.
- **Audio**: mux `music_track_id`; loop or trim the track to the video length
  and fade the tail. No track → silent video.
- Target H.264 + AAC in MP4 (the format the gallery already assumes a browser
  `<video>` can play), a sane resolution cap (e.g. 1080p), and a
  quality/size-balanced CRF.

**Videos as slides** — videos **are** included: each contributes its own clip
(capped at 20s, normalized to the shared 1080p/30fps canvas) transitioning like a
photo. Its audio is dropped — the movie's soundtrack is the music bed (or silence);
mixing per-clip audio into the transition timeline is a later step.

**Storage & retention** — a rendered MP4 is a new storage consumer on the Unraid
box. v1: keep the latest render per slideshow (re-render overwrites); editing any
setting marks the slideshow `draft` and invalidates the stale MP4. A retention
sweep (drop movies not watched in N days, regenerate on demand) is a later
nicety that fits the existing maintenance-tasks table.

## UI

- **Slideshows** surface in the gallery (a tab alongside Timeline / Folders /
  Map / People / Albums, or a section within Memories — TBD in build). Cards
  show cover + name + a **render badge** (Draft / Rendering N% / Ready / Failed).
- **Editor** (a `shared/Modal` `panel`): reorderable photo strip (drag —
  `position REAL` already supports it), music picker (bundled + upload), a
  transition selector, a duration control, and a **Preview** button that plays
  the current settings live in the existing lightbox player (no encode). A
  **Render movie** button enqueues the export; while rendering, the Tasks page
  and the card badge track progress.
- **Music picker** — bundled tracks listed first; "Upload track" flows through
  the existing upload path. Follows the shared Button/Modal/MessageBox
  conventions (no hand-rolled modal, no `window.confirm`).
- **Ready state** — inline `<video>` playback of the rendered MP4 + a Download
  button; re-render available after edits.

## Build order

Each phase is independently shippable; effort increases down the list, and the
expensive encoder is built **last**, against an editor that already works.

1. **Slideshow entity + editor + live preview.** — **BUILT.** CRUD, pick/reorder
   photos, choose transition/duration, live-preview in the lightbox. No music, no
   encode yet — already a satisfying feature on its own. As built: `gallery_slideshows`
   + `gallery_slideshow_items` (+ `gallery_music_tracks` declared for Phase 2, all
   render_* columns declared for Phase 4, so later phases add no migration);
   `slideshows.ts` / `slideshow-routes.ts` under `/api/library/gallery/slideshows`
   (CRUD, batch add/remove, **reorder** — the endpoint albums lack); a **Slideshows**
   tab with cover cards + create dialog; a `GallerySlideshowEditor` (drag-reorder
   with ‹/› + keyboard fallbacks, per-photo remove, transition picker, seconds-per-
   photo slider); `AddToSlideshowModal` in the multi-select bar + create-and-add;
   and the lightbox extended with a `transition` (crossfade/fade/slide/Ken Burns/
   none, Ken Burns zoom tied to the dwell via `--lb-dwell`) + `initialInterval` for
   the saved-slideshow preview.
2. **Music model.** — **BUILT.** `gallery_music_tracks` (built-in beds + user
   uploads share one table + one storage location: the thumbnail store's shared
   `music` bucket). `music.ts` synthesises six beds on startup with the bundled
   ffmpeg (idempotent, no audio blobs in the repo) — three sustained ambient pads
   plus three looping chord-progression beds (I-V-vi-IV etc., each chord's triad
   gated to its time slot then mixed, for a more melodic feel) — encoded as **FLAC**,
   deliberately: libmp3lame *and* the native AAC encoder both assert / drop frames
   non-deterministically on the beds' pure-sine chords (their psychoacoustic models
   choke on pathologically tonal input); FLAC is lossless with no such model and
   still compresses these pads to ~300 KB. `music-routes.ts` under
   `/api/library/gallery/music` (list, multipart upload via the shared upload
   primitive, delete own/admin — beds undeletable, range-aware stream). Slideshows
   gained `music_track_id` (FK `ON DELETE SET NULL` → degrade-to-silent); the detail
   response resolves `musicTitle`/`musicUrl`. Web: `MusicPicker` (built-in + upload
   sections, in-place looped preview, select/clear/delete) opened from a Music
   control in the editor; the live-preview `GalleryLightbox` plays the chosen bed
   looped, synced to play/pause, and mutes video clips so the two don't fight.
3. **Rich Memories suggestions.** — **BUILT.** `memories.ts`
   `suggestGalleryMemories()` clusters the viewer's accessible dated items into
   "moments" (split on >5h gaps, capped at a 14-day span, ≥6 items), scores them
   (size + geotag bonus + gentle recency), titles from the date span, samples a
   ≤40-photo montage, and adds a subtitle with the top **user-named** people
   (`gallery_people.name != ''` — auto-clusters carry an empty name).
   `GET /api/library/gallery/memories/suggestions` returns them as *proposed*
   slideshows (nothing persisted). The shipped date-only `/memories` ("On this
   day") stays as its own anniversary feed. Slideshow create now accepts
   `itemIds` + `sourceKind`/`sourceRef`, so a memory becomes a slideshow
   (`source_kind='memory'`) in one call. Web: a **Memories** card section (the tab
   now appears whenever suggestions OR anniversaries exist) with a "Surprise me"
   action; tapping a card creates the slideshow and drops straight into its editor.
4. **MP4 render pipeline.** — **BUILT.** `slideshow-render.ts` rides the generic
   `jobs` table + a 2s poller (like the scan/face workers): `POST /slideshows/:id/render`
   enqueues, the worker runs ONE ffmpeg command (each photo normalized to 1080p →
   xfade transition → music bed muxed, `-stream_loop` + out-fade), writes the H.264+AAC
   MP4 into the thumbnail store's `slideshows` bucket, and moves the slideshow through
   queued → rendering → ready|failed with live `-progress` percent in the job payload.
   `GET /slideshows/:id/movie` streams it (range-aware, `?download` for Save As); the
   detail resolves `movieUrl`/`renderPercent`/`outputBytes`; content/settings edits
   knock a ready render back to `draft` (and delete reclaims the file). Web: a **Movie**
   panel in the editor (Render → progress bar → inline `<video>` + Download + Re-render)
   and a "Movie ready"/"Rendering…" badge on the list cards; the editor polls while a
   render runs.

   **Videos ARE included** — each clip is capped (20s), normalized to the shared canvas,
   and transitioned like a photo, with its audio dropped (the soundtrack is the music
   bed). The rendered movie is versioned by `rendered_at` in its URL so a re-render
   (e.g. after adding music) isn't masked by the browser's cache of the previous render.

   **One measured decision** (verified on real photos before committing): **Ken Burns is
   NOT rendered** — ffmpeg's `zoompan` re-renders every frame and ran ~25× real-time (a
   4-photo/9s clip took 231s and 51 MB on a modest box), impractical on an Unraid host,
   so a `kenburns` slideshow *exports* as a crossfade while the animated zoom stays a
   cheap live-preview effect. A 4-photo crossfade movie renders in ~8s; the AAC re-encode
   of the FLAC music bed is robust here (it decodes real samples, unlike the pure-lavfi
   path that broke bed generation in Phase 2).

## Open questions

- **Where do Slideshows live** — their own gallery tab, or folded into a
  reworked Memories surface? (Leaning: a tab, with Memories feeding it.)
- **Render resolution / quality knobs** — fixed sensible default, or
  user-selectable (720p/1080p, quality)? v1 leans fixed.
- **Music length vs. movie length** — loop the track, trim it, or auto-fit
  per-slide durations so the movie ends with the song? v1: loop + tail fade.
- **Editing rights** — creator + admins (mirrors albums), or every member with
  access? (Leaning: creator + admins, like albums.)
- **Re-render cost guard** — should a large render warn before it runs, given
  it's minutes of CPU on the Unraid box?

## Non-goals (v1)

- **Per-clip video audio in the movie** — videos are included visually, but their
  audio is dropped; the soundtrack is the music bed (or silence). Aligning per-clip
  audio to the transition timeline is a later step.
- **Background auto-generated Memories** + notifications — suggestions are
  on-demand only.
- **ML/semantic curation** (object/scene recognition, aesthetic ranking) —
  clustering uses time/GPS/faces already indexed, nothing more.
- **Reverse-geocoded place names** in memory titles — coordinate clusters only;
  place names are a later enrichment.
- **Sharing the rendered movie via public links** — reuses the gallery
  share-link infrastructure later, but is out of this proposal's scope.
