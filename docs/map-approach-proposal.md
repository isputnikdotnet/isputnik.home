# Map approach — proposal

Status: proposed, not started. Supersedes nothing; `docs/lightbox-panel.md` and
`docs/photo-review-plan.md` describe the surfaces this touches.

## Where we are

Four Leaflet surfaces, all drawing on the same base map:

| Surface | File |
|---|---|
| Gallery map (clustered thumbnails) | `apps/web/src/features/gallery/GalleryMap.tsx` |
| Lightbox mini-map | `apps/web/src/features/gallery/GalleryMiniMap.tsx` |
| Story route map | `apps/web/src/features/stories/StoryMap.tsx` |
| Dashboard sign-in locations | `apps/web/src/features/control/sections/dashboard/LocationsMap.tsx` |

All four import `OSM_TILE_URL` from `apps/web/src/shared/mapTiles.ts`, so the
**browser** fetches tiles straight from `tile.openstreetmap.org`. That host is the
one exception in the CSP's `img-src`.

Geocoding is forward only: `modules/library/gallery/geocode.ts` proxies Nominatim
for the location picker (plus the Plus Code path, plus an LRU cache). There is no
reverse geocoding anywhere — `gallery_details.place_text` is only ever what a
person typed, and the schema comment beside it already promises a "geocoded
label" that does not exist.

IP → location is already local and already offline: `core/geoip.ts` reads MMDB
files from `<data>/geoip` in two tiers (DB-IP Country Lite ~9 MB, which the app
can fetch *for* you on request; and any city-level database the owner sources
themselves). Neither is automatic — both are admin actions. The folder is
*scanned* rather than configured, absence is a normal state, and an admin
installs by URL or by upload. **This is the pattern the rest of the proposal
reuses.**

## Phase 1 — vector tiles through one route

Base map becomes **OpenFreeMap vector tiles rendered by MapLibre GL**, fetched
through our own route:

`GET /api/map/tiles/{z}/{x}/{y}.pbf`, resolved in order:

1. the on-disk tile cache;
2. the configured upstream — then written to the cache.

Why vector rather than the raster tiles we serve today:

- **Dark mode.** OpenFreeMap ships a Dark style. Raster OSM has one look, for
  ever — on an app built around themes, that is a permanent mismatch.
- **Labels follow the interface language.** The OpenMapTiles schema carries
  `name:en` and `name:ru`, so map labels can switch with the UI. Baked raster
  tiles cannot do this at all; today a Russian speaker gets Cyrillic only where
  OSM's renderer happens to use it. Given the i18n rule, this is the strongest
  single argument.
- **A much smaller cache.** Vector stops at z14 and the client over-zooms;
  raster needs every level to z19, and z15–19 are the bulk of a raster cache.
- **No usage policy to work around.** OpenFreeMap has no key, no registration and
  no request limits; OSM's tile policy constrains what we may cache.
- Crisp at any zoom and on retina.

Costs, stated plainly: MapLibre replaces Leaflet (~45 KB → ~200 KB gzipped),
WebGL becomes a requirement, and four components change. The seams below are
what keep that from being a one-way door.

### Third-party risk, and the answer to it

OpenFreeMap is one maintainer, donation-funded, with no SLA. For software that
ships to other people's servers that is a real dependency risk. Three things
contain it: tiles are cached, so an outage degrades rather than breaks; the
source is configuration, not code (below); and MapLibre + OpenMapTiles is a
standard schema with other providers behind it.

Self-hosting OpenFreeMap is not an option here — **300 GB for one planet run**
(600 GB while auto-updating), on a dedicated VM whose nginx config its deploy
script owns.

### Why

- **Privacy.** Today OSM sees every pan, per user. The sharpest case is the
  dashboard: `LocationsMap` calls `fitBounds` over the sign-in locations at
  `maxZoom: 10` and `flyTo` at zoom ≥5 on click, so the *set* of tiles requested
  outlines where this household signs in from — on the one page whose purpose is
  that those locations never leave the house. The file's comment ("Nothing about
  a sign-in is in those requests") is true of any single request and understates
  the aggregate. Switching lets that caveat be deleted.
