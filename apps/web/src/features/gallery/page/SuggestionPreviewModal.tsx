import { useTranslation } from "react-i18next";
import { Film, Image as ImageIcon, Play, Sparkles } from "lucide-react";
import { Modal } from "../../../shared/Modal";
import type { GalleryAsset, GalleryMemorySuggestion } from "../types";

// Suggested-slideshow preview: look at the photos first, then create a slideshow
// from them. Closing without creating = nothing happens.
export function SuggestionPreviewModal({
  suggestion,
  assets,
  onCreate,
  onClose
}: {
  suggestion: GalleryMemorySuggestion;
  /** null while the thumbnails load. */
  assets: GalleryAsset[] | null;
  onCreate: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <Modal
      variant="panel"
      title={suggestion.title}
      icon={<Sparkles size={20} />}
      className="add-to-album-modal"
      onClose={onClose}
    >
      <div className="add-to-album-head suggestion-preview-head">
        <p className="muted">{suggestion.subtitle}</p>
        <div className="suggestion-preview-actions">
          <button
            type="button"
            className="primary-button compact-button"
            onClick={onCreate}
          >
            <Film size={15} aria-hidden="true" /> {t("gallery:slideshows.createTitle")}
          </button>
        </div>
      </div>
      <div className="modal-tab-content add-to-album-body">
        {assets === null ? (
          <p className="management-empty">{t("gallery:suggestions.loadingPhotos")}</p>
        ) : assets.length === 0 ? (
          <p className="management-empty">{t("gallery:suggestions.previewEmpty")}</p>
        ) : (
          <div className="gallery-folder-grid suggestion-preview-grid">
            {assets.map((asset) => (
              <div key={asset.id} className="gallery-folder-tile suggestion-preview-tile">
                <span className="gallery-folder-thumb">
                  {asset.coverUrl ? <img src={asset.coverUrl} alt={asset.title} loading="lazy" /> : <ImageIcon size={26} aria-hidden="true" />}
                  {asset.kind === "video" && <span className="gallery-video-badge"><Play size={11} aria-hidden="true" />{t("gallery:common.video")}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
