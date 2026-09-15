import { useEffect } from "react";
import type { TFunction } from "i18next";
import { api } from "../../../../api";
import { formatBytes } from "../../../../shared/utils";
import type { GeoipStatus } from "../../types";

// What the Maps page reads: GET /api/map/settings, one answer for the whole page —
// the kept maps, the place names and the sign-in location databases side by side.
// Road routes are their own endpoint (/api/config/routing), read beside it.

/** The limits offered for kept maps, in MB — the server's CACHE_LIMITS_MB. */
export const CACHE_LIMITS_MB = [100, 200, 500, 1000, 2000] as const;
export type CacheLimitMb = (typeof CACHE_LIMITS_MB)[number];

export interface MapSettingsDto {
  settings: { cache: boolean; cacheLimitMb: CacheLimitMb };
  cache: {
    /** The Map data room: what the Storage page moves. */
    folder: string;
    /** The tile cache inside it: what turning offline maps off deletes. */
    path: string;
    bytes: number;
    limitBytes: number;
  };
  /** How the map service has answered this run of the server. */
  service?: MapServiceHealth;
  locations: GeoipStatus;
  places: PlacesView;
  /** Kept maps and place names live in App storage's Map data (docs/system-data-plan.md,
   *  decision 11): their switches wait while it is off. */
  appStorage?: { enabled: boolean };
}

/** The map service as the server has found it — nothing before it first needed
 *  a piece of map that was not already kept (`reachable: null`). */
export interface MapServiceHealth {
  reachable: boolean | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
  /** Set while the server is leaving a failing service alone. */
  pausedUntil: string | null;
}

export type PlacesBuildStage = "download" | "places" | "names" | "write";

/** The place names database (docs/map-approach-proposal.md, phase 2). */
export interface PlacesView {
  present: boolean;
  sizeBytes: number;
  builtAt: string | null;
  /** When GeoNames last changed the data it was built from. */
  sourceDate: string | null;
  places: number;
  /** Search-only villages, and the countries the current database has them for. */
  villages?: number;
  villageCountries?: string[];
  /** The countries asked for — differs from villageCountries until the next build. */
  villageCountriesWanted?: string[];
  /** Every country the database has places in: what "every village in" offers. */
  countries?: string[];
  build: {
    running: boolean;
    jobId: string | null;
    stage: PlacesBuildStage | null;
    done: number;
    total: number;
    /** The last build's failure, while the last build is a failed one. */
    error: string | null;
    finishedAt: string | null;
  };
}

export interface RoutingDto {
  routing: { endpoint: string; hasApiKey: boolean };
  configured: boolean;
}

export function loadMapSettings(): Promise<MapSettingsDto> {
  return api<MapSettingsDto>("/api/map/settings");
}

/** Save the "every village in" countries; the server rebuilds the database when
 *  there is one. */
export function saveVillageCountries(countries: string[]): Promise<{ places: PlacesView }> {
  return api<{ places: PlacesView }>("/api/map/places/villages", { method: "PUT", body: JSON.stringify({ countries }) });
}

/** A country's name in the reader's language, from its two-letter code. */
export function countryLabel(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Queue a build of the place names database (a task; it runs for minutes). */
export function startPlacesBuild(): Promise<{ places: PlacesView }> {
  return api<{ places: PlacesView }>("/api/map/places", { method: "POST" });
}

/** The country tier the app can fetch for itself, when it is present. */
export function countryDatabase(locations: GeoipStatus) {
  return locations.databases.find((entry) => entry.tier === "country") ?? null;
}

/** The first city-level database the owner supplied, when there is one. */
export function cityDatabase(locations: GeoipStatus) {
  return locations.databases.find((entry) => entry.tier === "city") ?? null;
}

/** "200 MB", "1 GB": a limit as the owner chose it, not as bytes happen to divide. */
export function limitLabel(mb: number): string {
  return mb >= 1000 ? `${mb / 1000} GB` : `${mb} MB`;
}

/** Where a running build has got to, as a phrase for "Building · …". */
export function placesProgressText(t: TFunction<["common", "controlAdmin"]>, build: PlacesView["build"]): string {
  switch (build.stage) {
    case "download": return t("controlAdmin:mapFeatures.placesStageDownload", { size: formatBytes(build.done) });
    case "places": return t("controlAdmin:mapFeatures.placesStagePlaces", { number: build.done.toLocaleString() });
    case "names": return t("controlAdmin:mapFeatures.placesStageNames");
    case "write": return t("controlAdmin:mapFeatures.placesStageWrite");
    default: return t("controlAdmin:mapFeatures.placesStageQueued");
  }
}

/** Keep asking while a places build runs, so the page follows it to the end. */
export function useFollowPlacesBuild(status: MapSettingsDto | null, reload: () => Promise<void>) {
  const running = Boolean(status?.places.build.running);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void reload(), 3000);
    return () => window.clearInterval(timer);
  }, [running, reload]);
}
