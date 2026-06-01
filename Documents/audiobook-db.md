# Digital Library — Audiobook Database Diagram

Entity-relationship diagram for the audiobook library type. Shared system tables (`shares`, `jobs`) are shown in outline — the sharing model schema is in [`sharing.md`](sharing.md).

---

## Diagram

```mermaid
erDiagram

    %% ── Library container ──────────────────────────────────────────
    libraries {
        TEXT id PK
        TEXT name
        TEXT type
        TEXT source_path
        TEXT settings_json
        TEXT scan_status
        TEXT last_scanned_at
        TEXT created_by FK
        TEXT created_at
        TEXT updated_at
    }

    %% ── Book record ─────────────────────────────────────────────────
    books {
        TEXT id PK
        TEXT library_id FK
        TEXT folder_path
        TEXT series_id FK
        REAL series_position
        TEXT status
        TEXT discovered_at
        TEXT updated_at
        TEXT deleted_at
    }

    %% ── One-to-one metadata ──────────────────────────────────────────
    book_metadata {
        TEXT id PK
        TEXT book_id FK
        TEXT source
        TEXT title
        TEXT sort_title
        TEXT description
        INTEGER year_published
        TEXT language
        INTEGER duration_seconds
        TEXT cover_storage_key
        TEXT isbn
        TEXT asin
        TEXT publisher
        TEXT openlibrary_id
        TEXT category_id FK
        TEXT updated_at
    }

    %% ── Audio files ──────────────────────────────────────────────────
    book_files {
        TEXT id PK
        TEXT book_id FK
        TEXT relative_path
        TEXT mime_type
        INTEGER track_number
        TEXT chapter_title
        INTEGER duration_seconds
        INTEGER size
        TEXT modified_at
        TEXT content_hash
        TEXT status
        TEXT discovered_at
        TEXT updated_at
        TEXT deleted_at
    }

    %% ── Library-scoped lookup tables ─────────────────────────────────
    authors {
        TEXT id PK
        TEXT library_id FK
        TEXT name
        TEXT sort_name
        TEXT bio
        TEXT cover_storage_key
        TEXT openlibrary_id
    }

    series {
        TEXT id PK
        TEXT library_id FK
        TEXT name
        TEXT sort_name
    }

    genres {
        TEXT id PK
        TEXT library_id FK
        TEXT name
    }

    categories {
        TEXT id PK
        TEXT key
        TEXT name
        INTEGER sort_order
        TEXT icon
        TEXT image_storage_key
    }

    category_aliases {
        TEXT id PK
        TEXT keyword
        TEXT category_id FK
        INTEGER priority
    }

    tags {
        TEXT id PK
        TEXT key
        TEXT display_name
        TEXT created_at
    }

    taggables {
        TEXT tag_id FK
        TEXT entity_type
        TEXT entity_id
    }

    %% ── Join tables ──────────────────────────────────────────────────
    book_authors {
        TEXT book_id FK
        TEXT author_id FK
        TEXT role
        INTEGER sort_order
    }

    book_genres {
        TEXT book_id FK
        TEXT genre_id FK
    }

    %% ── Playback ─────────────────────────────────────────────────────
    playback_progress {
        TEXT id PK
        TEXT user_id FK
        TEXT book_id FK
        TEXT current_file_id FK
        INTEGER position_seconds
        INTEGER duration_seconds
        REAL percent_complete
        TEXT updated_at
        TEXT completed_at
    }

    %% ── Per-user bookmarks ───────────────────────────────────────────
    book_bookmarks {
        TEXT id PK
        TEXT user_id FK
        TEXT book_id FK
        TEXT file_id FK
        INTEGER position_seconds
        INTEGER book_position_seconds
        TEXT label
        TEXT note
        TEXT created_at
        TEXT updated_at
    }

    %% ── Per-user saved books (My List) ───────────────────────────────
    book_saves {
        TEXT id PK
        TEXT user_id FK
        TEXT book_id FK
        TEXT note
        TEXT created_at
        TEXT updated_at
    }

    %% ── Library sections (grouping shell) ────────────────────────────
    library_sections {
        TEXT id PK
        TEXT name
        TEXT icon
        TEXT created_by FK
        TEXT created_at
        TEXT updated_at
    }

    %% ── Shared systems (outline only) ────────────────────────────────
    jobs {
        TEXT id PK
        TEXT type
        TEXT payload
        TEXT status
    }

    %% ── Relationships ────────────────────────────────────────────────

    libraries ||--o{ books          : "contains"
    libraries ||--o{ authors        : "scoped to"
    libraries ||--o{ series         : "scoped to"
    libraries ||--o{ genres         : "scoped to"

    series    ||--o{ books          : "groups"
    categories ||--o{ book_metadata : "assigned to"
    categories ||--o{ category_aliases : "matched by"
    tags      ||--o{ taggables      : "linked via"

    books     ||--||  book_metadata : "has one"
    books     ||--o{  book_files    : "has many"
    books     ||--o{  book_authors  : "linked via"
    books     ||--o{  book_genres   : "linked via"
    books     ||--o{  taggables     : "tagged via"
    books     ||--o{  playback_progress : "tracked by"
    books     ||--o{  book_bookmarks : "bookmarked in"
    books     ||--o{  book_saves     : "saved in"
    authors   ||--o{  book_authors  : "linked via"
    genres    ||--o{  book_genres   : "linked via"

    book_files ||--o{ playback_progress : "position in"
    book_files ||--o{ book_bookmarks    : "anchored in"

    jobs      }o--||  libraries     : "scan job for"
    library_sections ||..o{ libraries : "groups (via settings_json.section_id)"
```

---

## Table Reference

### `libraries`

