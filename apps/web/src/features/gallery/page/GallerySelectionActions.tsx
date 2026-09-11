import { useTranslation } from "react-i18next";
import { CalendarClock, CheckCheck, Film, Heart, ImagePlus, ListMusic, MapPinned, MessageSquareText, Share2, Tags, Trash2, X } from "lucide-react";

// What the gallery toolbar holds while photos are selected: select all, then every
// bulk verb — like, add to an album / slideshow / collection, share, tag, date,
// place, ask someone, delete — and Done. Labelled, as on the book pages: an
// unlabelled trash icon is exactly where hesitation costs the most.
export function GallerySelectionActions({
  selectedCount,
  selectableCount,
  busy,
  canShareAny,
  canWriteAny,
  canDeleteAny,
  onSelectAll,
  onLike,
  onAddToAlbum,
  onAddToSlideshow,
  onAddToCollection,
  onShare,
  onTag,
  onDate,
  onPlace,
  onAskSomeone,
  onDelete,
  onDone
}: {
  selectedCount: number;
  /** How many photos on screen "All" would select. */
  selectableCount: number;
  busy: boolean;
  canShareAny: boolean;
  canWriteAny: boolean;
  canDeleteAny: boolean;
  onSelectAll: () => void;
  onLike: () => void;
  onAddToAlbum: () => void;
  onAddToSlideshow: () => void;
  onAddToCollection: () => void;
  onShare: () => void;
  onTag: () => void;
  onDate: () => void;
  onPlace: () => void;
  onAskSomeone: () => void;
  onDelete: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const idle = selectedCount === 0 || busy;
  return (
    <>
      <button
        type="button"
        className="library-toolbar-button"
        onClick={onSelectAll}
        disabled={selectableCount === 0}
        title={t("gallery:bulk.selectAllTitle")}
      >
        <CheckCheck size={18} aria-hidden="true" />
        <span className="toolbar-label">{t("gallery:bulk.all")}</span>
      </button>
      <button
        type="button"
        className="library-toolbar-button"
        onClick={onLike}
        disabled={idle}
        title={busy ? t("gallery:bulk.liking") : t("gallery:bulk.like")}
      >
        <Heart size={18} aria-hidden="true" />
        <span className="toolbar-label">{t("gallery:bulk.like")}</span>
      </button>
      <button
        type="button"
        className="library-toolbar-button"
        onClick={onAddToAlbum}
        disabled={idle}
        title={t("gallery:bulk.addToAlbumTitle")}
      >
        <ImagePlus size={18} aria-hidden="true" />
        <span className="toolbar-label">{t("gallery:bulk.albumLabel")}</span>
      </button>
      <button
        type="button"
        className="library-toolbar-button"
        onClick={onAddToSlideshow}
        disabled={idle}
        title={t("gallery:bulk.addToSlideshowTitle")}
      >
        <Film size={18} aria-hidden="true" />
        <span className="toolbar-label">{t("gallery:bulk.slideshowLabel")}</span>
      </button>
      <button
        type="button"
        className="library-toolbar-button"
        onClick={onAddToCollection}
        disabled={idle}
        title={t("gallery:bulk.addToCollectionTitle")}
      >
        <ListMusic size={18} aria-hidden="true" />
        <span className="toolbar-label">{t("gallery:bulk.collectionLabel")}</span>
      </button>
      {canShareAny && (
        <button
          type="button"
          className="library-toolbar-button"
          onClick={onShare}
          disabled={idle}
          title={t("gallery:bulk.shareTitle")}
        >
          <Share2 size={18} aria-hidden="true" />
          <span className="toolbar-label">{t("gallery:bulk.shareTitle")}</span>
        </button>
      )}
      {canWriteAny && (
        <button
          type="button"
          className="library-toolbar-button"
          onClick={onTag}
          disabled={idle}
          title={t("gallery:bulk.tagTitle")}
        >
          <Tags size={18} aria-hidden="true" />
          <span className="toolbar-label">{t("gallery:bulk.tagLabel")}</span>
        </button>
      )}
      {canWriteAny && (
        <button
          type="button"
          className="library-toolbar-button"
          onClick={onDate}
          disabled={idle}
          title={t("gallery:bulk.setDateTitle")}
        >
          <CalendarClock size={18} aria-hidden="true" />
          <span className="toolbar-label">{t("gallery:bulk.dateLabel")}</span>
        </button>
      )}
      {canWriteAny && (
        <button
          type="button"
          className="library-toolbar-button"
          onClick={onPlace}
          disabled={idle}
          title={t("gallery:bulk.setLocationTitle")}
        >
          <MapPinned size={18} aria-hidden="true" />
          <span className="toolbar-label">{t("gallery:bulk.placeLabel")}</span>
        </button>
      )}
      <button
        type="button"
        className="library-toolbar-button"
        onClick={onAskSomeone}
        disabled={idle}
        title={t("gallery:bulk.askSomeoneTitle")}
      >
        <MessageSquareText size={18} aria-hidden="true" />
        <span className="toolbar-label">{t("gallery:bulk.askSomeoneLabel")}</span>
      </button>
      {canDeleteAny && (
        <button
          type="button"
          className="library-toolbar-button danger"
          onClick={onDelete}
          disabled={idle}
          title={t("gallery:bulk.deleteTitle")}
        >
          <Trash2 size={18} aria-hidden="true" />
          <span className="toolbar-label">{t("gallery:bulk.deleteLabel")}</span>
        </button>
      )}
      <span className="library-toolbar-divider" aria-hidden="true" />
      <button type="button" className="library-toolbar-button" onClick={onDone} title={t("gallery:bulk.leaveSelectionTitle")}>
        <X size={18} aria-hidden="true" />
        <span className="toolbar-label">{t("common:common.done")}</span>
      </button>
    </>
  );
}
