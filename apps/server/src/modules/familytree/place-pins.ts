// A place in the tree is words, and — when the words were picked from the places
// search — a pin. Births, deaths, marriages and life events all keep the same
// rule, so it lives here once:
//
// - a pin sent with its place is stored; one sent with an empty place is dropped
// - a place cleared loses its pin
// - a place changed WITHOUT a pin loses the old pin, which named the old words;
//   the same words saved again keep it
import { z } from "zod";

export interface PlacePin {
  lat: number;
  lng: number;
}

export const pinSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180)
}).nullable().optional();

export function pin(lat: number | null, lng: number | null): PlacePin | null {
  return lat != null && lng != null ? { lat, lng } : null;
}

/** The pin to INSERT beside a place: none for an empty place. */
export function pinForPlace(place: string | null | undefined, sent: PlacePin | null | undefined): PlacePin | null {
  return place?.trim() ? sent ?? null : null;
}

/** SET clauses (and their parameters, in order) for a patch to a place and its
 *  pin. `text`/`sent` undefined = not part of the patch. SQLite evaluates every
 *  SET expression against the row as it was, so `${textColumn} IS ?` compares the
 *  old words to the new ones. */
export function placeUpdate(
  columns: { text: string; lat: string; lng: string },
  text: string | null | undefined,
  sent: PlacePin | null | undefined
): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (text === undefined && sent === undefined) return { sets, params };
  const place = text === undefined ? undefined : text?.trim() || null;
  if (place !== undefined) {
    sets.push(`${columns.text} = ?`);
    params.push(place);
  }
  if (sent !== undefined || place === null) {
    const kept = place === null ? null : sent ?? null;
    sets.push(`${columns.lat} = ?`, `${columns.lng} = ?`);
    params.push(kept?.lat ?? null, kept?.lng ?? null);
  } else if (place !== undefined) {
    sets.push(
      `${columns.lat} = CASE WHEN ${columns.text} IS ? THEN ${columns.lat} END`,
      `${columns.lng} = CASE WHEN ${columns.text} IS ? THEN ${columns.lng} END`
    );
    params.push(place, place);
  }
  return { sets, params };
}
