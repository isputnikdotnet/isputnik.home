import { useEffect, useState } from "react";

// Which sections this household uses — the admin's switches on Settings →
// Appearance (server: core/sections.ts). The answer arrives on /api/setup/status
// before the first paint, so the menu is drawn right from the start, and it is
// kept here in module state (like the games' availability) rather than in the
// session: every shell, page and route guard reads it, and the Sections card
// updates it the moment a switch moves, without a reload.
//
// Remembered in localStorage for the installed app's offline start, where the
// status call fails and the cached identity signs in: the menu then looks as it
// did last time rather than briefly showing everything.

export const SECTION_KEYS = ["audiobooks", "ebooks", "gallery", "familyTree", "stories", "games"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type Sections = Record<SectionKey, boolean>;

export const ALL_SECTIONS_ON: Sections = {
  audiobooks: true,
  ebooks: true,
  gallery: true,
  familyTree: true,
  stories: true,
  games: true
};

const STORAGE_KEY = "isputnik-sections";
const CHANGED = "isputnik:sections";

function normalise(value: unknown): Sections {
  const next = { ...ALL_SECTIONS_ON };
  if (value && typeof value === "object") {
    for (const key of SECTION_KEYS) {
      const flag = (value as Record<string, unknown>)[key];
      if (typeof flag === "boolean") next[key] = flag;
    }
  }
  return next;
}

function cached(): Sections {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalise(JSON.parse(raw)) : { ...ALL_SECTIONS_ON };
  } catch {
    return { ...ALL_SECTIONS_ON };
  }
}

let current: Sections = cached();

/** The sections as last told by the server (or remembered from last time). */
export function currentSections(): Sections {
  return current;
}

/** What the server said — on /api/setup/status at start, or the Sections card's save. */
export function rememberSections(value: unknown): void {
  current = normalise(value);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Private mode or storage full: the menu is still right for this load.
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function useSections(): Sections {
  const [sections, setSections] = useState<Sections>(current);
  useEffect(() => {
    const update = () => setSections(current);
    update();
    window.addEventListener(CHANGED, update);
    return () => window.removeEventListener(CHANGED, update);
  }, []);
  return sections;
}

/** Tests only. */
export function resetSections(): void {
  current = { ...ALL_SECTIONS_ON };
}

// The section a route belongs to, where it belongs to one; null for the pages
// every install has (home, profile, likes, tags, …). "books" is either book
// section: the author, category and series pages span both and stay as long as
// one of them is on.
type RouteSection = SectionKey | "books" | null;

const ROUTE_SECTIONS: Record<string, RouteSection> = {
  audiobooks: "audiobooks", audiobookBook: "audiobooks", audiobookPlayer: "audiobooks",
  audiobookNarrators: "audiobooks", audiobookNarratorDetail: "audiobooks",
  audiobookSeries: "audiobooks", audiobookSeriesDetail: "audiobooks", audiobookAuthorDetail: "audiobooks",
  personDetail: "audiobooks",
  ebooks: "ebooks", ebookBook: "ebooks", ebookAuthorDetail: "ebooks", ebookSeries: "ebooks", ebookSeriesDetail: "ebooks",
  gallery: "gallery", galleryAlbum: "gallery", galleryAsset: "gallery", galleryFolder: "gallery",
  galleryInbox: "gallery", galleryPerson: "gallery", galleryReview: "gallery", galleryReviewAlbum: "gallery",
  gallerySlideshow: "gallery",
  familyTree: "familyTree", familyPeople: "familyTree", familyFamilies: "familyTree", familyMap: "familyTree",
  familyPerson: "familyTree", familyPersonPhotos: "familyTree",
  stories: "stories", storyDetail: "stories", storyChapter: "stories", storyCollection: "stories", storyEditor: "stories",
  authors: "books", categories: "books", categoryDetail: "books", libraryFeed: "books"
};

/** Whether a route may open with these sections; a direct link to a section that
 *  is off lands on the home page instead. */
export function routeAllowed(routeName: string, sections: Sections): boolean {
  const section = ROUTE_SECTIONS[routeName] ?? null;
  if (section === null) return true;
  if (section === "books") return sections.audiobooks || sections.ebooks;
  return sections[section];
}
