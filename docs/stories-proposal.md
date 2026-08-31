# Stories — proposal

Status: **Phases 1–4 built** (schema, `modules/stories`, index / reading view /
editor; tags, person and quote blocks, suggestions, subject registry; guest
links with a public viewer; presentation mode). Phase 5 is a menu of options,
none started. Companion to
[gallery-library.md](gallery-library.md),
[gallery-memories-albums-proposal.md](gallery-memories-albums-proposal.md)
(albums/slideshows, largely shipped), [sharing.md](sharing.md), and
[family-tree.md](family-tree.md).

## Goal

A **Story** is an authored narrative page built from content the library
already holds: rich text, photos, videos, albums, slideshows, maps, and
timeline chapters with dates and places. It is a *presentation layer* —
everything is referenced, nothing is copied. Think interactive digital
journal / documentary: "Minnesota, summer 2004" as a scrollable page that
interleaves prose, a map, the vacation album, and the highlights slideshow,
shareable with the family as one link.

The mental model, extending the table in the memories/albums proposal:

| Structure | What it answers                  | Curation  | Content                    |
| --------- | -------------------------------- | --------- | -------------------------- |
| Album     | "how do I organize photos?"      | manual    | gallery items              |
| Slideshow | "how do I present a photo set?"  | manual    | gallery items + cards/music|
| Collection| "what goes together across types?"| manual   | refs to any media          |
| **Story** | "what happened, in what order, and why does it matter?" | manual | text + refs to albums, slideshows, media, maps, people |

## Why build it (research summary, 2026-08)

Market research before this proposal (mainstream photo apps, self-hosted
competitors, travel/story apps, genealogy platforms):

- **Nobody ships this exact model.** The closest pieces exist separately:
  Google Photos album "enrichments" (inline text / location / map blocks
  interlaced with photos — referenced media, link-shared), Polarsteps
  (trip = "steps" pinned to date + place, map synced to a timeline — the
  thriving structural match for our chapters), Knight Lab StoryMap/TimelineJS
  (slides bound to place/time — the scrollytelling standard), and
  FamilySearch "stories" (text + up to 10 photos tagged to tree persons).
  No product combines them over one library.
- **Self-hosted is an empty niche.** Immich, PhotoPrism, Nextcloud Memories,
  LibrePhotos: none has a story/narrative feature. Immich has ~9 fragmented
  open requests for text-in-albums / journals / stories; maintainers closed
  the journal one ("Immich is not a journaling app") while leaving album-text
  open. A Stories feature is a genuine differentiator.
- **Demand for family storytelling is proven where people pay for it.**
  StoryWorth (prompted memoirs → printed book): 64k+ Trustpilot reviews,
  ~95% positive, 1M+ books printed. Remento: ~$4.3M raised, Shark Tank deal.
  FamilySearch Memories: 40M+ uploads, called one of their best-received
  features. Category projected to roughly double to ~$850M by 2030.
- **Cautionary pattern:** standalone "beautiful story page" products died
  (Storehouse, Adobe Spark Page, Google+ Stories, 1000memories, Twile).
  Survivors anchor the story to something durable: a map+timeline spine
  (Polarsteps), a photo library (Google), a printed artifact (StoryWorth).
  This design has two of those anchors — the timeline/place spine and the
  existing library.
- **Engagement reality:** these features work when *one motivated person
  curates* and everyone else views (or answers prompts). That is exactly the
  self-hosted family-server shape — so the reading/viewing experience is
  first-class in this design, and collaborative editing is explicitly out of
  v1.

## What already exists to build on

Almost everything except the block model and rich text:

- **Reference-not-copy** is the house pattern: the polymorphic subject
  registry (`modules/social/subjects.ts`) hydrates `(entity_type, entity_id)`
  to title/cover/href with per-viewer access filtering and an
  `available: false` degrade for deleted targets. Albums, slideshows, and
  gallery items are already hydratable subjects.
- **Sharing** (`shares` / `share_links`, module-keyed) needs only a new
  `story` module value. The `gallery_album` link precedent — photos resolved
  against the *link creator's* rights at serve time — is exactly the rule a
  shared story needs for its embedded content.
