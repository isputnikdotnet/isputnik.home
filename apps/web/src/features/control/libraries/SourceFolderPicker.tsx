import { useState } from "react";
import { ChevronLeft, Folder, FolderOpen } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { Modal } from "../../../shared/Modal";
import type { StorageRoot, StorageBrowse } from "../types";

// Compact source-folder field for the create-library wizard. Browse opens a
// separate picker so the details step stays scannable.
export function SourceFolderPicker({
  storageRoots,
  selectedRootId,
  storageBrowse,
  onBrowse,
  onError
}: {
  storageRoots: StorageRoot[];
  selectedRootId: string;
  storageBrowse: StorageBrowse | null;
  onBrowse: (rootId: string, relativePath?: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftBrowse, setDraftBrowse] = useState<StorageBrowse | null>(null);
  const [draftRootId, setDraftRootId] = useState(selectedRootId);
  const [loading, setLoading] = useState(false);
  const folderLabel = storageBrowse?.selectedPath || "Choose a folder...";

  const loadDraft = async (rootId: string, relativePath = "") => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ path: relativePath });
      const payload = await api<StorageBrowse>(`/api/storage/roots/${rootId}/browse?${query}`);
      setDraftRootId(rootId);
      setDraftBrowse(payload);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to browse storage container");
    } finally {
      setLoading(false);
    }
  };

  const openPicker = () => {
    setPickerOpen(true);
    setDraftRootId(selectedRootId);
    if (storageBrowse && storageBrowse.root.id === selectedRootId) {
      setDraftBrowse(storageBrowse);
      return;
    }
    if (selectedRootId) void loadDraft(selectedRootId);
  };

  const useCurrentFolder = async () => {
    if (!draftBrowse) return;
    setLoading(true);
    try {
      await onBrowse(draftBrowse.root.id, draftBrowse.currentPath);
      setPickerOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to browse storage container");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="field source-folder-field">
        <span>Folder</span>
        <div className="source-folder-control">
          <Folder size={19} aria-hidden="true" />
          <span>{folderLabel}</span>
          <Button variant="secondary" compact onClick={openPicker}>
            Browse
          </Button>
        </div>
      </div>

      {pickerOpen && (
        <Modal
          title="Select library folder"
          className="folder-picker-modal"
          onClose={() => setPickerOpen(false)}
        >
          <p>Choose a folder inside an approved container.</p>

          <label className="field">
            <span>Container</span>
            <select value={draftRootId} onChange={(event) => void loadDraft(event.target.value)} required>
              {storageRoots.map((root) => (
                <option value={root.id} key={root.id}>{root.name}</option>
              ))}
            </select>
          </label>

          {draftBrowse && (
            <section className="folder-picker-browser" aria-label="Library folder browser">
              <div className="folder-picker-head">
                <div>
                  <strong>{draftBrowse.currentPath || draftBrowse.root.name}</strong>
                  <span>{draftBrowse.selectedPath}</span>
                </div>
                {draftBrowse.parentPath !== null && (
                  <Button
                    variant="secondary"
                    compact
                    onClick={() => void loadDraft(draftBrowse.root.id, draftBrowse.parentPath ?? "")}
                  >
                    <ChevronLeft size={16} aria-hidden="true" />
                    <span>Up</span>
                  </Button>
                )}
              </div>

              <div className="folder-picker-list">
                {draftBrowse.entries.map((entry) => (
                  <Button
                    variant="text"
                    className="folder-picker-row"
                    key={entry.relativePath}
                    onClick={() => void loadDraft(draftBrowse.root.id, entry.relativePath)}
                  >
                    <FolderOpen size={17} aria-hidden="true" />
                    <span>{entry.name}</span>
                  </Button>
                ))}
                {draftBrowse.entries.length === 0 && (
                  <p className="management-empty">No child folders found. The current folder can still be used.</p>
                )}
              </div>
            </section>
          )}

          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setPickerOpen(false)} disabled={loading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void useCurrentFolder()} disabled={!draftBrowse || loading}>
              {loading ? "Loading..." : "Use this folder"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
