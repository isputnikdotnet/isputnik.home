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

Stored in `libraries.settings_json`. The base shape is shared by every library type
(see `shared/library-settings.ts`); audiobooks add their own keys on top. Settings are
normalized on read (`normalizeLibrarySettings`), so missing fields always fall back to
the type defaults — older rows never break a scan.

| Setting | Default | Description |
|---|---|---|
| `default_language` | `en` | Fallback when no language tag is found |
| `scan_extensions` | see below | Dotless, lowercase file extensions to include during scan. **The same list is the upload extension policy** — one list for both. User-editable per library (create wizard / edit modal), with a "Reset to defaults" action |
| `scan_sources` | see below | Ordered list of metadata sources, `{ id, enabled }`. Position = priority: index 0 wins per field. See "Scan metadata sources" below |
| `show_narrator` | `true` | (audiobook) Display narrator prominently in the UI |
| `cover_filenames` | `cover,folder,artwork` | (audiobook) Image filenames to recognise as folder cover art (if none match, the largest image file in the folder is used as fallback) |

Default `scan_extensions` (audiobook):

```json
["m4b", "m4a", "mp3", "flac", "ogg", "opus", "aac", "wav", "wave"]
```

Default `scan_sources` (audiobook — reproduces the pre-0.13 behavior exactly):

```json
[
  { "id": "metadata_files",   "enabled": true  },
  { "id": "file_metadata",    "enabled": true  },
  { "id": "folder_structure", "enabled": false }
]
```

Per-upload size limit (`maxUploadMB`) lives in `libraries.policy_json` next to `mode`
(see `permissions.md`); it is exposed in the same create/edit UI.

---

## Scan Metadata Sources

Sources are defined once in a server-side registry (`shared/metadata-sources.ts`) —
id, label, description, applicable library types, default enablement — and exposed to
the web app through `GET /api/library/settings` (`metadataSources` + `typeDefaults`),
so the UI never duplicates them. **Adding a new source = one registry entry + an
extractor in the relevant scanner.**

| Source | Applies to | What it provides |
|---|---|---|
| `metadata_files` | audiobook | `metadata.json` sidecars next to the book files (native + Audiobookshelf formats) |
| `file_metadata` | audiobook, ebook | Embedded metadata: audio tags / EPUB details. Also gates embedded-cover extraction and tag-based disc/track ordering and chapter titles |
| `folder_structure` | audiobook | **Grouping + names.** When enabled, each *top-level folder* under the library root becomes one book and every audio file anywhere beneath it becomes a track of that book; folder names supply book titles and file names supply track titles at this source's priority position |

How the scanner uses them (`prepareBookScan`):

1. Each enabled source produces a metadata *candidate* (title, authors, narrators,
   description, year, language, genres, series, isbn/asin/publisher).
2. Candidates are merged **first-wins in list order** — the first source that provides
   a field keeps it.
3. Folder/file-name *fallback hints* (book title from folder name, author from parent
   folder, library default language) are always applied last, regardless of sources.
4. Disabling every source therefore yields pure folder/file-name records.

`folder_structure` is the only source that also changes grouping: `walkAudiobookFiles`
switches from "folder containing audio = book (disc subfolders collapse)" to
"top-level folder = book, recurse everything". Disc-named subfolders (`CD 1`, …) still
provide track-ordering hints in both modes.

Manual metadata (`book_metadata.source = 'manual'`) still beats everything and is
never overwritten by any source.

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
category_id      TEXT REFERENCES categories(id)
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


person_aliases
--------------
id              TEXT PRIMARY KEY
alias           TEXT NOT NULL UNIQUE COLLATE NOCASE  -- variant name, e.g. 'A.G. Riddle'
canonical_name  TEXT NOT NULL                        -- merged-into name, e.g. 'A. G. Riddle'
created_by      TEXT REFERENCES users(id)
created_at      TEXT

Records person merges (see "Merging duplicate people"). The scanner resolves every
author/narrator name through this table before upserting, so a merge stays merged
across rescans even though book_authors links are otherwise re-derived from tags.


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

