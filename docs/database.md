# iSputnik Home — Database

Canonical reference for the schema. The authoritative DDL is
[`apps/server/src/db/schema.sql`](../apps/server/src/db/schema.sql); this
document explains the model and the conventions behind it.

> **Status:** target design for the unified `library_items` model (replaces the
> `books`-centric schema). Being rolled out as a from-scratch rebuild — no data
> migration, the development database is recreated from `schema.sql`.

---

## Design principles

1. **Generic spine, typed extensions.** Every item — audiobook, ebook, future
   gallery/document — is one row in **`library_items`**. Shared descriptive data
   lives in **`item_metadata`** (1:1); media-specific columns live in per-type
   detail tables (**`audiobook_details`**, **`ebook_details`**) keyed 1:1 by
   `item_id`. Adding a media type = one library `type`, one `*_details` table,
   and its file/progress tables — never a reshape of the core.
2. **Shared concerns are media-agnostic.** Categories, tags, collections,
   permissions, sharing, favorites ("My List"), and the recycle bin attach to
   items generically, so every library type gets them for free.
3. **People are global; series are per-library.** `people` is not scoped to a
   library, so the same author/narrator can appear across libraries; a book
   `series` belongs to one library. Item links go through `item_people` and
   `series_items`.
4. **One permission model.** All access resolves through `assignments`
   (see [`permissions.md`](permissions.md)) — `object_type` is `'library'`,
   `'library_item'`, `'collection'`, … Public = the Everyone group's row;
   an owner = a `manager` row.

## Conventions

- **Naming.** snake_case, plural tables. `*_id` foreign keys, `*_at` timestamps,
  `*_json` JSON blobs, `*_hash` hashes, `is_*` / `*_from_*` booleans. Join tables
  read `noun_noun` (`item_people`, `series_items`, `collection_items`).
- **Primary keys.** `TEXT` nanoid for entities; composite PKs on join tables.
- **Timestamps.** ISO-8601 UTC with milliseconds — `'YYYY-MM-DDThh:mm:ss.sssZ'`.
  The SQL default `strftime('%Y-%m-%dT%H:%M:%fZ','now')` produces exactly what
  JS `new Date().toISOString()` produces, so a column never mixes formats. App
  code uses a shared `nowIso()` helper.
- **Booleans** are `INTEGER` `0/1` with a `CHECK`. **Enums** are
  `CHECK (col IN (...))` — except `libraries.type` and the polymorphic `*_type`
  columns, left unconstrained so new types need no schema change (validated in
  app code via Zod).
- **Source tracking.** `item_metadata.source`, `item_categories.source`, and
  `series_items.source` mark `'manual'` rows the scanner must not overwrite.
- **Soft delete.** `library_items` / `audio_files` / `document_files` carry
  `deleted_at` (set on rescan when a path disappears, cleared if it returns).
  User-initiated deletion goes through the Recycle Bin (`trashed_items`,
  see [`recycle-bin.md`](recycle-bin.md)).
- **Polymorphic links** (`assignments`, `taggables`, `collection_items`,
  `shares`, `share_links`, `trashed_items`) carry **no FK** on the polymorphic
  id by necessity — the owning module must delete their rows when a resource is
  removed. This is the schema's one integrity trade-off; the cleanup helpers and
  the access-control tests guard it.

---

## Model overview

```text
users ─┬─ sessions / invites
       ├─ user_groups ── group_members
       └─ assignments ───────────────►  (library | library_item | collection)

libraries
   └── library_items ──┬── item_metadata        (1:1 shared)
                       ├── audiobook_details     (1:1)   ┐ exactly one
                       ├── ebook_details         (1:1)   ┘ per item type
                       ├── item_people ───── people       (global)
                       ├── series_items ──── series       (per-library)
                       ├── item_categories ─ categories ── category_aliases
                       ├── taggables ─────── tags          (polymorphic)
                       ├── collection_items ─ collections  (polymorphic)
                       ├── audio_files ───── audio_chapters
                       ├── document_files
                       ├── playback_progress / track_progress / audio_bookmarks
                       ├── reading_progress / reading_bookmarks
                       └── item_saves   ("My List")

shares / share_links   ── item-level sharing (module, resource_id)
trashed_items          ── recycle bin
activity_logs / app_settings / jobs / storage_roots  ── system
```

