# Digital Library — Audiobook Library Type

## Overview

The Digital Library module supports multiple library types. Each type has its own metadata schema, scan behaviour, processing jobs, and display logic. This document covers the audiobook library type in full.

An audiobook library indexes an existing folder of audiobook files on the home server. Original files are never moved or modified. The application scans the folder, builds a structured catalogue of books, authors, series, and chapters, enriches metadata from embedded tags and optionally from OpenLibrary, and generates cover art thumbnails for browsing.

---

## Core Concept — Book as the Unit, Not File

A file is not the primary unit in an audiobook library. A **book** is.

A book maps to a folder on disk. All audio files inside that folder are the book's files — whether it is a single `.m4b` or thirty numbered `.mp3` chapters. This model handles both formats identically and is how Audiobookshelf and similar tools work.

The recommended folder structure is:

```
/audiobooks
  /Andy Weir
    /The Martian
      cover.jpg
      The Martian.m4b
    /Project Hail Mary
      cover.jpg
      Project Hail Mary.m4b
  /Terry Pratchett
    /Discworld 01 - The Colour of Magic
      cover.jpg
      01 - The Colour of Magic.mp3
      02 - The Colour of Magic.mp3
    /Discworld 02 - The Light Fantastic
      cover.jpg
      The Light Fantastic.mp3
```

The scanner treats each leaf folder (a folder containing audio files) as one book candidate. The parent folder is treated as the author name hint if no embedded metadata is present.

---

## Library Settings

When an administrator creates an audiobook library, the following settings are configured and stored in `libraries.settings_json`:

| Setting | Default | Description |
|---|---|---|
| `folder_structure` | `author_book` | Expected layout: `author_book`, `flat`, or `series_author_book` |
| `enrich_from_openlibrary` | `true` | Attempt OpenLibrary metadata lookup after scan |
| `default_language` | `en` | Used when no language is detected from file tags |
| `show_narrator` | `true` | Display narrator prominently in the UI |
| `supported_extensions` | see below | Audio formats to include during scan |
| `cover_filenames` | `cover,folder,artwork` | Filenames to look for as folder cover images |

Default supported extensions:

```json
["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"]
```

---

## Database Schema

### Core tables

```sql
libraries
---------
id            TEXT PRIMARY KEY
name          TEXT NOT NULL
type          TEXT NOT NULL DEFAULT 'audiobook'   -- 'audiobook' | 'photo' | 'video' etc.
source_path   TEXT NOT NULL                        -- container-visible path
settings_json TEXT NOT NULL DEFAULT '{}'
scan_status   TEXT NOT NULL DEFAULT 'idle'         -- 'idle' | 'scanning' | 'error'
last_scanned_at INTEGER
created_by    TEXT NOT NULL REFERENCES users(id)
created_at    INTEGER NOT NULL
updated_at    INTEGER NOT NULL


books
-----
id                TEXT PRIMARY KEY
library_id        TEXT NOT NULL REFERENCES libraries(id)
folder_path       TEXT NOT NULL                    -- relative to library source_path
series_id         TEXT REFERENCES series(id)
series_position   REAL                             -- supports '2.5' for novellas between books
status            TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'ready' | 'error'
discovered_at     INTEGER NOT NULL
updated_at        INTEGER NOT NULL
deleted_at        INTEGER

UNIQUE (library_id, folder_path)


book_metadata
-------------
id              TEXT PRIMARY KEY
book_id         TEXT NOT NULL UNIQUE REFERENCES books(id)
source          TEXT NOT NULL DEFAULT 'scan'  -- 'scan' | 'manual' | 'openlibrary'
title           TEXT
sort_title      TEXT                           -- 'Martian, The' for correct sorting
description     TEXT
year_published  INTEGER
language        TEXT
duration_seconds INTEGER
cover_storage_key TEXT                         -- relative path in thumbnail cache
isbn            TEXT
openlibrary_id  TEXT
updated_at      INTEGER NOT NULL


authors
-------
id              TEXT PRIMARY KEY
library_id      TEXT NOT NULL REFERENCES libraries(id)
name            TEXT NOT NULL
sort_name       TEXT                           -- 'Pratchett, Terry'
bio             TEXT
cover_storage_key TEXT
openlibrary_id  TEXT

UNIQUE (library_id, name)


narrators
---------
id          TEXT PRIMARY KEY
library_id  TEXT NOT NULL REFERENCES libraries(id)
name        TEXT NOT NULL

UNIQUE (library_id, name)


series
------
id          TEXT PRIMARY KEY
library_id  TEXT NOT NULL REFERENCES libraries(id)
name        TEXT NOT NULL
sort_name   TEXT

UNIQUE (library_id, name)


genres
------
id          TEXT PRIMARY KEY
library_id  TEXT NOT NULL REFERENCES libraries(id)
name        TEXT NOT NULL

UNIQUE (library_id, name)
```

