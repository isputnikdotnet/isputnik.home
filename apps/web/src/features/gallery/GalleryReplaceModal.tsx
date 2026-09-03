import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { FileUpload } from "../../shared/FileUpload";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryAsset, GalleryLibrary } from "./types";

// Swap the file behind one photo or video — the high-resolution scan over the
// low-resolution one — keeping the item itself, and with it every story, album,
// tag, face and favourite pointing at it. That is the whole point: deleting and
// re-uploading makes a NEW item and strands every one of them.
//
// The picker is the shared FileUpload, so this gets the same drag-and-drop,
// size checks, progress bar and error messages as every other upload in the app;
// only the endpoint differs.
export function GalleryReplaceModal({
  asset,
  onClose,
  onReplaced
}: {
  asset: GalleryAsset;
  onClose: () => void;
  onReplaced: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [busy, setBusy] = useState(false);
  // What this library accepts, and how big a file it takes. Asked for here
  // rather than threaded through the lightbox, which knows nothing about
  // libraries — one small request when the dialog opens.
  const [limits, setLimits] = useState<{ accept: string[]; maxUploadMB: number | null }>(
    { accept: [], maxUploadMB: null }
  );

  useEffect(() => {
    api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries")
      .then((payload) => {
        const library = payload.libraries.find((entry) => entry.id === asset.libraryId);
        if (library) setLimits({ accept: library.uploadExtensions, maxUploadMB: library.maxUploadMB });
      })
      .catch(() => { /* falls back below; the server validates for real */ });
  }, [asset.libraryId]);

  const accept = limits.accept.length > 0 ? limits.accept : FALLBACK_EXTENSIONS;
  const maxUploadMB = limits.maxUploadMB;

  // Only what this item could actually become: a photo takes a photo, a video a
  // video. The server enforces it too — this keeps the picker from offering a
  // file it would refuse.
  const kindExtensions = accept.filter((ext) => (
    asset.kind === "video"
      ? VIDEO_EXTENSIONS.has(ext.toLowerCase())
      : !VIDEO_EXTENSIONS.has(ext.toLowerCase())
  ));

  return (
    <Modal variant="card" title={t("gallery:replace.title")} onClose={onClose} busy={busy}>
      <p className="muted">{t("gallery:replace.body")}</p>

      <MessageBox tone="info" title={t("gallery:replace.keptTitle")}>
        {t("gallery:replace.keptBody")}
      </MessageBox>

      <FileUpload
        endpoint={`/api/library/gallery/assets/${asset.id}/replace`}
        accept={kindExtensions.length > 0 ? kindExtensions : accept}
        maxBytes={maxUploadMB != null ? maxUploadMB * 1024 * 1024 : null}
        hint={t("gallery:replace.hint")}
        onBusyChange={setBusy}
        onUploaded={() => onReplaced()}
      />
    </Modal>
  );
}

// Mirrors the server's own video list closely enough to filter the picker; the
// server is the authority and refuses a mismatch either way.
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm", "mpg", "mpeg", "wmv", "3gp"]);

/** Only until the library answers — the server validates for real. */
const FALLBACK_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "heic", "tif", "tiff", "mp4", "mov", "m4v", "webm"];