---

## Migration from the `books`-centric schema

Table/column map for anyone porting old queries:

| Old | New |
|---|---|
| `books` | `library_items` |
| `book_metadata` (shared cols) | `item_metadata` |
| `book_metadata.duration_seconds`, `.asin` | `audiobook_details` |
| *(new)* | `ebook_details` |
| `book_metadata.category_id` | `item_categories` (M2M, `is_primary`, `source`) |
| `authors` (library-scoped) | `people` (global) |
| `book_authors` | `item_people` |
| `series` (library-scoped), `books.series_id/series_position` | `series` (library-scoped) + `series_items` |
| `book_files` | `audio_files` (`chapter_title` → `title`) |
| `book_chapters` (`book_file_id`) | `audio_chapters` (`audio_file_id`) |
| `book_documents` | `document_files` (+ `role` content/companion) |
| `book_bookmarks` (`book_position_seconds`) | `audio_bookmarks` (`item_position_seconds`) |
| `ebook_bookmarks` (`cfi`) | `reading_bookmarks` (`location`) |
| `reading_progress.cfi` | `reading_progress.location` |
| `book_saves` | `item_saves` |
| `sessions.last_seen` | `sessions.last_seen_at` |
| `assignments`, `shares`, `share_links`, `tags`, `taggables`, `collections`, `collection_items`, `trashed_items`, `users`, `sessions`, `invites`, `user_groups`, `group_members`, `categories`, `category_aliases`, `person_aliases`, `storage_roots`, `libraries`, `activity_logs`, `app_settings`, `jobs` | unchanged (categories gains `slug`/`parent_id`) |

Polymorphic `*_type` values that referenced `'audiobook'`/`'ebook'` as the item
kind become `'library_item'` (the item's own `type` column carries the media
kind). `module` on `shares`/`share_links` is unchanged.

---

## Versioning & migrations

A fresh database applies `schema.sql` and sets `PRAGMA user_version` to the
current migration count. Going forward — once there is data worth keeping —
schema changes are **ordered, append-only migration files** run by a small
runner that compares `user_version` to the highest migration and applies the
gap inside a transaction. This replaces the ad-hoc `PRAGMA table_info` + `ALTER`
checks that previously lived inline in `db.ts`. Seed data (navigation categories
and alias keywords) is applied idempotently after migrations.

---

## Table reference

**Identity & access** — `users`, `sessions`, `invites`, `user_groups`,
`group_members`, `assignments` (the unified role engine; see
[`permissions.md`](permissions.md)).

**Libraries & items** — `storage_roots`, `libraries` (owner + `policy_json`
write gates), `library_items` (the spine), `item_metadata` (1:1 shared),
`audiobook_details` / `ebook_details` (1:1 typed).

**People, series, taxonomy** — `people` + `item_people` + `person_aliases`;
`series` + `series_items`; `categories` (+ `parent_id`) + `category_aliases` +
`item_categories`; `tags` + `taggables`. See [`categories.md`](categories.md)
and [`tags.md`](tags.md).

**Media files** — `audio_files` + `audio_chapters`; `document_files` (`role`
content = the ebook itself, companion = a doc bundled with an audiobook).

**Progress & bookmarks** — `playback_progress` (linear audio),
`track_progress` (episodic), `reading_progress` (ebook); `audio_bookmarks`,
`reading_bookmarks`; `item_saves` ("My List").

**Collections & sharing** — `collections` + `collection_items` (polymorphic);
`shares` + `share_links` (item-level; see [`sharing.md`](sharing.md)).

**System** — `trashed_items` (recycle bin), `activity_logs`, `app_settings`,
`jobs`, `storage_roots`.
