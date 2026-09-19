import { api } from "../../api";
import type { PlaceLoadResult, PlaceOption, PlacePin } from "../../shared/PlaceField";

// Suggestions for every place field in the family tree — birth, death, marriage,
// life events. Only real places: the tree's own places that were picked from
// the places database before (spelled as they were, with their pin), then towns
// from that database. Words typed by hand are not suggested back. One loader,
// so every field offers the same list.

interface FamilyPlacesPayload {
  available: boolean;
  known: { label: string; pin: PlacePin | null }[];
  towns: { label: string; lat: number; lng: number }[];
}

export async function loadFamilyPlaces(query: string): Promise<PlaceLoadResult> {
  const payload = await api<FamilyPlacesPayload>(
    `/api/family-tree/places${query ? `?q=${encodeURIComponent(query)}` : ""}`
  );
  const seen = new Set<string>();
  const options: PlaceLoadResult["options"] = [];
  for (const place of payload.known) {
    if (!place.pin) continue;
    seen.add(place.label.toLocaleLowerCase());
    options.push({ label: place.label, pin: place.pin, kind: "known" });
  }
  for (const town of payload.towns) {
    if (seen.has(town.label.toLocaleLowerCase())) continue;
    options.push({ label: town.label, pin: { lat: town.lat, lng: town.lng }, kind: "town" });
  }
  return { options, available: payload.available };
}

// The online lookup behind the field's button — OpenStreetMap, through the
// server, one request per press. For the places the offline database will never
// hold: a village too small for it, a parish, a hospital, a street. The
// geocoder's full address is what the list shows, so she can see which
// Veselovka it found; its own short form is what goes in the field.
export async function searchFamilyPlacesOnline(query: string): Promise<PlaceOption[]> {
  const payload = await api<{ results: { label: string; short: string; lat: number; lng: number }[] }>(
    `/api/family-tree/places/online?q=${encodeURIComponent(query)}`
  );
  return (payload.results ?? []).map((hit) => ({
    label: hit.label,
    insert: hit.short || hit.label,
    pin: { lat: hit.lat, lng: hit.lng },
    kind: "online" as const
  }));
}
