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

## Search & advanced filters

The Timeline is the searchable/filterable view (searching or filtering from the
Folder view pulls you into it, like the audiobook catalog):

- **Text search** (`q`) matches the title, description/caption, any folder or
  file-name segment, and tagged people's names.
- **Advanced filters** (the Filter button, same UI as audiobooks — the shared
  `web/src/shared/FacetFilter.tsx` panel + chips): **People** (named
  `gallery_people`), **Years**, **Date taken** (inclusive From/To range),
  **Tags**, **Cameras** (one display string per make/model, deduplicated when the
  model embeds the make), **File size** (fixed buckets: <1 MB, 1–5 MB, 5–25 MB,
  25 MB+), and **Location** (has / has no GPS). Lists are OR within a facet, AND
  across facets. The media-type filter (photos/videos) stays in the header dropdown.
- Option lists come from `GET /api/library/gallery/facets` (people/tags/cameras/
  years, scoped to accessible libraries); filter arrays go in the
  `POST /api/library/gallery/timeline` body as `filters`.

## Memories ("On this day")

`GET /api/library/gallery/memories` returns past-year assets whose `taken_at`
matches today's month/day, grouped by year (newest first) with per-year counts.
The match widens until it finds something — exact day → ±3 days → same month —
and reports which tier matched as `precision` (`day` / `near` / `month`) so the
UI can label the row honestly. The current year is excluded, and undated assets
never match. `date` is the **client's** local calendar date (the server may sit
in another timezone); `perYear` caps items per year group.

Three surfaces consume it (`queryGalleryMemories` in `catalog.ts`):

- a **Memories view** (`/gallery/memories`, also a gallery tab that appears
  whenever memories exist) — one section per year with a date heading
  ("July 6, 2014 · 12 years ago"), photo grids feeding the lightbox over the
  **flattened** cross-year list, so Next flows from one year into the next.
- a **Memories strip** above the gallery Timeline — one large card per year
  ("2019 · 12 photos"); tapping opens the Memories view anchored at that year.
  Hidden while searching, filtering, or selecting.
- an **"On this day" Home row** (the gallery's first Home presence) — one tile
  per year, linking to `/gallery/memories`. Desktop only, hidden when there is
  nothing day-precise to show (the month-wide fallback stays off the dashboard).

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

Two edge cases the pipeline handles explicitly:

- **Formats sharp can't read** (BMP is the common one — the prebuilt libvips has no
  BMP loader): the photo is re-decoded to JPEG via the bundled `ffmpeg` and the
  thumbnail/metadata/face-detection paths retry from that buffer
  (`media.ts decodePhotoToJpeg`). Dimensions come from `ffprobe` in that case.
- **Zero-byte files** (failed copies, placeholders, copies still in flight) are
  skipped entirely — nothing can render them; a later scan picks them up if they
  gain content, and an already-indexed empty file is reconciled away.

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
| POST | `/api/library/gallery/timeline` | Paged date timeline (scope, kinds, q, `filters`: people/tags/years/taken/cameras/sizes/location) |
| GET | `/api/library/gallery/memories` | "On this day": past-year assets matching today's month/day, grouped by year (`date` = client's local day, `perYear` cap, `precision` tier) |
| GET | `/api/library/gallery/folders` | Folder listing (subfolders + assets) |
| GET | `/api/library/gallery/facets` | Filter options (people/tags/cameras/years) + kind counts + geotagged count (`withGps`) |
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

## Face recognition

On-device face detection + grouping, entirely in-process (no external service, nothing
leaves the machine). Code lives under `modules/library/gallery/faces/`.

**Pipeline** (`arcface.ts`): InsightFace SCRFD-500MF detector → 5-point similarity-warp
alignment to 112×112 → ArcFace **ResNet50** recogniser (`w600k_r50`) → 512-d L2-normalised
embedding (cosine = dot product). Runs on `onnxruntime-node` (CPU by default; set
`FACE_ORT_PROVIDERS=cuda,cpu` / `dml,cpu` to try an accelerator). CPU fallback is
automatic at both model **load** and — because DirectML can accept a model and still
reject an op mid-run — at **execution** time: the first runtime failure rebuilds the
engine CPU-only, retries the photo, and stays on CPU until restart. Models are vendored
under `apps/server/models/face/` (`det_500m.onnx`, `w600k_r50.onnx`). The engine loads
lazily on first detection and disables sharp's cache for the duration (a scan sees only
unique images). Faces of one photo are recognised in a single batched `rec.run` on CPU;
on a GPU provider they run one at a time instead (DirectML rejects the dynamic batch dim
at execution time — the model is exported as `[1,3,112,112]`).

