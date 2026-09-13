import type { GalleryView } from "../../../router";
import i18n from "../../../i18n";
import { formatDate } from "../../../shared/dates";
import type { LightboxSource } from "../AssetTile";
import type { GalleryMemories, GalleryMemoryGroup, TakenPrecision } from "../types";
import { formatTakenDate } from "../taken-date";

// Shared by the gallery page and its views: page sizes, the lightbox state, and
// the few pure helpers that name what is on screen.

export const PAGE_SIZE = 80;
// The most a single browse request may ask for (the server caps it there). A
// refresh re-fetches what is already on screen in chunks this size, so a visitor
// deep into "Load more" keeps every page they asked for.
export const MAX_PAGE_SIZE = 200;
// The People grid can hold thousands of clusters; render them a page at a time so a
// wall of avatar thumbnails doesn't flood the cover route (and trip its rate limit).
export const PEOPLE_PAGE = 120;

export type TimelineSort = "taken" | "added";

/** Which array + index the lightbox has open. A deep-linked asset opens standalone. */
export interface LightboxState {
  source: LightboxSource;
  index: number;
  autoPlay?: boolean;
}

// What the page calls itself in each view. The Timeline is the gallery's own
// front page, so it keeps the section's name; every other view is titled after
// the nav item that opens it, the way Series and Narrators are under Audiobooks.
//
// A function, not a frozen const, so a language switch is picked up on the next
// render instead of caching whichever language was active on first import.
export function getViewTitles(): Record<GalleryView, string> {
  return {
    timeline: i18n.t("gallery:page.views.timeline"),
    memories: i18n.t("gallery:page.views.memories"),
    albums: i18n.t("gallery:page.views.albums"),
    slideshows: i18n.t("gallery:page.views.slideshows"),
    folder: i18n.t("gallery:page.views.folder"),
    people: i18n.t("gallery:page.views.people"),
    places: i18n.t("gallery:page.views.places"),
    map: i18n.t("gallery:page.views.map")
  };
}

// Timeline sort, presented through the same compact dropdown the audiobooks/ebooks
// header uses, so the controls line up visually. The media-type (photo/video)
// filter lives in the Filter panel with the other facets.
export function getSortOptions() {
  return [
    { value: "taken" as const, label: i18n.t("gallery:page.sort.taken") },
    { value: "added" as const, label: i18n.t("gallery:page.sort.added") }
  ];
}

// Titles for the Memories strip — the server reports how wide it had to match
// before it found anything, and the heading must not overpromise.
export function getMemoriesTitles(): Record<GalleryMemories["precision"], string> {
  return {
    day: i18n.t("gallery:memories.titleDay"),
    near: i18n.t("gallery:memories.titleNear"),
    month: i18n.t("gallery:memories.titleMonth")
  };
}

export function yearsAgo(year: number): string {
  const diff = new Date().getFullYear() - year;
  return i18n.t("gallery:memories.yearsAgo", { count: diff });
}

// Date heading for one year group in the Memories view — today's month/day
// projected onto that year, phrased to match the precision tier. Takes the
// GROUP's precision, not the row's: years widen independently, so a 1990 photo
// dated two days off says "Around August 11, 1990" while the rest of the row
// still says the day itself.
export function memoryDateLabel(precision: GalleryMemoryGroup["precision"], year: number): string {
  const now = new Date();
  if (precision === "month") {
    return formatDate(new Date(year, now.getMonth(), 1), "monthYear");
  }
  const day = formatDate(new Date(year, now.getMonth(), now.getDate()), "long");
  return precision === "near" ? i18n.t("gallery:memories.aroundDate", { date: day }) : day;
}

// Calendar-day label for the timeline header from an asset's takenAt — or, for a
// photo dated only to the month or the year, that month or year, so a box of
// "1962" prints heads one group rather than pretending to share New Year's Day.
export function dayLabel(asset: { takenAt: string | null; takenPrecision?: TakenPrecision; takenApprox?: boolean }): string {
  const label = formatTakenDate(asset, { long: true });
  return label || i18n.t("gallery:timeline.undated");
}
