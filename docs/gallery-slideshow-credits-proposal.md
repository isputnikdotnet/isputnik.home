# Slideshow credits & typography — proposal

Three additions to the rendered slideshow movie, building directly on the title-card
machinery that shipped with migration 33 (`slideshow-title-card.ts`,
[gallery-slideshows.md](gallery-slideshows.md)):

1. **Font styles and sizes** for the card text.
2. **Opening credits** — free multi-line text on the opening card, and an optional
   opening clip before it.
3. **Closing credits** — a closing card (text + background, same drawer), an optional
   closing clip, and the music fading out under the credits.

Everything here is **movie-only**, like the title card today. The live browser player
is untouched in v1 (parity noted under Future work).

## Why this is cheap: the card is just a segment

The render pipeline never asks ffmpeg to draw anything. The title card is rasterised
to a 1920×1080 PNG *before* ffmpeg runs (opentype.js glyph outlines → SVG paths →
sharp), and enters the filtergraph as an ordinary still — padded, cross-faded,
batched, and memory-bounded exactly like a photo (`slideshow-render.ts:740`:
`nodes = titleCard ? [titleCard, ...renderSegs] : renderSegs`).

So every feature below is either "hand the drawer different inputs" (fonts, sizes,
more lines, a second card) or "put another segment in the node list" (clips). The
batching arithmetic, memory levers, stale-flag logic, cancel path, and library
auto-save all apply unchanged, because none of them know what a segment *is*.

One hard rule inherited from the card drawer: **no dependence on ffmpeg filters or
system fonts** (the Linux ffmpeg-static build has no `drawtext`; that's why the card
is drawn in-process). Every font ships in `apps/server/src/assets/fonts/` and is laid
out by our own char-by-char + kerning code — opentype's shaper is bypassed because it
throws on DejaVu's `ccmp` table.

---

## Phase 1 — Font styles and sizes

### Named styles, not font files

Users pick a **style**, and the style maps to a bundled TTF. Candidate set (all must
be verified to (a) cover Cyrillic, (b) look right under *unshaped* char-by-char
layout — a script face that depends on contextual alternates will render as
disconnected glyphs, so each candidate gets a visual check with a Russian and an
English sample before it makes the cut):

| Style key | Face | Notes |
| --- | --- | --- |
| `classic` | DejaVu Sans (bundled today) | Default; existing movies unchanged. |
| `serif` | PT Serif (OFL) or DejaVu Serif | Book/documentary feel. |
| `bold` | DejaVu Sans Bold | Poster feel; same metrics family as classic. |
| `script` | Marck Script (OFL) | Handwritten; **verify unshaped rendering**. |
| `typewriter` | PT Mono or DejaVu Sans Mono | Home-movie / archival feel. |

Reject any candidate that fails the checks rather than special-casing it. TTF only
(opentype.js parses OTF/CFF too, but TTF keeps `getPath` on the well-tested path).
`copy-assets.mjs` already ships the whole `src/assets` tree, so new fonts reach the
Docker image with no build changes.

### Size

A **size** choice — `small | medium | large` — scaling `TITLE_SIZE`/`SUBTITLE_SIZE`
by ×0.72 / ×1.0 / ×1.35. `medium` reproduces today's card exactly. Shrink-to-fit
(`fittedSize`, `MIN_TITLE_SIZE`) stays and still wins over the size choice, so a long
title never runs off the frame.

Font and size are **per-slideshow and shared by both cards** (opening and closing) —
one typographic voice per movie, and half the columns/UI of per-card settings.

### Changes

- **Schema** (migration **40** + `schema.sql`): on `gallery_slideshows`
  - `card_font TEXT NOT NULL DEFAULT 'classic' CHECK (card_font IN (…))`
  - `card_size TEXT NOT NULL DEFAULT 'medium' CHECK (card_size IN ('small','medium','large'))`
- **`slideshow-title-card.ts`**: a `CARD_FONTS` registry (style key → ttf path);
  `cachedFont` becomes a small `Map` keyed by path; `titleCardSvg`/`titleCardPngBuffer`
  take `{ font, sizeFactor }`. `bundledFontPath()` keeps its fall-back role: an
  unknown/missing style logs and falls back to `classic`, never fails the render.
- **API** (`slideshow-routes.ts`): `cardFont`/`cardSize` in the PATCH schema (zod
  enums), echoed in `titleFields()`.
