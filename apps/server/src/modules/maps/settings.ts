// Which map levels this house has turned on (docs/map-approach-proposal.md,
// "Optional, and off by default").
//
// Nothing is on until an admin turns it on, because not every house has disk to
// spare. Off is not "no maps" — it is the map as it has always been drawn,
// straight from the provider, with nothing kept here.
//
// One JSON blob in app_settings, like the other house-wide settings: whether maps
// are kept, and how much of them. The place names and sign-in databases are not
// settings — whether they are on is whether their file is there.
import { db } from "../../db.js";
import type { AppSettingRow } from "../../db/rows.js";

export const MAP_SETTINGS_KEY = "maps";

/** The limits the Maps page offers for kept maps, in MB. A choice from a short
 *  list rather than a number field: the useful answers are orders of magnitude,
 *  and a typo of 20000 should not be one keystroke away. */
export const CACHE_LIMITS_MB = [100, 200, 500, 1000, 2000] as const;
export type CacheLimitMb = (typeof CACHE_LIMITS_MB)[number];

export interface MapSettings {
  /** Maps come through this server and are kept on its disk. */
  cache: boolean;
  /** How much of them may be kept before the oldest go (sweep.ts). */
  cacheLimitMb: CacheLimitMb;
}

const DEFAULTS: MapSettings = { cache: false, cacheLimitMb: 200 };

export function isCacheLimit(value: unknown): value is CacheLimitMb {
  return (CACHE_LIMITS_MB as readonly unknown[]).includes(value);
}

export function getMapSettings(): MapSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(MAP_SETTINGS_KEY) as
    | Pick<AppSettingRow, "value">
    | undefined;
  if (!row) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(row.value) as Partial<MapSettings>;
    return {
      cache: parsed.cache === true,
      cacheLimitMb: isCacheLimit(parsed.cacheLimitMb) ? parsed.cacheLimitMb : DEFAULTS.cacheLimitMb
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveMapSettings(settings: MapSettings, userId: string | null): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by = excluded.updated_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(MAP_SETTINGS_KEY, JSON.stringify(settings), userId);
}
