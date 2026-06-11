import { useState, useEffect, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import type { LibrarySettings, StorageRoot } from "../types";

export function StorageSection() {
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [thumbnailPathInput, setThumbnailPathInput] = useState("");
  const [rootNameInput, setRootNameInput] = useState("");
  const [rootPathInput, setRootPathInput] = useState("");
  const [editThumbnailPathOpen, setEditThumbnailPathOpen] = useState(false);
  const [createStorageRootOpen, setCreateStorageRootOpen] = useState(false);
  const [savingLibrarySettings, setSavingLibrarySettings] = useState(false);
  const [savingStorageRoot, setSavingStorageRoot] = useState(false);
  const [deletingRootId, setDeletingRootId] = useState("");
  const [error, setError] = useState("");

  const loadStorage = async () => {
    const settingsPayload = await api<{ settings: LibrarySettings }>("/api/library/settings");
    setLibrarySettings(settingsPayload.settings);
    setThumbnailPathInput(settingsPayload.settings.thumbnailPath);

    const rootsPayload = await api<{ roots: StorageRoot[] }>("/api/storage/roots");
    setStorageRoots(rootsPayload.roots);
  };

  useEffect(() => {
    loadStorage().catch((err) => setError(err instanceof Error ? err.message : "Unable to load storage settings"));
  }, []);

  useEffect(() => {
    if (!editThumbnailPathOpen && !createStorageRootOpen) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingLibrarySettings && !savingStorageRoot) {
        setEditThumbnailPathOpen(false);
        setCreateStorageRootOpen(false);
      }
    };

    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [editThumbnailPathOpen, createStorageRootOpen, savingLibrarySettings, savingStorageRoot]);

  const saveLibrarySettings = async (event: FormEvent) => {
    event.preventDefault();
    setSavingLibrarySettings(true);
    setError("");
    try {
      const payload = await api<{ settings: LibrarySettings }>("/api/library/settings", {
        method: "PATCH",
        body: JSON.stringify({ thumbnailPath: thumbnailPathInput })
      });
      setLibrarySettings(payload.settings);
      setThumbnailPathInput(payload.settings.thumbnailPath);
      setEditThumbnailPathOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save Digital Library settings");
    } finally {
      setSavingLibrarySettings(false);
    }
  };

  const createStorageRoot = async (event: FormEvent) => {
    event.preventDefault();
    setSavingStorageRoot(true);
    setError("");
    try {
      await api("/api/storage/roots", {
        method: "POST",
        body: JSON.stringify({ name: rootNameInput, path: rootPathInput })
      });
      setRootNameInput("");
      setRootPathInput("");
      setCreateStorageRootOpen(false);
      await loadStorage();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save storage container");
    } finally {
      setSavingStorageRoot(false);
    }
  };

  const deleteStorageRoot = async (root: StorageRoot) => {
    setDeletingRootId(root.id);
    setError("");
    try {
      await api(`/api/storage/roots/${root.id}`, { method: "DELETE" });
      await loadStorage();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete storage container");
    } finally {
      setDeletingRootId("");
    }
  };

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Application</p>
          <h1>Storage</h1>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Storage error">{error}</MessageBox>}

      <section className="library-settings-panel storage-settings-panel">
        <div>
          <h2>Thumbnail storage</h2>
          <p>Generated covers and previews are written here, separate from original library files.</p>
        </div>
        <div className="storage-path-summary">
          <strong>{librarySettings?.thumbnailPath || "Not configured"}</strong>
        </div>
        <div className="library-settings-actions">
          {librarySettings?.thumbnailPathReady ? (
            <span className="setting-status ready">Ready</span>
          ) : (
            <span className="setting-status needs-attention">
              {librarySettings?.thumbnailPathError || "Required before adding a library"}
            </span>
          )}
          <button
            className="secondary-button compact-button"
            onClick={() => {
              setError("");
              setThumbnailPathInput(librarySettings?.thumbnailPath ?? "");
              setEditThumbnailPathOpen(true);
            }}
          >
            Edit path
          </button>
        </div>
      </section>

      <section className="storage-section">
        <div className="storage-section-head">
          <div>
            <h2>Digital Library containers</h2>
            <p>Containers are approved root folders. Libraries can use the whole container or any folder inside it.</p>
          </div>
          <button
            className="primary-button"
            onClick={() => {
              setError("");
              setRootNameInput("");
              setRootPathInput("");
              setCreateStorageRootOpen(true);
            }}
            title="Add storage container"
          >
            <Plus size={18} />
            <span>Add container</span>
          </button>
        </div>

        {storageRoots.length === 0 ? (
          <p className="management-empty">No Digital Library containers configured.</p>
        ) : (
          <div className="datagrid-wrap">
            <table className="datagrid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Path</th>
                  <th className="col-num">Libraries</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {storageRoots.map((root) => (
                  <tr key={root.id}>
                    <td><strong>{root.name}</strong></td>
                    <td className="datagrid-muted storage-path-cell">{root.path}</td>
                    <td className="col-num">
                      {root.libraryCount > 0 ? (
                        <span className="count-badge">{root.libraryCount}</span>
                      ) : (
                        <span className="datagrid-muted">—</span>
                      )}
                    </td>
                    <td className="col-actions">
                      <button
                        className="text-button danger"
                        disabled={root.libraryCount > 0 || deletingRootId === root.id}
                        onClick={() => deleteStorageRoot(root)}
                        title={root.libraryCount > 0 ? "Remove all libraries using this container first" : undefined}
                      >
                        {deletingRootId === root.id ? "Deleting..." : "Delete"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editThumbnailPathOpen && (
        <Modal
          title="Edit thumbnail storage"
          className="edit-thumbnail-modal"
          busy={savingLibrarySettings}
          onClose={() => setEditThumbnailPathOpen(false)}
          onSubmit={saveLibrarySettings}
        >
            <p>Choose a writable folder for generated covers and previews. In Docker, use the container path.</p>
            <Field label="Thumbnail path" value={thumbnailPathInput} onChange={setThumbnailPathInput} />
            {error && <MessageBox tone="error" title="Unable to save path">{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setEditThumbnailPathOpen(false)} disabled={savingLibrarySettings} autoFocus>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={savingLibrarySettings}>
                {savingLibrarySettings ? "Saving..." : "Save path"}
              </Button>
            </div>
        </Modal>
      )}

      {createStorageRootOpen && (
        <Modal
          title="Add storage container"
          className="create-storage-modal"
          busy={savingStorageRoot}
          onClose={() => setCreateStorageRootOpen(false)}
          onSubmit={createStorageRoot}
        >
            <p>Choose an existing server folder that libraries are allowed to scan. In Docker, use the container path.</p>
            <Field label="Container name" value={rootNameInput} onChange={setRootNameInput} />
            <Field label="Container path" value={rootPathInput} onChange={setRootPathInput} />
            {error && <MessageBox tone="error" title="Unable to add container">{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setCreateStorageRootOpen(false)} disabled={savingStorageRoot} autoFocus>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={savingStorageRoot}>
                {savingStorageRoot ? "Saving..." : "Save container"}
              </Button>
            </div>
        </Modal>
      )}
    </>
  );
}
