import { api } from "../../api";
import type { PlaceOption, PlacePin } from "../../shared/PlaceField";

// Suggestions for every place field in the family tree — birth, death, marriage,
// life events. The tree's own places come first, spelled as they were written
// before (with their pin when one was picked), then towns from the server's
// offline places database. One loader, so every field offers the same list.

interface FamilyPlacesPayload {
  known: { label: string; pin: PlacePin | null }[];
  towns: { label: string; lat: number; lng: number }[];
}

export async function loadFamilyPlaces(query: string): Promise<PlaceOption[]> {
  const payload = await api<FamilyPlacesPayload>(
    `/api/family-tree/places${query ? `?q=${encodeURIComponent(query)}` : ""}`
  );
  const seen = new Set<string>();
  const options: PlaceOption[] = [];
  for (const place of payload.known) {
    seen.add(place.label.toLocaleLowerCase());
    options.push({ label: place.label, pin: place.pin, kind: "known" });
  }
  for (const town of payload.towns) {
    if (seen.has(town.label.toLocaleLowerCase())) continue;
    options.push({ label: town.label, pin: { lat: town.lat, lng: town.lng }, kind: "town" });
  }
  return options;
}
