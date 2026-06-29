# Gallery library (photos + videos)

The gallery is a media type for photos and videos, modelled on Google Photos /
Immich rather than the book-like types. Its defining choice:

> **One asset = one item.** Every photo and every video is its own
> `library_items` row (`type = 'gallery'`), unlike audiobooks (a folder of tracks)
> or ebooks (a basename group of formats). This is what lets the same set of assets
> be browsed two ways.

## Three views over one asset set

- **Timeline** (default) — assets newest-first by `gallery_details.taken_at`
  (EXIF date, falling back to file mtime), grouped into month headers in the UI.
- **Folder** — a file-explorer over the on-disk directory structure, for libraries
  that keep their own folder layout (the common case for a read-only source).
- **Map** — geotagged assets plotted on a Leaflet/OpenStreetMap map with clustered
  thumbnail pins; clicking a pin opens the asset in the lightbox. The tab only
  appears when the scope has geotagged assets (`galleryFacets().withGps > 0`).

All are queries over the same rows (`modules/library/gallery/catalog.ts`); the
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
  so both user-to-user item shares and anonymous **guest links** are namespaced
  correctly. A guest link opens a self-contained viewer (photo inline / `<video>`
  with range seeking) plus a single-file download — see `shares.ts` (the
  `module === "gallery"` branches) and `SharePage`'s `GalleryShareView`.

## API

| Method | Path | Purpose |
|---|---|---|
| POST/GET/PATCH/DELETE | `/api/library/gallery-libraries[/:id]` | Library CRUD (admin) |
| POST | `/api/library/gallery-libraries/:id/rescan` | Queue a rescan |
| POST | `/api/library/gallery-libraries/:id/assets/upload` | Upload photos/videos (multipart batch; upload permission) |
| POST | `/api/library/gallery/timeline` | Paged date timeline (scope, kinds, q) |
| GET | `/api/library/gallery/folders` | Folder listing (subfolders + assets) |
| GET | `/api/library/gallery/facets` | Kind counts + year list + geotagged count (`withGps`) |
| GET | `/api/library/gallery/map` | Geotagged assets as lightweight markers (scope/kind, capped at 5000) |
| GET | `/api/library/gallery/assets/:id` | Single asset detail |
| PATCH | `/api/library/gallery/assets/:id` | Edit title/caption, description, date taken, tags (write access) |
| GET | `/api/library/gallery/assets/:id/file` | Original photo/video (range) |

**Editing.** The lightbox offers a metadata edit (write access required) for
title/caption, description, **date taken** (drives the Timeline), and tags. Edits
set `item_metadata.source = 'manual'` and `gallery_details.taken_at_source =
'manual'`, so a later rescan refreshes the thumbnail/technical fields but never
clobbers the hand-edited values. Technical fields (dimensions, size, camera) and
GPS stay read-only.

## Uploads

Managed galleries accept uploads via `POST …/assets/upload` (gated by the library's
`upload` permission, refused on external/read-only libraries). It reuses the shared
streaming uploader (`receiveUploadBatch`) and the multi-file / whole-folder
`FileUpload` dropzone: every file becomes its own asset, streamed into a hidden
`.upload-*` staging folder, moved into the library root under a unique name, then
cataloged immediately with `scanSingleGalleryFile` (EXIF + thumbnails). Folders
flatten into the filename, like the other library uploaders. Uploaded files land in
the library root; on-disk subfolder organization is a future nicety.

## Map view

`GalleryMap.tsx` is plain Leaflet (no react-leaflet) driven via a ref + effects, with
`leaflet.markercluster` for clustering. It's **lazy-loaded** (`React.lazy`), so the
~140 KB of Leaflet only ships when a user opens the Map tab — it stays off the
initial bundle that Timeline/Folder browsing uses. Base tiles come from
OpenStreetMap; markers are divIcon thumbnail pins, and clicking one fetches the full
asset (`getGalleryAsset`) to open the lightbox. The lightbox **Info panel** also
embeds a small one-marker location map (`GalleryMiniMap.tsx`, likewise lazy-loaded
and sharing the Leaflet chunk) for any geotagged asset, above the plain-coordinate
OpenStreetMap link.

**CSP exception.** OSM raster tiles are the *only* external resource the app loads.
Leaflet requests them as `<img>`, so `imgSrc` in the server's helmet config allows
`https://tile.openstreetmap.org` and `https://*.tile.openstreetmap.org` (nothing uses
`connect-src` for tiles). This does mean a browser viewing the Map reveals the
approximate locations of geotagged photos to the OSM tile host — an accepted
trade-off for the slippy-map UX. A future option is an admin-configurable tile URL so
a privacy-conscious deployment can self-host tiles.

## Not yet (future phases)

- **Face detection / semantic search** (ML — the heavy part of Immich).
- **Dedicated shareable album object** (v1 uses Collections).
- **Upload into a chosen subfolder** (today everything lands in the library root).
- **Configurable map tile source** (today OSM is hard-wired).
