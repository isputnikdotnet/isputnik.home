# Digital Library — Audiobook Library Type

## Overview

An audiobook library indexes an existing folder of audiobook files on the home server. Original files are never moved or modified. The application scans the folder, builds a structured catalogue of books, authors, series, and chapters, and generates cover art thumbnails for browsing.

See [`audiobook-db.md`](audiobook-db.md) for the full entity-relationship diagram.

---

## Core Concept — Folder = Book

A file is not the primary unit. A **book** is.

A book maps to a folder on disk. All audio files inside that folder are the book's files — whether it is a single `.m4b` or thirty numbered `.mp3` chapters. This model handles both formats identically.

Recommended folder structure:

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
```

The scanner treats each leaf folder containing audio files as one book. The parent folder is the author name hint when no embedded metadata is present.

---

## Implementation Phases

| Phase | Status | Scope |
|---|---|---|
| **1 — Foundation** | Complete | Library registration, folder walk, DB upsert (folder names), rescan, admin UI |
| **2 — Audio metadata** | Complete | `music-metadata` tag reading, disc folder collapse, cover art detection, async scan |
| **3 — Enrichment** | In progress | Sidecar file import, per-book metadata lookup (iTunes, OpenLibrary, FantLab), manual metadata editing/pinning |
| **4 — Polish** | Future | Metadata export, file system watcher, inode tracking, streaming endpoint |

---

## Library Settings

Stored in `libraries.settings_json` when a library is created:

| Setting | Default | Description |
|---|---|---|
| `folder_structure` | `author_book` | Expected layout hint: `author_book`, `flat`, or `series_author_book` |
| `default_language` | `en` | Fallback when no language tag is found |
| `show_narrator` | `true` | Display narrator prominently in the UI |
| `supported_extensions` | see below | Audio formats to include during scan |
| `cover_filenames` | `cover,folder,artwork` | Image filenames to recognise as folder cover art |

Default supported extensions:

```json
["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac"]
```

---

## Database Schema

See [`audiobook-db.md`](audiobook-db.md) for the full ER diagram.

### Core tables

```sql
libraries
---------
id            TEXT PRIMARY KEY
name          TEXT NOT NULL
type          TEXT NOT NULL                        -- 'audiobook' | 'photo' | 'video' etc.
source_path   TEXT NOT NULL                        -- container-visible path
settings_json TEXT NOT NULL DEFAULT '{}'
scan_status   TEXT NOT NULL DEFAULT 'idle'         -- 'idle' | 'scanning' | 'error'
last_scanned_at TEXT
created_by    TEXT NOT NULL REFERENCES users(id)
created_at    TEXT NOT NULL
updated_at    TEXT NOT NULL


books
-----
id                TEXT PRIMARY KEY
library_id        TEXT NOT NULL REFERENCES libraries(id)
folder_path       TEXT NOT NULL                    -- relative to library source_path
series_id         TEXT REFERENCES series(id)
series_position   REAL                             -- supports '2.5' for novellas
status            TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'ready' | 'error'
discovered_at     TEXT NOT NULL
updated_at        TEXT NOT NULL
deleted_at        TEXT

UNIQUE (library_id, folder_path)


book_metadata
-------------
id               TEXT PRIMARY KEY
book_id          TEXT NOT NULL UNIQUE REFERENCES books(id)
source           TEXT NOT NULL DEFAULT 'scan'  -- 'scan' | 'manual'
title            TEXT
sort_title       TEXT                          -- 'Martian, The' for correct sorting
description      TEXT
year_published   INTEGER
language         TEXT
duration_seconds INTEGER                      -- summed from book_files (Phase 2)
cover_storage_key TEXT                        -- relative path in thumbnail cache (Phase 2)
isbn             TEXT
asin             TEXT                         -- Audible Standard Identification Number
publisher        TEXT
openlibrary_id   TEXT                         -- reserved for future enrichment
updated_at       TEXT NOT NULL


