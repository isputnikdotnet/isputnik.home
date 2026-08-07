import { useEffect, useState } from "react";
import { ChevronLeft, FolderOpen } from "lucide-react";
import { api } from "../../../api";
import { Button } from "../../../shared/Button";
import { Modal } from "../../../shared/Modal";
import type { StorageRoot, StorageBrowse } from "../types";

// Pick a folder by walking a storage container, rather than typing a server path.
//
// Shared, because there is one right answer to "which folder?" and typing it was the
// wrong one twice over: the path has to be what the SERVER sees (in Docker that is the
// container path, not the host path the admin knows), and it has to already exist. Both
// failures land as "that folder is missing or not accessible", which is true and no help
// at all. Browsing can only ever offer paths the server can actually reach.
export function FolderPickerModal({
  title,
  intro,
  storageRoots,
  initialRootId,
  confirmLabel = "Use this folder",
  onPick,
  onClose,
  onError
}: {
  title: string;
  intro: string;
  storageRoots: StorageRoot[];
  /** Which container to open on. Falls back to the first one. */
  initialRootId?: string;
  confirmLabel?: string;
  /** The absolute server path, plus where it came from — a library needs the root and
   *  the relative path; the Recycle Bin needs only the absolute one. */
  onPick: (picked: { absolutePath: string; rootId: string; relativePath: string }) => void | Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [browse, setBrowse] = useState<StorageBrowse | null>(null);
  const [rootId, setRootId] = useState(initialRootId || storageRoots[0]?.id || "");
  const [loading, setLoading] = useState(false);

  const load = async (id: string, relativePath = "") => {
    if (!id) return;
    setLoading(true);
    try {
      const query = new URLSearchParams({ path: relativePath });
      const payload = await api<StorageBrowse>(`/api/storage/roots/${id}/browse?${query}`);
      setRootId(id);
      setBrowse(payload);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Unable to browse storage container");
    } finally {
      setLoading(false);
    }
  };

  // Open on the container it was given, so the first thing shown is where you were.
  useEffect(() => { void load(rootId); }, []);

  return (
    <Modal title={title} className="folder-picker-modal" onClose={onClose}>
      <p>{intro}</p>

      <label className="field">
        <span>Container</span>
        <select value={rootId} onChange={(event) => void load(event.target.value)} required>
          {storageRoots.map((root) => (
            <option value={root.id} key={root.id}>{root.name}</option>
          ))}
        </select>
      </label>

      {storageRoots.length === 0 && (
        <p className="management-empty">
          No Digital Library containers yet — add one above, and its folders can be browsed here.
        </p>
      )}

      {browse && (
        <section className="folder-picker-browser" aria-label="Folder browser">
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
                <span>Up</span>
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
              <p className="management-empty">No child folders found. The current folder can still be used.</p>
            )}
          </div>
        </section>
      )}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!browse || loading}
          onClick={() => {
            if (!browse) return;
            void onPick({
              absolutePath: browse.selectedPath,
              rootId: browse.root.id,
              relativePath: browse.currentPath
            });
          }}
        >
          {loading ? "Loading…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