- **CSP.** Tiles stay first-party: `connect-src 'self'` once Off is not in play.
- **Offline.** A family library revisits a small, repeating set of places, so the
  cache hit rate is unusually good. It also means the security dashboard still
  draws a map when the house's internet is down.
- **Failure is visible.** The referer bug proved this surface fails *silently* —
  HTTP 200 with a 7 KB "Access blocked" image. Our own route, our own logs.

### Keeping it swappable

The point of this section is that "we picked OpenFreeMap and MapLibre" must not
become "we are married to OpenFreeMap and MapLibre". Three seams, at three
different levels.

**Seam 1 — the tile source is data, not code.** The route resolves through an
ordered list of sources behind one interface:

```ts
interface TileSource {
  get(z: number, x: number, y: number): Promise<TileBody | null>;
}
```

`CacheSource` and `UpstreamSource` implement it; the upstream's URL template,
format and attribution come from configuration. Changing provider is a settings
change, not a deploy — and a second upstream can be added as a fallback without
touching the route.

**Seam 2 — the web asks the server what to draw on.** `mapTiles.ts` stops being
a constant and becomes `GET /api/map/config`, answering with mode (off /
proxied), style URL, attribution and max zoom. The provider is therefore a
runtime fact, not a compile-time one: no web rebuild to change it, and the Off
and Cached levels differ only in what this endpoint returns.

**Seam 3 — one map component, renderer behind an adapter.** Today four features
each call `L.map()`, `L.tileLayer`, `L.marker`, `L.circleMarker`, `L.divIcon`,
`fitBounds` and `flyTo` directly — the renderer is smeared across four files,
which is what makes swapping it expensive. Replace that with one shared
`apps/web/src/shared/map/MapView`, which features drive *declaratively*:

```tsx
<MapView
  markers={[{ id, lat, lng, content: 'thumbnail' | 'dot' | 'ring' | 'number' }]}
  circles={[{ id, lat, lng, value, className }]}
  lines={[{ points }]}
  cluster
  view={{ fit: bounds } | { center, zoom } | { flyTo: bounds }}
  onMarkerClick={…}
/>
```

That vocabulary — markers, circles, lines, clusters, view control, tooltips,
click — is everything our four surfaces actually use. Behind it sits a
`MapRenderer` adapter in one file. Swapping renderers becomes "write a second
adapter", not "rewrite four features".

This also follows the existing rule that a new UI pattern extends a shared
component rather than being inlined, so `MapView` earns its place on
deduplication alone, independent of any future swap.

**Seam 4 — place naming** (phase 2) sits behind a `PlaceNamer` interface, so the
GeoNames dataset is an implementation rather than an assumption.

What is deliberately *not* abstracted: there is no plugin system, no generic GIS
API, and no attempt to support every map library. The vocabulary above is what
these four surfaces need and nothing more.

### Constraints

- Offline coverage is limited to what someone has actually looked at — there is
  no bulk region download. Accepted.
- WebGL is required by MapLibre. Software rendering on an old device or a VM
  without a GPU will be slow.
- Vector tiles arrive by `fetch`, not as `<img>`, so they are governed by
  `connect-src` rather than `img-src`. Proxied, that is `'self'`; while the Off
  level exists, the provider's host must be allowed. MapLibre also needs
  `worker-src blob:`.
- `GalleryMap`'s `leaflet.markercluster` is replaced by MapLibre's built-in
  GeoJSON clustering — comparable behaviour, but a rewrite, not a port.
- The `{z}/{x}/{y}` route needs bounds validation and will read as path-injection
  to CodeQL until the `pathIsInside` sanitizer is applied (see the standing
  dismissal families in `docs/`-adjacent notes).
- The upstream fetch must carry `REMOTE_FETCH_USER_AGENT`, for the same reason
  `referrerPolicy` is load-bearing today.

### As built — server (steps A, B and C)

`apps/server/src/modules/maps/`. Where it departs from the plan above, and why:

- **The style names no host; the web supplies the origin.** Every URL MapLibre
  fetches from a rewritten style is root-relative (`/api/map/...`), and the
  vector source is INLINED (tiles, zoom range, bounds) so MapLibre never fetches
  a TileJSON. The server cannot know the browser's origin: Origin is absent on a
  same-origin GET, and Host is whatever the last proxy chose — an end-to-end run
  through Vite's dev proxy produced a style pointing at `http://127.0.0.1:4000`,
  which the browser refused. **Contract for the web half:** prefix
  `location.origin` onto every root-relative URL before handing the style to
  MapLibre (it loads tiles in a worker, where a relative URL resolves to
  nothing). There is no public TileJSON route.