Genres are structured and sourced from metadata (embedded tags or OpenLibrary). They are library-scoped because "Fantasy" in an audiobook library and "Fantasy" in a future video library are independent controlled vocabularies.

### Join tables

```sql
book_authors
------------
book_id     TEXT NOT NULL REFERENCES books(id)
author_id   TEXT NOT NULL REFERENCES authors(id)
role        TEXT NOT NULL DEFAULT 'author'   -- 'author' | 'narrator'
sort_order  INTEGER NOT NULL DEFAULT 0

PRIMARY KEY (book_id, author_id, role)


book_genres
-----------
book_id   TEXT NOT NULL REFERENCES books(id)
genre_id  TEXT NOT NULL REFERENCES genres(id)

PRIMARY KEY (book_id, genre_id)
```

### Shared tags system

Tags are separate from genres. Genres are structured metadata sourced from file tags or OpenLibrary. Tags are freeform, user-defined labels — things like "family favourite", "long drive", "re-listen", "kids".

The tags system is designed to work across all modules — audiobooks, photos, notes, and any future module. It uses the same `module` + `resource_id` pattern as the `shares` table so no schema changes are needed when new modules are added.

```sql
tags
----
id          TEXT PRIMARY KEY
name        TEXT NOT NULL
created_by  TEXT NOT NULL REFERENCES users(id)
created_at  INTEGER NOT NULL

UNIQUE (name)


resource_tags
-------------
id          TEXT PRIMARY KEY
module      TEXT NOT NULL        -- 'library', 'notes', etc.
resource_id TEXT NOT NULL        -- book_id, asset_id, note_id, etc.
tag_id      TEXT NOT NULL REFERENCES tags(id)
created_by  TEXT NOT NULL REFERENCES users(id)
created_at  INTEGER NOT NULL

UNIQUE (module, resource_id, tag_id)
```

Tags are global — the same tag "family favourite" can be applied to an audiobook, a photo, and a note. The `module` column on `resource_tags` scopes queries per module without isolating the tags themselves.

A view provides tag usage counts for the UI, so popular tags surface and orphaned ones can be hidden:

```sql
CREATE VIEW tag_usage AS
SELECT
  t.id,
  t.name,
  COUNT(rt.id)                                    AS usage_count,
  COUNT(CASE WHEN rt.module = 'library' THEN 1 END) AS library_count,
  COUNT(CASE WHEN rt.module = 'notes'   THEN 1 END) AS notes_count
FROM tags t
LEFT JOIN resource_tags rt ON rt.tag_id = t.id
GROUP BY t.id, t.name;
```

Required indexes for tags:

```sql
CREATE INDEX idx_resource_tags_lookup  ON resource_tags(module, resource_id);
CREATE INDEX idx_resource_tags_tag     ON resource_tags(tag_id);
CREATE INDEX idx_resource_tags_creator ON resource_tags(created_by);
```

### File tracking

```sql
book_files
----------
id              TEXT PRIMARY KEY
book_id         TEXT NOT NULL REFERENCES books(id)
relative_path   TEXT NOT NULL               -- relative to library source_path
mime_type       TEXT
track_number    INTEGER                     -- sort order within the book
chapter_title   TEXT
duration_seconds INTEGER
size            INTEGER
modified_at     INTEGER
content_hash    TEXT                        -- sha256, computed at scan time

UNIQUE (book_id, relative_path)
```

### Playback progress

```sql
playback_progress
-----------------
id               TEXT PRIMARY KEY
user_id          TEXT NOT NULL REFERENCES users(id)
book_id          TEXT NOT NULL REFERENCES books(id)
current_file_id  TEXT REFERENCES book_files(id)
position_seconds INTEGER NOT NULL DEFAULT 0
duration_seconds INTEGER                    -- cached total, avoids joining book_files
percent_complete REAL                       -- stored for fast sorting by progress
updated_at       INTEGER NOT NULL
completed_at     INTEGER                    -- set when percent_complete >= 0.98

UNIQUE (user_id, book_id)
```