authors
-------
id              TEXT PRIMARY KEY
library_id      TEXT NOT NULL REFERENCES libraries(id)
name            TEXT NOT NULL
sort_name       TEXT                          -- 'Pratchett, Terry'
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

Note: narrators are currently stored in the authors table with book_authors.role = 'narrator'.
The narrators table is reserved for Phase 3 when narrators get their own entity.


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

Genres are library-scoped controlled vocabulary — "Fantasy" in an audiobook library and "Fantasy" in a future video library are independent.

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

### File tracking

```sql
book_files
----------
id               TEXT PRIMARY KEY
book_id          TEXT NOT NULL REFERENCES books(id)
relative_path    TEXT NOT NULL               -- relative to library source_path
mime_type        TEXT
track_number     INTEGER                     -- sort order within the book
chapter_title    TEXT
duration_seconds INTEGER                    -- per-file duration (Phase 2, from music-metadata)
size             INTEGER
modified_at      TEXT
content_hash     TEXT                        -- sha256 (Phase 2)

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
percent_complete REAL                       -- stored for fast sorting
updated_at       TEXT NOT NULL
completed_at     TEXT                       -- set when percent_complete >= 0.98

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

---

## Scan Pipeline

### Current implementation (Phase 2)

The scan runs asynchronously through the SQLite job queue. Create and rescan requests enqueue `SCAN_AUDIOBOOK_LIBRARY`, set `scan_status = 'scanning'`, and return immediately. The worker processes scan jobs in the server process; the UI polls `scan_status` until it returns to `idle`.

```
Admin registers library (name, source_path, defaultLanguage)
  → validateLibrarySource:
      - path must be absolute
      - directory must exist
      - must fall inside a registered storage root
      - must not overlap with THUMBNAIL_PATH
  → INSERT libraries record
  → scanAudiobookLibrary(libraryId) — runs inline, returns when done

scanAudiobookLibrary:
  → SET scan_status = 'scanning'
  → walkAudiobookFiles(rootPath):
      recursive walk, skip symlinks outside root
      collect audio files grouped by parent folder
      return Map<folderAbsPath, files[]>

  → BEGIN TRANSACTION
  → for each book folder:
      sort files by filename (alpha-numeric)
      folderPath = relative path from library root

      upsert book (library_id, folder_path)
        new  → INSERT status='ready'
        seen → UPDATE status='ready', deleted_at=NULL

      upsert book_metadata
        title       = first file's album/title tag, falling back to folder name
        sort_title  = strip leading "the/a/an"
        language    = tag language, falling back to settings.default_language
        description, year, publisher, isbn, asin from tags when available
        duration_seconds = sum(book_files.duration_seconds)
        cover_storage_key = generated WebP thumbnail key when cover art is found

      upsert author from artist/albumartist tag, falling back to parent folder name
      upsert narrators from composer tag as book_authors.role='narrator'
      upsert genres from genre tags
      INSERT book_authors (role='author') ON CONFLICT DO NOTHING

      mark all existing book_files as status='missing'
      for each audio file (sorted):
        upsert book_files
          track_number  = parse from filename prefix or sort index
          chapter_title = tag title or filename without extension
          mime_type     = mapped from extension
          duration_seconds = music-metadata duration
          size          = fs.statSync
          modified_at   = fs.statSync
          content_hash  = sha256

  → soft-delete books not found in this walk (deleted_at = now)
  → mark their files missing
  → mark job completed with discovered book/file counts
  → SET scan_status='idle', last_scanned_at=now
  → COMMIT
