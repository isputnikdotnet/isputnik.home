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
| **3 — Enrichment** | Complete | Sidecar import (native + Audiobookshelf format), metadata lookup, iTunes/OpenLibrary/FantLab providers, preview/diff before apply, apply result + cover, manual edit + pinning, metadata reset/unpin, FantLab original title as subtitle |
| **4 — Playback & Export** | Complete | Streaming endpoint (byte-range HTTP, seek support), metadata export (write `<book-id>.json` on manual save) |
| **5 — Player UX** | Complete | Skip ±30 s with cross-chapter wrap, overall book progress bar, toggleable chapter list with click-to-jump, save-on-close via `fetch keepalive` |

---

## Library Settings

Stored in `libraries.settings_json` when a library is created:

| Setting | Default | Description |
|---|---|---|
| `folder_structure` | `author_book` | Expected layout hint: `author_book`, `flat`, or `series_author_book` |
| `default_language` | `en` | Fallback when no language tag is found |
| `show_narrator` | `true` | Display narrator prominently in the UI |
| `supported_extensions` | see below | Audio formats to include during scan |
| `cover_filenames` | `cover,folder,artwork` | Image filenames to recognise as folder cover art (if none match, the largest image file in the folder is used as fallback) |
| `ignore_sidecar` | `false` | When `true`, `metadata.json` files in book folders are ignored during all scans |

Default supported extensions:

```json
["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac", "wav", "wave"]
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
content_hash     TEXT                        -- sha256 (reserved; no longer computed during scan — size+modified_at fingerprint is sufficient)

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

The scan runs asynchronously through the SQLite job queue. Create and rescan requests enqueue `SCAN_AUDIOBOOK_LIBRARY`, set `scan_status = 'scanning'`, and return immediately. The worker processes scan jobs in the server process; the UI polls `scan_status` (and live progress) until it returns to `idle`.

```
Admin registers library (name, source_path, defaultLanguage, ignoreSidecar?)
  → validateLibrarySource:
      - path must be absolute
      - directory must exist
      - must fall inside a registered storage root
      - must not overlap with THUMBNAIL_PATH
  → INSERT libraries record (settings_json includes ignore_sidecar flag)
  → enqueueAudiobookScan(libraryId) → INSERT jobs row, return immediately

scanAudiobookLibrary (runs in background worker):
  → SET scan_status = 'scanning'
  → walkAudiobookFiles(rootPath):
      async recursive walk (fs.promises.readdir), skip symlinks outside root
      collect audio files grouped by parent folder
      return Map<folderAbsPath, files[]>

  → process up to 4 book folders concurrently:

      [per book folder]
      fingerprint check (size + modified_at for all files):
        if all files unchanged AND book already in DB AND no sidecar → skip, reuse existing data

      otherwise:
        parse all files in parallel (Promise.all):
          first file  → full parse (book metadata + cover extraction)
          other files → parse for duration, track number, chapter title

        if settings.ignore_sidecar = false AND metadata.json present in folder:
          read sidecar → overrides title, authors, narrators, description, year,
                         language, genres, series, isbn, asin, publisher

        resolve cover:
          1. named file match: cover.jpg / folder.png / artwork.webp (or cover_filenames setting)
          2. fallback: largest image file in the folder
          3. fallback: embedded cover from first audio file tags

        upsert book (library_id, folder_path)
        upsert book_metadata (skip fields where source='manual')
        upsert authors, narrators, genres, series
        mark existing book_files missing
        upsert book_files (track_number, chapter_title, duration_seconds, size, modified_at)

      write book to DB immediately (per-book transaction)
      update job progress (booksProcessed / booksTotal) every 5 books or 3 seconds

  → after all books processed:
      soft-delete books not found in this walk (deleted_at = now)
      mark their files missing
      SET scan_status='idle', last_scanned_at=now
      mark job completed with discovered book/file counts
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
      1. named match: cover.jpg / cover.png / folder.jpg / artwork.jpg, etc. (configurable via cover_filenames)
      2. fallback: largest image file by size in the folder (handles non-standard filenames)
      3. fallback: embedded cover from audio file tags
      if found: copy to /data/cache/thumbnails/<shard>/<book-id>-cover.webp
               generate 300×300 and 600×600 WebP with sharp

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

**Phase 3 — complete.**

