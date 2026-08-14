import type { SortOption } from "../../shared/SortMenu";

// How the gallery's photo grids look. Both settings sit behind one View control
// in the browse toolbar, next to Filter and Sort — see GalleryPage.
//
// Unlike the book pages' density (an in-session choice, see readCatalogView),
// these persist in localStorage: how big your photos are and whether they come
// in dated sections is a standing preference, the way the ebook reader remembers
// its font size, not something to re-pick on every visit.

/** How wide one tile in the photo grid is. */
export type GalleryTileSize = "small" | "medium" | "large";

/** Whether the timeline breaks into calendar-day sections or runs as one grid. */
export type GalleryGrouping = "day" | "none";

export interface GalleryViewPrefs {
  tileSize: GalleryTileSize;
  grouping: GalleryGrouping;
}

export const TILE_SIZE_OPTIONS: SortOption<GalleryTileSize>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" }
];

export const GROUPING_OPTIONS: SortOption<GalleryGrouping>[] = [
  { value: "day", label: "Group by day" },
  { value: "none", label: "One continuous grid" }
];

const DEFAULTS: GalleryViewPrefs = { tileSize: "medium", grouping: "day" };
const STORE_KEY = "gallery.view";

export function readGalleryView(): GalleryViewPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULTS;
    const stored = JSON.parse(raw) as Partial<GalleryViewPrefs>;
    // Anything the options no longer offer (an older build's value, a hand-edited
    // entry) falls back rather than leaving the grid in a state with no CSS.
    const tileSize = TILE_SIZE_OPTIONS.some((option) => option.value === stored.tileSize);
    const grouping = GROUPING_OPTIONS.some((option) => option.value === stored.grouping);
    return {
      tileSize: tileSize ? stored.tileSize! : DEFAULTS.tileSize,
      grouping: grouping ? stored.grouping! : DEFAULTS.grouping
    };
  } catch {
    return DEFAULTS; // private mode, or a value that isn't JSON
  }
}

export function writeGalleryView(prefs: GalleryViewPrefs) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

/** The photo grid's class list at the chosen tile size. */
export function galleryGridClass(size: GalleryTileSize) {
  return `gallery-grid tiles-${size}`;
}
