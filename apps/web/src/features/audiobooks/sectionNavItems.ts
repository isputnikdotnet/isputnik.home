import { BookOpen, Library, Mic2, Shapes, UserRound } from "lucide-react";
import type { DashboardActive } from "../../app/DashboardShell";
import type { SectionNavItem } from "../../shared/SectionNav";

// Authors and Categories are single cross-type pages (AuthorListPage,
// CategoryListPage/CategoryDetailPage), so there's no `kind` to key off like
// Series has — the `section` query param is how they know which of these lists
// sent them there, so they can keep showing that section's left nav instead of
// falling back to the generic one. See sectionFromQuery() below.
export const EBOOK_NAV_ITEMS: SectionNavItem[] = [
  { key: "books", label: "All Ebooks", href: "/ebooks", icon: BookOpen },
  { key: "authors", label: "Authors", href: "/authors?section=ebooks", icon: UserRound },
  { key: "series", label: "Series", href: "/ebooks/series", icon: Library },
  { key: "categories", label: "Categories", href: "/categories?section=ebooks", icon: Shapes }
];

export const AUDIOBOOK_NAV_ITEMS: SectionNavItem[] = [
  { key: "books", label: "All Audiobooks", href: "/audiobooks", icon: BookOpen },
  { key: "authors", label: "Authors", href: "/authors?section=audiobooks", icon: UserRound },
  { key: "narrators", label: "Narrators", href: "/audiobooks/narrators", icon: Mic2 },
  { key: "series", label: "Series", href: "/audiobooks/series", icon: Library },
  { key: "categories", label: "Categories", href: "/categories?section=audiobooks", icon: Shapes }
];

export interface QuerySection {
  active: DashboardActive;
  items: SectionNavItem[];
}

// Reads the `?section=` a cross-type page (Authors, Categories) was linked in
// with, so it can keep showing the Ebooks/Audiobooks nav that sent it there.
// Reached any other way — Tags, a bookmark, a typed URL — this returns null and
// the page falls back to the generic main nav, same as before `section` existed.
export function sectionFromQuery(): QuerySection | null {
  const section = new URLSearchParams(window.location.search).get("section");
  if (section === "ebooks") return { active: "ebooks", items: EBOOK_NAV_ITEMS };
  if (section === "audiobooks") return { active: "audiobooks", items: AUDIOBOOK_NAV_ITEMS };
  return null;
}
