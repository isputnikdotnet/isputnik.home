import { useTranslation } from "react-i18next";
import { Modal } from "../../../shared/Modal";

// The two "New …" dialogs the Albums and Slideshows lists open from the header's
// primary slot. Their state lives in useGalleryAlbums / useGallerySlideshows.

export function CreateAlbumModal({
  name,
  description,
  busy,
  onNameChange,
  onDescriptionChange,
  onSubmit,
  onClose
}: {
  name: string;
  description: string;
  busy: boolean;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <Modal
      variant="card"
      title={t("gallery:albums.createTitle")}
      onClose={() => { if (!busy) onClose(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <label className="field">
          <span>{t("gallery:common.name")}</span>
          <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder={t("gallery:albums.namePlaceholderExample")} autoFocus maxLength={120} />
        </label>
        <label className="field">
          <span>{t("gallery:albums.descriptionLabel")}</span>
          <input value={description} onChange={(event) => onDescriptionChange(event.target.value)} placeholder={t("gallery:albums.descriptionPlaceholder")} maxLength={2000} />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</button>
          <button type="submit" className="primary-button" disabled={!name.trim() || busy}>
            {busy ? t("gallery:common.creating") : t("gallery:albums.createTitle")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CreateSlideshowModal({
  name,
  busy,
  onNameChange,
  onSubmit,
  onClose
}: {
  name: string;
  busy: boolean;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  return (
    <Modal
      variant="card"
      title={t("gallery:slideshows.createTitle")}
      onClose={() => { if (!busy) onClose(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <label className="field">
          <span>{t("gallery:common.name")}</span>
          <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder={t("gallery:slideshows.namePlaceholderExample")} autoFocus maxLength={120} />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t("common:common.cancel")}</button>
          <button type="submit" className="primary-button" disabled={!name.trim() || busy}>
            {busy ? t("gallery:common.creating") : t("gallery:slideshows.createTitle")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
