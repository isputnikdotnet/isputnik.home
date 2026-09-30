import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { formatPlaceLabel } from "./place-label";
import type { PlaceLabel } from "./types";

// Saved places (server: modules/library/gallery/saved-places.ts): the household's
// one list of named points — home, the dacha — plus this person's own recent
// pins, offered wherever a photo is put on the map so an address is typed once.

export interface SavedPlace {
  id: string;
  /** '' only for the place copied from the Home location and never renamed:
   *  read it through savedPlaceName(). */
  name: string;
  lat: number;
  lng: number;
  home: boolean;
  useCount: number;
}

export interface RecentPlace {
  lat: number;
  lng: number;
  label: string | null;
  place: PlaceLabel | null;
}

interface SavedPlacesPayload {
  canSave?: boolean;
  places?: SavedPlace[];
  recent?: RecentPlace[];
}

export interface Point { lat: number; lng: number }

/** A pin this close to a saved place is that place — the server's SAME_PLACE_KM. */
export const SAME_PLACE_KM = 0.05;

export const SAVED_PLACE_NAME_MAX = 60;

export function distanceKm(a: Point, b: Point): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The saved place a pin stands on, if any. */
export function savedPlaceAt(places: SavedPlace[], pin: Point | null): SavedPlace | null {
  if (!pin) return null;
  return places.find((place) => distanceKm(place, pin) <= SAME_PLACE_KM) ?? null;
}

/** `homeName` is "Home" in the reader's language (gallery:savedPlaces.home). */
export function savedPlaceName(place: Pick<SavedPlace, "name">, homeName: string): string {
  return place.name || homeName;
}

/** "Ratomka, Minsk District, Minsk Region, Belarus" on a chip is "Ratomka,
 *  Belarus"; the full line stays in its tooltip. */
function shortLabel(label: string): string {
  const parts = label.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 2 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts.join(", ");
}

/** What a recent place is called: the search's words, else the town it is in,
 *  else its coordinates. `full` is the unshortened line. */
export function recentPlaceName(place: RecentPlace): { short: string; full: string } {
  if (place.label) return { short: shortLabel(place.label), full: place.label };
  if (place.place) {
    return { short: [place.place.place, place.place.country].filter(Boolean).join(", "), full: formatPlaceLabel(place.place) };
  }
  const coords = `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`;
  return { short: coords, full: coords };
}

/** Saved places whose name holds what is typed, for the search's own list. */
export function matchSavedPlaces(places: SavedPlace[], query: string, homeName: string): SavedPlace[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < 2) return [];
  return places.filter((place) => savedPlaceName(place, homeName).toLocaleLowerCase().includes(needle));
}

export interface SavedPlacesState {
  /** False for someone who cannot edit photos: nothing is offered. */
  canSave: boolean;
  places: SavedPlace[];
  recent: RecentPlace[];
  reload: () => void;
}

/** The list, read when the editor opens. A failed read offers nothing — places
 *  are a shortcut, and the search and the map work without them. */
export function useSavedPlaces(enabled = true): SavedPlacesState {
  const [state, setState] = useState<Omit<SavedPlacesState, "reload">>({ canSave: false, places: [], recent: [] });
  const request = useRef(0);

  const reload = useCallback(() => {
    const id = ++request.current;
    api<SavedPlacesPayload>("/api/library/gallery/saved-places")
      .then((payload) => {
        if (request.current !== id) return;
        setState({ canSave: Boolean(payload.canSave), places: payload.places ?? [], recent: payload.recent ?? [] });
      })
      .catch(() => { /* nothing offered */ });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    reload();
    return () => { request.current += 1; };
  }, [enabled, reload]);

  return { ...state, reload };
}
