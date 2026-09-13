// Sign-in places in the reader's language (docs/map-approach-proposal.md, phase 2,
// "Bonus"). The location database names towns in English only, and not always
// well — DB-IP calls central Moscow "Moscow (Tsentralnyy administrativnyy okrug)".
// When the place names database is there, a town is named from its coordinates
// the same way a photo is, so both maps speak one vocabulary: «Москва» to a Russian
// reader, "Moscow" to an English one. Without it, the English names stay.
//
// Only the words change. The English city and region stay on every row as the
// keys the Sign-in details page filters by.
import { geoNamesNamer, namesLanguageFor, type PlaceLabel } from "../maps/places/namer.js";

/** How far the place names database's answer may lie from the location
 *  database's point and still be taken as the same town. IP locations are coarse;
 *  beyond this they are probably not talking about the same place. */
const SAME_TOWN_KM = 25;

export interface TownLabel {
  place: string;
  region: string | null;
}

export interface SignInPlaceNames {
  language: string;
  country(code: string, fallback: string | null): string;
  /** `city` is the location database's own name for the town: a place near the
   *  point going by that name is used, or none — the English name then stays.
   *  Only a town with no name is named from the point alone. "Copenhagen (Valby)"
   *  stays Copenhagen rather than becoming the suburb whose centre is nearer. */
  town(latitude: number | null, longitude: number | null, city?: string | null): TownLabel | null;
}

export function signInPlaceNames(chosenLanguage: string | null | undefined, acceptLanguage: string | undefined): SignInPlaceNames {
  const language = namesLanguageFor(chosenLanguage, acceptLanguage);
  const namer = geoNamesNamer();
  let countries: Intl.DisplayNames | null = null;
  try {
    countries = new Intl.DisplayNames([language], { type: "region" });
  } catch {
    countries = null;
  }
  const towns = new Map<string, TownLabel | null>();

  return {
    language,
    country(code, fallback) {
      try {
        return countries?.of(code.toUpperCase()) ?? fallback ?? code;
      } catch {
        return fallback ?? code;
      }
    },
    town(latitude, longitude, city) {
      if (!namer || latitude === null || longitude === null) return null;
      const key = `${latitude},${longitude},${city ?? ""}`;
      if (towns.has(key)) return towns.get(key)!;
      // With a name to go by, only a place of that name will do: naming the nearest
      // town instead swapped Copenhagen for a suburb. Without one, the point decides.
      const hit = city ? namer.namedNear(latitude, longitude, city, SAME_TOWN_KM) : namer.nearest(latitude, longitude);
      const label: PlaceLabel | null = hit && hit.distanceKm <= SAME_TOWN_KM ? namer.describe(hit.id, language) : null;
      const town = label ? { place: label.place, region: label.region } : null;
      towns.set(key, town);
      return town;
    }
  };
}
