import type { PlaceLabel } from "./types";

// A named place as one line: "Verona, Veneto, Italy". The region is already left
// out by the server when it only repeats the place.
export function formatPlaceLabel(label: Pick<PlaceLabel, "place" | "region" | "country">): string {
  return [label.place, label.region, label.country].filter(Boolean).join(", ");
}

/** Where the names come from. GeoNames asks for credit wherever they are shown
 *  (CC BY 4.0). */
export const PLACE_NAMES_CREDIT_URL = "https://www.geonames.org/";