```

### Phase 2 additions implemented

The following steps are added to the per-book loop when `music-metadata` is integrated:

```
Phase 2 additions per book folder:
  → disc folder detection:
      if sub-folders match /^(cd|disc|disk)\s*\d+$/i
      collect files from all disc sub-folders as part of this book
      do not create separate book records for disc folders

  → read first file with music-metadata (tags for book-level metadata):
      title         ← tag: title / album
      author(s)     ← tag: artist / albumartist (comma-split for multiple)
      narrator(s)   ← tag: composer
      year          ← tag: date / year
      description   ← tag: description / comment
      language      ← tag: language
      genres        ← tag: genre (comma-split)

  → read all files with music-metadata (physical properties):
      duration_seconds per file → sum for book total
      track_number → tag: track (overrides filename parse if present)
      disc_number  → tag: disc (for multi-disc sort ordering)

  → look for cover image in folder:
      check filenames: cover.jpg, cover.png, folder.jpg, artwork.jpg, etc.
      if found: copy to /data/cache/thumbnails/<shard>/<book-id>-cover.webp
               generate 300×300 WebP with sharp

  → upsert book_metadata with tag values (skip fields where source='manual')
  → upsert authors, narrators, genres from tags
```

### Phase 2 architecture change — async scan

`scanAudiobookLibrary` now runs from the job queue. The HTTP request creates the library record and enqueues `SCAN_AUDIOBOOK_LIBRARY`, then returns immediately. The UI polls `scan_status` and shows a scanning indicator until `idle`. Failed jobs retry up to `max_attempts`, and stale running jobs can be reclaimed by the worker.

---

## Metadata Sources and Priority

Metadata is resolved in this order. Each level overrides the previous except `source = 'manual'` which is never overwritten.

| Priority | Source | Phase | What it provides |
|---|---|---|---|
| 1 (lowest) | Folder and filename patterns | Phase 1 ✓ | Title (folder name), author (parent folder) |
| 2 | Embedded audio tags — first file | Phase 2 | Title, authors, narrators, year, genre, description |
| 3 | Sidecar `metadata.json` in source folder | Phase 3 ✓ | Any field — import from Audiobookshelf or hand-written |
| 4 | Metadata lookup — user-triggered | Phase 3 ✓ | Any field from iTunes, OpenLibrary, or FantLab |
| 5 (highest) | Manual user edits in app | Phase 3 UI ✓ | Any field — permanent, survives rescans |

Sources 1–3 run automatically during scan. Source 4 is user-triggered per book. Source 5 is set when a user edits a field directly.

When `book_metadata.source = 'manual'`, all automatic sources (1–4) skip that book entirely on rescans.

---

## Metadata Fields

| Field | Phase 1 source | Phase 2 source | Phase 3 lookup |
|---|---|---|---|
| Title | Folder name | Tag: `title` / `album` | ✓ all providers |
| Author(s) | Parent folder name | Tag: `artist` / `albumartist` | ✓ all providers |
| Narrator(s) | — | Tag: `composer` | ✓ iTunes, OpenLibrary |
| Series name | — | Tag: `series` / `grouping` | ✓ iTunes |
| Series position | — | Tag: `series-part` | ✓ iTunes |
| Description | — | Tag: `description` / `comment` | ✓ all providers |
| Year published | — | Tag: `date` / `year` | ✓ all providers |
| Language | Library default | Tag: `language` | ✓ OpenLibrary |
| Genre(s) | — | Tag: `genre` | ✓ all providers |
| Duration | — | Summed from all files via `music-metadata` | — (physical, not from providers) |
| Cover art | — | `cover.jpg` in folder | ✓ all providers — downloaded to thumbnail cache |
| ISBN | — | Tag: `isbn` | ✓ OpenLibrary |
| ASIN | — | Tag: `asin` / `audible_asin` | — (future: Audible provider) |
| Publisher | — | Tag: `publisher` / `tpub` | ✓ iTunes, OpenLibrary |

---

## Cover Art and Thumbnail Storage

Cover images are stored in the managed thumbnail cache — never in the source folder.

```
/data/cache/thumbnails/
  /ab/cd/<book-id>-cover.webp          ← 300×300 browse thumbnail
  /ab/cd/<book-id>-cover-large.webp    ← 600×600 detail view
```

Shard key: first 4 characters of the book ID, split into two path components (`ab/cd/`). The `cover_storage_key` field in `book_metadata` stores the relative path within the thumbnail root.

`sharp` generates both sizes from the source image in a single pass and converts to WebP.

If no cover art is found, the UI generates a placeholder from the book's title initials — no broken image icons.

---

## Metadata File Storage

Our app-managed metadata files (manual edit exports) are stored **separately from source folders** to preserve the read-only source rule.

```
/data/cache/metadata/
  /ab/cd/<book-id>.json
