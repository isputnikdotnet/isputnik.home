// Which map levels this house has turned on (docs/map-approach-proposal.md,
// "Optional, and off by default").
//
// Nothing is on until an admin turns it on, because not every house has disk to
// spare. Off is not "no maps" — it is the map as it has always been drawn,
// straight from the provider, with nothing kept here.
//
// One JSON blob in app_settings, like the other house-wide settings. Only the
// tile cache exists so far; the place names and sign-in levels join this shape
// when they are built, rather than appearing as settings that do nothing.
import { db } from "../../db.js";
import type { AppSettingRow } from "../../db/rows.js";

export const MAP_SETTINGS_KEY = "maps";

export interface MapSettings {
  /** Maps come through this server and are kept on its disk. */
  cache: boolean;
}

const DEFAULTS: MapSettings = { cache: false };

export function getMapSettings(): MapSettings {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(MAP_SETTINGS_KEY) as
    | Pick<AppSettingRow, "value">
    | undefined;
  if (!row) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(row.value) as Partial<MapSettings>;
    return { cache: parsed.cache === true };
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
