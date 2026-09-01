import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Download, Heart, Image as ImageIcon, Mic, Play, UserRound, X } from "lucide-react";
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
  removeTitle,
  onToggleLike
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
  // When set, the tile carries its own heart. This is the cheap tap the whole
  // year-in-review depends on: liking from a grid must not cost opening the
  // photo, hearting it and coming back.
  onToggleLike?: (next: boolean) => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const resolvedRemoveTitle = removeTitle ?? t("gallery:assetTile.removeDefaultTitle");
  // No heart while selecting — the tile means "pick me" then, and a second target
  // on it is a mis-tap waiting to happen.
  const canLike = Boolean(onToggleLike) && !selectionMode;
  const tile = (
    <button
      type="button"
      className={`gallery-tile${selectionMode ? " selectable" : ""}${selected ? " selected" : ""}`}
      onClick={selectionMode ? onToggleSelect : onOpen}
      aria-pressed={selectionMode ? selected : undefined}
      aria-label={selectionMode ? t("gallery:assetTile.selectAria", { title: asset.title }) : t("gallery:assetTile.openAria", { title: asset.title })}
    >
      {asset.coverUrl ? (
        <img src={asset.coverUrl} alt="" loading="lazy" style={faceFocusStyle(asset)} />
      ) : (
        // A recording usually has no artwork at all (only embedded cover art
        // yields one), so its fallback is the mic, not the broken-photo icon.
        <span className="gallery-tile-fallback">
          {asset.kind === "audio" ? <Mic size={26} aria-hidden="true" /> : <ImageIcon size={26} aria-hidden="true" />}
        </span>
      )}
      {/* The read-only marker, for grids that don't offer the heart button below —
          which renders its own filled heart in the same corner. */}
      {asset.saved && !selectionMode && !canLike && <Heart size={14} className="gallery-like-dot" fill="currentColor" aria-hidden="true" />}
      {asset.kind === "video" && (
        asset.playable === false ? (
          <span className="gallery-video-badge unplayable" title={t("gallery:assetTile.unplayableTitle")}>
            <Download size={11} aria-hidden="true" />{t("gallery:common.video")}
          </span>
        ) : (
          <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />{t("gallery:common.video")}</span>
        )
      )}
      {asset.kind === "audio" && (
        <span className="gallery-video-badge"><Mic size={11} aria-hidden="true" />{t("gallery:common.audio")}</span>
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
  if (!onRemove && !canLike) return tile;
  // Both overlays are SIBLINGS of the tile, never children of it: the tile is
  // itself a <button>, and a button inside a button is invalid markup that screen
  // readers can't reach. gallery-tile-remove already established the shape.
  return (
    <div className="gallery-tile-wrap">
      {tile}
      {canLike && (
        <button
          type="button"
          className={`gallery-tile-like${asset.saved ? " on" : ""}`}
          onClick={(event) => { event.stopPropagation(); onToggleLike!(!asset.saved); }}
          aria-pressed={asset.saved}
          aria-label={asset.saved ? t("gallery:assetTile.unlikeAria", { title: asset.title }) : t("gallery:assetTile.likeAria", { title: asset.title })}
          title={asset.saved ? t("gallery:common.unlike") : t("gallery:common.like")}
        >
          <Heart size={15} fill={asset.saved ? "currentColor" : "none"} aria-hidden="true" />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          className="gallery-tile-remove"
          onClick={(event) => { event.stopPropagation(); onRemove(); }}
          aria-label={t("gallery:assetTile.removeAria", { title: asset.title })}
          title={resolvedRemoveTitle}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
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
