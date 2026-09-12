import { api } from "../../../../api";
import type { GeoipStatus } from "../../types";

// What the Maps pages read: GET /api/map/settings, one answer for the whole
// group — the tile cache and the sign-in location databases side by side, since
// Setup shows both as levels of the same thing.

export interface MapSettingsDto {
  settings: { cache: boolean };
  cache: {
    /** The Map data room: what the Storage page moves. */
    folder: string;
    /** The tile cache inside it: what turning caching off deletes. */
    path: string;
    bytes: number;
  };
  locations: GeoipStatus;
}

export function loadMapSettings(): Promise<MapSettingsDto> {
  return api<MapSettingsDto>("/api/map/settings");
}

/** The country tier the app can fetch for itself, when it is present. */
export function countryDatabase(locations: GeoipStatus) {
  return locations.databases.find((entry) => entry.tier === "country") ?? null;
}

/** The first city-level database the owner supplied, when there is one. */
export function cityDatabase(locations: GeoipStatus) {
  return locations.databases.find((entry) => entry.tier === "city") ?? null;
}
