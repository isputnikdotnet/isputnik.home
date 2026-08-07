import { useState, useEffect, type FormEvent } from "react";
import { Folder, HardDrive, Plus } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import { FolderPickerModal } from "../libraries/FolderPickerModal";
import type { LibrarySettings, StorageRoot } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";

/** The install-wide Recycle Bin folder. `path` null = each library keeps its own
 *  `.trash`, the default. `editable` is false as soon as the bin holds anything. */
interface TrashRootSettings {
  path: string | null;
  libraryCount: number;
  itemsInBin: number;
  editable: boolean;
}

export function StorageSection() {
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [trashRoot, setTrashRoot] = useState<TrashRootSettings | null>(null);
  const [trashRootInput, setTrashRootInput] = useState("");
  const [editTrashRootOpen, setEditTrashRootOpen] = useState(false);
  const [savingTrashRoot, setSavingTrashRoot] = useState(false);
  const [trashPickerOpen, setTrashPickerOpen] = useState(false);
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

    const trashPayload = await api<TrashRootSettings>("/api/storage/trash-root");
    setTrashRoot(trashPayload);
    setTrashRootInput(trashPayload.path ?? "");
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

  const saveTrashRoot = async (event: FormEvent) => {
    event.preventDefault();
    setSavingTrashRoot(true);
    setError("");
    try {
      // Blank means "back to each library's own .trash" — a real choice, so it is sent
      // as null rather than treated as an empty form.
      await api("/api/storage/trash-root", {
        method: "PUT",
        body: JSON.stringify({ path: trashRootInput.trim() || null })
      });
      await loadStorage();
      setEditTrashRootOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save the Recycle Bin location");
    } finally {
      setSavingTrashRoot(false);
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
      <ControlSectionHead
        section="storage"
        icon={<HardDrive size={30} />}
        iconClassName="storage"
        description="Where thumbnails live, and which folders libraries may be created in."
      >
        <RefreshButton
          onRefresh={async () => {
            setError("");
            try {
              await loadStorage();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Unable to refresh storage settings");
              throw err;
            }
          }}
        />
      </ControlSectionHead>

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

      {/* Deliberately under thumbnail storage and above containers: like the thumbnail
          path, it is a decision that wants making before the first library exists. */}
      <section className="library-settings-panel storage-settings-panel">
        <div>
          <h2>Recycle Bin location</h2>
          <p>
            One folder for every library's deleted files, instead of a hidden <code>.trash</code>{" "}
            inside each library — which other apps reading the same folders will index and show
            as though nothing had been deleted.
          </p>
        </div>
        <div className="storage-path-summary">
          <strong>{trashRoot?.path || "Each library's own .trash folder"}</strong>
        </div>
        <div className="library-settings-actions">
          {/* Not a fault, just why the button is off — so it states the fact and the
              tooltip on the button explains what to do about it. */}
          {trashRoot && !trashRoot.editable && (
            <span className="setting-status">
              {trashRoot.itemsInBin} item{trashRoot.itemsInBin === 1 ? "" : "s"} in the bin
            </span>
          )}
          <Button
            variant="secondary"
            compact
            disabled={!trashRoot?.editable}
            title={trashRoot?.editable
              ? undefined
              : "Empty the Recycle Bin first — the location can only change while it holds nothing"}
            onClick={() => {
              setError("");
              setTrashRootInput(trashRoot?.path ?? "");
              setEditTrashRootOpen(true);
            }}
          >
            Edit location
          </Button>
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

      {editTrashRootOpen && (
        <Modal
          title="Edit Recycle Bin location"
          className="edit-thumbnail-modal"
          busy={savingTrashRoot}
          onClose={() => { setError(""); setEditTrashRootOpen(false); }}
          onSubmit={saveTrashRoot}
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
              <span>{trashRootInput || "Each library's own .trash folder"}</span>
              <Button variant="secondary" compact onClick={() => { setError(""); setTrashPickerOpen(true); }}>
                Browse
              </Button>
              {trashRootInput && (
                <Button variant="text" onClick={() => setTrashRootInput("")}>Clear</Button>
              )}
            </div>
          </div>
          {error && <MessageBox tone="error" title="Unable to save the location">{error}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => { setError(""); setEditTrashRootOpen(false); }} disabled={savingTrashRoot} autoFocus>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={savingTrashRoot}>
              {savingTrashRoot ? "Saving…" : "Save location"}
            </Button>
          </div>
        </Modal>
      )}

      {trashPickerOpen && (
        <FolderPickerModal
          title="Select the Recycle Bin folder"
          intro="Choose a folder inside an approved container — one outside every library, since anything inside a library is scanned."
          storageRoots={storageRoots}
          confirmLabel="Use this folder"
          onPick={({ absolutePath }) => {
            setTrashRootInput(absolutePath);
            setTrashPickerOpen(false);
          }}
          onClose={() => setTrashPickerOpen(false)}
          onError={setError}
        />
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
