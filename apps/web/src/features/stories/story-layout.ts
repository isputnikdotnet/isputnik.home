import type { PhotoGroupLayout, StoryBlock, StoryChapter } from "./types";

// Layout rules shared by the reading view and the editor preview, kept out of
// both components so they can't drift apart.

/** How many photos sit side by side before a new row starts. */
const MAX_ROW = 3;

/** A mosaic row's width ÷ its height. Rows are packed until they reach this,
 *  so every row lands at roughly the same comfortable height whatever shapes
 *  it holds — about a third of the measure. */
const MOSAIC_TARGET = 2.6;

/** A last row shorter than this fraction of the target is folded back into the
 *  row above rather than left as one lonely photo on a line of its own. */
const MOSAIC_ORPHAN = 0.55;

/** Fallback shape for a photo whose dimensions were never read: 3:2, the shape
 *  most cameras hand back, so an unmeasured photo sits in a plate rather than
 *  forcing every row around it. */
const DEFAULT_ASPECT = 1.5;

/** A photo's width ÷ height, already turned by any manual rotation (the server
 *  swaps the sides before sending them). Clamped: a panorama or a scanned strip
 *  would otherwise squash a whole row to a few pixels high. */
export function photoAspect(asset: { width: number | null; height: number | null }): number {
  if (!asset.width || !asset.height) return DEFAULT_ASPECT;
  return Math.min(3, Math.max(0.4, asset.width / asset.height));
}

/** One row of a mosaic. `aspect` is what the row's own box is set to, and each
 *  photo's `grow` shares that row out in proportion to its shape — so every
 *  photo keeps its shape AND the row fills the measure exactly.
 *  `filled` false = a last row that didn't reach the target: it is laid out at
 *  the target height and left short, because stretching three snapshots across
 *  the page to tidy the edge is worse than the gap. */
export interface MosaicRow<T> {
  photos: { photo: T; grow: number }[];
  aspect: number;
  filled: boolean;
}

/** Pack photos into justified rows — the plate `mosaic` draws. Greedy: take
 *  photos until the row is wide enough for the target height, then start a new
 *  one. Portrait photos therefore sit beside each other and a landscape shot
 *  takes a row or shares it, which is what makes the plate uneven on purpose. */
export function packMosaicRows<T extends { width: number | null; height: number | null }>(
  photos: T[]
): MosaicRow<T>[] {
  const rows: MosaicRow<T>[] = [];
  let current: { photo: T; grow: number }[] = [];
  let sum = 0;
  for (const photo of photos) {
    const grow = photoAspect(photo);
    current.push({ photo, grow });
    sum += grow;
    if (sum >= MOSAIC_TARGET) {
      rows.push({ photos: current, aspect: sum, filled: true });
      current = [];
      sum = 0;
    }
  }
  if (current.length > 0) {
    const last = rows[rows.length - 1];
    // A stub of a final row joins the one above it, which simply gets taller.
    if (last && sum < MOSAIC_TARGET * MOSAIC_ORPHAN) {
      last.photos.push(...current);
      last.aspect += sum;
    } else {
      rows.push({ photos: current, aspect: Math.max(sum, MOSAIC_TARGET), filled: false });
    }
  }
  return rows;
}

/** The layout a group is drawn with. Anything unset — or a `default`/`wide`
 *  left on a block that became a group — reads as the mosaic default, so a
 *  group always has a plate to draw. */
export function groupLayout(layout: string | null): PhotoGroupLayout {
  return layout === "grid" || layout === "stack" ? layout : "mosaic";
}

// Consecutive SINGLE-photo blocks group into one row, so three snapshots from
// the same afternoon read as a plate instead of three full-width images. A
// `wide` photo, a video, and every non-media block always stand alone.
//
// This is the old implicit grouping, kept for the stories that were written
// under it: it is a guess, and a guess that a caption silently undid. A group
// of photos is now a block of its own (kind `photos`) that says so — see
// packMosaicRows above — and that is what the Photos choice makes today.
// Nothing here applies to a `photos` block: it is one block and stands alone.
export function groupIntoRows(blocks: StoryBlock[]): StoryBlock[][] {
  const rows: StoryBlock[][] = [];
  for (const block of blocks) {
    const groupable =
      block.kind === "media" &&
      block.available &&
      block.layout !== "wide" &&
      block.asset?.kind === "photo" &&
      // A captioned photo — or one under its own heading — is making a point of
      // its own; don't crowd it into a row.
      !block.caption &&
      !block.heading;
    const last = rows[rows.length - 1];
    const lastGroupable = last?.length && last.every((item) =>
      item.kind === "media" && item.layout !== "wide" && item.asset?.kind === "photo" &&
      !item.caption && !item.heading
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
