import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { FacetFilterButton, FacetFilterChips, countActiveFilters, type FacetDef } from "../../shared/FacetFilter";
import type { GalleryFacets } from "./types";

// Gallery advanced filters — the same filter surface the audiobook catalog uses,
// with photo/video-relevant facets: media type (photo/video), named people (face
// recognition), years and months (from the EXIF date), tags, cameras, and a fixed
// with/without-location toggle. The header dropdown holds the timeline sort.
export interface GalleryFilters {
  libraries: string[]; // gallery library ids — which libraries the view draws from
  kinds: string[];    // codes: photo | video | audio (sent as the API's top-level `kinds`)
  people: string[];
  years: string[];
  months: string[];   // codes: "01".."12" (any year)
  taken: string[];    // date-taken bounds: "from:YYYY-MM-DD" / "to:YYYY-MM-DD"
  tags: string[];
  cameras: string[];
  sizes: string[];    // codes: small | medium | large | huge (server-defined byte buckets)
  location: string[]; // codes: with_gps | no_gps
  likes: string[]; // codes: mine | anyone | none
}

export const EMPTY_GALLERY_FILTERS: GalleryFilters = {
  libraries: [], kinds: [], people: [], years: [], months: [], taken: [], tags: [], cameras: [], sizes: [], location: [], likes: []
};

// Functions rather than frozen consts, so these stay reactive to a language
// switch instead of freezing whichever language was active on first import
// (same pattern as controlDash's DashboardChart / search-index.ts).
function getKindOptions() {
  return [
    { value: "photo", label: i18n.t("gallery:filter.kindPhotos") },
    { value: "video", label: i18n.t("gallery:filter.kindVideos") },
    { value: "audio", label: i18n.t("gallery:filter.kindAudio") }
  ];
}

// Calendar months as fixed codes matching substr(taken_at, 6, 2) on the server;
// a month selection spans every year (e.g. "July" across the whole archive).
function getMonthOptions() {
  return [
    { value: "01", label: i18n.t("gallery:filter.monthJanuary") },
    { value: "02", label: i18n.t("gallery:filter.monthFebruary") },
    { value: "03", label: i18n.t("gallery:filter.monthMarch") },
    { value: "04", label: i18n.t("gallery:filter.monthApril") },
    { value: "05", label: i18n.t("gallery:filter.monthMay") },
    { value: "06", label: i18n.t("gallery:filter.monthJune") },
    { value: "07", label: i18n.t("gallery:filter.monthJuly") },
    { value: "08", label: i18n.t("gallery:filter.monthAugust") },
    { value: "09", label: i18n.t("gallery:filter.monthSeptember") },
    { value: "10", label: i18n.t("gallery:filter.monthOctober") },
    { value: "11", label: i18n.t("gallery:filter.monthNovember") },
    { value: "12", label: i18n.t("gallery:filter.monthDecember") }
  ];
}

function getSizeOptions() {
  return [
    { value: "small", label: i18n.t("gallery:filter.sizeUnder1mb") },
    { value: "medium", label: i18n.t("gallery:filter.size1to5mb") },
    { value: "large", label: i18n.t("gallery:filter.size5to25mb") },
    { value: "huge", label: i18n.t("gallery:filter.size25plusMb") }
  ];
}

function getLocationOptions() {
  return [
    { value: "with_gps", label: i18n.t("gallery:filter.locationHasGps") },
    { value: "no_gps", label: i18n.t("gallery:filter.locationNoGps") }
  ];
}

// The heart, as a filter. "Anyone's" is the household cut — the same signal the
// year-in-review scores on — so it reads next to "Mine" rather than hiding behind
// a separate surface.
function getLikeOptions() {
  return [
    { value: "mine", label: i18n.t("gallery:filter.likeMine") },
    { value: "anyone", label: i18n.t("gallery:filter.likeAnyone") },
    { value: "none", label: i18n.t("gallery:filter.likeNone") }
  ];
}

