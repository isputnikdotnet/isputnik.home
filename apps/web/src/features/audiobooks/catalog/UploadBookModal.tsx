import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { LibraryBig, X } from "lucide-react";
import { FileUpload } from "../../../shared/FileUpload";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import type { AudiobookBookDetail } from "../types";
import type { CatalogLibrary } from "./catalogKinds";
import { Button } from "../../../shared/Button";

// Upload one audiobook: pick the target library (when more than one allows
// uploads), optionally name the book, then drop the audio files — or a whole
// book folder. All files of one upload become a single book; the server scans it
// immediately and the new title appears in the catalog when the modal closes.
export function UploadBookModal({
  libraries,
  initialLibraryId,
  onClose,
  onUploaded
}: {
  libraries: CatalogLibrary[];
  initialLibraryId: string;
  onClose: () => void;
  onUploaded: (book: AudiobookBookDetail | null, libraryName: string) => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [libraryId, setLibraryId] = useState(() => (
    libraries.some((library) => library.id === initialLibraryId) ? initialLibraryId : libraries[0]?.id ?? ""
  ));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const library = libraries.find((item) => item.id === libraryId);

  return (
    <Modal
      title={t("book:catalog.uploadAudiobookTitle")}
      className="book-upload-modal"
      busy={busy}
      onClose={onClose}
      headerAction={
        <Button variant="bare" className="modal-close" onClick={onClose} disabled={busy} aria-label={t("common:common.close")}>
          <X size={18} aria-hidden="true" />
        </Button>
      }
    >
      {libraries.length > 1 && (
        <SelectField
          className="book-upload-library"
          label={t("book:detail.rows.library")}
          icon={<LibraryBig size={17} />}
          value={libraryId}
          onChange={setLibraryId}
          disabled={busy}
          options={libraries.map((item) => ({ value: item.id, label: item.name }))}
        />
      )}

      <label className="field" style={{ marginBottom: 12 }}>
        <span><Trans i18nKey="catalog.uploadTitleLabel" ns="book" components={{ muted: <span className="muted" /> }} /></span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("book:catalog.uploadTitlePlaceholder")}
          disabled={busy}
        />
      </label>

      {library && (
        <FileUpload
          endpoint={(batch) => {
            const folder = title.trim() || batch.folderName || "";
            return `/api/library/audiobook-libraries/${library.id}/books/upload${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;
          }}
          accept={library.uploadExtensions}
          maxBytes={library.maxUploadMB != null ? library.maxUploadMB * 1024 * 1024 : null}
          multiple
          folders
          maxFiles={500} // mirrors MAX_BOOK_UPLOAD_FILES on the server
          hint={library.maxUploadMB != null
            ? t("book:catalog.acceptedHintWithSize", { types: library.uploadExtensions.map((ext) => `.${ext}`).join(", "), mb: library.maxUploadMB })
            : t("book:catalog.acceptedHint", { types: library.uploadExtensions.map((ext) => `.${ext}`).join(", ") })}
          onUploaded={(response) => {
            const payload = response as { book?: AudiobookBookDetail };
            onUploaded(payload.book ?? null, library.name);
          }}
          onBusyChange={setBusy}
        />
      )}

    </Modal>
  );
}