- **Attribution is ours**, set on the inlined source from our own constant —
  never the provider's TileJSON string, since MapLibre writes it as HTML.

- **Six resources, not one.** A MapLibre map on OpenFreeMap fetches a style, a
  TileJSON, vector tiles, a raster hillshade layer, glyphs and sprites. All six
  are proxied — tiles for privacy, the rest so the map draws offline and
  `connect-src` can be `'self'`. The style and TileJSON are rewritten per
  request so every URL points back here; an unrecognised source is dropped with
  its layers, and unrecognised glyphs or sprites are an error.
- **Cache keyed on what an asset is.** Upstream tile URLs carry a weekly build
  version; keying on them would discard the whole cache every week.
- **Access is a session OR a live share link** (`?share=`). Shared stories draw
  maps for guests with no session; unauthenticated, an internet-facing install
  would be an open map proxy. Proxy routes get their own 3000/min rate limit.
- **Validated before upstream is asked.** Upstream answers 200 for impossible
  coordinates (`x=99999` at z14), so the bounds check is the only thing keeping
  junk keys out of the cache.
- **Stale-on-error.** An expired copy is served (`x-map-cache: stale`) when
  upstream is unreachable; a 404 is not papered over.
- **The provider is code plus `MAP_UPSTREAM_URL`**, not an admin setting.
  Providers do not share a URL layout, so "just a base URL" only holds within
  one; a second provider is a second `provider.ts`.
- **The cap is a throttled sweep after writes** (`sweep.ts`, 200 MB,
  `MAP_CACHE_LIMIT_MB`), not a scheduled job: a cap must hold whether or not
  anyone schedules anything. Oldest-fetched tiles go first; styles, glyphs and
  sprites are never evicted.
- **Map data is a room** (`maps`, folder "Map data"), on the Renders rule: App
  storage as soon as there is one, "own" meaning `MAP_DATA_PATH` or
  `<data>/map-data`, no "off" (whether maps are kept is the maps setting, not
  a storage question). Switching, and changing the App storage folder, **move**
  it with the existing storage move task rather than discarding it — at a 200 MB
  cap that is simpler than a special path, and it merges into tiles fetched at
  the new place meanwhile. A move carries only `MAP_DATA_FOLDERS` (today
  `Tiles`); the geoip and places databases join that list when they move in.
  The geoip folder itself has NOT moved yet — still `<data>/geoip`.

Measured against the real provider: a vector tile is 1.9 KB gzipped (2.4 KB
raw), a glyph range 42 KB, and a **hillshade tile ~190 KB — about a hundred
vector tiles**, so hillshade dominates the cache wherever someone zooms out.

### As built — web (steps D and E)

**D — MapLibre.** `shared/map/maplibre-renderer.ts` replaces the Leaflet
adapter; Leaflet and markercluster are uninstalled, and nothing outside that
file imports MapLibre.

- **The worker must be handed to MapLibre** (`?worker&url` + `setWorkerUrl`).
  Version 6 looks for it beside its own bundle, which Vite neither emits nor
  serves.
- **Markers and circles stay HTML**, so the features' CSS applies unchanged; a
  circle is an SVG `<circle>` inside a marker. **Lines are WebGL layers**, and
  their colour is read from CSS through a hidden probe, so the theme still owns
  it. Clusters are a clustered GeoJSON source with HTML bubbles kept in step.
- **Zoom stays on the raster scale** in the vocabulary; the adapter subtracts 1.
- **Dark themes get the dark style**, swapped live when the theme changes
  (markers survive). **Labels follow the interface language** (`name:ru` /
  `name:en`, falling back to the local name). A narrow map starts with its
  credit folded to the (i) button.
- **CSP:** the OSM tile hosts are gone from `img-src`; the provider's origin
  (from `upstreamBase()`, so `MAP_UPSTREAM_URL` is honoured) is in `connect-src`.