- **Maps**: leaflet + markercluster, `gps_lat/gps_lng` on `gallery_details`,
  server-side Nominatim geocode proxy, `GalleryPlaceSearch` /
  `GalleryLocationPicker` / `GalleryMiniMap` components.
- **Partial dates**: the family-tree convention — partial ISO strings
  `'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'` (lexicographic = chronological),
  `partialDateSchema`, `date`/`end_date` for ranges, shared
  `PartialDateField` input. Chapters adopt it unchanged; no second date
  system.
- **Tags**: `taggables` is polymorphic with no type restriction — story
  tagging is "start writing rows", plus one entry per type in the tag browse
  counts.
- **Markdown rendering**: `marked` + `DOMPurify`, dynamically imported, used
  by `GuidePage.tsx` today.
- **Viewer surfaces**: `GalleryLightbox` already contains the slideshow
  player (autoplay, transitions, music, preloading); `SharePage.tsx` is the
  chrome-free public viewer with a per-module payload union.

## Design decisions

### Placement: `modules/stories/`, not under `library/`

A story is not a media type — nothing on disk is scanned into it. Like
Collections it is a cross-cutting product feature composing other entities,
so it is a sibling module (`apps/server/src/modules/stories/`, registered in
`index.ts` beside `collectionsPlugin`), hydrating references through
`subjects.ts`. Web routes are top-level `/stories` and `/stories/:id` — not
an eighth gallery view.

### Rich text = Markdown, not WYSIWYG

