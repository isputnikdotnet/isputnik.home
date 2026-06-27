# Gallery library (photos + videos)

The gallery is a media type for photos and videos, modelled on Google Photos /
Immich rather than the book-like types. Its defining choice:

> **One asset = one item.** Every photo and every video is its own
> `library_items` row (`type = 'gallery'`), unlike audiobooks (a folder of tracks)
> or ebooks (a basename group of formats). This is what lets the same set of assets
> be browsed two ways.

## Two views over one asset set

- **Timeline** (default) — assets newest-first by `gallery_details.taken_at`
  (EXIF date, falling back to file mtime), grouped into month headers in the UI.
- **Folder** — a file-explorer over the on-disk directory structure, for libraries
  that keep their own folder layout (the common case for a read-only source).

Both are queries over the same rows (`modules/library/gallery/catalog.ts`); the
view toggle is pure UI. Source files are never modified — the same safety rule as
every other library type.

## Scan pipeline

`modules/library/gallery/scanner.ts` walks the configured photo/video extensions
(symlink-safe, dot-folders skipped). For each file:

1. **Skip unchanged** — if size + mtime match the stored `gallery_details` row and a
   preview already exists, the file is left untouched (a rescan only does new/changed work).
2. **Metadata** (`media.ts`, when *File metadata* is enabled):
   - photos — dimensions/orientation via `sharp`; date / GPS / camera via `exifr`.
   - videos — dimensions / duration / creation time via `ffprobe`.
3. **Thumbnails** (`media.ts`) — a grid cover (~400px) + a lightbox preview (~1600px),
   both WebP via `sharp`. For videos the source is an `ffmpeg` poster frame.
4. **Upsert** — `library_items` + `gallery_details` + a minimal `item_metadata`
   row (title = filename, `cover_storage_key` = the grid thumbnail).

Every probe degrades gracefully: if `ffmpeg`/`ffprobe` are missing or a file can't
be decoded, the asset is still indexed (just without dimensions/thumbnail). The scan
runs on the shared job queue (`SCAN_GALLERY_LIBRARY`), mirroring the ebook worker.

**External dependencies:** `exifr` (npm) for EXIF; `ffmpeg`/`ffprobe` (system
binaries, installed in the Docker image) for video. Range *streaming* of the
original video uses plain `fs` + the shared `parseRangeHeader` — ffmpeg is only for
poster extraction.

## Serving

- Thumbnails + previews are served by the existing `/api/library/covers/*` route
  (keyed by storage key) — no gallery-specific image route.
- The original photo/video streams from `GET /api/library/gallery/assets/:id/file`
  with HTTP range support (`stream.ts`), so `<video>` can seek.

## Schema

`gallery_details` (1:1 with `library_items`): `kind` (`photo`|`video`),
`relative_path`, `mime_type`, `size`, `width`, `height`, `orientation`,
`duration_seconds`, `taken_at`, `modified_at`, `gps_lat`/`gps_lng`,
`camera_make`/`camera_model`, `preview_storage_key`. Indexed on `taken_at` for the
Timeline. See `db/schema.sql` and migration 5.

## Cross-type systems

Gallery is **not** a `BOOK_LIBRARY_TYPES` member — it stays out of the genre
Categories taxonomy and the book-only Home feeds. It does join the polymorphic,
item-keyed systems:

- **Tags**, **Favorites** (`item_saves`), **Recycle Bin** — work per asset
  unchanged (the asset's `folder_path` is a single file, so trash moves that file).
- **Collections** — gallery assets are collectable (`collections/hydrators.ts`,
  `entityType = "library_item"`, `libraries.type = 'gallery'`), so a Collection
  works as a photo album. Surfaced via the **Add to album** action in the lightbox.
- **Shares** — the `libraries.type → module` map (`mediaKind`) resolves `'gallery'`,
  so user-to-user item shares are namespaced correctly. (Guest *link* viewing for
  gallery assets is not implemented yet — a later phase.)

## API

| Method | Path | Purpose |
|---|---|---|
| POST/GET/PATCH/DELETE | `/api/library/gallery-libraries[/:id]` | Library CRUD (admin) |
| POST | `/api/library/gallery-libraries/:id/rescan` | Queue a rescan |
| POST | `/api/library/gallery/timeline` | Paged date timeline (scope, kinds, q) |
| GET | `/api/library/gallery/folders` | Folder listing (subfolders + assets) |
| GET | `/api/library/gallery/facets` | Kind counts + year list |
| GET | `/api/library/gallery/assets/:id` | Single asset detail |
| GET | `/api/library/gallery/assets/:id/file` | Original photo/video (range) |

## Not yet (future phases)

- **Map view** over the stored GPS coordinates.
- **Face detection / semantic search** (ML — the heavy part of Immich).
- **Dedicated shareable album object** (v1 uses Collections) and gallery **uploads**
  into managed libraries.
