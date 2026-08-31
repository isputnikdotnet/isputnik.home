import type { StoryBlock, StoryChapter } from "./types";

// Layout rules shared by the reading view and the editor preview, kept out of
// both components so they can't drift apart.

/** How many photos sit side by side before a new row starts. */
const MAX_ROW = 3;

// Consecutive photo blocks group into one row, so three snapshots from the same
// afternoon read as a plate instead of three full-width images. A `wide` photo,
// a video, and every non-media block always stand alone.
export function groupIntoRows(blocks: StoryBlock[]): StoryBlock[][] {
  const rows: StoryBlock[][] = [];
  for (const block of blocks) {
    const groupable =
      block.kind === "media" &&
      block.available &&
      block.layout !== "wide" &&
      block.asset?.kind === "photo" &&
      // A captioned photo is making a point of its own; don't crowd it.
      !block.caption;
    const last = rows[rows.length - 1];
    const lastGroupable = last?.length && last.every((item) =>
      item.kind === "media" && item.layout !== "wide" && item.asset?.kind === "photo" && !item.caption
    );
    if (groupable && lastGroupable && last.length < MAX_ROW) {
      last.push(block);
    } else {
      rows.push([block]);
    }
  }
  return rows;
}

// A chapter's date as prose: "2004", or "Jul 12–19, 2004" for a range. An
// approximate date is wrapped by the caller (t("stories:chapter.approx")) so the
// typed translator stays where it belongs — in the component.
export function chapterDateText(
  chapter: Pick<StoryChapter, "date" | "endDate">,
  formatDate: (value: string | null | undefined) => string,
  formatRange: (start: string | null | undefined, end: string | null | undefined) => string
): string {
  if (!chapter.date) return "";
  return chapter.endDate ? formatRange(chapter.date, chapter.endDate) : formatDate(chapter.date);
}