### Required indexes

```sql
CREATE INDEX idx_books_library        ON books(library_id, status);
CREATE INDEX idx_books_series         ON books(series_id);
CREATE INDEX idx_book_files_book      ON book_files(book_id, track_number);
CREATE INDEX idx_book_authors_book    ON book_authors(book_id);
CREATE INDEX idx_book_authors_author  ON book_authors(author_id);
CREATE INDEX idx_progress_user        ON playback_progress(user_id, updated_at DESC);
CREATE INDEX idx_progress_book        ON playback_progress(book_id);
```

Tag indexes are defined in the shared tags system section above.

---

## Scan Pipeline

The scan runs as a background job triggered when a library is created or when an admin requests a rescan.

```
Admin registers library (name, source_path, type = audiobook)
  → validate path is accessible
  → create library record (scan_status = scanning)
  → enqueue SCAN_LIBRARY job
  → return immediately — UI shows scanning state

SCAN_LIBRARY job:
  → walk source_path recursively
  → identify book folders (folders containing supported audio files)
  → for each book folder:
      → compute folder_path (relative)
      → upsert book record (status = pending)
      → upsert book_files for each audio file found
      → mark files missing if previously known but not found
      → enqueue per-book background jobs
  → update library scan_status = idle, last_scanned_at = now
```

Per-book background jobs (run concurrently after discovery):

| Job type | What it does | Dependency |
|---|---|---|
| `EXTRACT_AUDIO_METADATA` | Reads embedded ID3/MP4 tags — title, author, narrator, year, duration, chapter markers | None |
| `EXTRACT_COVER_ART` | Finds embedded cover image or `cover.jpg` in folder | None |
| `GENERATE_THUMBNAIL` | Runs Sharp to produce WebP thumbnail from cover art | `EXTRACT_COVER_ART` |
| `MATCH_SERIES_AUTHOR` | Finds or creates series, author, and narrator records | `EXTRACT_AUDIO_METADATA` |
| `ENRICH_OPENLIBRARY` | Searches OpenLibrary by title and author, fills in description, ISBN, genres | `EXTRACT_AUDIO_METADATA` |
| `FINALISE_BOOK` | Sets book status = ready once required jobs complete | All above |

A book is visible in the library browser as soon as `status = ready`. A large existing collection becomes browsable progressively — books appear as their jobs complete rather than all at once.

---

## Metadata Sources and Priority

Metadata is resolved in this order, with each level overriding the previous:

```
1. Embedded file tags (ID3 for MP3, MP4 tags for M4B)   — lowest priority
2. Folder and filename patterns                           — used as fallback hints
3. OpenLibrary API lookup                                 — fills gaps automatically
4. Manual user edits                                      — highest priority, never overwritten
```

When `book_metadata.source = 'manual'`, the enrichment jobs skip that book on rescans. Manual edits are permanent unless explicitly reset.

---

## Metadata Fields

| Field | Source | Notes |
|---|---|---|
| Title | Tags → folder name → OpenLibrary | `sort_title` strips leading articles |
| Author(s) | Tags → parent folder → OpenLibrary | Multiple authors supported |
| Narrator(s) | Tags → OpenLibrary | Stored separately from authors |
| Series name | Tags → folder name pattern → OpenLibrary | e.g. "Discworld" |
| Series position | Tags → folder name pattern | Supports decimal (2.5 for novellas) |
| Description | Tags → OpenLibrary | Plain text, no HTML |
| Year published | Tags → OpenLibrary | |
| Language | Tags → library default | ISO 639-1 code |
| Genre(s) | OpenLibrary → manual | Structured, library-scoped, multiple supported |
| User tags | User-defined | Freeform, global, via shared tags system |
| Duration | Summed from `book_files.duration_seconds` | Displayed as h:mm |
| Cover art | Embedded → `cover.jpg` → OpenLibrary | Stored as thumbnail |
| ISBN | OpenLibrary | Stored for future reference |

---

## Cover Art and Thumbnail Storage

Cover art follows the same sharded storage pattern as the rest of the library:

```
/data/cache/thumbnails/
  /ab/cd/<book-id>-cover.webp          ← 300×300 browse thumbnail
  /ab/cd/<book-id>-cover-large.webp    ← 600×600 detail view
  /ab/cd/<author-id>-photo.webp        ← author photo if available
```

