# Stories v2 — collections, chapter pages, kinds

Status: **Draft — design agreed 2026-09-01, nothing built.** Supersedes the
*design direction* of [stories-proposal.md](stories-proposal.md), which remains
the as-built record of what shipped in 3.43.0 (phases 1–5). Companion to
[gallery-library.md](gallery-library.md), [sharing.md](sharing.md), and
[family-tree.md](family-tree.md).

Reference layout: <https://www.travelingjournals.com/journal/2026-04-18/> —
maps as Journal = story, Day = chapter, day page = chapter page. One entry is
hero (dateline + title + standfirst overlaid) · route aside · continuous prose
· typed callout · "Photos from Day 1 · 5 shots" carousel. It is a **template
with named slots**, not a free block sequence — and it has no map, which is a
place this design beats it.

Mockups (index + collection page, in the app's own theme tokens):
<https://claude.ai/code/artifact/d3a27baf-eb4b-4ab5-8d7a-2d1bcb887e78>

## Why revisit

Stories shipped and immediately got used four different ways: as a **memory**
(one dated page around an album), as a **family timeline** (years of events),
as a **vacation blog** (day-by-day trip), and as an **ebook/audiobook review**
(a new use nothing else in the app serves). v1 handles all four with the same
flat card grid and the same blank editor, which fits none of them well. Three
structural gaps:

1. **No layer above stories.** "Family Story" — years of related stories
   organized by date — has nowhere to live; the index is a flat grid.
2. **Chapters are too weak.** The reference layout works because a day page
   has *named slots* (hero, standfirst, route, photo footer); v1 chapters are
   a title + dateline over an undifferentiated block stack.
3. **`story_audio` breaks the one rule.** Narration is the only content a
   story *owns* rather than references — it needed its own table, its own
   file store, its own deletion logic, and its files die with the story.
   "Stories reference, period" should have no exceptions.

## Design principles (carried forward, now absolute)

- **Reference, never copy.** Every non-text block points at a library entity.
  Narration moves *into* a library (below); `story_audio` is retired.
- **One Story entity.** Kinds are templates and surfacing, never forks.
- **Containers stay light.** A collection is a shelf with access — metadata +
  membership; the stories stay the heavy objects. (A second heavy container
  would be indistinguishable from a story.)
- **Security invariants unchanged**: per-viewer filtering of referenced
  content through the subjects hydrator, and guest links resolved against the
  *link creator's current rights at serve time*, with the reachable set
  computed from the same helpers the reading view uses.

## Collections (story containers)

A **collection** groups stories the way "Family Story" or "Trips" needs:
title, cover, description, access, member stories. Rendered as a **year-spine
timeline** — stories grouped under year markers derived from their chapters'
dates (nothing is entered twice), undated stories gathered in a "No date"
group at the end.

- `stories.collection_id` is **nullable**. Standalone stories (the school
  project shared by guest link) keep exactly today's behavior. No default
  collection, no forced hierarchy.
- The `/stories` index becomes two zones: a **Collections shelf** (wide
  cards: cover, derived date span, story count) above the **Stories** grid
  (standalone + visible contained stories). Primary action becomes a split
  **Create story ▾ / Create collection**.
- A collection page's "Add story" creates directly into it; the editor gains
  a collection picker ("None (standalone)" default, listing only collections
  where the author can create).
- Guest links stay **per story**. A collection-level guest link is a later,
  separate decision.
- "Play the whole collection chronologically" is a natural later option, not
  part of this work.

### Access

Decided (2026-09-01) and recorded here so it doesn't get relitigated: **do
NOT copy the family tree's tag-scoped model.** Tag scoping exists there
because the tree is one shared, ownerless graph needing branch boundaries —
and it forces tagging to be admin-only. A story has an author, and story tags
must stay pure discovery.

- **Standalone stories: album rules, unchanged.** Viewable by every member,
  editable by creator + admins.
- **Collections: `assignments` rows**, `object_type = 'story_collection'`,
  the same `resolveObjectRole` semantics libraries use (deny wins, strongest
  explicit grant beats the Everyone baseline). Role meaning here:
  - `viewer` — sees the collection and its stories;
  - `contributor` — may create stories in it and edit their own;
  - `manager` — may edit every story in it and manage access.
  Admins always have full access. A new collection gets an Everyone→`viewer`
  row so an unrestricted collection behaves exactly like today's flat list;
  removing that row is what restricts it.
- **Collection access overrides member visibility.** A story in a restricted
  collection is invisible to non-members *everywhere* — lists, search, tag
  browse, suggestions, home feed, back-links — not just on the collection
  page. (The alternative makes the access panel decorative.) Cost: every
  story list query learns one join; the tag routes already delegate to
  `listStories`, so the rule lives in one place.
- Editing rights on a contained story: creator + admins + collection
  `manager` (and the creator must have been at least `contributor` to create
  it there).

## Story kinds

`stories.kind` — `'memory' | 'journal' | 'review' | 'free'` (default
`'free'`; the UI labels `journal` as "Travel journal"). A kind does exactly
three things:

1. **Picks the creation template** — pre-seeded chapters/blocks (this is
   phase 5's "prompt starters" wearing a structural coat): memory seeds one
   undated chapter from an album or memory cluster; journal seeds dated "Day"
   chapters; review seeds a book card + text block.
2. **Sets defaults** — e.g. `chapter_noun` "Day" for journal.
3. **Adds surfacing** — reviews appear on the book's detail page; memories
   join the on-this-day row.

A kind never affects permissions, validation, or what the editor allows —
any story can still become anything.

**Rating**: `stories.rating` (nullable INTEGER 1–5), set from the editor,
shown only when present. Exists for reviews but is not restricted to them.

**Back-links** — the mechanism that makes reviews (and more) work, nearly
free via `idx_story_blocks_entity`: "which stories reference entity X" is one
indexed query. Surfaces, all per-viewer filtered through the normal list
visibility rules:

- Book detail page → "Reviews & stories" section;
- Person page → "Stories featuring …";
- Album/slideshow → "Appears in …".

**Reviews surface on the work, with the edition noted.** A book card points
at one specific edition (the one the reviewer actually read or listened to),
but the review shows on every edition's page — a review is about the story,
not the file. The section notes which edition was referenced ("reviewed the
audiobook edition"), which preserves the cases where the edition matters (a
translation, a narrator). Costs one join through `work_items` in the
back-link query.

## Chapter pages

`stories.chapter_noun` (TEXT, nullable): authored label — "Day", "Part",
"Stop" — so chapters render "Day 1 · April 18". Authored text, **not**
through `t()`. Null = no noun, chapters show only their titles/dates (v1
behavior).

A chapter becomes a **page with a template** — hybrid of typed fields and
the block stream, per the reference:

- **Hero** (typed chapter fields, not blocks): dateline (existing partial
  date/range + `approx`), title, **standfirst** (`story_chapters.standfirst`,
  a one-line teaser), and an optional hero photo
  (`story_chapters.hero_item_id` → `library_items`, SET NULL) rendered as a
  cover band with the text overlaid.
- **Place/route aside**: existing `place`/`place_lat`/`place_lng` rendered
  as a mini-map card beside the opening prose.
- **Body**: the block stream (palette below).
- **Photo footer** (derived, never authored): "Photos from Day 1 · 12
  shots" — a carousel gathering every gallery item the chapter's blocks
  reference. Computed at hydrate time from the blocks; no new rows.

**Each chapter is its own page** (decided): `/stories/:id/chapters/:chapterId`
renders one chapter, with prev/next navigation and a chapter strip. The
single-chapter collapse from v1 is kept: a story with one untitled chapter
renders that chapter directly at `/stories/:id` with no chapter chrome at all.

### Story Home (`/stories/:id`)

A true overview page, not just a chapter list (sharpened after external
review):

- **Hero**: cover image with title + subtitle overlaid.
- **Introduction**: `stories.intro` — authored opening prose that belongs to
  the story, not to any chapter.
- **Overall date range** — derived from the chapters' dates, never entered.
- **Primary location** — derived too (the most frequent chapter place), a
  label under the dateline, not another field to fill.
- **Chapter navigation**: the chapter/day cards (noun + number, title, date,
  place, thumbnail) in order.
- **Story map**: one mini-map with a pin per placed chapter, linked to its
  page — the piece the travel-journal reference lacks. Chapters carry
  coordinates already, so this is a render, not a schema change.

## Site view replaces the player

Presentation mode (the phase-4 player) is **retired** — reading the story as
a website is the presentation. In its place, stories render in a **site
view**: a dedicated layout with no app chrome — no top nav, no library
UI — just the story's own navigation (title, chapter strip, prev/next) and an
Exit back to the app. Opening a story puts the reader in this layout;
signed-in members and guests see the same thing, since the guest share page
already renders chrome-free — v2 unifies both on one story-site layout, with
the guest variant additionally stripping in-app links as today.

The player's code (`story-player.ts`, `StoryPlayer.tsx`, the share-payload
slide builders) is removed when chapter pages land, rather than adapted to
the new structure. Gallery slideshows keep their own autoplay player — that
was never the story player.

## Block palette

Every reference block is library-backed. Authored-in-place content is text
and maps only.

| Block | Source | Notes |
| ----- | ------ | ----- |
| `text` | authored | Markdown, same sanitizer pipeline as v1 |
| `map` | authored | lat/lng/zoom/label, as v1 |
| `media` | Gallery | one photo or video, as v1 |
| `album` | Gallery | as v1 |
| `slideshow` | Gallery | as v1 |
| `person` | Family tree | as v1 |
| `quote` | Quotes | as v1 (bridges ebooks + audiobooks already) |
| `book` | Ebooks / Audiobooks | **new**: cover + title + author card, links to the book page |
| `audio` | Recordings library / Audiobooks | **new**: minimal inline player (play/pause, scrubber, duration) |

- **`book` card** is cheap: books are already hydratable subjects with
  per-viewer access filtering; `entity_type` distinguishes ebook/audiobook.
- **`audio` player** takes either a recording (a gallery `audio` asset) or an
  audiobook. Signed-in playback streams through the existing library routes
  with the viewer's own rights — nothing new. **Guest links are scoped
  deliberately**: recordings stream through the token from day one (small
  clips, part of the story); an audiobook in a guest link **degrades to its
  card** — handing a guest an entire audiobook through a story token is a
  rights decision to make explicitly later, not a default. This finally
  builds the first slice of the token-scoped audio surface phase 3 deferred.

**Not a page builder.** The named chapter template plus this palette is the
whole editing surface. If editing friction ever proves real, the next step is
a few *editorial* block options — callout, divider, heading, photo spread —
never free-form layout.

## Narration → the recordings library

`story_audio` is retired. Recording flow: press Record (or Upload) in the
editor → the clip uploads into the **global recordings library** → the block
references the asset like any other library content. Same pattern
`PhotoPicker.uploadTo` proved: the author never leaves the story.

- **One global setting**, admin-selected from **existing gallery libraries**
  (Control → Stories). While unset, the Record/Upload affordance simply does
  not appear in the editor, with a hint for admins pointing at the setting —
  never a failure at upload time.
- **Gallery gains a third asset kind: `audio`** (`gallery_details.kind`),
  rather than a new library type — gallery is already asset-as-item (each
  file = one `library_items` row), ffmpeg is already present to probe
  duration, and a voice memo *is* a family memory like a photo. Touch points:
  the scanner (accept audio extensions, probe duration, no thumbnail), the
  `kinds` filter enums in gallery routes/catalog, and an audio tile treatment
  (mic glyph / duration badge) in gallery views. Audio assets get everything
  free: timeline placement by `captured_at`, favorites, backup, sharing, and
  the token-scoped guest item routes.
- What narration gains from the move: recordings **survive story deletion**,
  appear in the gallery timeline, are backed up with everything else, and
  play in guest links through existing token machinery.
- MediaRecorder still needs a secure context; where unavailable, upload
  carries it (unchanged from v1's behavior).

**Transition**: existing `story_audio` rows/files keep serving until an admin
selects the recordings library; Control → Stories then offers a one-time
"Move existing narrations" action that imports the files as gallery `audio`
assets, rewrites the blocks to reference them, and drops the old store. Only
after that migration path has shipped does `story_audio` code get deleted.

## Schema sketch

New table (auto-applies from `schema.sql`, no `migrations[]` entry):

```sql
CREATE TABLE IF NOT EXISTS story_collections (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  cover_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

New columns on existing tables (**need a migration**, per the house rule):

```sql
ALTER TABLE stories ADD COLUMN collection_id TEXT
  REFERENCES story_collections(id) ON DELETE SET NULL;
ALTER TABLE stories ADD COLUMN kind TEXT NOT NULL DEFAULT 'free';
ALTER TABLE stories ADD COLUMN rating INTEGER;
ALTER TABLE stories ADD COLUMN chapter_noun TEXT;
ALTER TABLE stories ADD COLUMN intro TEXT;
ALTER TABLE story_chapters ADD COLUMN standfirst TEXT;
ALTER TABLE story_chapters ADD COLUMN hero_item_id TEXT
  REFERENCES library_items(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stories_collection
  ON stories (collection_id);
```

Plus: the recordings-library id in the settings store; `assignments` rows
with `object_type = 'story_collection'` (no schema change); the
`gallery_details.kind` CHECK/enum widened to `'audio'` if constrained.
Retired (after the transition): `story_audio`.

## Build order

Each step independently shippable, in this order:

1. **Gallery `audio` kind** — pure gallery work, useful on its own (voice
   memos in the library), prerequisite for narration. **BUILT** (2026-09-01,
   uncommitted). As-built notes:
   - Migration 55 is the schema's first table rebuild (stage → drop →
     recreate → restore via a dynamic column list, no RENAME); it has a
     dedicated test (`gallery-audio-migration.test.ts`) that upgrades a
     database wearing the old CHECK.
   - Audio extensions (`mp3 m4a aac ogg oga opus flac wav wma weba`) are NOT
     in the gallery scan defaults — defaults apply live to libraries without a
     stored list, so audio is opt-in per library. `.webm` stays video;
     MediaRecorder captures must be saved `.weba`.
   - Thumbnails come from embedded cover art (ID3/MP4 attached picture) when
     present; otherwise the tile/lightbox show a mic glyph.
   - Excluded from: memories, year review, home-feed cards, slideshow render,
     PhotoPicker (unpickable everywhere until the audio block brings its own
     mode). Audio joins sets from the gallery page's own selection.
   - Lightbox plays audio natively (cover/mic + `<audio controls>`); in a
     playing slideshow it advances on `ended`, like a video.
2. **Recordings setting + narration migration** — retire `story_audio`.
   **BUILT** (2026-09-01, uncommitted). As-built notes:
   - The setting is a JSON blob (`stories_settings` in `app_settings`,
     `modules/stories/settings.ts`), mirroring the family-tree precedent, and
     lives at Control → Settings → Stories (`storySettings` section).
   - **Choosing a library opts it into audio automatically**
     (`ensureAudioScanExtensions`) — required for durability, not just UX: a
     full rescan reconciles against the scan-extension list and would
     tombstone every recording otherwise.
   - New audio blocks are `entity_type 'gallery'` (`BLOCK_ENTITY_TYPE.audio`);
     legacy `'story_audio'` blocks keep serving through every read path
     (reading view, guest links, delete-reclaim) until the import runs. No
     new legacy clip can ever be created.
   - The narration upload (`POST /api/stories/:id/audio`, same endpoint and
     response shape the editor already used) stores into
     `Story recordings/<year>/` via `storeRecording`, deliberately WITHOUT a
     per-user upload check on that library — story edit rights + the admin's
     nomination are the authorization; the write is narrow (audio, capped,
     fixed folder). MediaRecorder `.webm` is stored as `.weba`.
   - Guest links: gallery-backed recordings join the link's reach and stream
     through the token item routes (and the ZIP); legacy clips keep the
     dedicated `/api/share/:token/audio/` route meanwhile.
   - The one-time import (Control page button) copies-then-deletes per clip,
     is safe to re-run, counts failures, and imports orphaned clips too.
   - The editor hides Record/Upload until the setting exists; admins see it
     disabled with a pointer at the setting.
   - `audio.ts` (legacy module) is deliberately still present; it goes in a
     later cleanup once installs have run the import.
3. **Chapter pages + site view** — `chapter_noun`, standfirst, hero, photo
   footer, per-chapter URLs, the chrome-free story-site layout, and the
   player's removal. The biggest visible change; no access implications.
   **BUILT** (2026-09-01, uncommitted). As-built notes:
   - Migration 56 adds `stories.chapter_noun`/`intro` and
     `story_chapters.standfirst`/`hero_item_id`; the detail payload gains
     `chapterNoun`, `intro`, `cover` (the resolved cover asset) and per-chapter
     `standfirst`/`heroItemId`/`hero`, all per-viewer hydrated.
   - `StoryDetailPage` renders the **site view** for both the Home and chapter
     routes: sticky story bar (Exit → /stories, story name, Edit/Send), a
     pill chapter strip (Overview + labels), no `DashboardShell`. A story
     without chapter structure keeps the v1 single-page rendering inside the
     same layout.
   - `chapterLabel()` (types.ts) resolves "Day 1" → title → date → number,
     and the UI suppresses the echo when the label IS the title.
   - The **Story Home** hero prefers the story cover, then any chapter hero;
     primary location is the most-named chapter place; the **story map** is a
     new `StoryMap` (plain Leaflet, numbered pins, fitBounds — no clustering)
     and only renders when a chapter has coordinates.
   - Chapter coordinates are captured in the editor via the existing
     `StoryMapModal` ("Pin on map" beside the place field — the pin's label
     fills an empty place); the chapter hero via `PhotoPicker` pick="any".
   - The photo footer derives from the chapter's block assets and previews
     (audio excluded), deduplicated, opening the shared lightbox.
   - **Player deleted**: `StoryPlayer.tsx`, `story-player.ts`, their test
     file, ~250 lines of CSS, and the `player.*` i18n keys; the share view
     lost its Play button. Slideshow blocks still play via `GalleryLightbox`.
   - Deliberately deferred: the guest share view keeps its v1 single-scroll
     rendering (already chrome-free); giving guests chapter pages needs
     chapter ids + hero/coords in the share payload and a share URL scheme —
     small, but its own change.
4. **`book` + `audio` blocks, rating** — with the guest scoping above.
   **BUILT** (2026-09-01, uncommitted). As-built notes:
   - Migration 57 adds `stories.rating` (INTEGER, CHECK 1–5, nullable). Stars
     show on the Story Home meta line, the flat story head, and the index
     card ("★ 4"); the editor's picker is five stars + Clear.
   - The `book` block is the ONE block whose entity type is chosen per block:
     `entity_type` is `audiobook` or `ebook` (`BOOK_ENTITY_TYPES`), picked in
     `StoryRefPicker` (both catalogs merged into one searchable list, tag
     suggestions included) and settled at creation — a patch can re-point the
     reference but never change the type. Hydration and per-viewer access come
     free from the subjects registry, so the card (cover · title · author ·
     type label · "Open book") needed no new server queries.
   - Guests get a text-only book card (title/author/type) resolved against the
     link creator's access via the same hydrator — no cover (no token route
     for book covers) and no in-app link, per the guest rules.
   - **Deferred: the audio block playing an AUDIOBOOK inline.** A recording is
     one file; an audiobook is many files with chapters and progress — an
     honest inline player for it is a real feature, not a source switch. The
     book card (linking to the book page, where the real player lives) covers
     the use meanwhile. Revisit if a genuine "play this audiobook inside the
     story" need shows up.
5. **Back-links** — book/person/album pages list referencing stories.
   **BUILT** (2026-09-01, uncommitted). As-built notes:
   - `listStories` gained an optional `ref` filter (EXISTS over
     `idx_story_blocks_entity`), so back-links carry the exact index
     visibility rule and card shape; `storyRefMatches` answers "which of the
     queried entities did this story actually reference", in reading order.
   - One endpoint, `GET /api/stories/referencing?type=&id=` — for a book it
     widens to the whole WORK (every `work_items` sibling, both book types)
     and each card carries `refEntityType`, rendered as an "Audiobook
     edition"/"Ebook edition" chip. Decided earlier: reviews live on the
     work, edition noted.
   - One shared component, `RelatedStories`, derives its own heading by
     entity type ("Reviews & stories" / "Stories featuring {name}" /
     "Appears in stories") and renders NOTHING when no story matches — no
     permanent empty furniture. Mounted above the Notes section on the book
     detail page, the family person page, and the album and slideshow
     details in GalleryPage.
   - Deferred with the rest of the guest work: back-links are signed-in
     surfaces only (a guest page has no shelves to link back into).
6. **Collections** — shelf, timeline page, access, visibility join. Largest
   security-sensitive step, so it goes last, alone in its release.
   **BUILT** (2026-09-01, uncommitted). As-built notes:
   - `story_collections` (schema.sql) + `stories.collection_id` (migration
     58). The membership index lives in the MIGRATION only — putting it in
     schema.sql crash-looped upgraded databases (schema runs before
     migrations) while every fresh-DB test stayed green; a v57-upgrade
     regression test now pins that, and the recurring rule is written into
     schema.sql itself.
   - Access exactly as designed: `assignments` object_type
     `story_collection`, roles viewer/contributor/manager(+deny), creator →
     manager, Everyone → viewer on create ("No access" on the Everyone row is
     what restricts). Admins always pass — no take-ownership dance, unlike
     libraries. All helpers in `collection-access.ts`, dependency-light so
     the subjects hydrator can import it without cycles.
   - **The visibility override lives in exactly three places** —
     `listStories` (which tags and back-links already delegate to),
     `canViewStory`, and the send-to hydrator — each with the same author
     carve-out: a story's creator always sees their own story, or an access
     change could take their writing away. Eight security tests pin deny >
     Everyone, group grants, the override on all three surfaces, and
     manager-edits-members.
   - Guest links unchanged: minting requires edit rights, and the creator of
     a link to a shelved story had access by construction.
   - The access modal is manager-reachable (not admin-only like the library
     one), so its GET carries its own user/group candidate lists — the same
     names-only disclosure the send-to sheet already makes.
   - Collection endpoints register before the story routes;
     `/stories/collections/:id` matches before the single-segment story
     detail in the web router for the same reason.
   - Deleting a shelf frees its stories (FK SET NULL) and sweeps its
     assignments; it never deletes a story.
7. **Kinds/templates** — creation flow polish once everything else stands.
   **BUILT** (2026-09-01, uncommitted) — the whole v2 build order is done.
   As-built notes:
   - `stories.kind` (migration 59, app-enforced like `status` so a future
     kind needs no schema change). Existing stories read as `free`.
   - A kind is chosen ONCE, in the New story modal (four cards: Story /
     Memory / Travel journal / Review), and is deliberately not editable
     afterward — the external review's "mostly a creation-template choice".
     It gates nothing: a memory can still become a chaptered epic (tested).
   - Templates, exercised at creation inside `createStory`: journal →
     `chapter_noun` "Day"; review → the book card seeded when the review
     starts from a book.
   - The review surfacing that matters is **"Write a review" on the book
     detail page**: `RelatedStories` gained a `reviewTitle` prop — the
     section then stays on the page even with no stories ("Nobody has
     written about this book yet"), and one click creates a review-kind
     story titled after the book with its card pre-seeded, straight into the
     editor. Reviews reach the page through the ordinary back-links.
   - Deliberately thin: memory-kind prompt starters (seed from an album or
     memory cluster) and on-this-day surfacing stay Phase-5 options; the
     kind column is where they plug in.

## Open questions

- **Rating halves**: integer 1–5, or allow halves? (Start integer.)
- **Collection guest link**: wanted eventually? (Out of scope here.)
- **Audio in the duplicate scanner / phash pipeline**: gallery `audio`
  assets must be excluded from photo-only pipelines — audit which gallery
  subsystems assume `kind IN ('photo','video')`.

Resolved 2026-09-01: per-chapter pages (not continuous scroll); reviews
surface on the work with the edition noted; the player is retired in favor
of the site view.

## Non-goals

- WYSIWYG editing (unchanged from v1).
- Collaborative simultaneous editing — collection roles widen *who* may
  edit, not *how many at once*; autosave-per-block stays last-write-wins.
- Copying media into stories — the rule now has zero exceptions.
- Collection-level guest links (separate decision).
- Auto-generated stories (templates pre-seed; authors write).