The top-level record for an audiobook library. `type = 'audiobook'` selects the scanner and display logic. `settings_json` holds audiobook-specific settings (folder_structure, default_language, supported_extensions, etc.). `scan_status` drives the UI scanning indicator.

### `books`

One record per book folder. The unique key is `(library_id, folder_path)` — folder path is relative to the library `source_path`. `deleted_at` is set on rescan when a folder is no longer found; cleared if it reappears.

### `book_metadata`

One-to-one with `books`. Holds all descriptive metadata. `source` tracks origin:
- `'scan'` — written by the scanner, can be overwritten on rescan
- `'manual'` — set by user edit, never overwritten by the scanner

`cover_storage_key` is a relative path into the thumbnail cache, e.g. `ab/cd/<book-id>-cover.webp`.
`category_id` stores the book's single primary navigation category. If no mapping matches, the scanner assigns the seeded `general_other` category.

### `book_files`

One record per audio file. `relative_path` is relative to `source_path`. `track_number` determines playback order within the book — set from the audio tag if present, otherwise parsed from the filename prefix, otherwise the sort index. `status = 'missing'` when a file is not found during rescan.

### `authors`

Library-scoped. Both authors and narrators are stored here; `book_authors.role` distinguishes them. `sort_name` is used for alphabetical listing (e.g. "Pratchett, Terry"). The separate `narrators` table is reserved for a future phase when narrators get richer metadata.

### `series`

Library-scoped. `books.series_position` supports decimals (2.5 for novellas between books). `sort_name` strips leading articles for sorting.

### `genres` / `book_genres` (deprecated)

The original library-scoped freeform genre tables. **Superseded** by the two-layer model below — the scanner no longer writes to them. Retained only to avoid a destructive migration; safe to drop later.

### Genre model — categories + tags

Incoming genre strings (from audio tags and sidecars) are split into two layers:

- **`categories`** — a fixed, app-defined, global navigation taxonomy: Fiction, Classics & Literary, Adventure & Action, Mystery & Thriller, Sci-Fi & Fantasy, Horror & Supernatural, Romance, Humor & Satire, Biographies & Memoirs, History, Self-Help & Business, Science & Culture, Kids & Teens, plus the `general_other` fallback. Seeded on startup from `categories-seed.ts`. A book has **one** primary category (`book_metadata.category_id`).
- **`category_aliases`** — `keyword → category_id` with a `priority`. The scanner normalizes each raw genre and assigns the highest-priority keyword match; no match → General / Other. Default aliases are English-only for new installs, and admins can add/edit aliases per category.
- **`tags`** — global, freeform, normalized-by `key`. Every raw genre becomes a tag (the descriptive/filter layer). Nothing is discarded.
- **`taggables`** — polymorphic link (`tag_id`, `entity_type`, `entity_id`) so tags are reusable across future library types and Notes, not just books. No FK on `entity_id`; library/book deletion cleans up its rows explicitly.

Example: a scanned tag `historical mystery` matches the `mystery` keyword for Mystery & Thriller and could also match a lower-priority history keyword. The higher-priority match wins, so the book lands in Mystery & Thriller.

`book_metadata.category_id` (and the book's tags) are protected by the `source = 'manual'` rule — a manual category/tag edit survives rescans.

### `book_authors`

Join table linking books to authors/narrators. `role` is `'author'` or `'narrator'`. `sort_order` controls display order when a book has multiple authors.

### `book_genres`

Deprecated join table linking books to the old `genres` table. The scanner now writes `category_id` and `taggables` instead.

### `playback_progress`

One record per `(user_id, book_id)` pair, upserted on each position save. `current_file_id` is the file currently in progress. `percent_complete` is stored (not computed on read) for efficient sorting. Marked complete at 0.98 to allow for end credits.

### `book_bookmarks`

Per-user position bookmarks within a book — many rows per `(user_id, book_id)`. `file_id` + `position_seconds` locate the moment within a specific track (used to seek); `book_position_seconds` is the absolute offset within the whole book, denormalized on write for display and ordering. `label` defaults to the chapter title; `note` is optional free text. `file_id` is `ON DELETE SET NULL` so a bookmark survives if its file is purged. Private to the owning user.

### `book_saves`

Per-user "saved" flag for a whole book — the My List view. Unique on `(user_id, book_id)`, so a book is either saved or not. `note` holds an optional book-level note (a personal thought or mini-review), distinct from per-moment bookmark notes. Private to the owning user.

### `library_sections`

Grouping shell for **Special Sections** — a master entry in the audiobook sidebar that holds one or more audiobook libraries. Owns only identity (`name`, `icon`). Membership is not a foreign key: a library joins a section by storing `section_id` in its `settings_json`, and per-library metadata overrides live in `settings_json.overrides`. Member counts are derived with `json_extract`. Deleting a section detaches its members (clears their `section_id`); no books or files are removed. See [`special-section.md`](special-section.md).

### `jobs`

Background job queue. Scan jobs are type `SCAN_AUDIOBOOK_LIBRARY`; Phase 2 uses the queue for async scan execution, retries, and completed scan audit details.

---

## Notes

**Narrators** are currently stored in the `authors` table with `book_authors.role = 'narrator'`. The standalone `narrators` table exists in the schema but is not yet populated. Phase 3 separates them when narrator-specific metadata (bio, photo) is needed.

**`openlibrary_id`** on `book_metadata` and `authors` is retained as a reserved field for any future enrichment source that uses OpenLibrary identifiers. It is not populated by the current scanner.

**Soft delete** — `books.deleted_at` and `book_files.deleted_at` are set rather than deleting rows. Rows are permanently purged after 30 days by a future maintenance job.