```

Same sharding pattern as thumbnails. Configurable via `METADATA_PATH`.

**Reading vs. writing:**

| Direction | Location | When |
|---|---|---|
| Read — import from existing libraries | `cover.jpg`, `metadata.json` in source folder | Phase 2 (cover), Phase 3 (metadata) |
| Write — export manual edits | `/data/cache/metadata/<book-id>.json` | Phase 4 |

We never write to source folders. If a user's library already has `metadata.json` files from Audiobookshelf, we read them as an import source without touching them.

---

## Metadata Lookup

**Phase 3 — in progress.**

A per-book feature that lets a user search external providers for metadata and apply selected results. Distinct from the automatic scan pipeline — entirely user-triggered.

### Providers

| Provider | Free | Key required | Covers | What it returns |
|---|---|---|---|---|
| **iTunes / Apple Books** | ✓ | No | ✓ | Title, author, narrator, year, description, genres, series |
| **OpenLibrary** | ✓ | No | ✓ | Title, authors, year, description, ISBN |
| **FantLab** | ✓ | No | ✓ | Russian title, author, year, description, genre hints |

Audible is a future addition — it requires either an unofficial API or scraping and adds deployment complexity.

iTunes, Open Library, and FantLab do not require API keys.

### User flow

1. Open a book's detail page
2. Click **"Look up metadata"**
3. An inline search panel opens, pre-filled with current title + author
4. User adjusts the query and selects a provider
5. Results appear as cards showing: cover thumbnail, title, author(s), year, publisher
6. User clicks a result to preview what would change on their book
7. Checkboxes: **Update details** (on by default) and **Update cover** (on by default)
8. Click **Apply** — metadata saved, `source = 'manual'` set, cover downloaded

Manual edits are also available from the book detail page. Users can directly edit title, authors, narrators, genres, publisher, year, description, language, ISBN, and ASIN. Saving direct edits sets `book_metadata.source = 'manual'`.

### API endpoints

```
GET  /api/library/books/:id/metadata-search
     ?q=The+Martian&provider=openlibrary
     → MetadataCandidate[]

POST /api/library/books/:id/metadata-match
     { candidate: MetadataCandidate, updateDetails: bool, updateCover: bool }
     → { updated: bool, book: BookDetail }

PATCH /api/library/books/:id/metadata
     { title, authors, narrators, genres, publisher, yearPublished, description, language, isbn, asin }
     → { updated: bool, book: BookDetail }
```

Implemented provider values: `itunes`, `openlibrary`, `fantlab`, and `all`.

When a result is applied, `book_metadata.source` is set to `manual`; future rescans preserve the selected metadata.

### Normalised candidate shape

All providers map their raw API response to a single common type before returning to the client:

```typescript
interface MetadataCandidate {
  title: string
  subtitle?:    string
  authors:      string[]
  narrators?:   string[]
  publisher?:   string
  year?:        number
  description?: string
  coverUrl?:    string
  isbn?:        string
  asin?:        string
  genres?:      string[]
  language?:    string
  source: "itunes" | "openlibrary" | "fantlab"
}
```

### Apply logic

When the user clicks Apply, the server updates `book_metadata` and related tables:

| Field | Applied if empty | Applied with `updateDetails = true` |
|---|---|---|
| title, subtitle | ✓ | ✓ |
| authors, narrators | ✓ | ✓ — replaces existing |
| publisher, year | ✓ | ✓ |
| description | ✓ | ✓ |
| isbn, asin | ✓ | ✓ |
| genres | ✓ | ✓ — merges, deduplicates |
| language | ✓ | ✓ |
| cover | only if no cover exists | ✓ — only when `updateCover = true` |

After apply, `book_metadata.source` is set to `'manual'`. The scanner will never overwrite these fields on future rescans.

### Provider modules

Each provider lives in its own file and exposes a single `search(query)` function:

```
modules/library/audiobook/providers/
  itunes.ts
  open-library.ts
  fantlab.ts
