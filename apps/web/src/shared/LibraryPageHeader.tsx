import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import type { ReactNode } from "react";

// The one page header every library browse page wears — Audiobooks, Ebooks,
// Gallery, and the section lists they link to (Authors, Narrators, Series,
// Categories, Tags, Family). It exists so that moving between siblings in the
// same left nav never moves the search box: these pages used to carry three
// different header layouts and two differently-sized search fields between them.
//
// The row has a fixed order, left to right, and pages opt into the slots they
// need rather than arranging their own:
//
//   title + count · nav · search · filters/sort · icon actions · primary action
//
// `primaryAction` is a slot of its own rather than the tail of `actions` so the
// page's one Create/New button lands in the same place on every page without
// each call site having to remember to put it last.
//
// `nav` leads the row because it answers "where am I" rather than "what do I do
// with this" — the gallery's phone Browse menu, which stands in for the left nav
// a phone has no room for, so it must be reachable from every view.
//
// Anything that filters by facet rather than by text — the A–Z strip, the media
// kind toggle, filter chips — belongs in a row BELOW this header, not inside it.
export function LibraryPageHeader({
  title,
  subtitle,
  nav,
  search,
  onSearchChange,
  searchPlaceholder,
  actions,
  primaryAction
}: {
  title: string;
  subtitle?: string;
  /** A view switcher for this section — always first in the row, before search. */
  nav?: ReactNode;
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Filter, sort, scope and icon-only controls, in that order. */
  actions?: ReactNode;
  /** The page's single Create/New button — always rendered last in the row. */
  primaryAction?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="audiobook-page-header">
      <div className="audiobook-page-title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {(nav || onSearchChange || actions || primaryAction) && (
        <div className="audiobook-page-actions">
          {nav}
          {onSearchChange && (
            <label className="audiobook-page-search">
              <span className="sr-only">{searchPlaceholder ?? t("common.searchIn", { what: title.toLowerCase() })}</span>
              <Search size={22} aria-hidden="true" />
              <input
                type="search"
                value={search ?? ""}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder={searchPlaceholder ?? t("common.searchIn", { what: title.toLowerCase() })}
              />
            </label>
          )}
          {actions}
          {primaryAction}
        </div>
      )}
    </header>
  );
}
