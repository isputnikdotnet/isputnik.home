import { useState } from "react";
import { X } from "lucide-react";
import { Modal } from "../../shared/Modal";
import { FileUpload } from "../../shared/FileUpload";
import type { GalleryLibrary } from "./types";

// Upload photos/videos into a managed gallery. Each file becomes its own asset
// (one file = one item), so this is a multi-file / whole-folder dropzone — drop a
// batch of photos or an album folder and the server catalogs each on its own,
// reading EXIF and building thumbnails. Files land in the library root; folders
// flatten into the filename, like the other library uploaders.
export function GalleryUploadModal({
  libraries,
  onClose,
  onUploaded
}: {
  libraries: GalleryLibrary[];
  onClose: () => void;
  onUploaded: (count: number, libraryName: string) => void;
}) {
  const [libraryId, setLibraryId] = useState(() => libraries[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const library = libraries.find((item) => item.id === libraryId);

  return (
    <Modal
      title="Upload photos & videos"
      className="book-upload-modal"
      busy={busy}
      onClose={onClose}
      headerAction={
        <button type="button" className="modal-close" onClick={onClose} disabled={busy} aria-label="Close">
          <X size={18} aria-hidden="true" />
        </button>
      }
    >
      {libraries.length > 1 && (
        <label className="field" style={{ marginBottom: 12 }}>
          <span>Library</span>
          <select value={libraryId} onChange={(event) => setLibraryId(event.target.value)} disabled={busy}>
            {libraries.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
      )}

      {library && (
        <FileUpload
          endpoint={`/api/library/gallery-libraries/${library.id}/assets/upload`}
          accept={library.uploadExtensions}
          maxBytes={library.maxUploadMB != null ? library.maxUploadMB * 1024 * 1024 : null}
          multiple
          folders
          maxFiles={200} // mirrors MAX_GALLERY_UPLOAD_FILES on the server
          hint={`Accepted: ${library.uploadExtensions.map((ext) => `.${ext}`).join(", ")}${library.maxUploadMB != null ? ` · up to ${library.maxUploadMB} MB per file` : ""}`}
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