A per-book feature that lets a user search external providers for metadata and apply selected results. Distinct from the automatic scan pipeline — entirely user-triggered.

### Providers

| Provider | Free | Key required | Covers | What it returns |
|---|---|---|---|---|
| **iTunes / Apple Books** | ✓ | No | ✓ | Title, author, narrator, year, description, genres, series |
| **OpenLibrary** | ✓ | No | ✓ | Title, authors, year, description, ISBN |
| **FantLab** | ✓ | No | ✓ | Russian title, original title, author, year, description, genre hints |

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

POST /api/library/books/:id/metadata-reset
     → { reset: bool, book: BookDetail }
```

Implemented provider values: `itunes`, `openlibrary`, `fantlab`, and `all`.

When a result is applied, `book_metadata.source` is set to `manual`; future rescans preserve the selected metadata.

#### FantLab title handling

FantLab work pages carry two titles: the Russian title (the canonical title in the FantLab catalogue) and the original-language title (for translated works). Both are useful, and the right choice depends on the user's library.

**Fields returned:**

| FantLab field | `MetadataCandidate` mapping |
|---|---|
| Russian title | `title` |
| Original title | `subtitle` |

By surfacing the original title as `subtitle`, the diff preview can show both. When the user applies the result with `updateDetails = true`:

- `title` ← Russian title (default, matches FantLab's canonical record)
- `subtitle` / `sort_title` ← original title preserved if present

**Limitation:** if the work is originally Russian, there is no "original title" distinction — `subtitle` is left empty.

**Future option:** a per-library setting `fantlab_title_mode = 'russian' | 'original' | 'both'` could swap the mapping. Not implemented in Phase 3.

---

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

### Metadata preview / diff before apply

Before writing any changes, the UI should show a side-by-side comparison of the current book record and what the selected candidate would change.

**Trigger:** clicking a result card expands an inline diff panel instead of immediately applying.

**Diff display:**

| Field | Current value | Candidate value |
|---|---|---|
| Title | The Martian | The Martian |
| Author | Andy Weir | Andy Weir |
| Year | — | 2011 |
| Description | — | *excerpt…* |
| Cover | *(thumbnail)* | *(candidate thumbnail)* |

Unchanged fields are shown greyed out or hidden. Changed fields are highlighted. The **Apply** button is inside the diff panel, not on the card. The existing `updateDetails` and `updateCover` checkboxes remain here.

**Implementation note:** the diff is computed client-side from the `BookDetail` already in state and the `MetadataCandidate` returned by the search — no extra API call needed before the user confirms.

---

### Metadata reset / unpin

A book with `source = 'manual'` is permanently locked from automatic updates. Users need a way to undo this.

**UI:** a **"Reset to auto"** button on the book detail page, visible only when `source = 'manual'`. Shown near the Edit metadata panel, not inline with individual fields.

**Behaviour:**
1. Sets `book_metadata.source = 'scan'`
2. Enqueues a single-book rescan (`RESCAN_BOOK` job type or inline call to `prepareBookScan`)
3. The book refreshes with whatever the scanner derives from disk — tags, sidecar, folder names

**API endpoint:**

```
POST /api/library/books/:id/metadata-reset
     → { reset: true, book: BookDetail }