- **UI** (`SlideshowTitleCardModal.tsx`): two chip rows (same `slideshow-transitions`
  button pattern as Background), each chip labelled in its own face via a small
  `@font-face` set in the web app — display-only; the render still uses the bundled
  server copies. Preview endpoint already redraws through the render code, so the
  picture is authoritative.
- **Tests** (`gallery-slideshow-title-card.test.ts`): registry resolves every style
  to an existing file; unknown style falls back; size factors change layout; golden
  check that `classic`/`medium` is byte-identical to today's card.

---

## Phase 2 — Closing card + multi-line credits + music fade

### Multi-line text (both cards)

Today a card is exactly two lines (title + subtitle). Generalise the drawer:

- `titleCardSvg(font, title, lines: string[], backdrop, …)` — the subtitle becomes
  the first entry of `lines`. Layout: title centred as today; the lines block sits
  below it at subtitle size, line-height ×1.5, the *whole* block (title + lines)
  vertically centred. All lines share one fitted size (the minimum of their
  individual fits) so a credits block doesn't ripple between sizes.
- Caps, validated at the route: **6 lines**, 120 chars/line, 500 chars total. Enough
  for "Filmed by · Music · For grandma's 80th", not enough to need scrolling.
- Storage: the existing `title_subtitle` column simply allows `\n` (mode `custom`);
  zod max length raised to 500. `titleCardLines()` returns `lines: string[]`
  (split + trimmed + capped) instead of one nullable subtitle. `count` and `none`
  modes behave exactly as today.

**Explicitly out of scope: scrolling credits.** The pipeline renders stills; an
animated roll means per-frame generation or ffmpeg overlay animation — the same cost
class that got Ken Burns cut from exports. Static card(s) with a cross-fade and the
music fading out get the feel at a fraction of the cost.

### The closing card

A second card, drawn by the same code, appended as the **last** node:

