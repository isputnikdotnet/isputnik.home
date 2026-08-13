import { FacetFilterButton, FacetFilterChips, countActiveFilters, type FacetDef } from "../../shared/FacetFilter";
import type { AudiobookBook } from "./types";

// A book row in the grids — the list type plus the libraryName the pages attach.
export type FilterableBook = AudiobookBook & { libraryName?: string };

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

// Derive facet options from an in-memory book set — used by pages that still load
// everything client-side (e.g. Ebooks). The audiobook catalog fetches facets from
// the server instead.
export function facetsFromBooks(books: FilterableBook[]): FacetOptions {
  const uniq = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    authors: uniq(books.flatMap((b) => b.authors)),
    narrators: uniq(books.flatMap((b) => b.narrators)),
    categories: uniq(books.map((b) => b.category?.name ?? "")),
    tags: uniq(books.flatMap((b) => b.tags)),
    series: uniq(books.map((b) => b.series ?? "")),
    languages: uniq(books.map((b) => b.language ?? "")),
    // Letters are indexed server-side (the bucket depends on script detection a
    // loaded page can't redo), so a client-derived facet set has none.
    letters: []
  };
}

export type SortKey = "title" | "title_desc" | "recent" | "duration" | "author" | "series";

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "title", label: "Title (A–Z)" },
  { value: "title_desc", label: "Title (Z–A)" },
  { value: "recent", label: "Recently added" },
  { value: "duration", label: "Longest first" },
  { value: "author", label: "Author" },
  { value: "series", label: "Series order" }
];

// Ebooks have no duration or series, so they offer the subset of sorts that apply.
export const EBOOK_SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "title", label: "Title (A–Z)" },
  { value: "title_desc", label: "Title (Z–A)" },
  { value: "recent", label: "Recently added" },
  { value: "author", label: "Author" }
];

const STATUS_OPTIONS = [
  { value: "in_progress", label: "In progress" },
  { value: "finished", label: "Finished" },
  { value: "not_started", label: "Not started" }
];

const DURATION_OPTIONS = [
  { value: "short", label: "Under 2h" },
  { value: "medium", label: "2–6h" },
  { value: "long", label: "6–12h" },
  { value: "epic", label: "12h+" }
];

// Facets keyed to the BookFilters fields, in display order. Status/duration are
// fixed enumerations; libraries are supplied per page (ids with names to show);
// the rest are derived from the loaded books.
const FACET_ORDER: FacetDef<keyof BookFilters>[] = [
  // First, because it is the widest cut: which shelves the rest of the panel is
  // narrowing. Leaving it empty means every library you can reach.
  { key: "libraries", title: "Libraries", searchable: false },
  { key: "status", title: "Status", searchable: false, fixed: STATUS_OPTIONS },
  { key: "authors", title: "Authors", searchable: true },
  { key: "narrators", title: "Narrators", searchable: true },
  { key: "categories", title: "Categories", searchable: true },
  { key: "tags", title: "Tags", searchable: true },
  { key: "series", title: "Series", searchable: true },
  { key: "languages", title: "Language", searchable: true },
  { key: "durations", title: "Length", searchable: false, fixed: DURATION_OPTIONS }
];

const CODE_LABELS: Record<string, string> = Object.fromEntries(
  [...STATUS_OPTIONS, ...DURATION_OPTIONS].map((o) => [o.value, o.label])
);

export function bookStatus(book: FilterableBook): string {
  const p = book.progress;
  const finished = p?.completedAt != null;
  if (finished) return "finished";
  if (p?.percentComplete != null && p.percentComplete > 0) return "in_progress";
  return "not_started";
}

function durationBucket(seconds: number | null): string | null {
  if (seconds == null) return null;
  const hours = seconds / 3600;
  if (hours < 2) return "short";
  if (hours < 6) return "medium";
  if (hours < 12) return "long";
  return "epic";
}

export function activeFilterCount(filters: BookFilters): number {
  return countActiveFilters(filters);
}

export function filterBooks(books: FilterableBook[], filters: BookFilters): FilterableBook[] {
  return books.filter((b) => {
    if (filters.libraries.length && !filters.libraries.includes(b.libraryId)) return false;
    if (filters.authors.length && !b.authors.some((a) => filters.authors.includes(a))) return false;
    if (filters.narrators.length && !b.narrators.some((n) => filters.narrators.includes(n))) return false;
    if (filters.categories.length && !(b.category && filters.categories.includes(b.category.name))) return false;
    if (filters.tags.length && !b.tags.some((t) => filters.tags.includes(t))) return false;
    if (filters.series.length && !(b.series && filters.series.includes(b.series))) return false;
    if (filters.languages.length && !(b.language && filters.languages.includes(b.language))) return false;
    if (filters.status.length && !filters.status.includes(bookStatus(b))) return false;
    if (filters.durations.length) {
      const bucket = durationBucket(b.durationSeconds);
      if (!bucket || !filters.durations.includes(bucket)) return false;
    }
    return true;
  });
}

export function sortBooks(books: FilterableBook[], sort: SortKey): FilterableBook[] {
  const arr = [...books];
  switch (sort) {
    case "title_desc":
      return arr.sort((a, b) => b.title.localeCompare(a.title));
    case "recent":
      return arr.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
    case "duration":
      return arr.sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0));
    case "author":
      return arr.sort((a, b) => (a.authors[0] ?? "").localeCompare(b.authors[0] ?? "") || a.title.localeCompare(b.title));
    case "series":
      return arr.sort((a, b) =>
        (a.series ?? "~").localeCompare(b.series ?? "~") ||
        (a.seriesPosition ?? 0) - (b.seriesPosition ?? 0) ||
        a.title.localeCompare(b.title));
    case "title":
    default:
      return arr.sort((a, b) => a.title.localeCompare(b.title));
  }
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
  const order = (fields ? FACET_ORDER.filter((facet) => fields.includes(facet.key)) : FACET_ORDER)
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

export function SortSelect({ value, onChange }: { value: SortKey; onChange: (sort: SortKey) => void }) {
  return (
    <select
      className="library-filter"
      value={value}
      onChange={(e) => onChange(e.target.value as SortKey)}
      aria-label="Sort books"
    >
      {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
    </select>
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
  const labels = libraries?.length
    ? { ...CODE_LABELS, ...Object.fromEntries(libraries.map((library) => [library.id, library.name])) }
    : CODE_LABELS;
  return <FacetFilterChips value={value} onChange={onChange} empty={EMPTY_FILTERS} labels={labels} />;
}