The `genres` table is deprecated. It remains in the schema to avoid a destructive migration, but new scans use categories and tags instead.

### Categories and tags

```sql
categories
----------
id                TEXT PRIMARY KEY
key               TEXT NOT NULL UNIQUE
name              TEXT NOT NULL
sort_order        INTEGER NOT NULL DEFAULT 0
icon              TEXT
image_storage_key TEXT


category_aliases
----------------
id          TEXT PRIMARY KEY
keyword     TEXT NOT NULL UNIQUE
category_id TEXT NOT NULL REFERENCES categories(id)
priority    INTEGER NOT NULL DEFAULT 0


tags
----
id           TEXT PRIMARY KEY
key          TEXT NOT NULL UNIQUE
display_name TEXT NOT NULL
created_at   TEXT NOT NULL


taggables
---------
tag_id      TEXT NOT NULL REFERENCES tags(id)
entity_type TEXT NOT NULL
entity_id   TEXT NOT NULL

PRIMARY KEY (tag_id, entity_type, entity_id)
```

Categories are fixed navigation buckets seeded from `categories-seed.ts`: Fiction, Classics & Literary, Adventure & Action, Mystery & Thriller, Sci-Fi & Fantasy, Horror & Supernatural, Romance, Humor & Satire, Biographies & Memoirs, History, Self-Help & Business, Science & Culture, Kids & Teens, and General / Other. A book has one primary category. Original genre strings are preserved as global tags. Seeded categories can also carry built-in public card art, while uploaded admin images still use thumbnail storage.

Tags are created automatically from scanned genre metadata or manually from **Control Panel → Labels → Tags**. Admin tag management supports creating, renaming, deleting, merging on a rename collision, and removing unused tags.

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

`book_genres` is deprecated with `genres`. New scans write `book_metadata.category_id` and `taggables`.

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

### Companion documents

Bundled non-audio files in a book's folder — a PDF supplement or the ebook edition. Collected during the scan (any `.pdf` / `.epub` / `.mobi` / `.azw3` in the book folder), surfaced on the book detail page with download and an in-app reader (PDF now; EPUB once the ebook reader lands). These are *assets of the audiobook*, not catalogued ebooks — see the future ebook library type.

```sql
book_documents
--------------
id            TEXT PRIMARY KEY
book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE
relative_path TEXT NOT NULL
format        TEXT NOT NULL                -- 'pdf' | 'epub' | 'mobi' | 'azw3'
mime_type     TEXT
size          INTEGER
status        TEXT NOT NULL                -- 'available' | 'missing'
... discovered_at / updated_at / deleted_at

UNIQUE (book_id, relative_path)
```

Re-synced from disk on every scan (mark-missing-then-upsert), the same as `book_files`. Served via `GET /api/library/books/:id/documents/:docId` (inline by default, `?download` forces attachment, range supported), access-gated by `canUserAccessBook`.

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

### Rescan options

`POST /api/library/audiobook-libraries/:id/rescan` accepts an optional body `{ sources?, tagEncoding? }`, carried through the job payload into `scanAudiobookLibrary` → `prepareBookScan`. The single-book rescan (`POST /api/library/books/:id/rescan`) takes the same shape. The Rescan dialog pre-fills the editor from the library's persisted `scan_sources`; changes there are **one-shot overrides for that run only** — edit the library to change the persisted defaults.

- **`sources`** — full override of the library's `scan_sources` (same `{ id, enabled }[]` ordered shape). The old `skipSidecar` flag is gone; it is equivalent to disabling `metadata_files` in the override.
- **`tagEncoding`** — one of `windows-1251`, `windows-1250`, `windows-1252`, `koi8-r`. Repairs mojibake: tag text whose bytes are really a legacy charset but were decoded as Latin-1 (e.g. `Ðàíåå` → `Ранее`). `repairEncoding()` re-encodes the string to Latin-1 bytes and decodes with the chosen charset (Node `TextDecoder`, no dependency). Strings already containing characters above U+00FF (correct UTF-8) and plain ASCII are left untouched; manual-source metadata and ISBN/ASIN are never altered.