function getFacetOrder(): FacetDef<keyof GalleryFilters>[] {
  return [
    // First, because it's the widest cut: which libraries the rest of the panel is
    // narrowing. Leaving it empty means every library the viewer can reach.
    { key: "libraries", title: i18n.t("gallery:filter.facetLibraries"), searchable: false },
    { key: "kinds", title: i18n.t("gallery:filter.facetMediaType"), searchable: false, fixed: getKindOptions() },
    // High up: "show me the good ones" is a coarser cut than any of the descriptive
    // facets below, and it's the one the year-in-review is built from.
    { key: "likes", title: i18n.t("gallery:filter.facetLikes"), searchable: false, fixed: getLikeOptions() },
    { key: "people", title: i18n.t("gallery:filter.facetPeople"), searchable: true },
    // A family archive can span many decades (scanned prints reach the 1940s), so
    // the year list gets the type-ahead too.
    { key: "years", title: i18n.t("gallery:filter.facetYears"), searchable: true },
    { key: "months", title: i18n.t("gallery:filter.facetMonths"), searchable: false, fixed: getMonthOptions() },
    { key: "taken", title: i18n.t("gallery:filter.facetDateTaken"), searchable: false, type: "daterange" },
    { key: "tags", title: i18n.t("gallery:filter.facetTags"), searchable: true },
    { key: "cameras", title: i18n.t("gallery:filter.facetCameras"), searchable: true },
    { key: "sizes", title: i18n.t("gallery:filter.facetFileSize"), searchable: false, fixed: getSizeOptions() },
    { key: "location", title: i18n.t("gallery:filter.facetLocation"), searchable: false, fixed: getLocationOptions() }
  ];
}

function getCodeLabels(): Record<string, string> {
  return Object.fromEntries(
    [...getKindOptions(), ...getMonthOptions(), ...getSizeOptions(), ...getLocationOptions(), ...getLikeOptions()]
      .map((o) => [o.value, o.label])
  );
}

export function activeGalleryFilterCount(filters: GalleryFilters): number {
  return countActiveFilters(filters);
}

export function GalleryFilterButton({
  facets, value, onChange, fields, libraries, compact = false
}: {
  facets: GalleryFacets | null;
  value: GalleryFilters;
  onChange: (filters: GalleryFilters) => void;
  // Restrict which facet sections render — Memories, People and Map have nothing
  // but Libraries to offer, unlike Timeline and Folder. Defaults to every facet.
  fields?: (keyof GalleryFilters)[];
  // The gallery libraries this viewer can reach, as id + name. Omitted (or fewer
  // than two) drops the Libraries section: a filter that can only mean
  // "everything" isn't one.
  libraries?: { id: string; name: string }[];
  compact?: boolean;
}) {
  useTranslation(["common", "gallery"]); // keeps this component reactive to a language switch
  const facetOrder = getFacetOrder();
  const order = (fields ? facetOrder.filter((facet) => fields.includes(facet.key)) : facetOrder)
    .flatMap((facet) => {
      if (facet.key !== "libraries") return [facet];
      if (!libraries || libraries.length < 2) return [];
      return [{ ...facet, fixed: libraries.map((library) => ({ value: library.id, label: library.name })) }];
    });
  return (
    <FacetFilterButton
      order={order}
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
  if (value.startsWith("from:")) return i18n.t("gallery:filter.chipFrom", { date: value.slice(5) });
  if (value.startsWith("to:")) return i18n.t("gallery:filter.chipTo", { date: value.slice(3) });
  return undefined;
}

export function GalleryFilterChips({
  value, onChange, libraries, fields
}: {
  value: GalleryFilters;
  onChange: (filters: GalleryFilters) => void;
  // Library chips carry ids; without this they'd read as nanoids.
  libraries?: { id: string; name: string }[];
  // Restrict the row to the facets that actually narrow the view showing it —
  // Folders, Memories and People are scoped by library alone, so a year still
  // sitting in the filters from a visit to the timeline must not draw a chip
  // there claiming to be in force. The facets left out ride through untouched:
  // removing a chip (and "Clear all") only ever clears what is on show.
  // Defaults to every facet, which is what the timeline wants.
  fields?: (keyof GalleryFilters)[];
}) {
  useTranslation(["common", "gallery"]); // keeps this component reactive to a language switch
  const labels = libraries?.length
    ? { ...getCodeLabels(), ...Object.fromEntries(libraries.map((library) => [library.id, library.name])) }
    : getCodeLabels();
  const pick = (from: GalleryFilters) =>
    Object.fromEntries((fields ?? []).map((key) => [key, from[key]])) as Partial<GalleryFilters>;
  const shown = fields ? { ...EMPTY_GALLERY_FILTERS, ...pick(value) } : value;
  const handleChange = (next: GalleryFilters) => onChange(fields ? { ...value, ...pick(next) } : next);
  return <FacetFilterChips value={shown} onChange={handleChange} empty={EMPTY_GALLERY_FILTERS} labels={labels} formatLabel={chipLabel} />;
}
