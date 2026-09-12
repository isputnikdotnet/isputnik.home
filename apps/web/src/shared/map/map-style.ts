// Getting from "draw a map" to a style MapLibre can use.
//
// The server says where maps come from (GET /api/map/config): straight from the
// provider while map caching is off, through this server once it is on. Either
// way the style is fetched HERE rather than handed to MapLibre as a URL, because
// two things have to happen to it first:
//
//  1. Absolute URLs. A proxied style is root-relative on purpose — the server
//     cannot know the origin this page was opened on (a proxy rewriting Host once
//     sent maps to 127.0.0.1:4000) — and MapLibre loads tiles in a worker, where
//     a relative URL resolves to nothing. This page knows its own origin.
//  2. Labels in the reader's language. The vector tiles carry name:ru and
//     name:en; the provider's style shows Latin-with-native. Rewritten here, so a
//     Russian interface reads Минск and an English one Minsk.
//
// Pure helpers are exported for tests; the fetching is cached per page life,
// and forgetMapConfig() drops it when an admin changes where maps come from.
import i18n from "../../i18n";

export type MapStyleName = "liberty" | "positron" | "bright" | "dark";

export interface MapConfig {
  mode: "direct" | "proxied";
  styles: Record<MapStyleName, string>;
  attribution: string;
}

// Loosely typed on purpose: this only walks the parts of a style it rewrites,
// and MapLibre validates the whole thing when it receives it.
type StyleJson = {
  sources?: Record<string, { url?: string; tiles?: string[]; [key: string]: unknown }>;
  layers?: { type?: string; layout?: Record<string, unknown>; [key: string]: unknown }[];
  glyphs?: string;
  sprite?: string | { id: string; url: string }[];
  [key: string]: unknown;
};

const configs = new Map<string, Promise<MapConfig>>();
const styles = new Map<string, Promise<StyleJson>>();

/** Forget what the server said. Called after map settings change, so the next
 *  map opened follows the new answer instead of this page's first one. */
export function forgetMapConfig(): void {
  configs.clear();
  styles.clear();
}

export function loadMapConfig(share?: string): Promise<MapConfig> {
  const key = share ?? "";
  let pending = configs.get(key);
  if (!pending) {
    const query = share ? `?share=${encodeURIComponent(share)}` : "";
    pending = fetch(`/api/map/config${query}`, { credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error(`Map configuration unavailable (${response.status}).`);
      return (await response.json()) as MapConfig;
    });
    // A failure is not remembered: the next map tries again.
    pending.catch(() => configs.delete(key));
    configs.set(key, pending);
  }
  return pending;
}

/** Whether the page is on a dark theme right now, judged by what is actually
 *  painted rather than by theme names, so a theme added later needs nothing here. */
export function isDarkTheme(): boolean {
  const painted = getComputedStyle(document.body).backgroundColor;
  const rgb = painted.match(/\d+(\.\d+)?/g)?.map(Number);
  if (rgb && rgb.length >= 3 && (rgb.length < 4 || rgb[3] > 0)) {
    const [r, g, b] = rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  }
  return (document.documentElement.dataset.theme ?? "").includes("dark");
}

export function styleNameFor(dark: boolean): MapStyleName {
  return dark ? "dark" : "liberty";
}

/** Prefix this page's origin onto every root-relative URL MapLibre will fetch. */
export function absolutizeStyle(style: StyleJson, origin: string): StyleJson {
  const abs = (url: string) => (url.startsWith("/") ? `${origin}${url}` : url);
  for (const source of Object.values(style.sources ?? {})) {
    if (typeof source.url === "string") source.url = abs(source.url);
    if (Array.isArray(source.tiles)) source.tiles = source.tiles.map(abs);
  }
  if (typeof style.glyphs === "string") style.glyphs = abs(style.glyphs);
  if (typeof style.sprite === "string") style.sprite = abs(style.sprite);
  else if (Array.isArray(style.sprite)) style.sprite = style.sprite.map((entry) => ({ ...entry, url: abs(entry.url) }));
  return style;
}

/** A label that shows a place's NAME (as opposed to a road number or a house
 *  number), in whichever form the provider wrote it. */
function showsName(field: unknown): boolean {
  const text = typeof field === "string" ? field : JSON.stringify(field ?? "");
  return /\{name[:_}]|\["get","name(?:[:_][A-Za-z-]+)?"\]/.test(text);
}

/** Show place names in `language`, falling back to the local name — which is
 *  what a place with no translation should read as, not a blank. */
export function localizeLabels(style: StyleJson, language: string): StyleJson {
  const lang = language.toLowerCase().startsWith("ru") ? "ru" : "en";
  const field = lang === "ru"
    ? ["coalesce", ["get", "name:ru"], ["get", "name"]]
    : ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];
  for (const layer of style.layers ?? []) {
    if (layer.type !== "symbol" || !layer.layout || !showsName(layer.layout["text-field"])) continue;
    layer.layout["text-field"] = field;
  }
  return style;
}

/** The style to draw with, ready for MapLibre: fetched, made absolute, labels
 *  in the interface language. Cached per style URL and language. */
export function loadMapStyle(config: MapConfig, dark: boolean): Promise<StyleJson> {
  const url = config.styles[styleNameFor(dark)];
  const language = i18n.language || "en";
  const key = `${url}|${language}`;
  let pending = styles.get(key);
  if (!pending) {
    // Our own server gets the session cookie; the provider gets nothing.
    const credentials: RequestCredentials = url.startsWith("/") ? "same-origin" : "omit";
    pending = fetch(url, { credentials }).then(async (response) => {
      if (!response.ok) throw new Error(`Map style unavailable (${response.status}).`);
      const style = (await response.json()) as StyleJson;
      return localizeLabels(absolutizeStyle(style, window.location.origin), language);
    });
    pending.catch(() => styles.delete(key));
    styles.set(key, pending);
  }
  // A copy: MapLibre may keep and mutate what it is given, and the cache must
  // stay the prepared original.
  return pending.then((style) => structuredClone(style));
}
