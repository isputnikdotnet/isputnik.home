// Place lookup for the gallery's location picker — type "Vilnius" or a postcode
// instead of hunting for a spot on a world map.
//
// Proxied through the server rather than called from the browser so that
// connect-src stays 'self' (the CSP only opens up for OSM *tiles*, which are
// <img>), and so the outbound request carries our User-Agent, which Nominatim's
// usage policy requires. Fixed host, GET only, query in a URLSearchParams — the
// URL is never assembled from caller input.
import { REMOTE_FETCH_USER_AGENT } from "../shared/remote-image.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESULTS = 6;

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
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
  display_name?: string;
}

export async function searchPlaces(query: string): Promise<GeocodeHit[]> {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  const cached = cache.get(key);
  if (cached) {
    remember(key, cached); // refresh recency
    return cached;
  }

  const params = new URLSearchParams({
    q: query.trim(),
    format: "jsonv2",
    addressdetails: "0",
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
    hits.push({ label: row.display_name, lat, lng });
    if (hits.length >= MAX_RESULTS) break;
  }

  remember(key, hits);
  return hits;
}
