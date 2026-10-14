import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";
import { FileUpload } from "../../shared/FileUpload";
import type { GalleryAsset, GalleryLibrary } from "./types";

// Add (or replace) the BACK of a scanned print — docs/back-sides-proposal.md.
// One photo file, written beside the front under the library's own naming and
// recorded on the photo; a back it already had is set aside with the replaced
// originals, never overwritten. Same shape as GalleryReplaceModal: the dialog
// asks the library what it accepts, the server validates for real.
export function GalleryBackSideModal({
  asset,
  onClose,
  onDone
}: {
  asset: GalleryAsset;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [busy, setBusy] = useState(false);
  const [limits, setLimits] = useState<{ accept: string[]; maxUploadMB: number | null }>({ accept: [], maxUploadMB: null });

  useEffect(() => {
    api<{ libraries: GalleryLibrary[] }>("/api/library/gallery-libraries")
      .then((payload) => {
        const library = payload.libraries.find((entry) => entry.id === asset.libraryId);
        if (library) setLimits({ accept: library.uploadExtensions, maxUploadMB: library.maxUploadMB });
      })
      .catch(() => { /* falls back below; the server validates for real */ });
  }, [asset.libraryId]);

  // The back of a photo is a photo: videos never fit, whatever the library takes.
  const accept = (limits.accept.length > 0 ? limits.accept : FALLBACK_EXTENSIONS)
    .filter((ext) => !VIDEO_EXTENSIONS.has(ext.toLowerCase()) && !AUDIO_EXTENSIONS.has(ext.toLowerCase()));
  const replacing = Boolean(asset.back);

  return (
    <Modal
      variant="card"
      title={replacing ? t("gallery:backSide.replaceTitle") : t("gallery:backSide.addTitle")}
      onClose={onClose}
      busy={busy}
    >
      <p className="muted">{t("gallery:backSide.body")}</p>
      {replacing && (
        <MessageBox tone="info" title={t("gallery:backSide.keptTitle")}>
          {t("gallery:backSide.keptBody")}
        </MessageBox>
      )}
      <FileUpload
        endpoint={`/api/library/gallery/assets/${asset.id}/back`}
        accept={accept.length > 0 ? accept : FALLBACK_EXTENSIONS}
        maxBytes={limits.maxUploadMB != null ? limits.maxUploadMB * 1024 * 1024 : null}
        hint={t("gallery:backSide.hint")}
        onBusyChange={setBusy}
        onUploaded={() => onDone()}
      />
    </Modal>
  );
}

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm", "mpg", "mpeg", "wmv", "3gp"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "weba", "ogg", "opus", "aac", "flac"]);
/** Only until the library answers — the server validates for real. */
const FALLBACK_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "tiff", "bmp"];
