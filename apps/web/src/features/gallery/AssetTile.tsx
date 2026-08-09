import { useState } from "react";
import { CheckCircle2, Download, Heart, Image as ImageIcon, Play, UserRound, X } from "lucide-react";
import type { GalleryAsset } from "./types";
import { faceFocusStyle } from "./types";

// The leaf pieces of a gallery grid, lifted out of GalleryPage so that file is
// about the page rather than about a tile. Both are presentational: no data
// loading, no page state, everything in through props.
//
// Deliberately NOT memoised. It looks like it should be — up to PAGE_SIZE tiles
// re-render whenever anything on the page changes, including every keystroke in
// the search box. Measured on a production build with 80 tiles on screen, a
// keystroke costs 0.8 ms to render and commit, and wrapping this in memo() took
// it to 2.3 ms: the shallow prop compare across eighty tiles costs more than
// re-rendering a button and an img. (In a dev build the same keystroke measures
// ~70 ms, which is StrictMode double-invoking renders on unminified React, not
// anything a user ever sees. Profile the preview build, not the dev server.)

/** Which list the lightbox should page through when a tile is opened. */
export type LightboxSource =
  | "timeline" | "folder" | "single" | "person" | "memory" | "album" | "slideshow";

export function AssetTile({
  asset,
  onOpen,
  selectionMode,
  selected,
  onToggleSelect,
  onRemove,
  removeTitle = "Not this person — remove from here"
}: {
  asset: GalleryAsset;
  onOpen: () => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  // When set (person page / album detail), a corner button detaches this photo
  // from the containing set. removeTitle names what it detaches from.
  onRemove?: () => void;
  removeTitle?: string;
}) {
  const tile = (
    <button
      type="button"
      className={`gallery-tile${selectionMode ? " selectable" : ""}${selected ? " selected" : ""}`}
      onClick={selectionMode ? onToggleSelect : onOpen}
      aria-pressed={selectionMode ? selected : undefined}
      aria-label={selectionMode ? `Select ${asset.title}` : `Open ${asset.title}`}
    >
      {asset.coverUrl ? (
        <img src={asset.coverUrl} alt="" loading="lazy" style={faceFocusStyle(asset)} />
      ) : (
        <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
      )}
      {asset.saved && !selectionMode && <Heart size={14} className="gallery-fav-dot" fill="currentColor" aria-hidden="true" />}
      {asset.kind === "video" && (
        asset.playable === false ? (
          <span className="gallery-video-badge unplayable" title="Can’t play in browser — download to view">
            <Download size={11} aria-hidden="true" />Video
          </span>
        ) : (
          <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />Video</span>
        )
      )}
      {/* Only a selected tile gets the check overlay — unselected tiles stay
          clean rather than all sprouting empty circles in selection mode. */}
      {selectionMode && selected && (
        <span className="gallery-tile-check" aria-hidden="true">
          <CheckCircle2 size={22} />
        </span>
      )}
    </button>
  );
  if (!onRemove) return tile;
  return (
    <div className="gallery-tile-wrap">
      {tile}
      <button
        type="button"
        className="gallery-tile-remove"
        onClick={(event) => { event.stopPropagation(); onRemove(); }}
        aria-label={`Remove ${asset.title}`}
        title={removeTitle}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// A person's avatar with a graceful fallback: if the crop can't load (a missing file,
// or a request that got rate-limited), show the placeholder icon instead of the
// browser's broken-image glyph.
export function PersonAvatar({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <UserRound size={28} aria-hidden="true" />;
  return <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />;
}