```

No request body. The endpoint sets source and triggers the rescan. Returns the re-scanned book state.

**Confirmation:** a brief inline confirmation ("This will replace all manually edited fields. Continue?") before the request is sent.

---

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

#### Audiobookshelf sidecar compatibility

Audiobookshelf writes its own `metadata.json` (and `metadata.abs`) with different field names. The scanner should accept both formats without requiring the user to rewrite their existing files.

**Audiobookshelf field mapping:**

| Audiobookshelf field | Our field | Notes |
|---|---|---|
| `authorName` | `authors` | String → split on `, ` |
| `authorNameLF` | — | Last-first variant, ignored if `authorName` present |
| `narratorName` | `narrators` | String → split on `, ` |
| `publishedYear` | `year` | String or number |
| `publishedDate` | `year` | Extract year component |
| `subtitle` | `subtitle` | Direct map |
| `series` | `series` | May be a string or `[{ name, sequence }]` |
| `sequence` | `seriesPosition` | String → parseFloat |
| `genres` | `genres` | Array of strings |
| `tags` | — | Not imported |
| `coverPath` | — | Ignored; we detect cover image separately |
| `explicit` | — | Not imported |

**Detection:** if the file contains `authorName` or `narratorName` (string fields), treat it as Audiobookshelf format and apply the mapping above. Otherwise treat as our native format. Both formats can coexist in the same library since detection is per-file.

**`metadata.abs` format:** Audiobookshelf also writes a binary `.abs` file in some versions. This is not imported — only `metadata.json` is read.

---

## Rescan Behaviour

| Condition | Action |
|---|---|
| New folder found | Insert book record, run full metadata pipeline |
| Existing folder, files unchanged | Skip re-parsing — size + modified_at fingerprint matches existing DB records |
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
        <book-id>.json                   ← Phase 4 ✓

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
| Audio tag reading (metadata) | `music-metadata` (npm) | 2 | All files parsed in parallel; 15 s timeout per file guards against malformed files |
| Audio duration + track order | `music-metadata` (npm) | 2 | All files: sum duration, sort order |
| Cover art processing | `sharp` (npm) | 2 | WebP generation, two sizes (300 px and 600 px) |

---

## Phase 4 — Playback & Export

### Streaming endpoint

```
GET /api/library/books/:id/stream/:fileId
```

Streams the audio file directly from the source folder with HTTP byte-range support, which browsers require for seeking.

**Behaviour:**
- Verifies the file belongs to the requested book and is `status = 'available'`
- Resolves the absolute path from `libraries.source_path + book_files.relative_path` and checks it is inside `source_path`
- Responds with `Accept-Ranges: bytes` on all responses
- Without `Range` header → `200 OK`, full file stream
- With `Range: bytes=start-end` → `206 Partial Content`, `Content-Range` header, partial stream
- Invalid or unsatisfiable range → `416 Range Not Satisfiable`
- `Cache-Control: private, no-cache` (files change on rescan)

**Configuration:** no additional config needed — uses the library's `source_path` already in the DB.

### Metadata export

When a user saves manual metadata (via direct edit or applying a provider result), the server writes a JSON file to the configured metadata cache:

```
$METADATA_PATH/<ab>/<cd>/<book-id>.json
```

Same sharding pattern as thumbnails. Configured via `METADATA_PATH` environment variable. If `METADATA_PATH` is not set, export is silently skipped — it is best-effort and never blocks a save.

**Exported fields:** title, authors, narrators, genres, publisher, year, description, language, isbn, asin.

The format matches our native sidecar schema, so the exported file can be copied back into a source folder as `metadata.json` if a user wants to migrate libraries.

---

## Phase 5 — Player UX

### Skip ±30 s with cross-chapter wrap

Two skip buttons flank the chapter prev/next controls: rewind 30 s and fast-forward 30 s. If the skip would move before the start of the current chapter, playback jumps to the previous chapter at the correct offset. If it would overshoot the end, it jumps to the next chapter carrying the overflow as the initial seek position. State (`shouldAutoPlayRef`, `pendingSeekRef`) is set identically to chapter navigation so play/pause state is preserved across the boundary.

### Overall book progress bar

A second, read-only progress bar sits between the chapter seek slider and the aux row. It shows position across all chapters: `completedDuration` (sum of durations of fully played chapters) plus `currentTime` within the active chapter, over the total book duration. The bar is styled deliberately more subdued than the interactive seek bar to avoid visual confusion.

### Chapter list panel

A **Chapters** toggle button (same style as the speed menu button) sits in the aux row. Expanding the panel shows all `available` files as a scrollable list with chapter number, title, and duration. Clicking any entry saves current progress, preserves the current playing state, and jumps to that chapter at position 0. The active chapter is highlighted. The panel closes automatically on jump.

### Save on browser close

A `beforeunload` handler calls `fetch` with `keepalive: true`, which browsers keep alive even after the tab is closed or navigated away. The handler is re-registered whenever `currentFile` changes so the closure always captures the correct file ID. Combined with the existing 10 s periodic save and save-on-pause, progress loss on unexpected close is reduced to at most the current playback interval.

---

## Future Considerations

- **Managed uploads** — users upload their own audiobooks into `/data/media/library/`; same book/file/metadata model
- **Podcast library type** — reuses `libraries`, `book_files`, and `playback_progress` with its own `episodes` table and RSS scanner
- **Mobile playback** — same API endpoints; `playback_progress` syncs on resume
