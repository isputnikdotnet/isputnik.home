import { useEffect, useState } from "react";
import { ChevronLeft, FolderOpen, HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import type { StorageBrowseEntry } from "../types";

/** A place the picker opens on: a storage container of home's, or a location another
 *  server offers (the video container's libraries and cache folders). */
export interface FolderPickerRoot {
  id: string;
  name: string;
}

/** One folder of a location, as the picker shows it (home's StorageBrowse is one). */
export interface FolderBrowse {
  root: FolderPickerRoot;
  currentPath: string;
  /** The absolute path as the server that owns it sees it. */
  selectedPath: string;
  parentPath: string | null;
  entries: StorageBrowseEntry[];
}

// Pick a folder by walking a storage container, rather than typing a server path.
//
// Shared, because there is one right answer to "which folder?" and typing it was the
// wrong one twice over: the path has to be what the SERVER sees (in Docker that is the
// container path, not the host path the admin knows), and it has to already exist. Both
// failures land as "that folder is missing or not accessible", which is true and no help
// at all. Browsing can only ever offer paths the server can actually reach.
//
// It walks home's storage containers unless told how to walk something else
// (`browseFolders`): the video container's folders are picked with it too
// (VideoFolderModal), so choosing a folder looks the same wherever it is done.
export function FolderPickerModal({
  title,
  intro,
  storageRoots,
  initialRootId,
  confirmLabel,
  onPick,
  onClose,
  onError,
  browseFolders,
  rootLabel,
  error,
  busy = false,
  blocked
}: {
  title: string;
  intro: string;
  storageRoots: FolderPickerRoot[];
  /** Which container to open on. Falls back to the first one. */
  initialRootId?: string;
  confirmLabel?: string;
  /** The absolute server path, plus where it came from — a library needs the root and
   *  the relative path; the Recycle Bin needs only the absolute one. */
  onPick: (picked: { absolutePath: string; rootId: string; relativePath: string }) => void | Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
  /** Lists a folder of a location that is not one of home's storage containers. */
  browseFolders?: (rootId: string, relativePath: string) => Promise<FolderBrowse>;
  /** What the locations are called here ("Location"); home's are storage containers. */
  rootLabel?: string;
  /** Why the pick was refused, shown in the dialog. */
  error?: string;
  /** The pick is being saved: nothing can be pressed, and the dialog stays. */
  busy?: boolean;
  /** Why nothing can be picked in a location (it is read-only), or null. */
  blocked?: (rootId: string) => { title: string; body: string } | null;
}) {
  const { t } = useTranslation(["common", "control"]);
  const resolvedConfirmLabel = confirmLabel ?? t("control:libraries.useThisFolder");
  const [browse, setBrowse] = useState<FolderBrowse | null>(null);
  const [rootId, setRootId] = useState(initialRootId || storageRoots[0]?.id || "");
  const [loading, setLoading] = useState(false);

  const load = async (id: string, relativePath = "") => {
    if (!id) return;
    setLoading(true);
    try {
      const query = new URLSearchParams({ path: relativePath });
      const payload = browseFolders ? await browseFolders(id, relativePath) : await api<FolderBrowse>(`/api/storage/roots/${id}/browse?${query}`);
      setRootId(id);
      setBrowse(payload);
    } catch (err) {
      onError(err instanceof Error ? err.message : t("control:libraries.unableToBrowseStorage"));
    } finally {
      setLoading(false);
    }
  };

  // Open on the container it was given, so the first thing shown is where you were.
  // Once, deliberately: rootId is state the picker writes as you browse, so
  // following it here would re-open the dialog on top of every folder you enter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(rootId); }, []);

  return (
    <Modal title={title} className="folder-picker-modal" busy={busy} onClose={onClose}>
      <p>{intro}</p>
      {error && <MessageBox tone="error" title={t("common:errors.unableToSave")}>{error}</MessageBox>}

      <SelectField
        label={rootLabel ?? t("control:libraries.containerLabel")}
        icon={<HardDrive size={17} />}
        value={rootId}
        onChange={(value) => void load(value)}
        options={storageRoots.map((root) => ({ value: root.id, label: root.name }))}
      />

      {storageRoots.length === 0 && (
        <p className="management-empty">
          {t("control:libraries.noContainersYet")}
        </p>
      )}

      {browse && (
        <section className="folder-picker-browser" aria-label={t("control:libraries.folderBrowserAria")}>
          <div className="folder-picker-head">
            <div>
              <strong>{browse.currentPath || browse.root.name}</strong>
              {/* The absolute path as the SERVER sees it — the one that gets saved, and
                  in Docker the one an admin has never typed. Worth showing plainly. */}
              <span>{browse.selectedPath}</span>
            </div>
            {browse.parentPath !== null && (
              <Button
                variant="secondary"
                compact
                onClick={() => void load(browse.root.id, browse.parentPath ?? "")}
              >
                <ChevronLeft size={16} aria-hidden="true" />
                <span>{t("control:libraries.up")}</span>
              </Button>
            )}
          </div>

          <div className="folder-picker-list">
            {browse.entries.map((entry) => (
              <Button
                variant="text"
                className="folder-picker-row"
                key={entry.relativePath}
                onClick={() => void load(browse.root.id, entry.relativePath)}
              >
                <FolderOpen size={17} aria-hidden="true" />
                <span>{entry.name}</span>
              </Button>
            ))}
            {browse.entries.length === 0 && (
              <p className="management-empty">{t("control:libraries.noChildFolders")}</p>
            )}
          </div>
        </section>
      )}

      {blocked?.(rootId) && <MessageBox tone="warning" title={blocked(rootId)!.title}>{blocked(rootId)!.body}</MessageBox>}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={loading || busy}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={!browse || loading || busy || Boolean(blocked?.(rootId))}
          onClick={() => {
            if (!browse) return;
            void onPick({
              absolutePath: browse.selectedPath,
              rootId: browse.root.id,
              relativePath: browse.currentPath
            });
          }}
        >
          {loading ? t("control:ui.loading") : resolvedConfirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