- **Precache:** the 507 KB worker was being precached on every device, because
  Vite builds workers outside the import graph the precache scope reads. Untracked
  scripts under `static/` are now dropped; the diff removed exactly that one file.
- Verification note: the in-app preview pane is a hidden page, where
  `requestAnimationFrame` never fires and MapLibre never loads. Check maps in a
  painting browser (headless Chrome renders frames).

**E — the Maps group** (`features/control/sections/maps/`), the eighth nav
group by the owner's decision: **Setup** (a row per level with its size, the
three-step wizard, turning a level off behind a confirmation that says what it
deletes), **Data** (the location databases, the existing installer, removal via
the new `DELETE /api/dashboard/locations/database/:name`), **Routing** (the old
Settings › Maps; its address is an alias). The Locations view keeps its map and
points its notice and its database button at these pages.

Verified against the production bundle under the enforced CSP: every surface
draws with no violations, and with caching on the gallery map made **0 requests
to the provider and 42 through this server**. One world view plus fonts, icons
and hillshade came to 4.8 MB.

Not done: the geoip folder has not moved into the Map data room, and there is no
first-run (Welcome page) step offering the wizard.

## Phase 2 — coordinates become place names

Nominatim's policy rules out bulk reverse geocoding, so it stays where it is
(single interactive lookups in the picker). Library-scale naming is solved
locally.

**A prepared places dataset** (GeoNames `cities500` joined at build time with
`admin1CodesASCII` / `countryInfo`, plus `alternateNamesV2` filtered to `en`/`ru`
for those geonameids), shipped as a SQLite file with an R-tree on lat/lng.
Nearest-neighbour lookup is sub-millisecond and batches over a whole library
during scan. CC BY 4.0 — needs an attribution line.

Note this does **not** overlap the geoip database. An `.mmdb` is keyed by IP
range and answers IP → city; this is keyed by space and answers lat/lng → name.
Opposite directions, different indexes, separate files.

### Stored structured, not as a string

```
geo_place, geo_admin1, geo_country_code, geo_distance_km, geo_source
```

- Renders in the viewer's language at display time instead of freezing English
  into the row — which matters given the i18n rule.
- Gives a **Places facet** in the browse filter and a grouped Places view. Today
  the only location filter is `with_gps` / `no_gps`. The facet, not the line in
  the Info panel, is the real payoff.
- Precedence as the schema already promises: `place_text` → geocoded label →
  coordinates. Never write the geocoded value into `place_text`; the human's
  words stay theirs.
- Pure function of `(lat, lng, dataset)`, so backfill is re-runnable and changing
  the rule later risks no user data.

### The degrade rule is the work

Nearest-town is wrong or meaningless in wilderness, at sea, and near borders.
`geo_distance_km` drives it: "Ratomka" under a few km, region or country beyond
that, nothing at all when there is nothing. Optionally add Natural Earth admin-1
polygons (a few MB) so country/region is right for any point.

### Bonus

`LocationsMap` currently renders whatever English city string the MMDB carries
(`place.city`, `place.region`) — frozen and untranslatable. The same dataset can
normalise those, so both maps speak one vocabulary in the user's language.

## Optional, and off by default

Not every house has a spare gigabyte, so none of this is on until someone turns
it on. "Off" must not mean "no maps" — four map surfaces work today and must keep
working untouched. So off means **today's behaviour**, and the levels are:

| Level | Disk | What you get |
|---|---|---|
| **Off** (default) | 0 | Tiles direct from the provider. Maps work; nothing stored. |
| **Cached** | ~100 MB | Tiles via our server. Privacy fixed, offline for places already seen. |
| **Named places** | +50–100 MB | Photo GPS reads as a place name; Places facet. |
| **Sign-in countries** | +9 MB | Which country a sign-in came from, on the dashboard. |
| **Sign-in towns** | +70–400 MB | Region, city and coordinates. Owner-supplied `.mmdb`. |

Every level above Off is independent — cache without names, names without cache.
Each is a checkbox, not a step on a ladder.

The two sign-in levels are the existing geoip tiers, moved rather than changed:
`downloadGeoip()` is already admin-triggered (there is no boot wiring), so this
relocates a button that was always opt-in. The only consumer of `lookupLocation()`
is `modules/dashboard/routes.ts` — nothing in auth, lockout or the alert emails
reads it — so leaving these off costs the Locations map and nothing else.

