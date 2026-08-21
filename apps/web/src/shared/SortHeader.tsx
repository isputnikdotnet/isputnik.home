import { ChevronDown, ChevronUp } from "lucide-react";

// A sortable column heading for `.datagrid` tables: the whole label is the
// control, the chevron shows only on the column currently doing the sorting, and
// clicking the active column flips its direction.
//
// `columns` takes more than one key when a cell stacks two values (an address
// over the person who used it): each line sorts by its own key, so the header
// mirrors the cell under it instead of forcing a second column.

export type SortDirection = "asc" | "desc";

export interface SortColumn<T extends string> {
  column: T;
  label: string;
  /** Which way a first click on this column should sort. */
  initial?: SortDirection;
}

export function SortHeader<T extends string>({
  column,
  label,
  columns,
  sort,
  dir,
  onChange,
  className,
  initial = "asc"
}: {
  column?: T;
  label?: string;
  columns?: SortColumn<T>[];
  sort: T;
  dir: SortDirection;
  onChange: (sort: T, dir: SortDirection) => void;
  className?: string;
  initial?: SortDirection;
}) {
  const entries: SortColumn<T>[] =
    columns ?? (column && label ? [{ column, label, initial }] : []);
  const active = entries.find((entry) => entry.column === sort);

  return (
    <th
      className={[className, entries.length > 1 ? "datagrid-sort-stack" : null].filter(Boolean).join(" ") || undefined}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {entries.map((entry) => {
        const isActive = entry.column === sort;
        return (
          <button
            key={entry.column}
            type="button"
            className={`datagrid-sort${isActive ? " active" : ""}`}
            onClick={() =>
              onChange(entry.column, isActive ? (dir === "asc" ? "desc" : "asc") : entry.initial ?? "asc")
            }
          >
            {entry.label}
            {isActive &&
              (dir === "asc" ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />)}
          </button>
        );
      })}
    </th>
  );
}
