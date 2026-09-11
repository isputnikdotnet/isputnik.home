import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryBig, X } from "lucide-react";
import { FileUpload } from "../../../shared/FileUpload";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import type { CatalogLibrary } from "./catalogKinds";

// Upload one or more ebooks: pick the target library (when more than one accepts
// uploads), then drop the files. Each file becomes its own ebook; the server scans
// each immediately so new titles appear in the catalog when the modal closes.
export function EbookUploadModal({
  libraries,
  initialLibraryId,
  onClose,
  onUploaded
}: {
  libraries: CatalogLibrary[];
  initialLibraryId: string;
  onClose: () => void;
  onUploaded: (count: number, libraryName: string) => void;
}) {
  const { t } = useTranslation(["common", "book"]);
  const [libraryId, setLibraryId] = useState(() => (
    libraries.some((library) => library.id === initialLibraryId) ? initialLibraryId : libraries[0]?.id ?? ""
  ));
  const [busy, setBusy] = useState(false);
  const library = libraries.find((item) => item.id === libraryId);

  return (
    <Modal
      title={t("book:catalog.uploadEbooksTitle")}
      className="book-upload-modal"
      busy={busy}
      onClose={onClose}
      headerAction={
        <button type="button" className="modal-close" onClick={onClose} disabled={busy} aria-label={t("common:common.close")}>
          <X size={18} aria-hidden="true" />
        </button>
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

      {library && (
        <FileUpload
          endpoint={`/api/library/ebook-libraries/${library.id}/books/upload`}
          accept={library.uploadExtensions}
          maxBytes={library.maxUploadMB != null ? library.maxUploadMB * 1024 * 1024 : null}
          multiple
          maxFiles={100} // mirrors MAX_EBOOK_UPLOAD_FILES on the server
          hint={library.maxUploadMB != null
            ? t("book:catalog.acceptedHintWithSize", { types: library.uploadExtensions.map((ext) => `.${ext}`).join(", "), mb: library.maxUploadMB })
            : t("book:catalog.acceptedHint", { types: library.uploadExtensions.map((ext) => `.${ext}`).join(", ") })}
          onUploaded={(response) => {
            const payload = response as { uploaded?: number };
            onUploaded(payload.uploaded ?? 0, library.name);
          }}
          onBusyChange={setBusy}
        />
      )}

    </Modal>
  );
}
