import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../shared/Button";
import { faceFocusStyle } from "../gallery/types";
import { groupLayout, packMosaicRows } from "./story-layout";
import type { PhotoGroupLayout } from "./types";

/** The least a plate needs to know about a photo. Deliberately narrower than
 *  GalleryAsset: the guest share page has its own token-scoped asset shape and
 *  draws the SAME plates, so the layout is shared instead of forked. Both
 *  StoryGroupPhoto and StoryShareAsset satisfy it. */
export interface PlatePhoto {
  id: string;
  title: string;
  previewUrl: string | null;
  coverUrl: string | null;
  width: number | null;
  height: number | null;
  /** The line the author wrote under this photo, on this plate. */
  blockCaption: string | null;
  /** Where the face is, for the layouts that crop. A guest payload has none. */
  faceFocus?: { x: number; y: number } | null;
}

// A plate of photos: one block holding several, drawn the way its author asked.
//
// The three layouts answer the same question differently — "how do these belong
// together?" — and none of them is a compromise of the others:
//   mosaic · justified rows of uneven widths. Every photo keeps its own shape,
//            so portraits sit side by side and a wide shot spans. The default:
//            it is what a handful of snapshots from one afternoon looks like
//            laid out on a table.
//   grid   · equal square tiles. Deliberately uniform — a set of portraits, a
//            page of scanned prints, anything where the rhythm is the point and
//            the crop doesn't matter.
//   stack  · one after another at full measure, each at its own shape. For
//            photos that each deserve looking at, with room for a line under
//            every one.
//
// Read-only, and the same component the editor previews with, so what an author
// arranges IS what a reader gets.
export function StoryPhotoGroup({
  photos,
  layout,
  onOpen
}: {
  photos: PlatePhoto[];
  layout: string | null;
  /** Open the lightbox over the whole group, at the photo that was clicked. */
  onOpen: (index: number) => void;
}) {
  const chosen: PhotoGroupLayout = groupLayout(layout);
  if (photos.length === 0) return null;
  // The lightbox opens over the whole group, so every cell needs its place in
  // the authored order — which the mosaic's rows no longer carry.
  const positions = new Map(photos.map((photo, index) => [photo.id, index]));

  if (chosen === "stack") {
    return (
      <div className="story-photo-group" data-layout="stack">
        {photos.map((photo, index) => (
          <figure className="story-photo-stacked" key={photo.id}>
            <PhotoButton photo={photo} index={index} onOpen={onOpen} />
            {photo.blockCaption && <figcaption>{photo.blockCaption}</figcaption>}
          </figure>
        ))}
      </div>
    );
  }

  if (chosen === "grid") {
    return (
      <div className="story-photo-group" data-layout="grid">
        {photos.map((photo, index) => (
          <figure className="story-photo-tile" key={photo.id}>
            <PhotoButton photo={photo} index={index} onOpen={onOpen} />
            {photo.blockCaption && <figcaption>{photo.blockCaption}</figcaption>}
          </figure>
        ))}
      </div>
    );
  }

  // Mosaic. Each row's box carries the summed aspect of the photos on it, and
  // each photo grows in proportion to its own — so the row fills the measure
  // exactly while every photo keeps its shape. A short last row keeps the
  // target height and is left short rather than stretched to tidy the edge.
  return (
    <div className="story-photo-group" data-layout="mosaic">
      {packMosaicRows(photos).map((row) => (
        // The row's shape and each cell's share ride as custom properties, not
        // as inline aspect-ratio/width: a phone drops the justified rows for a
        // two-up plate, and a stylesheet can only override a declaration it
        // owns — an inline one would need !important to shift.
        <div
          className="story-photo-mosaic-row"
          key={row.photos[0].photo.id}
          style={{ "--row-aspect": String(row.aspect) } as CSSProperties}
          data-filled={row.filled ? "yes" : "no"}
        >
          {row.photos.map(({ photo, grow }) => (
            <figure
              className="story-photo-cell"
              key={photo.id}
              style={row.filled
                ? ({ "--cell-grow": grow } as CSSProperties)
                // A short row: each photo takes exactly the width its shape
                // needs at the row's height, and the row simply ends early.
                : ({ "--cell-grow": 0, "--cell-width": `${(grow / row.aspect) * 100}%` } as CSSProperties)}
            >
              <PhotoButton photo={photo} index={positions.get(photo.id) ?? 0} onOpen={onOpen} />
              {photo.blockCaption && <figcaption>{photo.blockCaption}</figcaption>}
            </figure>
          ))}
        </div>
      ))}
    </div>
  );
}

/** One photo of the plate: the thumbnail, opening the group's lightbox. */
function PhotoButton({
  photo,
  index,
  onOpen
}: {
  photo: PlatePhoto;
  index: number;
  onOpen: (index: number) => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  return (
    <Button
      variant="bare"
      className="story-photo-button"
      onClick={() => onOpen(index)}
      aria-label={t("stories:block.openPhoto", { title: photo.title })}
    >
      <img
        src={photo.previewUrl ?? photo.coverUrl ?? ""}
        alt={photo.blockCaption ?? photo.title}
        loading="lazy"
        // A square tile crops, so it crops around the face when one is known —
        // the same focus the gallery's own grids use.
        style={faceFocusStyle(photo)}
      />
    </Button>
  );
}