Either option **forces a full metadata re-read** (bypassing the unchanged-files fast path) so the correction is actually applied and stored. A plain rescan with no options keeps the fast path.

```
Admin registers library (core fields + scanExtensions?, scanSources?, maxUploadMB?)
  → createLibraryRecord (shared/library-crud.ts, same helper for every library type):
      validateLibrarySource:
        - path must be absolute
        - directory must exist
        - must fall inside a registered storage root
        - must not overlap with THUMBNAIL_PATH
      build settings_json from type defaults + input (scan_extensions, scan_sources)
      build policy_json ({ mode, maxUploadMB? })
      INSERT libraries record, seed access assignments, log activity
  → enqueueAudiobookScan(libraryId) → INSERT jobs row, return immediately

scanAudiobookLibrary (runs in background worker):
  → SET scan_status = 'scanning'
  → resolveScanConfig: effective sources = rescan override ?? settings.scan_sources;
      groupingMode = folder_structure enabled ? top_level_folder : folder_hierarchy
  → walkAudiobookFiles(rootPath, settings, groupingMode):
      async recursive walk (fs.promises.readdir), skip symlinks outside root
      collect audio files grouped by book folder (parent folder, or top-level
      folder when groupingMode = top_level_folder)
      return Map<folderAbsPath, files[]>

  → process up to 4 book folders concurrently:

      [per book folder]
      fingerprint check (size + modified_at for all files):
        if all files unchanged AND book already in DB AND no sidecar
        AND no rescan override → skip, reuse existing data

      otherwise:
        parse all files in parallel (Promise.all):
          first file  → full parse (book metadata + cover extraction)
          other files → parse for duration, track number, chapter title

        build one metadata candidate per enabled source
        merge candidates first-wins in scan_sources order
        apply folder/file-name fallback hints last

        resolve cover:
          1. named file match: cover.jpg / folder.png / artwork.webp (or cover_filenames setting)
          2. fallback: largest image file in the folder
          3. fallback: embedded cover from first audio file tags

        upsert book (library_id, folder_path)
        upsert book_metadata (skip fields where source='manual')
        upsert authors, narrators, series, tags; assign category from mappings
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
      raw genres    ← tag: genre (comma-split)

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
  → upsert authors and narrators; save raw genres as tags and assign category from mappings
```

### Phase 2 architecture change — async scan

`scanAudiobookLibrary` now runs from the job queue. The HTTP request creates the library record and enqueues `SCAN_AUDIOBOOK_LIBRARY`, then returns immediately. The UI polls `scan_status` and shows a scanning indicator until `idle`. Failed jobs retry up to `max_attempts`, and stale running jobs can be reclaimed by the worker.

---

## Merging Duplicate People

Inconsistent tags across files produce duplicate authors/narrators — e.g. one book tagged `A.G. Riddle` and others `A. G. Riddle` become two separate people, splitting the filter list and detail pages.

An admin resolves this from an author or narrator detail page: the **Merge** action folds the current person into a chosen target.

What a merge does (admin only, `POST /api/library/people/merge`):

1. Records a `person_aliases` row mapping the variant → the canonical name.
2. Repoints `book_authors` links from the variant's `authors` rows to the target's (de-duplicating on `book_id, author_id, role`), then deletes the orphaned `authors` rows.
3. Rewrites any existing aliases that pointed at the variant, so chains stay consistent.

**Why the alias matters:** a rescan re-derives `book_authors` from the file tags (the author/narrator block is *not* protected by `source = 'manual'` — only `book_metadata` fields are). Without an alias the duplicate would return on the next scan. The scanner therefore resolves every scanned name through `person_aliases` in `upsertAuthor()` before creating rows, so the merge is permanent. Narrators are covered automatically because they upsert through the same function.

---

## Metadata Sources and Priority

Scan-time priority among `metadata_files`, `file_metadata`, and `folder_structure` is
**user-configurable per library** — the ordered `scan_sources` list, first source
providing a field wins (see "Scan Metadata Sources" above). The default order
reproduces the historical behavior: sidecar > audio tags > folder/file-name hints.

Outside the scan, the overall hierarchy is unchanged:

