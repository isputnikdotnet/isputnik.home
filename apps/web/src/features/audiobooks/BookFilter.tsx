import { useState } from "react";
import { Check, ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import type { AudiobookBook } from "./types";

// A book row in the grids — the list type plus the libraryName the pages attach.
export type FilterableBook = AudiobookBook & { libraryName?: string };

export interface BookFilters {
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
  authors: [], narrators: [], categories: [], tags: [], series: [], languages: [], status: [], durations: []
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
}

export const EMPTY_FACETS: FacetOptions = {
  authors: [], narrators: [], categories: [], tags: [], series: [], languages: []
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
    languages: uniq(books.map((b) => b.language ?? ""))
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
// fixed enumerations; the rest are derived from the loaded books.
const FACET_ORDER: { key: keyof BookFilters; title: string; searchable: boolean; fixed?: { value: string; label: string }[] }[] = [
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
  return Object.values(filters).reduce((sum, list) => sum + list.length, 0);
}

export function filterBooks(books: FilterableBook[], filters: BookFilters): FilterableBook[] {
  return books.filter((b) => {
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

// ── Components ──────────────────────────────────────────────────────

function FacetSection({
  title, options, selected, onToggle, searchable
}: {
  title: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  searchable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  if (options.length === 0) return null;

  const term = query.trim().toLowerCase();
  const shown = term ? options.filter((o) => o.label.toLowerCase().includes(term)) : options;

  return (
    <div className={`facet-section${open ? " open" : ""}`}>
      <button className="facet-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="facet-title">{title}</span>
        {selected.length > 0 && <span className="facet-count">{selected.length}</span>}
        <ChevronDown size={16} className="facet-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="facet-body">
          {searchable && options.length > 8 && (
            <label className="facet-search">
              <Search size={14} aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${title.toLowerCase()}`}
                aria-label={`Search ${title}`}
              />
            </label>
          )}
          <div className="facet-options">
            {shown.map((opt) => {
              const checked = selected.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  className={`facet-option${checked ? " checked" : ""}`}
                  onClick={() => onToggle(opt.value)}
                  role="checkbox"
                  aria-checked={checked}
                >
                  <span className="facet-check">{checked && <Check size={13} />}</span>
                  <span className="facet-option-label">{opt.label}</span>
                </button>
              );
            })}
            {shown.length === 0 && <p className="facet-empty">No matches</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function FilterButton({
  facets, value, onChange, fields
}: {
  facets: FacetOptions;
  value: BookFilters;
  onChange: (filters: BookFilters) => void;
  // Restrict which facet sections render (e.g. ebooks drop narrators/series/length).
  // Defaults to every facet in display order.
  fields?: (keyof BookFilters)[];
}) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(value);
  const order = fields ? FACET_ORDER.filter((facet) => fields.includes(facet.key)) : FACET_ORDER;

  const toggle = (key: keyof BookFilters, v: string) => {
    const current = value[key];
    onChange({ ...value, [key]: current.includes(v) ? current.filter((x) => x !== v) : [...current, v] });
  };

  return (
    <>
      <button className={`filter-button${count > 0 ? " active" : ""}`} onClick={() => setOpen(true)} aria-label="Filters">
        <SlidersHorizontal size={16} aria-hidden="true" />
        <span>Filter</span>
        {count > 0 && <span className="filter-badge">{count}</span>}
      </button>
      {open && (
        <Modal variant="panel" title="Filters" surfaceClassName="filter-modal" onClose={() => setOpen(false)}>
            <div className="filter-modal-body">
              {order.map((facet) => {
                const options = facet.fixed ?? (facets[facet.key as keyof FacetOptions] ?? []).map((v) => ({ value: v, label: v }));
                return (
                  <FacetSection
                    key={facet.key}
                    title={facet.title}
                    options={options}
                    selected={value[facet.key]}
                    onToggle={(v) => toggle(facet.key, v)}
                    searchable={facet.searchable}
                  />
                );
              })}
            </div>
            <div className="filter-modal-foot">
              <Button variant="secondary" onClick={() => onChange(EMPTY_FILTERS)} disabled={count === 0}>
                Clear all
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>Done</Button>
            </div>
        </Modal>
      )}
    </>
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

export function FilterChips({ value, onChange }: { value: BookFilters; onChange: (filters: BookFilters) => void }) {
  const chips = (Object.keys(value) as (keyof BookFilters)[]).flatMap((key) =>
    value[key].map((v) => ({ key, value: v, label: CODE_LABELS[v] ?? v }))
  );
  if (chips.length === 0) return null;

  const remove = (key: keyof BookFilters, v: string) =>
    onChange({ ...value, [key]: value[key].filter((x) => x !== v) });

  return (
    <div className="filter-chips">
      {chips.map((chip) => (
        <button key={`${chip.key}:${chip.value}`} className="filter-chip" onClick={() => remove(chip.key, chip.value)}>
          <span>{chip.label}</span>
          <X size={13} aria-hidden="true" />
        </button>
      ))}
      <button className="filter-chips-clear" onClick={() => onChange(EMPTY_FILTERS)}>Clear all</button>
    </div>
  );
}