Text blocks are Markdown edited in a plain `<textarea>` (monospace, with an
edit/preview toggle; optionally a small toolbar that inserts syntax), rendered
through the exact GuidePage pipeline: `marked` → `DOMPurify.sanitize` →
`dangerouslySetInnerHTML`, with a **tightened allowlist** (no raw HTML
pass-through: headings, emphasis, lists, blockquote, links with
`rel="noopener"`, code; no images — images are media blocks, so access
control can't be bypassed by hotlinking `![](...)`).

Rationale: a WYSIWYG editor (TipTap/ProseMirror class) would be the largest
dependency in the web app and a new XSS surface right after the
internet-exposure hardening effort. Markdown covers everything the concept
needs (headings, quotes, links, formatting) at near-zero risk, and the
sanitizer already exists. Revisit only if editing friction proves real.

### Structure: Story → Chapters → Blocks, chapters always present

Every story has ≥1 chapter (a new story gets one untitled chapter
automatically), so the reader, editor, and player all handle exactly one
shape. A simple story just never names its single chapter — the UI hides the
chapter chrome when there is only one untitled, undated chapter, so "flat
journal page" and "chaptered documentary" are the same data model.

Chapters carry the narrative timeline: title, partial date or range, an
`approx` flag, a free-text place with optional coordinates, and an optional
description. Unknown date = all date fields null (chapter keeps its manual
position). This deliberately mirrors Polarsteps' "steps" and StoryMap's
slides — date + place as the spine.

Chapter "events" stay independent of `family_tree_events` (those are
GEDCOM-shaped per-person facts); the bridge to the family tree is the
`person` block and person tags, not shared event rows.

### Access model

Album rules, verbatim: **viewable by every member, editable by creator +
admins**. Referenced content is filtered per viewer at read time (a member
who can't access the Trips library sees the story text but a "not available
to you" placeholder for that album block). A story whose visible-to-you
media count is zero still shows its text — text is content, not chrome.

## Phase 1 — Core: schema, module, editor, reading view — BUILT

Built as proposed. As-built notes, where reality refined the plan:

- **Chapter fields are revealed, not shown.** A story's single starting chapter
  hides its date/place/title form behind "Add a date, place or chapter title",
  so a plain journal page doesn't open with a form; the fields appear for good
  once the story has any chapter structure.
- **Dates commit on an explicit "Apply dates"** rather than on blur — a
  half-typed `2004-07-1` is invalid, and blur-saving fought the typist.
- **Consecutive photos group into a row** (`story-layout.ts`, up to three),
  which was not in the plan but is what makes the page read like a photo essay
  rather than a stack of full-width images. A `wide` photo, a video, and any
  captioned photo stand alone.
- **Slideshow blocks play in place**: Play fetches the slideshow's full item
  list and hands it to `GalleryLightbox` with the slideshow's own transition,
  dwell and music — the block itself only carries a preview strip.
- **`shared/utils.ts` gained `formatPartialDate`/`formatPartialDateRange`**,
  promoted from `FamilyPersonPage`'s private copy so the family tree and story
  chapters format the same convention identically.
- **`GalleryMiniMap` gained `zoom`/`className`** instead of a story-specific map
  component.
- **`resetDb` in the test helper needed the three new tables** — it clears an
  explicit list, so without them story rows leaked between every test in a file.
- Not built, deliberately: reordering is up/down controls (positions are REAL,
  so drag-and-drop remains open), and there is no cover picker yet — the list
  falls back to the first visible photo a media block points at.

The v1 deliverable is the **scrollable story page** — the digital-journal
form. This alone delivers most of the concept's value.

**Schema** (new tables → auto-apply from `schema.sql`, no `migrations[]`
entry):

```sql
CREATE TABLE IF NOT EXISTS stories (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  cover_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'draft',      -- 'draft' | 'published'
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS story_chapters (
  id          TEXT PRIMARY KEY,
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  position    REAL NOT NULL,
  title       TEXT,
  -- Partial ISO dates, family-tree convention ('YYYY'|'YYYY-MM'|'YYYY-MM-DD');
  -- end_date makes a range; both null = undated; approx renders "around ...".
  date        TEXT,
  end_date    TEXT,
  date_approx INTEGER NOT NULL DEFAULT 0,
  place       TEXT,
  place_lat   REAL,
  place_lng   REAL,
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_story_chapters_story
  ON story_chapters (story_id, position);

CREATE TABLE IF NOT EXISTS story_blocks (
  id          TEXT PRIMARY KEY,
  chapter_id  TEXT NOT NULL REFERENCES story_chapters(id) ON DELETE CASCADE,
  position    REAL NOT NULL,
  kind        TEXT NOT NULL,  -- 'text' | 'media' | 'album' | 'slideshow'
                              -- | 'map' | 'person' | 'quote'
  -- Reference kinds (media/album/slideshow/person/quote). Polymorphic like
  -- collection_items: no FK; module code cleans up + hydrator degrades.
  entity_type TEXT,
  entity_id   TEXT,
  -- 'text' kind: markdown source.
  body        TEXT,
  -- 'map' kind (also reusable as a location callout on any block later).
  lat         REAL,
  lng         REAL,
  zoom        INTEGER,
  label       TEXT,
  -- Presentation hints, all optional.
  caption     TEXT,
  layout      TEXT             -- e.g. 'default' | 'wide' | 'grid'
);
CREATE INDEX IF NOT EXISTS idx_story_blocks_chapter
  ON story_blocks (chapter_id, position);
CREATE INDEX IF NOT EXISTS idx_story_blocks_entity
  ON story_blocks (entity_type, entity_id);
```

Block kinds in v1: `text`, `media` (one photo or video), `album`,
`slideshow`, `map`. (`person` and `quote` are Phase 2 — columns cost nothing
now.) A `media` block with several consecutive photos is just several media
blocks; the reader may render adjacent ones as a grid (`layout` hint).

**Dangling references**: `idx_story_blocks_entity` lets the gallery/album/
slideshow delete paths clean story blocks the way `deleteSharesForResource`
cleans shares — or blocks simply degrade via the hydrator (`available:
false` → "This album was removed" placeholder). Do both: degrade at read
time (safety), clean on delete (hygiene).

**API** under `/api/stories`: list (member-visible; drafts only to
creator/admins), create, `GET /:id` (fully hydrated: chapters, blocks,
per-viewer filtered), `PATCH /:id`, `DELETE /:id` (confirmed), chapter CRUD
+ reorder, block CRUD + reorder + move-between-chapters. Reorder follows the
`position REAL` insert-between convention.

**Editor UI** (`/stories/:id/edit`, creator + admins): the biggest lift.
One scrolling surface mirroring the reading view, with an "insert block"
affordance between blocks: Text (textarea + preview), Photo/Video
(`PhotoPicker`, already built for reuse), Album / Slideshow (simple picker
modals patterned on `AddToCollectionModal`), Map (`GalleryPlaceSearch` +
`GalleryLocationPicker`). Chapter header edits inline; dates via
`PartialDateField`. Reorder via up/down controls in v1 (REAL positions keep
drag-and-drop open for later, same call as albums). Autosave per
block/field PATCH — no giant save button.

**Reading view** (`/stories/:id`): clean scroll page. Chapter headers render
title + formatted date ("Summer 2004", "around 1998", "July 12–19, 2004")
+ place; a media block opens the lightbox scoped to the story's media; an
album block renders a cover-strip + "View album" link *and* inlines its
first N photos; a slideshow block renders its title card with a play button
(opens the existing lightbox autoplay flow); a map block renders a
`GalleryMiniMap`-style embed. Draft stories show a Draft badge to the
author; `status='published'` is what lists to members.

**Discovery**: a `/stories` index page (cards: cover, title, date span,
chapter count). Entry point in the main nav; optionally a Home-feed card
type later ("New story: …").

**i18n**: all new strings are keys from day one (en + ru), per the sweep
rules.

## Phase 2 — Connections: tags, people, quotes, suggestions — BUILT

Built as proposed, all six items. As-built notes:

- **Stories are top-level**, not in the "My Library" side nav where phase 1
  put them (that group is things you *saved*; a story is *authored*) and not a
  gallery view either — every gallery tab is a way of looking at gallery
  assets, and a story isn't one. Family tree is the precedent.
- **Albums and slideshows count as gallery matches** in the tag browse rather
  than earning scopes of their own: the toggle lists media types, not
  container kinds. They get one "Albums & slideshows" section.
- **Tag reachability is delegated**, not re-derived — `listAlbums` /
  `listSlideshows` / `listStories` already own their visibility rules, so the
  tag routes filter their output instead of writing the rule a second time.
- **`shared/TagInput`** was extracted rather than inlined a second time, and
  commits the draft on blur as well as on Enter. That closes the gap the
  gallery's bulk tag dialog worked around with "anything still in the box
  counts".
- **The tag readers moved to `categorize.ts`** beside the writers
  (`getEntityTags` / `entityTagsByIds` / `deleteEntityTags`), so stories,
  albums and slideshows share one implementation.
- **Suggestions are tag-matched**, shown as a "Suggested" group above
  "Everything else", and collapse to a single list while searching — a search
  is the intent, and two lists would hide matches.
- Stories are **not collectable**, matching albums and slideshows: a
  collection renders playback/file affordances a story hasn't got. They are
  send-able and note-able, and the reading view gained both.

## Phase 2 — as proposed

- **Tags on stories**: write `taggables` rows with `entity_type='story'`;
  add per-type counts to `GET /api/library/tags` and a `stories` group on
  the tag detail page. Chapter-level tags are deferred (see open questions).
- **Tags on albums/slideshows** (enabler the proposal implies): same
  mechanism, `entity_type='gallery_album' | 'gallery_slideshow'`, so tags
  connect stories with the things they embed.
- **`person` block**: references a `family_tree_person` (already a subject
  type) — renders portrait + name + life dates, links to `/family/people/…`.
  This is the family-tree bridge, and it out-features what Ancestry offers
  (their LifeStory is auto-generated, not authorable).
- **`quote` block**: the quotes entity is already collectable/hydratable;
  a pull-quote block is nearly free and fits the documentary register.
- **Related-content suggestions while editing**: given the story's tags (and
  chapter date ranges), surface a "Suggested" rail in the pickers — the
  cross-type tag endpoints and timeline facets already answer these queries.
- **Subjects registry**: add a `story` entry to `SUBJECTS` (not collectable,
  or collectable — see open questions) so Send-to and Notes work on stories.

## Phase 3 — Sharing — BUILT

Guest links built as proposed. The in-app half turned out to need nothing:

- **In-app sharing was already there.** A published story is readable by every
  member, and Send to puts it in their inbox (phase 2's subject entry). A
  `shares` row with `module='story'` would have granted nothing a member didn't
  already have — and a draft isn't sendable at all, so there is nothing to
  widen. `GRANTABLE` in `modules/social/routes.ts` records why story is absent,
  beside the same note for family-tree people. So Phase 3 is guest links.
- **Story knowledge lives in `modules/stories/share.ts`**, not in the
  2,100-line `shares.ts`, which gained only a dispatch seam. The item routes
  now serve "any link whose resource is a set of photos" — quick link, album,
  or story — with each module answering membership its own way.
- **The reachable set is computed in JS**, from the same helpers the reading
  view uses, rather than as a second SQL query. That is what makes "a guest can
  open exactly what the page shows them" true by construction instead of by
  two queries agreeing.
- **`expandAlbums` is enforced, not cosmetic**: with it off, the photos past an
  album's inline preview 404 through the token. Tested both ways.
- **A retired creator kills the link.** `storyLinkContext` requires
  `is_active = 1 AND deleted_at IS NULL` — accounts are retired by soft delete
  (share_links.created_by has an FK, so the row never goes away), and a
  lookup by id alone would keep a deactivated person's links serving. The album
  path has the same lookup and the same gap; it is filed separately rather than
  changed here.
- **Guests get no in-app links.** Person blocks lose their "Open profile"
  button, album blocks lose "Open album" — every such link would bounce a guest
  to a sign-in screen. A test asserts the payload contains no `/gallery/` or
  `/stories/` URL.
- **Deferred as planned**: an embedded slideshow shows its photos rather than
  playing with music — that needs token-scoped music routes.

## Phase 3 — as proposed

- **In-app**: `shares` rows with `module='story'` (read permission);
  stories appear on `/shared`. Cheap because member visibility already
  exists — the value is the notification/attribution flow.
- **Guest link**: `share_links` with `module='story'`, **live** (like album
  links, not snapshot links): the page renders the story as it currently is,
  with every referenced item resolved against the **link creator's current
  rights at serve time**. Token-scoped media routes extend the existing
  `/api/share/:token/items/:itemId/...` family; a `story` arm joins the
  `SharePayload` union in `SharePage.tsx` — clean viewer, no library chrome.
- **Scope control** ("view only vs interact with linked content"): a link
  option `expand_albums` — off = album/slideshow blocks show only their
  inline preview photos; on = guest can open the full album grid through the
  token. Default off.
- **Deliberate deferral**: guest playback of an *embedded slideshow with
  music* needs token-scoped music/asset routes that don't exist; v1 guest
  links show the slideshow's photos as a set. Add the routes when wanted.

## Phase 4 — Story player (presentation mode) — BUILT

Built as proposed, with one honest departure and one nice consequence:

- **It is a sequencer, not a second reader.** `story-player.ts` flattens a
  story into one list of `PlayerSlide`s and `StoryPlayer.tsx` steps through
  them; neither knows where the story came from.
- **It is NOT built on GalleryLightbox**, which the proposal suggested. That
  component is 1,100 lines of gallery-asset machinery — info panel, editing,
  people tagging — and a story's slides are heterogeneous (chapter cards,
  prose, maps, quotes), so there was nothing to reuse but the idea. The player
  keeps the ideas — crossfade on slide change, preload the next photo — and
  drops the coupling.
- **Both payload shapes feed the same player.** `slidesFromStory` (signed-in)
  and `slidesFromShare` (guest) are the only two things that know about
  payloads. A guest show therefore honours the link's `expandAlbums` setting
  for free: the server already trimmed the album, so the player just plays what
  it was given, with no second decision to get wrong.
- **Albums play through.** The reading view holds only a preview strip, so
  pressing Play fetches each album's and slideshow's full contents first; a set
  that fails to load falls back to the strip rather than stopping the show.
- **Timing follows the content**: prose and quotes get a reading-pace dwell
  (floored so a one-liner doesn't blink past, capped so a long passage doesn't
  strand the room), photos take a fixed pace, and a video is absent from the
  clock entirely — it advances on `ended`, so a clip is never cut off and never
  leaves dead air.
- **A chapter earns an opening card only when it says something**, so the
  single untitled chapter a plain journal page carries doesn't open the show
  with a blank frame.
- The show **ends rather than loops** — a story has a shape — offering "Play
  again" and "Close".

Not built: music under the show, and a cast/credits card. Both belong with the
Phase 5 options if presentation mode gets real use.

## Phase 4 — as proposed

Full-screen "Play story" that walks the story linearly — chapter title card
(reuse the slideshow title-card look) → blocks in order: text rendered as
large slides, media via the lightbox machinery (transitions, preloading,
timing already built), embedded slideshows delegating to their own autoplay
settings, map blocks as animated pan-to-pin interludes (the StoryMap
pattern). Controls: advance/back, pause, exit; works from the reading view
and (once Phase 3 lands) the share page — phones/tablets/TV browsers are the
target. This is a sequencer over existing players, not a new renderer.

## Phase 5 (options) — research-backed extensions, each independent

- **Audio narration block** — BUILT. Record in the browser or upload a file;
  it plays in the reading view, in a guest link, and takes the stage in the
  player. Notes:
  - It is a BLOCK kind, not a chapter property. That way it inherits ordering,
    deletion, the player and the guest payload for free, and "grandma tells
    this part" sits exactly where the author put it.
  - Narration is the one story reference the story OWNS rather than points at,
    so `story_audio` cascades from the story — and `deleteBlock` reclaims the
    FILE, which no foreign key would have.
  - Reachability for an audio block is "belongs to THIS story", not a subjects
    lookup; a clip from someone else's story cannot be embedded.
  - In the player it is treated exactly like a video: absent from the clock,
    advancing on `ended`.
  - MediaRecorder needs a secure context, so where it is unavailable the record
    half simply does not appear and upload carries it.
- **Prompt starters**: "New story from…" templates — a memory (the memories
  clusterer already proposes date+place sets), an album, a year-in-review,
  a person. Pre-seeds chapters/blocks the author then edits. Prompts are the
  proven engagement engine (StoryWorth model) at tiny cost here since the
  generators exist.
- **Print/export**: story → PDF (or paginated print CSS) for a physical
  book — the terminal artifact people demonstrably pay for. Big lift; only
  worth it if stories get real use first.
- **On-this-day resurfacing**: stories whose chapter dates match today join
  the memories row ("5 years since *Minnesota 2004*").

## Build order

Core ✓ → connections ✓ → sharing ✓ → player ✓ → options. Each phase
independently shippable; core was by far the largest (the editor dominates).

## Open questions

Resolved while building Phase 1:

- **Who can create stories?** Every member. Edit stays creator + admins.
- **Album block inline count**: 6 (`BLOCK_PREVIEW_LIMIT`), with a "+N" chip.
- **Draft visibility**: creator **and** admins, matching every other
  "creator + admins" surface in the app — a separate rule for drafts would
  have been the only one of its kind.

Still open:

- **Chapter-level tags**: Phase 2 ships story-level only — is per-chapter
  discovery worth a second taggable type (`story_chapter`), or do story tags
  cover it?
- ~~Stories in collections?~~ Resolved while building phase 2: **not
  collectable**, matching albums and slideshows — a collection renders
  playback and file affordances a story hasn't got. Revisit only if
  collections grow a plain "reading list" mode.
- **Cover picker**: the list falls back to the first visible photo. Worth a
  "Set as story cover" action on a media block, or is the fallback enough?

## Non-goals (v1)

- WYSIWYG rich-text editing (Markdown only; see design decisions).
- Collaborative multi-author editing or block-level permissions — one
  curator, many viewers is the researched usage pattern.
- Auto-generated stories (AI narrative, Google-style memories movies) —
  prompt *starters* in Phase 5 are as far as this goes.
- Copying/re-encoding media into the story — stories reference, period.
- Chapter events syncing with `family_tree_events`.
- Guest playback of embedded slideshows with music (Phase 3 deferral).
- Print/PDF export (Phase 5 option, gated on real usage).