**With them off the map still draws**, at its usual opening view with no bubbles,
under a `MessageBox` notice (`info`) saying sign-in locations are not set up and
linking to the wizard. Keeping the map means the page still looks like itself and
the notice reads as one missing ingredient rather than a broken feature — and
`LocationsMap` already handles the empty case (`bounds.length === 0` opens on the
world at zoom 2), so nothing new is needed to draw it.

**Honest trade:** the privacy fix only lands for people who opt in. Worth
offering during first-run setup rather than leaving it to be discovered.

### Setup wizard

Enabling means choosing storage and downloading data, so it is a wizard, not a
toggle:

1. **What do you want?** The checkboxes above, each with its size.
2. **Where should it go?** The Map data room — App storage, or its own folder.
   Same chooser the other rooms use.
3. **Download.** Runs as a Task with progress, like other long jobs. Failure
   leaves the level off rather than half-on.

Turning a level back off deletes its data and says how much it frees.

## Storage — a new room

Map data is app-owned, not family data, so it belongs in `APP_ROOMS` beside
`thumbnails`, `renders` and `backups`. New room `maps`, folder **"Map data"**:

```
Map data/
  Tiles/       tile cache — regenerable, capped, swept
  Locations/   .mmdb geoip databases (today <data>/geoip)
  Places/      the places dataset (phase 2)
```

Inherited free from `app-storage-rooms.ts`: app/own/off modes, the
`MOVE_STORAGE` task, the Contents page, folder locks while in use, Tasks-page
reporting, and the row's `problem` text. Install-by-URL and upload already exist
in the geoip installer and are reused as-is for the places DB.

Room shape: `required: false`; `holdsFiles` true when any database is present;
a `map_tile_sweep` maintenance job enforces the cache cap via `JobScheduleControls`,
like backup retention.

### Space needed

| What | Size | Notes |
|---|---|---|
| Tile cache (typical) | **30–100 MB** | Vector, z0–14 only; grows with places viewed |
| Tile cache (cap) | **200 MB** | Default cap; swept back down by the job |
| GeoIP country tier | **~9 MB** | DB-IP Country Lite, fetched by the app |
| GeoIP city tier | **70–400 MB** | Optional, owner-supplied |
| Places dataset | **50–100 MB** | GeoNames `cities500` + EN/RU names in SQLite |
| Places dataset (small) | **5–10 MB** | `cities15000` fallback — towns only |

**Realistic totals.** Cached tiles, named places and country-tier geoip:
**~200 MB**. With a city-tier `.mmdb` instead: **up to ~1 GB**. Nothing here is
mandatory, so a house that wants none of it stays at zero.

### Decisions this forces

1. **Adopting `<data>/geoip`.** Resolution order becomes `GEOIP_PATH` → room path
   → legacy `<data>/geoip`, adopted on boot the way the legacy backup timer and
   `LEGACY_ROOM_FOLDERS` ("Made in the app") were. `GEOIP_PATH` keeps winning when
   set — an env var is a promise.
2. **Mixed carry semantics on a location change.** Databases must be carried; the
   tile cache should not be. Recommendation: discard and refill the cache, carry
   the rest. Moving hundreds of MB of tiles to save a few days of re-fetching is a
   bad trade.
3. **Backups stay as they are.** Backups archive the database plus the thumbnails
   directory only, so everything here is excluded automatically — correct, since
   all of it is regenerable. Worth saying on the page that an owner-supplied
   city `.mmdb` is *their* copy and is not in the backup.

## Rejected — an offline basemap

Considered: a Protomaps `.pmtiles` region file as a further level, giving maps for
places nobody has visited.

Rejected on **consistency and disk**, in that order.

Consistency: Protomaps uses its own tile schema, not OpenMapTiles, so its styles
are not interchangeable with the ones we render everywhere else. A house that
enabled it would get a visibly different-looking map from every other install,
and from its own maps before enabling — different land and water colours,
different road hierarchy, different label treatment. One base map, one look, at
every level.

Disk: it cost the most of any level (100 MB – 3 GB) for the least-wanted
capability. A family photo map is only interesting where the family has been, and
those tiles are exactly the ones the cache already holds.

