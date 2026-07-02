import { FacetFilterButton, FacetFilterChips, countActiveFilters, type FacetDef } from "../../shared/FacetFilter";
import type { GalleryFacets } from "./types";

// Gallery advanced filters — the same filter surface the audiobook catalog uses,
// with photo/video-relevant facets: named people (face recognition), years (from
// the EXIF date), tags, cameras, and a fixed with/without-location toggle. The
// media-type (photo/video) filter stays in the header dropdown, not here.
export interface GalleryFilters {
  people: string[];
  years: string[];
  taken: string[];    // date-taken bounds: "from:YYYY-MM-DD" / "to:YYYY-MM-DD"
  tags: string[];
  cameras: string[];
  sizes: string[];    // codes: small | medium | large | huge (server-defined byte buckets)
  location: string[]; // codes: with_gps | no_gps
}

export const EMPTY_GALLERY_FILTERS: GalleryFilters = {
  people: [], years: [], taken: [], tags: [], cameras: [], sizes: [], location: []
};

const SIZE_OPTIONS = [
  { value: "small", label: "Under 1 MB" },
  { value: "medium", label: "1–5 MB" },
  { value: "large", label: "5–25 MB" },
  { value: "huge", label: "25 MB+" }
];

const LOCATION_OPTIONS = [
  { value: "with_gps", label: "Has location" },
  { value: "no_gps", label: "No location" }
];

const FACET_ORDER: FacetDef<keyof GalleryFilters>[] = [
  { key: "people", title: "People", searchable: true },
  // A family archive can span many decades (scanned prints reach the 1940s), so
  // the year list gets the type-ahead too.
  { key: "years", title: "Years", searchable: true },
  { key: "taken", title: "Date taken", searchable: false, type: "daterange" },
  { key: "tags", title: "Tags", searchable: true },
  { key: "cameras", title: "Cameras", searchable: true },
  { key: "sizes", title: "File size", searchable: false, fixed: SIZE_OPTIONS },
  { key: "location", title: "Location", searchable: false, fixed: LOCATION_OPTIONS }
];

const CODE_LABELS: Record<string, string> = Object.fromEntries(
  [...SIZE_OPTIONS, ...LOCATION_OPTIONS].map((o) => [o.value, o.label])
);

export function activeGalleryFilterCount(filters: GalleryFilters): number {
  return countActiveFilters(filters);
}

export function GalleryFilterButton({
  facets, value, onChange, compact = false
}: {
  facets: GalleryFacets | null;
  value: GalleryFilters;
  onChange: (filters: GalleryFilters) => void;
  compact?: boolean;
}) {
  return (
    <FacetFilterButton
      order={FACET_ORDER}
      facets={{
        people: facets?.people ?? [],
        years: facets?.years ?? [],
        tags: facets?.tags ?? [],
        cameras: facets?.cameras ?? []
      }}
      value={value}
      onChange={onChange}
      empty={EMPTY_GALLERY_FILTERS}
      compact={compact}
    />
  );
}

function chipLabel(value: string): string | undefined {
  if (value.startsWith("from:")) return `From ${value.slice(5)}`;
  if (value.startsWith("to:")) return `To ${value.slice(3)}`;
  return undefined;
}

export function GalleryFilterChips({ value, onChange }: { value: GalleryFilters; onChange: (filters: GalleryFilters) => void }) {
  return <FacetFilterChips value={value} onChange={onChange} empty={EMPTY_GALLERY_FILTERS} labels={CODE_LABELS} formatLabel={chipLabel} />;
}