- **Schema** (same migration 40): mirrors of the `title_*` family —
  - `closing_enabled INTEGER NOT NULL DEFAULT 0` — **off by default**; existing
    slideshows render the same movie they always did.
  - `closing_text TEXT` — NULL = "The End" (localisable later; it's data, not code).
  - `closing_lines TEXT` — the multi-line credits block (nullable).
  - `closing_seconds REAL NOT NULL DEFAULT 5` (1–15, route-validated; credits read
    slower than a title).
  - `closing_background TEXT NOT NULL DEFAULT 'black' CHECK (… 'black','photo','blur','collage')`
  - `closing_photo_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL`
  No subtitle-*mode* — the closing card is title + free lines; a photo count makes
  no sense at the end.
- **Model** (`slideshows.ts`): fields join `SlideshowUpdate`/`updateSlideshow` (the
  existing COALESCE/CASE pattern); a `closingCardLines()` sibling of
  `titleCardLines()`. All go through the same UPDATE, so **`render_stale` marking is
  automatic**.
- **Render** (`slideshow-render.ts`): `closingCardFor(slideshow, items)` mirrors the
  title-card block at ~line 712 (own `nanoid` temp PNG, registered in `titleFiles`
  for sweep-on-cancel); node assembly becomes
  `nodes = [titleCard?, …renderSegs, closingCard?]`. `chunkSegments`/`renderInBatches`
  need nothing — more nodes is just more nodes.
- **Preview**: the existing `GET …/title-card.png` route gains `?card=closing`
  (default `opening`), calling the same `slideshowTitleCardPreview` with the closing
  fields. One route, one code path, both cards previewable.

### Music fades out under the credits

Today: fixed `afade=t=out` over the movie's last 2 s (`buildFfmpegArgs`, ~line 314).
Change: when a closing card is present, the fade **starts where the card starts** and
runs `min(closingDwell, 8)` seconds — the slides end at full volume, the credits play
the music down, the movie ends in silence. Without a closing card the 2-second tail
fade stays byte-for-byte identical. This is arithmetic on values `buildFfmpegArgs`
already has (`dwells`, `total`); it needs to know only which trailing node is the
card — a `closingDwell?: number` entry in `BuildOptions`.

**Batch-render note**: audio is muxed at the **join** step (batch intermediates are
video-only), so the fade change applies only where music is already applied — verify
with the existing 320.00 s two-path equality test extended to cover a closing card.

### UI

The Title card modal becomes **"Title & credits"** (`panel` variant, as now) with a
two-way segmented switch at the top — *Opening* | *Closing* — over the same body:
preview image, enable toggle, text fields (plus the credits textarea), seconds
slider, background chips, photo strip. ~80% of the component is reused; the
opening/closing difference is which fields it binds. The editor button under
Presentation settings is relabelled accordingly.

### Tests

- Drawer: multi-line layout (count, shared fitted size, vertical centring), caps.
- `closingCardLines()` defaults ("The End", empty-lines handling).
- `buildFfmpegArgs`: afade start/duration with and without a closing card; total
  duration unchanged by the fade.
- Render assembly: node order, temp-file sweep includes the closing PNG, batched ==
  single-pass duration with both cards on.
- Route: `?card=closing` preview, PATCH validation of the new fields.

---

## Phase 3 — Opening and closing clips

A user-chosen video that plays **before the opening card** (home-video "studio
logo") and/or **after the slides, before the closing card**.

- **Source**: any gallery video the user can access — *not* restricted to slideshow
  members (an intro clip is usually shot for the purpose, not part of the show).
  Picked through the existing folder browser (`SlideshowPhotoBrowser`) in a
  videos-only mode.
- **Schema** (same migration): `intro_item_id` / `outro_item_id`
  `TEXT REFERENCES library_items(id) ON DELETE SET NULL`.
- **Render**: resolve each id against the **renderer's** accessible libraries (the
  same `resolveRendererLibraries(payload.userId)` set the slides use) — an
  inaccessible or deleted clip is *skipped with a warning*, never a failed render.
  Each becomes a normal video segment: `{ file, dwell: min(duration, 20), isVideo: true }`
  — the existing 20 s cap and audio-drop rules apply (the soundtrack stays the music
  bed). Final node order:

  `[intro clip] → [opening card] → slides… → [outro clip] → [closing card]`

- **Prescale**: videos are already exempt from prescaling (decoded frame-by-frame);
  nothing to do.
- **Music fade**: the fade anchors to the start of the *closing card*, after the
  outro clip — the clip plays under music, the card plays it out.
- **UI**: two rows in the Title & credits modal (on the matching tab): thumbnail +
  "Choose a clip…" / "Remove". Clip duration shown, with a note that it's capped at
  20 s and its own audio is dropped.
- **Tests**: node order with every combination of the four optional segments;
  inaccessible-clip skip; cap; afade anchor with an outro clip present.

---

## Cross-cutting

- **Migrations**: one migration (**40**) adds every column above (new columns on an
  existing table need a migration entry; `schema.sql` updated in the same change).
  All defaults reproduce today's movie, so an untouched slideshow renders
  byte-identically — the same compatibility bar the title card held to.
- **Stale flag**: all new fields flow through `updateSlideshow`, so an edit marks a
  `ready` movie stale exactly as today. No new logic.
- **Deletes**: `ON DELETE SET NULL` on the two clip ids and `closing_photo_item_id`;
  the render's "chosen photo left the slideshow → first slide" fallback extends to
  the closing card's photo.
- **Docs**: update [gallery-slideshows.md](gallery-slideshows.md) (rendered-movie
  section) and the user guide `docs/users/library-gallery.md`; new screenshots via
  `npm run docs:shots`. `npm run check:ui` guards the Help-page listing.
- **Verification per phase**: `npm run typecheck`, `npm run check:ui`, `npm test`,
  then a real render on the dev server (sign in as the dev admin, render a small
  slideshow with all options on, watch the Tasks card) — build passing is not proof
  the page or the movie is right.
- **Release**: each phase is releasable on its own (bump the three `package.json`s,
  `versionUpdates` entry in `status.ts`, annotated `v*` tag). Suggested: Phase 1 as
  a minor, Phases 2+3 together as the headline "Credits" minor.

## Decisions taken (flag if you disagree)

1. **Font/size are shared** by both cards (per-slideshow), not per-card.
2. **Clips come from any accessible gallery video**, not just slideshow members.
3. **No scrolling credits** — static cards only (cost class of Ken Burns).
4. **Movie-only**, like the title card; live-player parity is future work.
5. **Closing card defaults off**; every default reproduces the current movie.

## Future work (explicitly not in this proposal)

- Live-player parity: showing the cards/clips in the browser slideshow.
- Per-card font overrides; user-uploaded fonts.
- A date-range auto-subtitle ("June–August 2026") on either card.
- Scrolling credits, if per-frame rendering ever becomes affordable.
