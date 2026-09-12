// The base map every Leaflet map in the app draws on: OpenStreetMap's public
// raster tiles, the one external resource the CSP allows (see imgSrc in the
// server's helmet config).
//
// referrerPolicy is the load-bearing option here, not a detail. The app sends
// `Referrer-Policy: no-referrer` on every response, so tile requests reached OSM
// with no Referer at all — and OSM's tile usage policy asks that an app identify
// itself. An unidentified client is answered with HTTP 200 and a 7 KB "Access
// blocked" image in place of the map, which is indistinguishable from a working
// map until you look at what was drawn. Setting the policy on the tile <img>
// overrides the document policy for these requests only: OSM is told which origin
// is asking, and nothing else in the app starts sending a referrer.
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const OSM_TILE_OPTIONS = {
  maxZoom: 19,
  referrerPolicy: "strict-origin-when-cross-origin"
} as const;
