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
   detail tables (**`audiobook_details`**, **`ebook_details`**, **`gallery_details`**) keyed 1:1 by
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

## Entity-relationship diagram

Renders on GitHub. Dotted relationships are **polymorphic** — enforced in app
code, not by a foreign key (the `*_type` column says which table the id points
at). System tables with no relationships (`activity_logs`, `app_settings`,
`jobs`) are omitted.

```mermaid
erDiagram
  users {
    TEXT id PK
    TEXT email UK
    TEXT role
  }
  sessions {
    TEXT id PK
    TEXT user_id FK
    TEXT token_hash UK
    TEXT expires_at
  }
  invites {
    TEXT id PK
    TEXT created_by FK
  }
  user_groups {
    TEXT id PK
    TEXT name UK
  }
  group_members {
    TEXT group_id FK
    TEXT user_id FK
    TEXT role
  }
  assignments {
    TEXT subject_type "user|group"
    TEXT subject_id
    TEXT object_type "library|library_item|collection"
    TEXT object_id
    TEXT role "viewer..manager|deny"
  }
  storage_roots {
    TEXT id PK
    TEXT path UK
    TEXT created_by FK
  }
  libraries {
    TEXT id PK
    TEXT type "audiobook|ebook|…"
    TEXT source_path
    TEXT owner_id
    TEXT policy_json
  }
  library_items {
    TEXT id PK
    TEXT library_id FK
    TEXT type
    TEXT folder_path
    TEXT series_source
    TEXT status
  }
  item_metadata {
    TEXT item_id PK "FK"
    TEXT source "scan|manual"
    TEXT title
    TEXT cover_storage_key
  }
  audiobook_details {
    TEXT item_id PK "FK"
    TEXT asin
    INTEGER duration_seconds
  }
  ebook_details {
    TEXT item_id PK "FK"
    INTEGER page_count
  }
  gallery_details {
    TEXT item_id PK "FK"
    TEXT kind "photo|video"
    TEXT relative_path
    INTEGER width
    INTEGER height
    REAL duration_seconds
    TEXT taken_at
    REAL gps_lat
    REAL gps_lng
    TEXT preview_storage_key
  }
  people {
    TEXT id PK
    TEXT name UK
    TEXT image_storage_key
  }
  item_people {
    TEXT item_id FK
    TEXT person_id FK
    TEXT role "author|narrator|…"
  }
  person_aliases {
    TEXT alias UK
    TEXT canonical_name
  }
  series {
    TEXT id PK
    TEXT library_id FK
    TEXT name
  }
  series_items {
    TEXT series_id FK
    TEXT item_id FK
    REAL position
    TEXT source
  }
  categories {
    TEXT id PK
    TEXT key UK
    TEXT parent_id FK
  }
  category_aliases {
    TEXT keyword UK
    TEXT category_id FK
  }
  item_categories {
    TEXT item_id FK
    TEXT category_id FK
    INTEGER is_primary
    TEXT source
  }
  tags {
    TEXT id PK
    TEXT key UK
  }
  taggables {
    TEXT tag_id FK
    TEXT entity_type
    TEXT entity_id
  }
  audio_files {
    TEXT id PK
    TEXT item_id FK
    INTEGER track_number
  }
  audio_chapters {
    TEXT id PK
    TEXT audio_file_id FK
    INTEGER ordinal
  }
  document_files {
    TEXT id PK
    TEXT item_id FK
    TEXT role "content|companion"
    TEXT format
  }
  playback_progress {
    TEXT user_id FK
    TEXT item_id FK
    TEXT current_file_id FK
  }
  track_progress {
    TEXT user_id FK
    TEXT item_id FK
    TEXT file_id FK
  }
  reading_progress {
    TEXT user_id FK
    TEXT item_id FK
    TEXT document_id FK
    TEXT location
  }
  audio_bookmarks {
    TEXT user_id FK
    TEXT item_id FK
    TEXT file_id FK
  }
  reading_bookmarks {
    TEXT user_id FK
    TEXT item_id FK
    TEXT document_id FK
  }
  item_saves {
    TEXT user_id FK
    TEXT item_id FK
  }
  collections {
    TEXT id PK
    TEXT user_id FK
    TEXT name
  }
  collection_items {
    TEXT collection_id FK
    TEXT entity_type
    TEXT entity_id
  }
  shares {
    TEXT id PK
    TEXT module
    TEXT resource_id
    TEXT user_id FK
  }
  share_links {
    TEXT id PK
    TEXT module
    TEXT resource_id
    TEXT token_hash UK
  }
  trashed_items {
    TEXT id PK
    TEXT library_id
    TEXT library_type
  }

  users ||--o{ sessions : "has"
  users ||--o{ invites : "issues"
  users ||--o{ user_groups : "creates"
  user_groups ||--o{ group_members : "has"
  users ||--o{ group_members : "in"
  users }o..o{ assignments : "subject"
  user_groups }o..o{ assignments : "subject"

  users ||--o{ libraries : "creates"
  users ||--o{ storage_roots : "configures"
  libraries ||--o{ library_items : "contains"
  library_items ||--|| item_metadata : "described by"
  library_items ||--o| audiobook_details : "if audiobook"
  library_items ||--o| ebook_details : "if ebook"
  library_items ||--o| gallery_details : "if gallery"

  library_items ||--o{ item_people : "credits"
  people ||--o{ item_people : "credited on"
  people ||..o{ person_aliases : "alias (by name)"
  libraries ||--o{ series : "scoped to"
  series ||--o{ series_items : "orders"
  library_items ||--o{ series_items : "in"

  categories ||--o| categories : "parent"
  categories ||--o{ category_aliases : "matched by"
  categories ||--o{ item_categories : "applied to"
  library_items ||--o{ item_categories : "categorised"
  tags ||--o{ taggables : "linked via"
  library_items }o..o{ taggables : "tagged (poly)"

  library_items ||--o{ audio_files : "has"
  audio_files ||--o{ audio_chapters : "has"
  library_items ||--o{ document_files : "has"

  library_items ||--o{ playback_progress : "progress"
  users ||--o{ playback_progress : "by user"
  library_items ||--o{ track_progress : "progress"
  users ||--o{ track_progress : "by user"
  library_items ||--o{ reading_progress : "progress"
  users ||--o{ reading_progress : "by user"
  library_items ||--o{ audio_bookmarks : "bookmarks"
  users ||--o{ audio_bookmarks : "by user"
  library_items ||--o{ reading_bookmarks : "bookmarks"
  users ||--o{ reading_bookmarks : "by user"
  library_items ||--o{ item_saves : "saved"
  users ||--o{ item_saves : "by user"

  users ||--o{ collections : "owns"
  collections ||--o{ collection_items : "contains"
  library_items }o..o{ collection_items : "member (poly)"
  users ||--o{ shares : "granted to"
  library_items }o..o{ shares : "shared (poly)"
  library_items }o..o{ share_links : "shared (poly)"
  libraries }o..o{ trashed_items : "snapshot (no FK)"
```

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
