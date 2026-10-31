import { useEffect, useState } from "react";
import { ChevronLeft, Folder, FolderOpen, MonitorPlay } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { Modal } from "../../../shared/Modal";

/** GET /api/library/video-folders: the engine's folders under its media mount. */
interface VideoFolders {
  path: string;
  folders: { name: string; path: string; folders: number }[];
}

// The folder of a video library is on the video app, not on this server: its
// media is mounted there (docs/video-architecture.md), so the picker walks the
// engine's folders through this server and the field says where they are. Same
// shape as the server-folder picker (SourceFolderPicker / FolderPickerModal).
export function VideoFolderPicker({
  value,
  onChange,
  onError
}: {
  /** Relative to the engine's media mount, "" while none is chosen. */
  value: string;
  onChange: (folder: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "control"]);
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="field source-folder-field">
        <span>{t("control:libraries.folderLabel")}</span>
        <div className="source-folder-control">
          <Folder size={19} aria-hidden="true" />
          <span>{value ? t("control:libraries.video.folderOnEngine", { folder: value }) : t("control:libraries.chooseFolderPlaceholder")}</span>
          <Button variant="secondary" compact onClick={() => setOpen(true)}>
            {t("common.browse")}
          </Button>
        </div>
        <small className="muted">{t("control:libraries.video.folderHint")}</small>
      </div>

      {open && (
        <VideoFolderModal
          initialPath={value}
          onPick={(folder) => { onChange(folder); setOpen(false); }}
          onClose={() => setOpen(false)}
          onError={onError}
        />
      )}
    </>
  );
}

function VideoFolderModal({
  initialPath,
  onPick,
  onClose,
  onError
}: {
  initialPath: string;
  onPick: (folder: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation(["common", "control"]);
  const [listing, setListing] = useState<VideoFolders | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async (path: string) => {
    setLoading(true);
    setError("");
    try {
      setListing(await api<VideoFolders>(`/api/library/video-folders?${new URLSearchParams({ path })}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("control:libraries.video.unableToBrowse");
      setError(message);
      onError(message);
    } finally {
      setLoading(false);
    }
  };

  // Open where the field already points, once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(initialPath); }, []);

  const parent = listing && listing.path ? listing.path.split("/").slice(0, -1).join("/") : null;

  return (
    <Modal title={t("control:libraries.selectFolderTitle")} className="folder-picker-modal" onClose={onClose}>
      <p>{t("control:libraries.video.pickerIntro")}</p>

      {error && <p className="management-empty">{error}</p>}

      {listing && (
        <section className="folder-picker-browser" aria-label={t("control:libraries.folderBrowserAria")}>
          <div className="folder-picker-head">
            <div>
              <strong>
                <MonitorPlay size={16} aria-hidden="true" /> {listing.path || t("control:libraries.video.mediaRoot")}
              </strong>
              <span>{t("control:libraries.video.onEngine")}</span>
            </div>
            {parent !== null && (
              <Button variant="secondary" compact onClick={() => void load(parent)}>
                <ChevronLeft size={16} aria-hidden="true" />
                <span>{t("control:libraries.up")}</span>
              </Button>
            )}
          </div>

          <div className="folder-picker-list">
            {listing.folders.map((folder) => (
              <Button variant="text" className="folder-picker-row has-count" key={folder.path} onClick={() => void load(folder.path)}>
                <FolderOpen size={17} aria-hidden="true" />
                <span>{folder.name}</span>
                <small className="muted">{t("control:libraries.video.subfolders", { count: folder.folders })}</small>
              </Button>
            ))}
            {listing.folders.length === 0 && <p className="management-empty">{t("control:libraries.noChildFolders")}</p>}
          </div>
        </section>
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={loading}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          // The media mount itself is never a library: pick a folder inside it.
          disabled={!listing || loading || !listing.path}
          onClick={() => listing && onPick(listing.path)}
        >
          {loading ? t("control:ui.loading") : t("control:libraries.useThisFolder")}
        </Button>
      </div>
    </Modal>
  );
}