**CPU budget / responsiveness.** Left unbounded, onnxruntime's CPU provider runs the
ResNet50 with `intraOpNumThreads` = every core and sharp's decode pool piles on, so a
scan pegs all cores and starves Node's event loop — the web UI goes unresponsive for the
whole run. Both are therefore capped to `faceScanThreadBudget()` — `cores − 1` by default,
leaving a core for the server (and sqlite, which is synchronous). Override with
`FACE_ORT_THREADS=<n>` (e.g. `1` to throttle hardest on a small box, or a higher number to
finish faster at the cost of responsiveness). The cap is set on the onnxruntime session
options and via `sharp.concurrency()`.

**Module layout:**
- `arcface.ts` — detection + embedding engine (native ORT).
- `queue.ts` — job-enqueue helpers + payload types; dependency-light (db + nanoid only) so
  callers like the maintenance scheduler don't pull in the ML import chain.
- `scanner.ts` — the scan worker (own `SCAN_GALLERY_FACES` queue, 2s poller, single-flight
  guard) + `activeFaceScan()` progress reader. Incremental scans run in **batches of
  1,000 photos**, pre-queued up front as numbered jobs (`batch 2/5`, shared `groupId`)
  so the Tasks page shows the whole backlog; correctness comes from the scan markers —
  a stale batch is just a fast no-op. Clustering is global and O(n²), so it runs **once
  when the queue drains**, and only if a batch actually changed face rows (or a crash
  left unassigned faces behind) — a no-op nightly pass never pays for it. The group's
  first batch stamps `chainStartedAt` onto its siblings; once **3 hours** pass, the
  running batch stops and the group's queued remainder is dropped (the next nightly run
  re-queues what's left). Forced full rescans are exempt from both limits and run as
  one uncapped job. Photos that fail to decode/detect get a `failed` marker and are
  retried on later scans — **after** every fresh photo, and at most
  `MAX_FACE_SCAN_ATTEMPTS` (3) times — then skipped, so corrupt/unsupported files can't
  clog or starve the backlog; a force rescan (or a model change) retries them, and the
  settings window shows them as "unreadable".
- `cluster.ts` — two-stage grouping: global mutual-kNN (resists hub-chaining) followed by
  a **centroid-merge pass** (clusters whose centroids agree ≥ 0.58 cosine re-unite —
  undoes k-NN fragmentation from burst/near-duplicate photos). Rebuilt groups reconcile
  with anchored people (named, linked, or **curated** — a user merge target), and ALL
  groups whose faces belonged to the same anchored person re-union into it, which makes
  manual merges durable across reclustering. Leftover 1–2-face groups join an anchored
  person at ≥ 0.5 centroid similarity (singleton absorption).
- `settings.ts` — per-library enable flag + global threshold/K; `model-id.ts` — the active
  `FACE_EMBEDDING_MODEL` id, isolated so the cluster/status layers can read it without
  loading ORT.
- `thumbnails.ts` — per-face avatar crops; `clear.ts` — wipe a library's face data.

**Storage:** `gallery_faces` (one row per detected face — box, embedding, `embedding_model`),
`gallery_people` (incl. the `curated` anchor flag set on merge targets), `gallery_face_scans`
(per-photo scan marker with the model used, plus `status`/`attempts` for the bounded
failure-retry budget), `gallery_face_exclusions` (durable "not this person" removals).
Face-crop thumbnail files are deleted wherever their rows go away (rescan replaces,
trash teardown, clear), and the recompute job sweeps any `*-face.webp` no row references.

**Model-aware incremental scan.** A non-forced scan only processes photos lacking a scan
marker **for the current model**, so bumping `FACE_EMBEDDING_MODEL` re-embeds stale-model
photos on the next scan (no `force` needed). Clustering and the "scanned X of Y" status
likewise filter on the current model, so after a model change progress correctly restarts
from zero and climbs. Changing the model invalidates old embeddings (they're never mixed
across models) and needs a one-time rescan.

**Progress + ETA.** The scan worker throttle-writes `{processed, total, startedAt,
etaSeconds}` into the job's payload via `shared/job-progress.ts` (recent-window rate).
Live progress is rendered on the admin **Tasks** page (Control panel → Libraries →
Tasks) — a progress ring with counts, percentage, and time remaining; the Face
recognition window just points there.

**Scheduled job.** The `scan_new_faces` maintenance job (Control panel → Libraries →
Scheduled jobs) enqueues non-forced scans across every face-enabled library — picking up
new and stale-model photos. Ships **enabled**, daily at **05:00** — deliberately after
the nightly library scans (randomized 01:00–04:59), so the day's new photos are already
cataloged and get their faces the same night.

## Not yet (future phases)

- **Semantic / content search** (ML — the heavy part of Immich).
- **Albums, photo-pure Collections + slideshow** — planned (Memories shipped);
  see [gallery-memories-albums-proposal.md](gallery-memories-albums-proposal.md).
- **Upload into a chosen subfolder** (today everything lands in the library root).
- **Configurable map tile source** (today OSM is hard-wired).
