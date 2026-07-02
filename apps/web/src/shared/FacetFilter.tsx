import { useState } from "react";
import { Check, ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";

// Generic advanced-filter surface: a Filter button opening a modal of collapsible
// facet sections, plus the removable-chip row for active selections. Each media
// type supplies its own facet ORDER (keys, titles, fixed enumerations) and value
// shape — audiobooks/ebooks via BookFilter.tsx, gallery via GalleryFilter.tsx —
// so every library type gets the same filtering UI without re-implementing it.

export interface FacetOption {
  value: string;
  label: string;
}

export interface FacetDef<K extends string> {
  key: K;
  title: string;
  searchable: boolean;
  // Fixed enumerations (e.g. status/length buckets) need no server facet list.
  fixed?: FacetOption[];
  // "daterange" renders From/To date inputs instead of a checkbox list. The
  // selection is stored in the same string[] as "from:YYYY-MM-DD" / "to:YYYY-MM-DD"
  // entries, so counting, chips, and clearing work unchanged.
  type?: "list" | "daterange";
}

export function countActiveFilters<K extends string>(value: Record<K, string[]>): number {
  return (Object.values(value) as string[][]).reduce((sum, list) => sum + list.length, 0);
}

function FacetSection({
  title, options, selected, onToggle, searchable
}: {
  title: string;
  options: FacetOption[];
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
          {/* Offer the type-ahead as soon as a facet has more than one option, so
              shorter lists (e.g. ebook authors/tags/categories) are filterable too —
              not just the long audiobook lists. It only renders inside an expanded
              facet, so it never clutters the collapsed view. */}
          {searchable && options.length > 1 && (
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

// From/To bounds for a "daterange" facet, stored as prefixed entries in the same
// string[] every other facet uses. Either bound is optional and independently
// removable (each shows as its own chip).
function DateRangeSection({
  title, selected, onChange
}: {
  title: string;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const from = selected.find((v) => v.startsWith("from:"))?.slice(5) ?? "";
  const to = selected.find((v) => v.startsWith("to:"))?.slice(3) ?? "";

  const set = (prefix: "from" | "to", date: string) => {
    const rest = selected.filter((v) => !v.startsWith(`${prefix}:`));
    onChange(date ? [...rest, `${prefix}:${date}`] : rest);
  };

  return (
    <div className={`facet-section${open ? " open" : ""}`}>
      <button className="facet-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="facet-title">{title}</span>
        {selected.length > 0 && <span className="facet-count">{selected.length}</span>}
        <ChevronDown size={16} className="facet-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="facet-body facet-daterange">
          <label>
            <span>From</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => set("from", e.target.value)} aria-label={`${title} from`} />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => set("to", e.target.value)} aria-label={`${title} to`} />
          </label>
        </div>
      )}
    </div>
  );
}

export function FacetFilterButton<K extends string>({
  order, facets, value, onChange, empty, compact = false
}: {
  order: FacetDef<K>[];
  // Server-supplied options for the non-fixed facets, keyed like `value`.
  facets: Partial<Record<K, string[]>>;
  value: Record<K, string[]>;
  onChange: (filters: Record<K, string[]>) => void;
  // The all-clear value for "Clear all".
  empty: Record<K, string[]>;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const count = countActiveFilters(value);

  const toggle = (key: K, v: string) => {
    const current = value[key];
    onChange({ ...value, [key]: current.includes(v) ? current.filter((x) => x !== v) : [...current, v] });
  };

  return (
    <>
      <button className={`filter-button${count > 0 ? " active" : ""}${compact ? " compact" : ""}`} onClick={() => setOpen(true)} aria-label="Filters" title={compact ? "Filter" : undefined}>
        <SlidersHorizontal size={16} aria-hidden="true" />
        {!compact && <span>Filter</span>}
        {count > 0 && <span className="filter-badge">{count}</span>}
      </button>
      {open && (
        <Modal variant="panel" title="Filters" surfaceClassName="filter-modal" onClose={() => setOpen(false)}>
            <div className="filter-modal-body">
              {order.map((facet) => {
                if (facet.type === "daterange") {
                  return (
                    <DateRangeSection
                      key={facet.key}
                      title={facet.title}
                      selected={value[facet.key]}
                      onChange={(next) => onChange({ ...value, [facet.key]: next })}
                    />
                  );
                }
                const options = facet.fixed ?? (facets[facet.key] ?? []).map((v) => ({ value: v, label: v }));
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
              <Button variant="secondary" onClick={() => onChange(empty)} disabled={count === 0}>
                Clear all
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>Done</Button>
            </div>
        </Modal>
      )}
    </>
  );
}

export function FacetFilterChips<K extends string>({
  value, onChange, empty, labels = {}, formatLabel
}: {
  value: Record<K, string[]>;
  onChange: (filters: Record<K, string[]>) => void;
  empty: Record<K, string[]>;
  // Display labels for code values (e.g. status/length/location codes).
  labels?: Record<string, string>;
  // Dynamic labels (e.g. daterange "from:2020-01-01" → "From 2020-01-01");
  // returning undefined falls through to `labels`/the raw value.
  formatLabel?: (value: string) => string | undefined;
}) {
  const chips = (Object.keys(value) as K[]).flatMap((key) =>
    value[key].map((v) => ({ key, value: v, label: formatLabel?.(v) ?? labels[v] ?? v }))
  );
  if (chips.length === 0) return null;

  const remove = (key: K, v: string) =>
    onChange({ ...value, [key]: value[key].filter((x) => x !== v) });

  return (
    <div className="filter-chips">
      {chips.map((chip) => (
        <button key={`${chip.key}:${chip.value}`} className="filter-chip" onClick={() => remove(chip.key, chip.value)}>
          <span>{chip.label}</span>
          <X size={13} aria-hidden="true" />
        </button>
      ))}
      <button className="filter-chips-clear" onClick={() => onChange(empty)}>Clear all</button>
    </div>
  );
}
