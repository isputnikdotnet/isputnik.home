// Pick a System data folder by walking the server's drives. FolderPickerModal walks
// storage containers, which is right for a library and wrong here: backups belong on
// another disk, and no container covers that. Same look, so its stylesheet is shared.
import { useEffect, useState } from "react";
import { ChevronLeft, FolderOpen, HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../../api";
import { Button } from "../../../../shared/Button";
import { MessageBox } from "../../../../shared/MessageBox";
import { Modal } from "../../../../shared/Modal";

interface ServerFolders {
  path: string | null;
  parent: string | null;
  entries: { name: string; path: string }[];
}

const fetchFolders = (path: string) => api<ServerFolders>(`/api/storage/server-folders?${new URLSearchParams({ path })}`);

export function ServerFolderPicker({ start, onPick, onClose }: {
  /** What the field holds now; a folder that isn't there yet opens the top instead. */
  start: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "control", "controlAdmin"]);
  const [view, setView] = useState<ServerFolders | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async (path: string) => {
    setLoading(true);
    setError("");
    try {
      setView(await fetchFolders(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:systemData.browseFailed"));
    } finally {
      setLoading(false);
    }
  };

  // Once, on opening: `start` is where it opens, not something to follow.
  useEffect(() => {
    const open = start.trim() ? fetchFolders(start.trim()).catch(() => fetchFolders("")) : fetchFolders("");
    open
      .then(setView)
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:systemData.browseFailed")))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const atTop = view?.path === null;
  const Icon = atTop ? HardDrive : FolderOpen;

  return (
    <Modal title={t("controlAdmin:systemData.pickerTitle")} className="folder-picker-modal" onClose={onClose}>
      <p>{t("controlAdmin:systemData.pickerIntro")}</p>
      {error && <MessageBox tone="error" title={t("controlAdmin:systemData.browseFailed")}>{error}</MessageBox>}

      {view && (
        <section className="folder-picker-browser" aria-label={t("control:libraries.folderBrowserAria")}>
          <div className="folder-picker-head">
            <div>
              <strong>{view.path ?? t("controlAdmin:systemData.pickerTop")}</strong>
            </div>
            {view.parent !== null && (
              <Button variant="secondary" compact disabled={loading} onClick={() => void load(view.parent ?? "")}>
                <ChevronLeft size={16} aria-hidden="true" />
                <span>{t("control:libraries.up")}</span>
              </Button>
            )}
          </div>

          <div className="folder-picker-list">
            {view.entries.map((entry) => (
              <Button variant="text" className="folder-picker-row" key={entry.path} disabled={loading} onClick={() => void load(entry.path)}>
                <Icon size={17} aria-hidden="true" />
                <span>{entry.name}</span>
              </Button>
            ))}
            {view.entries.length === 0 && (
              <p className="management-empty">{t("control:libraries.noChildFolders")}</p>
            )}
          </div>
        </section>
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={!view?.path || loading} onClick={() => { if (view?.path) onPick(view.path); }}>
          {t("controlAdmin:systemData.useFolder")}
        </Button>
      </div>
    </Modal>
  );
}
