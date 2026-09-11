import { FacetFilterButton, FacetFilterChips, countActiveFilters, type FacetDef } from "../../shared/FacetFilter";
import i18n from "../../i18n";

export interface BookFilters {
  libraries: string[];  // library ids — which shelves the list is drawn from
  authors: string[];
  narrators: string[];
  categories: string[]; // category display names (unique in the taxonomy)
  tags: string[];
  series: string[];
  languages: string[];
  status: string[];     // codes: finished | in_progress | not_started
  durations: string[];  // codes: short | medium | long | epic
}

export const EMPTY_FILTERS: BookFilters = {
  libraries: [], authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], status: [], durations: []
};

// Filter dropdown options, supplied by the server (the panel can no longer derive
// them from the loaded books once the catalog is paged).
export interface FacetOptions {
  authors: string[];
  narrators: string[];
  categories: string[];
  tags: string[];
  series: string[];
  languages: string[];
  // The A–Z buckets the scope holds — the strip's enabled letters. Not a filter
  // chip like the rest: it comes back with them because it answers the same
  // question ("what can this scope offer?") in the same request.
  letters: string[];
}

export const EMPTY_FACETS: FacetOptions = {
  authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], letters: []
};

export type SortKey = "title" | "title_desc" | "recent" | "duration" | "author" | "series";

// Built fresh on every call (not a module-level const) so the labels stay
// reactive to a language switch — same approach as control/nav.ts.
export function getSortOptions(): { value: SortKey; label: string }[] {
  return [
    { value: "title", label: i18n.t("book:filter.sortTitleAsc") },
    { value: "title_desc", label: i18n.t("book:filter.sortTitleDesc") },
    { value: "recent", label: i18n.t("book:filter.sortRecent") },
    { value: "duration", label: i18n.t("book:filter.sortDuration") },
    { value: "author", label: i18n.t("book:filter.sortAuthor") },
    { value: "series", label: i18n.t("book:filter.sortSeries") }
  ];
}

// Ebooks have no duration or series, so they offer the subset of sorts that apply.
export function getEbookSortOptions(): { value: SortKey; label: string }[] {
  return [
    { value: "title", label: i18n.t("book:filter.sortTitleAsc") },
    { value: "title_desc", label: i18n.t("book:filter.sortTitleDesc") },
    { value: "recent", label: i18n.t("book:filter.sortRecent") },
    { value: "author", label: i18n.t("book:filter.sortAuthor") }
  ];
}

function getStatusOptions() {
  return [
    { value: "in_progress", label: i18n.t("book:filter.statusInProgress") },
    { value: "finished", label: i18n.t("book:filter.statusFinished") },
    { value: "not_started", label: i18n.t("book:filter.statusNotStarted") }
  ];
}

function getDurationOptions() {
  return [
    { value: "short", label: i18n.t("book:filter.durationShort") },
    { value: "medium", label: i18n.t("book:filter.durationMedium") },
    { value: "long", label: i18n.t("book:filter.durationLong") },
    { value: "epic", label: i18n.t("book:filter.durationEpic") }
  ];
}

// Facets keyed to the BookFilters fields, in display order. Status/duration are
// fixed enumerations; libraries are supplied per page (ids with names to show);
// the rest are derived from the loaded books.
function getFacetOrder(): FacetDef<keyof BookFilters>[] {
  return [
    // First, because it is the widest cut: which shelves the rest of the panel is
    // narrowing. Leaving it empty means every library you can reach.
    { key: "libraries", title: i18n.t("book:filter.facetLibraries"), searchable: false },
    { key: "status", title: i18n.t("book:filter.facetStatus"), searchable: false, fixed: getStatusOptions() },
    { key: "authors", title: i18n.t("book:filter.facetAuthors"), searchable: true },
    { key: "narrators", title: i18n.t("book:filter.facetNarrators"), searchable: true },
    { key: "categories", title: i18n.t("book:filter.facetCategories"), searchable: true },
    { key: "tags", title: i18n.t("book:filter.facetTags"), searchable: true },
    { key: "series", title: i18n.t("book:filter.facetSeries"), searchable: true },
    { key: "languages", title: i18n.t("book:filter.facetLanguage"), searchable: true },
    { key: "durations", title: i18n.t("book:filter.facetLength"), searchable: false, fixed: getDurationOptions() }
  ];
}

function getCodeLabels(): Record<string, string> {
  return Object.fromEntries(
    [...getStatusOptions(), ...getDurationOptions()].map((o) => [o.value, o.label])
  );
}

export function activeFilterCount(filters: BookFilters): number {
  return countActiveFilters(filters);
}

// ── Components (thin wrappers over the shared generic filter UI) ───────────

export function FilterButton({
  facets, value, onChange, fields, libraries, compact = false
}: {
  facets: FacetOptions;
  value: BookFilters;
  onChange: (filters: BookFilters) => void;
  // Restrict which facet sections render (e.g. ebooks drop narrators/series/length).
  // Defaults to every facet in display order.
  fields?: (keyof BookFilters)[];
  // The libraries this user can reach, as id + name. Omitted (or fewer than two)
  // drops the section: a filter that can only mean "everything" isn't one.
  libraries?: { id: string; name: string }[];
  compact?: boolean;
}) {
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
      facets={facets}
      value={value}
      onChange={onChange}
      empty={EMPTY_FILTERS}
      compact={compact}
    />
  );
}

export function FilterChips({
  value, onChange, libraries
}: {
  value: BookFilters;
  onChange: (filters: BookFilters) => void;
  // Library chips carry ids; without this they would read as nanoids.
  libraries?: { id: string; name: string }[];
}) {
  const codeLabels = getCodeLabels();
  const labels = libraries?.length
    ? { ...codeLabels, ...Object.fromEntries(libraries.map((library) => [library.id, library.name])) }
    : codeLabels;
  return <FacetFilterChips value={value} onChange={onChange} empty={EMPTY_FILTERS} labels={labels} />;
}
