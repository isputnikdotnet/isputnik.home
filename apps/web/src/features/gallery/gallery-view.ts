import type { SortOption } from "../../shared/SortMenu";
import i18n from "../../i18n";

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

// Functions rather than frozen consts, so a language switch is picked up on the
// next render instead of caching whichever language was active on first import.
export function getTileSizeOptions(): SortOption<GalleryTileSize>[] {
  return [
    { value: "small", label: i18n.t("gallery:view.tileSmall") },
    { value: "medium", label: i18n.t("gallery:view.tileMedium") },
    { value: "large", label: i18n.t("gallery:view.tileLarge") }
  ];
}

export function getGroupingOptions(): SortOption<GalleryGrouping>[] {
  return [
    { value: "day", label: i18n.t("gallery:view.groupByDay") },
    { value: "none", label: i18n.t("gallery:view.oneContinuousGrid") }
  ];
}

// The valid values themselves — not the (now language-dependent) display
// labels — are what a stored preference is checked against.
const TILE_SIZE_VALUES: GalleryTileSize[] = ["small", "medium", "large"];
const GROUPING_VALUES: GalleryGrouping[] = ["day", "none"];

const DEFAULTS: GalleryViewPrefs = { tileSize: "medium", grouping: "day" };
const STORE_KEY = "gallery.view";

export function readGalleryView(): GalleryViewPrefs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULTS;
    const stored = JSON.parse(raw) as Partial<GalleryViewPrefs>;
    // Anything the options no longer offer (an older build's value, a hand-edited
    // entry) falls back rather than leaving the grid in a state with no CSS.
    const tileSize = TILE_SIZE_VALUES.includes(stored.tileSize as GalleryTileSize);
    const grouping = GROUPING_VALUES.includes(stored.grouping as GalleryGrouping);
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
