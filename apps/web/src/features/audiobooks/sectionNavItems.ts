import { BookOpen, Library, Mic2, Shapes, UserRound } from "lucide-react";
import i18n from "../../i18n";
import type { DashboardActive } from "../../app/DashboardShell";
import type { SectionNavItem } from "../../shared/SectionNav";

// Authors and Categories are single cross-type pages (AuthorListPage,
// CategoryListPage/CategoryDetailPage), so there's no `kind` to key off like
// Series has — the `section` query param is how they know which of these lists
// sent them there, so they can keep showing that section's left nav instead of
// falling back to the generic one. See sectionFromQuery() below.
//
// Built fresh on every call (not a module-level const) so the labels stay
// reactive to a language switch — same approach as control/nav.ts.
export function ebookNavItems(): SectionNavItem[] {
  return [
    { key: "books", label: i18n.t("book:sectionNav.allEbooks"), href: "/ebooks", icon: BookOpen },
    { key: "authors", label: i18n.t("book:authors.title"), href: "/authors?section=ebooks", icon: UserRound },
    { key: "series", label: i18n.t("book:series.title"), href: "/ebooks/series", icon: Library },
    { key: "categories", label: i18n.t("book:categories.title"), href: "/categories?section=ebooks", icon: Shapes }
  ];
}

export function audiobookNavItems(): SectionNavItem[] {
  return [
    { key: "books", label: i18n.t("book:sectionNav.allAudiobooks"), href: "/audiobooks", icon: BookOpen },
    { key: "authors", label: i18n.t("book:authors.title"), href: "/authors?section=audiobooks", icon: UserRound },
    { key: "narrators", label: i18n.t("book:narrators.title"), href: "/audiobooks/narrators", icon: Mic2 },
    { key: "series", label: i18n.t("book:series.title"), href: "/audiobooks/series", icon: Library },
    { key: "categories", label: i18n.t("book:categories.title"), href: "/categories?section=audiobooks", icon: Shapes }
  ];
}

export interface QuerySection {
  active: DashboardActive;
  items: SectionNavItem[];
}

/** A section's whole SectionNav configuration, so no page has to restate the
 *  label twice and the items once — the same "nowhere else to keep in sync"
 *  rule the control panel's nav.ts holds itself to. */
export function sectionNavProps(section: QuerySection): { ariaLabel: string; groupLabel: string; items: SectionNavItem[] } {
  const label = section.active === "ebooks" ? i18n.t("common:nav.ebooks") : i18n.t("common:nav.audiobooks");
  return { ariaLabel: label, groupLabel: label, items: section.items };
}

/** The same, from a media type rather than a parsed query param — what the
 *  pages that always know which section they're in (Series, Narrators) use. */
export function bookSectionNav(kind: "audiobook" | "ebook"): QuerySection {
  return kind === "ebook"
    ? { active: "ebooks", items: ebookNavItems() }
    : { active: "audiobooks", items: audiobookNavItems() };
}

// Reads the `?section=` a cross-type page (Authors, Categories) was linked in
// with, so it can keep showing the Ebooks/Audiobooks nav that sent it there.
// Reached any other way — Tags, a bookmark, a typed URL — this returns null and
// the page falls back to the generic main nav, same as before `section` existed.
export function sectionFromQuery(): QuerySection | null {
  return sectionFromName(new URLSearchParams(window.location.search).get("section"));
}

/** The same question asked of a link rather than of the current URL — what a
 *  page that only knows where its Back button points (the person page) uses to
 *  keep the nav its visitor arrived under. Per-type paths answer it on their
 *  own; the cross-type lists need the explicit `?section=` they are linked with. */
export function sectionFromHref(href: string | null | undefined): QuerySection | null {
  if (!href) return null;
  const [path, query = ""] = href.split("?");
  const named = sectionFromName(new URLSearchParams(query).get("section"));
  if (named) return named;
  if (path.startsWith("/ebooks")) return bookSectionNav("ebook");
  if (path.startsWith("/audiobooks")) return bookSectionNav("audiobook");
  return null;
}

function sectionFromName(name: string | null): QuerySection | null {
  if (name === "ebooks") return bookSectionNav("ebook");
  if (name === "audiobooks") return bookSectionNav("audiobook");
  return null;
}
