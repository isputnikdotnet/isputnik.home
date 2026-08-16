// The "edit Recycle Bin location" dialog, shared by the Storage page and the Recycle
// Bin's own settings. One component rather than two copies of the same modal, because
// the rules it explains — inside a container, outside every library, only changeable
// while the bin is empty — must read identically wherever the door into them is.
import { useEffect, useState, type FormEvent } from "react";
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
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load storage containers"));
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
      setError(err instanceof Error ? err.message : "Unable to save the Recycle Bin location");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        title="Edit Recycle Bin location"
        className="edit-thumbnail-modal"
        busy={saving}
        onClose={onClose}
        onSubmit={save}
      >
        <p>
          Browse to a folder inside a Digital Library container, but <strong>not</strong>{" "}
          inside a library — anything in a library is scanned, so deleted files would be
          catalogued straight back in. Clear it to go back to each library's own hidden{" "}
          <code>.trash</code> folder.
        </p>
        <MessageBox tone="info" title="Best set before you create libraries">
          The location can only change while the Recycle Bin is completely empty, so once
          you are using it, moving it means restoring or permanently deleting everything in
          it first. Nothing already deleted is moved by a change — every item remembers
          where its own files went.
        </MessageBox>
        <MessageBox tone="warning" title="Keep it on the same storage as your libraries">
          Deleting into a bin on the same disk is an instant rename. To another disk it is a
          real copy of every byte, so deleting a large video, or a duplicate cleanup removing
          thousands of photos, will take much longer.
        </MessageBox>
        {/* Browsed, not typed. The path has to be the one the SERVER sees — under
            Docker that is the container path, not the host path an admin knows — and it
            has to already exist. Typing it wrong produced "that folder is missing or not
            accessible", which is true and useless. The picker can only offer folders the
            server can actually reach. */}
        <div className="field source-folder-field">
          <span>Recycle Bin folder</span>
          <div className="source-folder-control">
            <Folder size={19} aria-hidden="true" />
            <span>{input || "Each library's own .trash folder"}</span>
            <Button variant="secondary" compact onClick={() => { setError(""); setPickerOpen(true); }}>
              Browse
            </Button>
            {input && (
              <Button variant="text" onClick={() => setInput("")}>Clear</Button>
            )}
          </div>
        </div>
        {error && <MessageBox tone="error" title="Unable to save the location">{error}</MessageBox>}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving} autoFocus>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save location"}
          </Button>
        </div>
      </Modal>

      {pickerOpen && (
        <FolderPickerModal
          title="Select the Recycle Bin folder"
          intro="Choose a folder inside an approved container — one outside every library, since anything inside a library is scanned."
          storageRoots={storageRoots}
          confirmLabel="Use this folder"
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
