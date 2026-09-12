// Where the base map comes from, and how its style is taught to come through us.
//
// A MapLibre map on OpenFreeMap fetches SIX kinds of thing, not one: a style
// (JSON), a TileJSON that names the current tile set, the vector tiles, a raster
// hillshade layer, glyphs for the labels, and a sprite sheet for the icons. Only
// the tiles say where somebody is looking — but every one of them has to come
// through this server, or the map cannot draw offline and connect-src cannot
// stay 'self'.
//
// This file is the provider seam (docs/map-approach-proposal.md, seam 1). It
// knows OpenFreeMap's URL layout and nothing about caching or HTTP; `resolve.ts`
// owns the cache policy and would not change for another provider. A second
// provider is a second object of this shape, because providers do not share a
// URL layout — "the upstream is just a base URL" would only be true within one.
//
// Pure: no I/O, so the rewriting — the part that must never emit a URL on a host
// we did not choose — is tested without a network.

/** The styles OpenFreeMap publishes that we offer. `dark` is why vector was
 *  chosen at all: raster OSM has one look. */
export const MAP_STYLES = ["liberty", "positron", "bright", "dark"] as const;
export type MapStyleName = (typeof MAP_STYLES)[number];

/** Sprite files MapLibre asks for, by exactly these names (it appends them to
 *  the style's `sprite` base). Nothing else under a sprite version is served. */
export const SPRITE_FILES = ["ofm.json", "ofm.png", "ofm@2x.json", "ofm@2x.png"] as const;
export type SpriteFile = (typeof SPRITE_FILES)[number];

/** Vector tiles stop here upstream; MapLibre over-zooms beyond it. */
export const VECTOR_MAX_ZOOM = 14;
/** The Natural Earth hillshade source stops here (its own `maxzoom`). */
export const RASTER_MAX_ZOOM = 6;

export type MapAsset =
  | { kind: "style"; style: MapStyleName }
  | { kind: "tilejson" }
  | { kind: "vector"; z: number; x: number; y: number }
  | { kind: "raster"; z: number; x: number; y: number }
  | { kind: "font"; fontstack: string; range: string }
  | { kind: "sprite"; version: string; file: SpriteFile };

export const OPENFREEMAP_BASE = "https://tiles.openfreemap.org";

/** Credit shown on every map drawn from this provider. Attribution is a
 *  condition of OpenFreeMap's terms and of the OpenStreetMap licence. */
export const OPENFREEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

/** The base URL, overridable for a self-hosted OpenFreeMap. An operator setting,
 *  deliberately not an admin form: it is read at startup and never from a
 *  request, and every fetch still goes through fetchSafely. */
export function upstreamBase(): string {
  return (process.env.MAP_UPSTREAM_URL ?? OPENFREEMAP_BASE).replace(/\/+$/, "");
}

/** Where an asset lives upstream. `vectorTemplate` is the tile URL the current
 *  TileJSON names — it carries a weekly build version, which is exactly why the
 *  cache must never be keyed on it. */
export function upstreamUrl(asset: MapAsset, vectorTemplate?: string): string {
  const base = upstreamBase();
  switch (asset.kind) {
    case "style":
      return `${base}/styles/${asset.style}`;
    case "tilejson":
      return `${base}/planet`;
    case "vector": {
      if (!vectorTemplate) throw new Error("A vector tile needs the current TileJSON first.");
      return vectorTemplate
        .replace("{z}", String(asset.z))
        .replace("{x}", String(asset.x))
        .replace("{y}", String(asset.y));
    }
    case "raster":
      return `${base}/natural_earth/ne2sr/${asset.z}/${asset.x}/${asset.y}.png`;
    case "font":
      // One segment, encoded: a fontstack is validated before it gets here, and
      // encoding makes it impossible for it to become more than one segment.
      return `${base}/fonts/${encodeURIComponent(asset.fontstack)}/${asset.range}.pbf`;
    case "sprite":
      return `${base}/sprites/${asset.version}/${asset.file}`;
  }
}

/**
 * URLs on this server, which a rewritten style points at.
 *
 * ROOT-RELATIVE, deliberately. This server cannot know the origin the browser
 * used: the Origin header is absent on a same-origin GET, and the Host header is
 * whatever the last proxy chose — Vite's dev proxy, and plenty of reverse
 * proxies, rewrite it, so a style built from it points at an address the browser
 * cannot reach (found end to end: http://127.0.0.1:4000, from a page on another
 * port). The browser does know. So the web prefixes location.origin before it
 * hands the style to MapLibre, which needs absolute URLs because it loads tiles
 * in a worker, where a relative URL has nothing to resolve against.
 *
 * `share` is threaded through every one: a guest on a share link has no
 * session, and each asset request must carry the link that lets it in.
 */
export interface ProxyUrls {
  vector: string;
  raster: string;
  glyphs: string;
  sprite: (version: string) => string;
}

export function proxyUrls(share?: string): ProxyUrls {
  const q = share ? `?share=${encodeURIComponent(share)}` : "";
  const api = "/api/map";
  return {
    vector: `${api}/tiles/{z}/{x}/{y}.pbf${q}`,
    raster: `${api}/raster/{z}/{x}/{y}.png${q}`,
    glyphs: `${api}/fonts/{fontstack}/{range}.pbf${q}`,
    sprite: (version) => `${api}/sprites/${version}/ofm${q}`
  };
}

