// The "edit Recycle Bin location" dialog, shared by the Storage page and the Recycle
// Bin's own settings. One component rather than two copies of the same modal, because
// the rules it explains — inside a container, outside every library, only changeable
// while the bin is empty — must read identically wherever the door into them is.
import { useEffect, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Folder } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { FolderPickerModal } from "../libraries/FolderPickerModal";
import type { StorageRoot } from "../types";

/** The install-wide Recycle Bin folder. `path` null = each library keeps its own
 *  `.trash`, the default. `editable` is false as soon as the bin holds anything. */
export interface TrashRootSettings {
  path: string | null;
  libraryCount: number;
  itemsInBin: number;
  editable: boolean;
}

export function TrashRootEditor({
  current,
  onSaved,
  onClose
}: {
  /** The location as currently configured — null for the per-library default. */
  current: string | null;
  /** Called after a successful save, before the dialog closes; the caller reloads
   *  whatever of its own view shows the location. */
  onSaved: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [input, setInput] = useState(current ?? "");
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");
  // The picker browses approved containers, so it needs the list; fetched here to
  // keep the component whole — the Recycle Bin page has no other use for it.
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);

  useEffect(() => {
    api<{ roots: StorageRoot[] }>("/api/storage/roots")
      .then((payload) => setStorageRoots(payload.roots))
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:trashRoot.loadContainersFailed")));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      // Blank means "back to each library's own .trash" — a real choice, so it is sent
      // as null rather than treated as an empty form.
      await api("/api/storage/trash-root", {
        method: "PUT",
        body: JSON.stringify({ path: input.trim() || null })
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:trashRoot.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        title={t("controlAdmin:trashRoot.modalTitle")}
        className="edit-thumbnail-modal"
        busy={saving}
        onClose={onClose}
        onSubmit={save}
      >
        <p>
          <Trans
            i18nKey="trashRoot.intro"
            ns="controlAdmin"
            components={{ bold: <strong />, cd: <code /> }}
          />
        </p>
        <MessageBox tone="info" title={t("controlAdmin:trashRoot.infoTitle")}>
          {t("controlAdmin:trashRoot.infoBody")}
        </MessageBox>
        <MessageBox tone="warning" title={t("controlAdmin:trashRoot.warnTitle")}>
          {t("controlAdmin:trashRoot.warnBody")}
        </MessageBox>
        {/* Browsed, not typed. The path has to be the one the SERVER sees — under
            Docker that is the container path, not the host path an admin knows — and it
            has to already exist. Typing it wrong produced "that folder is missing or not
            accessible", which is true and useless. The picker can only offer folders the
            server can actually reach. */}
        <div className="field source-folder-field">
          <span>{t("controlAdmin:trashRoot.folderLabel")}</span>
          <div className="source-folder-control">
            <Folder size={19} aria-hidden="true" />
            <span>{input || t("controlAdmin:storage.defaultTrash")}</span>
            <Button variant="secondary" compact onClick={() => { setError(""); setPickerOpen(true); }}>
              {t("controlAdmin:scanRules.browseFolders")}
            </Button>
            {input && (
              <Button variant="text" onClick={() => setInput("")}>{t("controlAdmin:trashRoot.clear")}</Button>
            )}
          </div>
        </div>
        {error && <MessageBox tone="error" title={t("controlAdmin:trashRoot.saveErrorTitle")}>{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving} autoFocus>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? t("controlAdmin:ui.saving") : t("controlAdmin:trashRoot.saveLocation")}
          </Button>
        </div>
      </Modal>

      {pickerOpen && (
        <FolderPickerModal
          title={t("controlAdmin:trashRoot.pickerTitle")}
          intro={t("controlAdmin:trashRoot.pickerIntro")}
          storageRoots={storageRoots}
          confirmLabel={t("controlAdmin:trashRoot.useThisFolder")}
          onPick={({ absolutePath }) => {
            setInput(absolutePath);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
          onError={setError}
        />
      )}
    </>
  );
}
