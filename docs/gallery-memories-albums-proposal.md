# Gallery: Memories, Albums, and photo Collections — proposal

Status: **proposal** (agreed direction, not yet built). Companion to
[gallery-library.md](gallery-library.md), which describes what is shipped today.
Supersedes the "Dedicated shareable album object (v1 uses Collections)" bullet in
that doc's future-phases list.

## Goal

Three separate, complementary features for the photo/video gallery:

1. **Memories** — automatic date-based resurfacing ("On this day"). Zero curation.
2. **Albums** — a gallery-native curated set. The everyday organization tool.
3. **Collections (photo-pure)** — hand-picked sets built for *presentation*:
   in-browser slideshow. Photos never mix with books.

The mental model, so the features never feel like duplicates:

| Structure   | What it answers              | Curation  | Scope        |
| ----------- | ---------------------------- | --------- | ------------ |
| Folders     | "how is it stored on disk?"  | none      | per library  |
| Memories    | "what happened on this day?" | automatic | all gallery  |
| Albums      | "how do I organize photos?"  | manual    | all gallery  |
| Collections | "what do I want to present?" | manual    | cross-user feature, photo-only kind |

The slideshow lives **only on collections** — that is what keeps Albums
(organize) and Collections (present) distinct.

## Phase 1 — Memories

No schema changes; `gallery_details.taken_at` is already indexed.

- **Endpoint** `GET /api/library/gallery/memories`: photos whose `taken_at`
  month/day matches today, across past years, grouped by year:
  `[{ year, count, items: [...] }]`. Same access filtering as the timeline
  endpoint (only libraries the user can access).
- **Fallback so the row is never empty**: exact day → widen to ±3 days → same
  month. Items without `taken_at` are excluded.
- **UI**: a Memories row at the top of the gallery Timeline
  ("On this day — 2019 · 12 photos"); tapping a year opens the lightbox scoped
  to that year's set.
- **Home tile**: gallery's first presence on the Home dashboard. One
  fixed-width tile per home conventions ("On this day — N photos"), linking to
  the gallery with the memories row expanded. Hidden when there is nothing to
  show.

## Phase 2 — Extend timeline multi-select (enabler)

The timeline **already has** a selection mode with a bulk bar, built for bulk
delete (`GalleryPage.tsx` — Select mode mirroring the audiobook/ebook pages).
This phase only adds actions to the existing bar: **Add to album**,
**Add to collection**, **Favorite**. Small effort, and it serves Albums and
Collections both — without batch add, building a set one photo at a time
through the lightbox is impractical.

## Phase 3 — Albums

Gallery-native entity under `modules/library/gallery`, like the faces tables.

**Schema** (new tables → auto-apply from `schema.sql`, no `migrations[]` entry):

```sql
CREATE TABLE IF NOT EXISTS gallery_albums (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  cover_item_id TEXT REFERENCES library_items(id) ON DELETE SET NULL,
  sort_mode     TEXT NOT NULL DEFAULT 'taken_at',   -- 'taken_at' | 'manual'
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS gallery_album_items (
  album_id TEXT NOT NULL REFERENCES gallery_albums(id) ON DELETE CASCADE,
  item_id  TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (album_id, item_id)
);
```

Albums span all gallery libraries; on read, items are filtered by the viewing
user's library access (same pattern as the collections hydrator).

- **API** under `/api/library/gallery/albums`: CRUD, batch add/remove items,
  set cover, reorder (manual mode).
- **UI**: an **Albums** tab in the gallery alongside Timeline / Folders / Map /
  People. Album cards (cover + name + count); detail view is a photo grid
  feeding the existing lightbox, with a `taken_at` / manual sort toggle.
  "Add to album" appears in the multi-select toolbar and the lightbox.

## Phase 4 — Collections become type-pure

Collections gain a kind; photos and books never share a collection.

- **Migration required** (new column on an existing table):
  `collections.kind TEXT NOT NULL DEFAULT 'books'` — values `'books'`
  (audiobooks + ebooks, which already mix freely) and `'photos'` (gallery
  only). Backfill: a collection whose members are all gallery items becomes
  `'photos'`; everything else stays `'books'`.
- **Server enforcement**: adding an entity whose kind conflicts with the
  collection's kind is rejected (400). Mixed collections that predate the
  migration keep rendering (hydrators are unaffected) but cannot grow more
  mixed.
- **Web**: `AddToCollectionModal` lists only compatible collections for the
  entity type being added, and creates new collections with the correct kind.
  The collections page may badge photo collections with a photo-grid style
  card instead of the bookshelf tile.

## Phase 5 — Slideshow (in-browser)

On photo collections: a fullscreen self-advancing viewer — effectively an
auto-advance mode of the existing `GalleryLightbox`. Interval setting,
crossfade, manual override (arrow keys pause auto-advance). Videos either play
through or are skipped (see open questions). Cheap to build since the lightbox
is reused.

## Build order

Memories → multi-select → Albums → collection kind (migration) → slideshow.
Roughly increasing effort; each phase is independently shippable.

## Open questions

- **Album ownership**: `created_by` grants edit rights — can other members
  edit, or view-only? (Proposal: view for everyone with library access, edit
  for creator + admins; revisit if collaborative albums are wanted.)
- **Slideshow on albums too?** Proposal: no — collections-only keeps the
  organize/present split crisp. Cheap to add later if it feels arbitrary.
- **Videos in slideshow**: play through (long clips can dominate) vs skip vs
  trim to N seconds.

## Non-goals (v1)

- ML semantic search or auto-curated "highlight movies" (Google-style).
- Nested albums, collaborative editing, album share links.
- **MP4 movie export** — dropped from this plan. If revisited later: it fits
  the existing background-jobs + Tasks-page infrastructure, and ffmpeg is
  already a gallery dependency, so nothing in this design blocks it.
