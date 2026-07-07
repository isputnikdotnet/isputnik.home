# Gallery: Memories, Albums, and photo Collections — proposal

Status: **in progress** — Phases 1 (Memories) and 2 (multi-select actions) are
**built**; sharing (Phase 2.5) is an agreed design; phases 3–5 remain proposals.
Companion to
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

## Phase 1 — Memories — SHIPPED

Built as proposed (see the Memories section of
[gallery-library.md](gallery-library.md) for the as-built reference), with two
refinements: the endpoint takes the **client's** local date and reports which
fallback tier matched (`precision: day | near | month`) so both surfaces label
the row honestly, and the Home row shows one tile per year but stays hidden for
month-precision fallback matches.

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

## Phase 2 — Extend timeline multi-select (enabler) — SHIPPED

As built: the bulk bar gained **Favorite** and **Add to collection** ("Add to
album" arrives with Phase 3). Supporting pieces:

- `POST /api/library/books/bulk-save` — one request per selection (mirrors
  bulk-delete's contract: inaccessible items counted as `forbidden`, not
  errors; idempotent; never clobbers an existing favorite note).
- `POST /api/collections/:id/items/batch` — batch append with the same
  access-check-and-skip semantics as the single add; duplicates skipped.
- `AddToCollectionModal` gained a bulk mode (`entityIds`, a union with the
  single `entityId` so a call site can't pass both): clicking a collection
  batch-adds everything and reports how many were added.
- Selection is no longer delete-gated — every member can select to favorite or
  collect; only the Delete button inside the bar still requires delete rights.
- The lightbox's collections button was relabeled "Add to collection" (it said
  "Add to album", which would collide with real Albums).

## Phase 2.5 — Gallery share links — quick links SHIPPED

Set-sharing for the gallery. Decided (over "every share auto-creates an album",
Google-style): sharing is a property of a **link**, not of the set — the Immich
model — with a UI bridge into albums for the durable case.

As built (the ad-hoc half; album links + the "Save as album & share" bridge
land with Phase 3): `share_link_items` snapshot table; `POST /api/shares/set` /
`GET /api/shares/sets` (revocation via the existing module-agnostic
`DELETE /api/shares/:id`); a `gallery_set` branch on the public
`/api/share/:token` with per-item token-scoped `cover|preview|file|download`
routes (membership in the set IS the authorization); `ShareSetModal` behind a
curate-gated **Share** button in the multi-select bar; and a public grid +
keyboard-navigable viewer on the share page.

Context that shaped it: `share_links` / `shares` already exist (hashed tokens,
forced 1–30 day expiry, revocation, curator-only) and single-photo gallery links
already work. In-app user-to-user sharing of albums is moot — albums are
member-visible by design — so set-sharing means **external guest links**.

- **Ad-hoc quick link** (independent of Albums, can ship first): multi-select →
  Share → "Copy quick link". A new `share_link_items` satellite table snapshots
  the selected item ids (a sent link keeps meaning what it meant when sent).
  Only items the sharer can curate are included (others skipped and reported —
  the bulk-endpoint contract).
- **Album link** (lands with/after Phase 3): "Share album" on the album detail —
  `module='gallery_album'`, resource_id = album id, **live** (the link shows the
  album as it changes). Serve-time filtering against the link creator's
  *current* curate scope, so revoking their rights immediately shrinks what old
  links expose.
- **The bridge**: the multi-select Share dialog offers two buttons — "Copy quick
  link" (snapshot, no object to manage) and "Save as album & share" (creates the
  album from the selection, then attaches a live link).
- **Public page**: one shared-set view for both flavors — photo grid + a
  lightweight viewer, token-scoped thumbnail/file routes, no login. The
  single-photo share page stays as is.
- Later niceties, per link: download-all-as-zip (archiver is already a dep for
  book shares), password protection.

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

Memories ✓ → multi-select ✓ → share quick links → Albums (+ album share links)
→ collection kind (migration) → slideshow. Roughly increasing effort; each
phase is independently shippable.

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