Sharp generates both sizes in a single job. The `cover_storage_key` in `book_metadata` stores the relative path. The thumbnail root is configurable via `THUMBNAIL_PATH`.

If no cover art is found, the UI renders a generated placeholder using the book's title initials and a colour derived from the book ID — no missing image icons.

---

## OpenLibrary Integration

OpenLibrary is a free public API with no key required. It is queried after audio metadata extraction when `enrich_from_openlibrary = true`.

Search strategy:

```
1. Search by title + author name
   GET https://openlibrary.org/search.json?title=<title>&author=<author>&limit=3

2. Pick the best match (title similarity + author match score)

3. Fetch the work record for description, subjects (genres), and cover ID
   GET https://openlibrary.org/works/<work_id>.json

4. Fetch cover image if available
   https://covers.openlibrary.org/b/id/<cover_id>-L.jpg
```

Results are stored in `book_metadata` with `source = 'openlibrary'`. If a book already has `source = 'manual'`, the enrichment job is skipped entirely.

Failed or low-confidence lookups are logged and the book proceeds with whatever metadata was extracted from tags. OpenLibrary enrichment is best-effort and never blocks a book from becoming ready.

---

## Rescan Behaviour

A rescan discovers new books, detects changed files, and marks missing files without destroying existing metadata or playback progress.

| Condition | Action |
|---|---|
| New folder found | Create new book record, enqueue all jobs |
| Existing folder, files unchanged (path + size + modified_at match) | No action |
| Existing folder, file changed (size or modified_at differs) | Update `book_files` record, recompute `content_hash`, re-enqueue metadata jobs |
| Previously known folder not found | Set `book.deleted_at = now` (soft delete, 30-day retention) |
| Previously missing folder reappears | Clear `deleted_at`, re-enqueue jobs |

Playback progress is never touched during a rescan.

---

## Playback Progress

Progress is tracked per user per book. When a user plays a book:

- `current_file_id` — which file they are currently in
- `position_seconds` — their position within that file
- `percent_complete` — calculated and stored for fast sorting

A book is marked complete when `percent_complete >= 0.98` (allowing for credits at the end). Completed books are still accessible and progress can be reset manually.

The progress record is upserted on each position update. Updates should be debounced on the client — write no more than once every 10–15 seconds during active playback.

---

## Safety Rules

These rules apply to all audiobook library operations:

- Original audio files are read-only — never renamed, moved, or deleted by the application
- Only paths beneath the registered `source_path` are accessed during scanning
- Symbolic links that resolve outside `source_path` are not followed
- Cover art extracted from files is copied to the thumbnail cache — original files are not modified
- All `source_path` values are validated server-side; users never supply raw filesystem paths
- Relative paths are stored in the database; the `source_path` root is joined at runtime

---

## File Storage Layout

```
/data
  /cache
    /thumbnails
      /ab/cd/
        <book-id>-cover.webp
        <book-id>-cover-large.webp
        <author-id>-photo.webp

Configured library source (read-only):
  /libraries/audiobooks/
    /Andy Weir/
      /The Martian/
      /Project Hail Mary/
    /Terry Pratchett/
      /Discworld 01 - The Colour of Magic/
```

---

## Technology Dependencies

| Purpose | Library | Notes |
|---|---|---|
| Audio metadata extraction | `music-metadata` (npm) | Reads ID3, MP4, FLAC, OGG tags |
| Cover art processing | `sharp` | Resize and convert to WebP |
| OpenLibrary API | Native `fetch` | No SDK needed, simple REST |
| Chapter detection | `music-metadata` | Returns chapter array if present in file |
| File hashing | Node.js `crypto` | SHA-256, computed incrementally for large files |

---

## Future Considerations

- **Managed uploads** — users upload their own audiobooks; stored in `/data/media/library/` rather than indexed in place. Same book/file/metadata model applies.
- **Streaming endpoint** — `GET /api/library/books/:id/stream/:fileId` with byte-range support for seeking without full download.
- **Multiple authors per book** — already supported via `book_authors` join table.
- **Podcast support** — a different library type (`type = 'podcast'`) would reuse `libraries`, `book_files`, and `playback_progress` but with its own `episodes` table and RSS feed scanner instead of a folder scanner.
- **Mobile playback** — the React Native app would consume the same API endpoints and sync `playback_progress` on resume.