**Worth revisiting later, though.** Moving to MapLibre makes offline
*technically* much cheaper — MapLibre reads PMTiles natively — and OpenFreeMap
publishes weekly planet MBTiles, so a region extract in the same schema would
keep one look. The blocker is sourcing that region without a planet-sized
download. Not now; not closed for ever.

## Rejected — a generic library type

Considered: a new `libraries.type` usable for any item type, to hold app-produced
content.

Rejected for map data outright — tiles and geo databases are never browsed,
shared, collected or favourited, so making them `library_items` is a category
error that rooms already solve.

Rejected as a fix for the related smell, too. The smell is real: the house
library is forced to `type = 'gallery'`, and `gallery_details.kind` had to grow an
`'audio'` value so story narration could live there, which also puts slideshow
movies and family-tree uploads in the family Timeline and under face scanning.
But a type is what tells the scanner how to read files and which detail table to
write — "any item type" contradicts the column's one job. It is also expensive in
the way `CLAUDE.md` sets out (scanner, detail table, browse routes, detail page,
collections/shares `entityType`), and `mediaKind()` folds anything unrecognised
into `"audiobook"`, so a new value misroutes silently until every call site is
found.

**Cheaper fix, matching our own precedent:** a policy flag. `policy_json` already
carries `inbox: true`, and that single flag is what makes the Photo Inbox behave
and place differently while remaining a gallery library. A `system: true` flag
would keep the house library out of ordinary browse, Timeline and face scanning —
no new type, no migration of existing rows, no cross-type wiring. Tracked
separately from this proposal.

A new type earns its cost the day there is a family-facing **Documents** or
**Music** library — something people actually browse — following the media-type
rule, nested under `library/`.

## Control panel — Maps becomes its own group

Maps is now a feature you enable, with storage and downloads behind it — too much
for a tab under Settings. It gets its own nav group in `features/control/nav.ts`,
a peer of the existing seven:

| Tab | Holds |
|---|---|
| **Setup** | On/off per level, the wizard, what is installed, disk used |
| **Data** | GeoIP databases, places database — install by URL or upload |
| **Routing** | The existing endpoint and key |

Two things move in, and nothing is left behind:

- **Settings › Maps** is removed; its routing endpoint and key become the
  Routing tab.
- The **geoip installer** moves off Overview › Dashboard › Locations into Data.
  The dashboard keeps its map — only the installer moves.

Follows the usual rules: canonical paths in `CONTROL_PATHS`, linked via
`controlHref()`, every tab a real route, pages open with `ControlSectionHead`,
one tab row, and new settings get terms in `features/control/search-index.ts`.

## Order

Phase 1 and phase 2 share no code. Phase 1 is small, self-contained, and gets
harder to retrofit later. Phase 2 is bigger and is the one users would notice.

Phase 1 splits in two, and the split is the point: **land the boundary before
changing the renderer.**

1. **Phase 1a — `MapView`, still on Leaflet.** Build the shared component and the
   `MapRenderer` adapter, implement the adapter on Leaflet, and move all four
   features onto it. Purely mechanical, no user-visible change, so it is
   verifiable on its own — the maps must look and behave exactly as before.
2. **Phase 1b — swap the adapter to MapLibre**, add the tile route, cache and
   sweep job, `/api/map/config`, the Maps nav group, the `maps` room and the
   wizard.

Doing 1a first turns one risky migration into two small verifiable ones, and it
is what proves the interface is real: an interface with a single implementation
is a guess, with two it is tested. The Leaflet adapter can be deleted afterwards,
or kept as the no-WebGL fallback — that choice is deferred, and costs nothing to
defer because the seam exists either way.

CSP note: `connect-src` can only close to `'self'` once the provider is never hit
directly, so it stays open while Off remains a level.
2. **Phase 2** — dataset build script, `geo_*` columns (migration), scan hook,
   backfill job, display precedence, Places facet and filter UI, i18n keys.

## Open questions

- Ship the places dataset in the image, or install-on-demand like the city-tier
  `.mmdb`? On-demand keeps the image small and matches the existing pattern.
- Default tile cache cap. 200 MB is a guess; it wants a number from a real
  library's usage.
- Does the Places facet get its own browse page, or only a filter facet to start?
