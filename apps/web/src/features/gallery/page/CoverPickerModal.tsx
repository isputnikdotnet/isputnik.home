import { useTranslation } from "react-i18next";
import { CheckCircle2, Image as ImageIcon } from "lucide-react";
import { Modal } from "../../../shared/Modal";
import type { GalleryAsset } from "../types";
import { Button } from "../../../shared/Button";

// "Set cover photo" for an album, a slideshow or a person: their photos as a grid,
// the current cover ticked, a click makes one the cover.
export function CoverPickerModal({
  hint,
  emptyText,
  assets,
  coverItemId,
  onPick,
  onClose
}: {
  hint: string;
  emptyText: string;
  assets: GalleryAsset[];
  coverItemId: string | null | undefined;
  onPick: (assetId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <Modal
      variant="panel"
      title={t("gallery:common.setCoverPhoto")}
      icon={<ImageIcon size={20} />}
      className="gallery-cover-modal"
      onClose={onClose}
    >
      <div className="modal-tab-content">
        <p className="muted">{hint}</p>
        {assets.length === 0 ? (
          <p className="management-empty">{emptyText}</p>
        ) : (
          <div className="gallery-grid gallery-cover-grid">
            {assets.map((asset) => (
              <Button
                variant="tile"
                key={asset.id}
                className={`gallery-tile${asset.id === coverItemId ? " selected" : ""}`}
                onClick={() => onPick(asset.id)}
                aria-label={t("gallery:page.dialogs.useAsCoverAria", { title: asset.title })}
                title={t("gallery:page.dialogs.useAsCoverAria", { title: asset.title })}
              >
                {asset.coverUrl ? (
                  <img src={asset.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="gallery-tile-fallback"><ImageIcon size={26} aria-hidden="true" /></span>
                )}
                {asset.id === coverItemId && (
                  <span className="gallery-tile-check" aria-hidden="true"><CheckCircle2 size={22} /></span>
                )}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
