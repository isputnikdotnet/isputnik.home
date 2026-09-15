// Place lookup for the gallery's location picker — type "Vilnius" or a postcode
// instead of hunting for a spot on a world map.
//
// Proxied through the server rather than called from the browser so that
// connect-src stays 'self' (the CSP only opens up for OSM *tiles*, which are
// <img>), and so the outbound request carries our User-Agent, which Nominatim's
// usage policy requires. Fixed host, GET only, query in a URLSearchParams — the
// URL is never assembled from caller input.
import { REMOTE_FETCH_USER_AGENT } from "../shared/remote-image.js";
import { decodePlusCode, parsePlusCode, recoverPlusCode } from "./pluscode.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 6;

export interface GeocodeHit {
  /** The geocoder's full address, for the hit list and the pin. */
  label: string;
  /** The same place in three parts at most — what goes in a text field. */
  short: string;
  lat: number;
  lng: number;
}

// A number sign written apart from its number ("Средняя школа № 4", "school # 4")
// loses the geocoder: it reads the sign as a word of its own, the rest of the
// query stops carrying weight, and a bare "4" matches house numbers the world
// over — which is how "Средняя школа № 4, Минск, Беларусь" came back as a school
// in Zhodino. Glued to its number the same query finds the Minsk school first.
function tidyQuery(text: string): string {
  return text.replace(/([#№])\s+(?=\d)/g, "$1").trim();
}

/** The parts of an address worth keeping: the place itself, the town it is in,
 *  and the country. "Сярэдняя школа №4, вуліца Кірава, Пасёлак Велазавода,
 *  Ленінскі раён, Мінск, 220009, Беларусь" is a mouthful for a text field, and
 *  trimming it to its ends alone would drop the one part she typed — Minsk. */
function shortLabel(row: NominatimRow): string {
  const address = row.address ?? {};
  const parts = row.display_name?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  const name = row.name?.trim() || parts[0] || "";
  const town = address.village || address.town || address.city || address.municipality || "";
  const country = address.country || (parts.length > 1 ? parts[parts.length - 1] : "");
  const kept: string[] = [];
  for (const part of [name, town, country]) {
    if (part && !kept.includes(part)) kept.push(part);
  }
  return kept.length > 0 ? kept.join(", ") : (row.display_name ?? "");
}

// Nominatim asks for no more than one request a second and rewards caching.
// Households search the same handful of places over and over, so an in-process
// LRU-ish cache keeps repeat lookups off their servers entirely.
const CACHE_LIMIT = 200;
const cache = new Map<string, GeocodeHit[]>();

function remember(key: string, hits: GeocodeHit[]) {
  cache.delete(key);
  cache.set(key, hits);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

interface NominatimRow {
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  address?: {
    village?: string;
    town?: string;
    city?: string;
    municipality?: string;
    country?: string;
  };
}

// A Plus Code copied out of Google Maps ("8MW8+4JV, Norman Manley Blvd, Negril,
// Jamaica"). Nominatim returns nothing at all for one, so the code is resolved
// here instead — by arithmetic for a full code, and against the address written
// beside it for a short one, which is the form Google actually hands out.
async function resolvePlusCode(query: string): Promise<GeocodeHit[]> {
  const parsed = parsePlusCode(query);
  if (!parsed) return [];

  if (parsed.full) {
    const point = decodePlusCode(parsed.code);
    if (!point) return [];
    const label = parsed.rest ? `${parsed.code}, ${parsed.rest}` : parsed.code;
    return [{ label, short: label, ...point }];
  }

  if (!parsed.rest) {
    throw new Error(
      `A short Plus Code needs the town or country after it, the way Google writes it — try “${parsed.code}, Negril, Jamaica”.`
    );
  }

  // The rest of the address anchors the code. Straight back through searchPlaces
  // so the anchor lookup is cached and rate-managed like any other search.
  const anchors = await searchPlaces(parsed.rest);
  if (anchors.length === 0) return [];
  const point = recoverPlusCode(parsed.code, anchors[0]);
  if (!point) return [];
  return [{ label: `${parsed.code}, ${anchors[0].label}`, short: `${parsed.code}, ${anchors[0].short}`, ...point }];
}

export async function searchPlaces(query: string): Promise<GeocodeHit[]> {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  const cached = cache.get(key);
  if (cached) {
    remember(key, cached); // refresh recency
    return cached;
  }

  const plusCode = await resolvePlusCode(query);
  if (plusCode.length > 0) {
    remember(key, plusCode);
    return plusCode;
  }

  const params = new URLSearchParams({
    q: tidyQuery(query),
    format: "jsonv2",
    // On, so a hit can be shortened to "school, town, country" rather than to its
    // two ends — which is the difference between naming Minsk and losing it.
    addressdetails: "1",
    limit: String(MAX_RESULTS)
  });

  let response: Response;
  try {
    response = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { Accept: "application/json", "User-Agent": REMOTE_FETCH_USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new Error("The place lookup isn’t responding. Check the server’s internet access, or drop the pin on the map instead.");
  }
  if (response.status === 429) {
    throw new Error("The place lookup is rate-limiting us. Wait a moment and try again.");
  }
  if (!response.ok) {
    throw new Error("The place lookup failed. Drop the pin on the map instead.");
  }

  const rows = (await response.json()) as NominatimRow[];
  const hits: GeocodeHit[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    if (!row.display_name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    hits.push({ label: row.display_name, short: shortLabel(row), lat, lng });
    if (hits.length >= MAX_RESULTS) break;
  }

  remember(key, hits);
  return hits;
}