```

### Sidecar metadata import

During scan, if a book folder contains `metadata.json`, the scanner reads it after embedded tags and before writing scanned metadata. Supported fields:

```json
{
  "title": "The Martian",
  "authors": ["Andy Weir"],
  "narrators": ["R. C. Bray"],
  "publisher": "Audible Studios",
  "year": 2014,
  "description": "...",
  "isbn": "978...",
  "asin": "B00...",
  "genres": ["Science Fiction"],
  "language": "en",
  "series": "Example Series",
  "seriesPosition": 1
}
```

Manual metadata still wins: if `book_metadata.source = 'manual'`, sidecar import is skipped for that book.

---

## Rescan Behaviour

| Condition | Action |
|---|---|
| New folder found | Insert book record, run full metadata pipeline |
| Existing folder, files unchanged | Mark book/files available without re-reading tags or re-hashing files |
| Existing folder, file changed (size or `modified_at` differs) | Update `book_files`, re-run metadata pipeline |
| Previously known folder not found | `book.deleted_at = now`, files marked missing (30-day retention) |
| Previously missing folder reappears | Clear `deleted_at`, re-run metadata pipeline |

Playback progress is never modified during a rescan. Manual metadata (`source = 'manual'`) is never overwritten.

---

## Playback Progress

Progress is tracked per user per book:

- `current_file_id` — which file the user is currently in
- `position_seconds` — position within that file
- `percent_complete` — stored for fast sorting (no join needed)

A book is marked complete when `percent_complete >= 0.98` (allows for credits). Progress can be reset manually. Updates should be debounced on the client — write no more than once every 10–15 seconds during playback.

---

## Safety Rules

- Original audio files are never renamed, moved, or deleted
- Only paths beneath the registered `source_path` are accessed during scanning
- Symbolic links that resolve outside `source_path` are not followed
- Cover art is copied to the thumbnail cache — source files are not modified
- Metadata files are written to `/data/cache/metadata/` — never to source folders
- All `source_path` values are validated server-side; users never supply raw filesystem paths
- Relative paths are stored in the database; `source_path` root is joined at runtime

---

## File Storage Layout

```
/data
  /cache
    /thumbnails
      /ab/cd/
        <book-id>-cover.webp             ← Phase 2
        <book-id>-cover-large.webp       ← Phase 2
    /metadata
      /ab/cd/
        <book-id>.json                   ← Phase 4 (export)

Configured library source (read-only):
  /libraries/audiobooks/
    /Andy Weir/
      /The Martian/
        cover.jpg                        ← Phase 2: read during scan
        The Martian.m4b
      /Project Hail Mary/
```

---

## Technology Dependencies

| Purpose | Library | Phase | Notes |
|---|---|---|---|
| Folder walking | Node.js `fs` | 1 ✓ | Built-in, no dependency |
| Track number from filename | Regex | 1 ✓ | Built-in |
| Audio tag reading (metadata) | `music-metadata` (npm) | 2 | First file: title/author/etc. |
| Audio duration + track order | `music-metadata` (npm) | 2 | All files: sum duration, sort order |
| Cover art processing | `sharp` (npm) | 2 | WebP generation, two sizes |
| File hashing | Node.js `crypto` | 2 | SHA-256, incremental for large files |

---

## Future Considerations

- **Streaming endpoint** — `GET /api/library/books/:id/stream/:fileId` with byte-range support for seeking
- **File system watcher** — auto-scan on file changes, no manual rescan needed (Phase 4)
- **Inode tracking** — detect renamed/moved folders without losing playback progress (Phase 4)
- **Managed uploads** — users upload their own audiobooks into `/data/media/library/`; same book/file/metadata model
- **Podcast library type** — reuses `libraries`, `book_files`, and `playback_progress` with its own `episodes` table and RSS scanner
- **Mobile playback** — same API endpoints; `playback_progress` syncs on resume
