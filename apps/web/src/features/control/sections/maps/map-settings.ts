import { useEffect } from "react";
import type { TFunction } from "i18next";
import { api } from "../../../../api";
import { formatBytes } from "../../../../shared/utils";
import type { GeoipStatus } from "../../types";

// What the Maps pages read: GET /api/map/settings, one answer for the whole
// group — the tile cache, the sign-in location databases and the named places
// side by side, since Setup shows them all as levels of the same thing.

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
  places: PlacesView;
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

export function loadMapSettings(): Promise<MapSettingsDto> {
  return api<MapSettingsDto>("/api/map/settings");
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

/** Where a running build has got to, as a phrase for "Building · …". */
export function placesProgressText(t: TFunction<["common", "controlAdmin"]>, build: PlacesView["build"]): string {
  switch (build.stage) {
    case "download": return t("controlAdmin:mapSetup.placesStageDownload", { size: formatBytes(build.done) });
    case "places": return t("controlAdmin:mapSetup.placesStagePlaces", { number: build.done.toLocaleString() });
    case "names": return t("controlAdmin:mapSetup.placesStageNames");
    case "write": return t("controlAdmin:mapSetup.placesStageWrite");
    default: return t("controlAdmin:mapSetup.placesStageQueued");
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