/** The upstream shape of a TileJSON's `tiles` entry. The build version in the
 *  middle is captured; anything not on our upstream host does not match. */
function vectorTemplatePattern(): RegExp {
  return new RegExp(`^${escapeRegExp(upstreamBase())}/planet/([A-Za-z0-9_]{1,64})/\\{z\\}/\\{x\\}/\\{y\\}\\.pbf$`);
}

/** The vector tile template a TileJSON names, if it names one we recognise. */
export function vectorTemplateOf(tilejson: unknown): string | null {
  const tiles = (tilejson as { tiles?: unknown })?.tiles;
  const first = Array.isArray(tiles) ? tiles[0] : null;
  return typeof first === "string" && vectorTemplatePattern().test(first) ? first : null;
}

function zoomOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 22 ? value : fallback;
}

interface StyleSource {
  type?: string;
  url?: string;
  tiles?: string[];
  [key: string]: unknown;
}

interface StyleLayer {
  id: string;
  source?: string;
  [key: string]: unknown;
}

export interface StyleDocument {
  sources?: Record<string, StyleSource>;
  layers?: StyleLayer[];
  glyphs?: string;
  sprite?: unknown;
  [key: string]: unknown;
}

export interface RewrittenStyle {
  style: StyleDocument;
  /** Sources this version did not recognise, dropped along with the layers that
   *  drew from them. Reported so the drop is logged rather than silent. */
  dropped: string[];
}

/**
 * Point every URL in an upstream style at this server.
 *
 * The vector source arrives as a pointer to a TileJSON; it leaves INLINED — the
 * tile URL, zoom range and bounds written into the source itself — so MapLibre
 * never fetches a TileJSON at all, and there is no document whose own URLs would
 * need the browser's origin. Its attribution is ours (OPENFREEMAP_ATTRIBUTION),
 * never the upstream TileJSON's: MapLibre writes a source's attribution into the
 * page as HTML, and that is not a string to take from somewhere else.
 *
 * The rule is that nothing leaves this function naming a host we did not
 * choose. Sources it recognises are rewritten; one it does not is DROPPED with
 * the layers that use it, so a decorative layer OpenFreeMap adds next month
 * costs that layer rather than the whole map. The glyphs and the sprite have no
 * such fallback — without them no label or icon draws — so an unrecognised one
 * is an error instead.
 */
export function rewriteStyle(input: StyleDocument, urls: ProxyUrls, tilejson: unknown): RewrittenStyle {
  if (!vectorTemplateOf(tilejson)) {
    throw new Error("The map's tile set is not in a shape this version understands.");
  }
  const tileset = tilejson as { minzoom?: unknown; maxzoom?: unknown; bounds?: unknown };
  const bounds = Array.isArray(tileset.bounds) && tileset.bounds.length === 4 && tileset.bounds.every((n) => typeof n === "number")
    ? (tileset.bounds as number[])
    : undefined;
  const base = escapeRegExp(upstreamBase());
  const style: StyleDocument = structuredClone(input);
  const dropped: string[] = [];

  const sources: Record<string, StyleSource> = {};
  for (const [name, source] of Object.entries(style.sources ?? {})) {
    if (source.type === "vector" && source.url === `${upstreamBase()}/planet`) {
      const inlined: StyleSource = { ...source };
      delete inlined.url;
      sources[name] = {
        ...inlined,
        tiles: [urls.vector],
        minzoom: zoomOf(tileset.minzoom, 0),
        maxzoom: zoomOf(tileset.maxzoom, VECTOR_MAX_ZOOM),
        ...(bounds ? { bounds } : {}),
        attribution: OPENFREEMAP_ATTRIBUTION
      };
      continue;
    }
    const tile = Array.isArray(source.tiles) && source.tiles.length === 1 ? source.tiles[0] : null;
    if (
      source.type === "raster" &&
      tile !== null &&
      new RegExp(`^${base}/natural_earth/ne2sr/\\{z\\}/\\{x\\}/\\{y\\}\\.png$`).test(tile)
    ) {
      sources[name] = { ...source, tiles: [urls.raster] };
      continue;
    }
    dropped.push(name);
  }
  style.sources = sources;
  if (dropped.length > 0) {
    style.layers = (style.layers ?? []).filter((layer) => !layer.source || !dropped.includes(layer.source));
  }

  if (typeof style.glyphs !== "string" || style.glyphs !== `${upstreamBase()}/fonts/{fontstack}/{range}.pbf`) {
    throw new Error("The map's label fonts are not in a shape this version understands.");
  }
  style.glyphs = urls.glyphs;

  const sprite = typeof style.sprite === "string"
    ? new RegExp(`^${base}/sprites/([A-Za-z0-9_]{1,40})/ofm$`).exec(style.sprite)
    : null;
  if (!sprite) {
    throw new Error("The map's icons are not in a shape this version understands.");
  }
  style.sprite = urls.sprite(sprite[1]);

  return { style, dropped };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