| Priority | Source | What it provides |
|---|---|---|
| 1 (lowest) | Folder and filename fallback hints — always on | Title (folder name), author (parent folder) |
| 2 | Enabled `scan_sources`, merged in their configured order | Any scanned field |
| 3 | Metadata lookup — user-triggered | Any field from iTunes, OpenLibrary, or FantLab |
| 4 (highest) | Manual user edits in app | Any field — permanent, survives rescans |

Sources 1–2 run automatically during scan. Source 3 is user-triggered per book. Source 4 is set when a user edits a field directly.

When `book_metadata.source = 'manual'`, all automatic sources skip that book entirely on rescans.

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

## Book details and manual editing

The book detail page keeps the cover, title, author, playback action, and core metadata at the top. **Author, narrator, series, and category are links** to their respective browse pages. When one of those pages is reached *from* a book, its "Back" button returns to the originating book (carried via a `?from=` referrer) instead of falling back to the list. The visible metadata grid leads with Library and Category (alongside Narrator, Format, Length, Size, Series); Published, Publisher, Language, ISBN, and ASIN live under **More details** (Publisher, ISBN and ASIN always appear, showing "Not available" when empty). Tags sit below the shorter cover, and Description and Files remain as the page tabs.

The header action row exposes **Favorites** — a per-user, whole-book save (♥), the same toggle as the player's Favorites button and the Favorites page (formerly labelled "Bookmark" / "My List") — and a **More options** menu with Edit metadata, Mark finished, **Reset progress** (clears playback progress, mirroring the player's menu action), Download, and Share.

**Edit metadata** opens a compact responsive modal without leaving the book:

- **Metadata** — title, authors, narrators, category, tags, and description (tags use the same pick-existing-or-add combobox as authors and narrators)
- **Publishing** — publisher, year, language, ISBN, ASIN
- **Series** — series and position
- **Cover** — refresh or upload cover art
- **Metadata Lookup** — search providers and apply a result

Saving direct edits sets `book_metadata.source = 'manual'`. Resetting to automatic metadata remains available from the editor.

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
2. Open **More options**, then select **Edit metadata**
3. Select the **Metadata Lookup** tab; search is pre-filled with the current title and author
4. Adjust the query and select a provider
5. Results appear as cards showing: cover thumbnail, title, author(s), year, publisher
6. Select a result to preview what would change on the book
7. Choose whether to update details and cover
8. Apply the result — metadata is saved, `source = 'manual'` is set, and the selected cover is downloaded

### API endpoints

```
GET  /api/library/books/:id/metadata-search
     ?q=The+Martian&provider=openlibrary
     → MetadataCandidate[]

POST /api/library/books/:id/metadata-match
     { candidate: MetadataCandidate, updateDetails: bool, updateCover: bool }
     → { updated: bool, book: BookDetail }

PATCH /api/library/books/:id/metadata
     { title, authors, narrators, categoryKey, tags, publisher, yearPublished, description, language, isbn, asin }
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
| provider genres | ✓ | ✓ — added as tags, deduplicated |
| category, tags | manual only | manual edits replace current category/tags |
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
3. The book refreshes with whatever the scanner derives from disk — tags, category mappings, sidecar, folder names

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

**Exported fields:** title, authors, narrators, category, tags, publisher, year, description, language, isbn, asin.

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

## Special Sections

Audiobook libraries can be grouped into a **Special Section** — a master entry in the audiobook sidebar that holds one or more libraries and keeps their books out of the main grid. Each member library carries its own **overwrite-on-add** rules (Author, Narrator, Description, Category, Tags) applied by the scanner on add and rescan, respecting the `source = 'manual'` lock. Built for collections like *Model for Assembly* where embedded tags are inconsistent and a constant Narrator/Category is wanted across the set.

See [`special-section.md`](special-section.md) for the full design, schema, and API.

---

## Future Considerations

- **Managed uploads** — users upload their own audiobooks into `/data/media/library/`; same book/file/metadata model
- **Podcast library type** — reuses `libraries`, `book_files`, and `playback_progress` with its own `episodes` table and RSS scanner
- **Mobile playback** — same API endpoints; `playback_progress` syncs on resume
