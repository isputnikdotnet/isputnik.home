import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import type { AudiobookLibrary } from "../../audiobooks/types";
import type { LibrarySettings, StorageRoot, StorageBrowse } from "../types";

export function LibrariesSection() {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [selectedRootId, setSelectedRootId] = useState("");
  const [storageBrowse, setStorageBrowse] = useState<StorageBrowse | null>(null);
  const [libraryName, setLibraryName] = useState("");
  const [rescanningLibraryId, setRescanningLibraryId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createLibraryOpen, setCreateLibraryOpen] = useState(false);
  const [error, setError] = useState("");

  const loadStorage = useCallback(async () => {
    const settingsPayload = await api<{ settings: LibrarySettings }>("/api/library/settings");
    setLibrarySettings(settingsPayload.settings);

    const rootsPayload = await api<{ roots: StorageRoot[] }>("/api/storage/roots");
    setStorageRoots(rootsPayload.roots);
    setSelectedRootId((current) => current || rootsPayload.roots[0]?.id || "");
    return { settings: settingsPayload.settings, roots: rootsPayload.roots };
  }, []);

  const loadLibraries = useCallback(async () => {
    await loadStorage();
    const payload = await api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries");
    setLibraries(payload.libraries);
  }, [loadStorage]);

  useEffect(() => {
    loadLibraries().catch((err) => setError(err instanceof Error ? err.message : "Unable to load libraries"));
  }, [loadLibraries]);

  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) {
      return;
    }

    const timer = window.setInterval(() => {
      loadLibraries().catch((err) => setError(err instanceof Error ? err.message : "Unable to load libraries"));
    }, 2500);

    return () => window.clearInterval(timer);
  }, [libraries, loadLibraries]);

  useEffect(() => {
    if (!createLibraryOpen) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) {
        setCreateLibraryOpen(false);
        setStorageBrowse(null);
      }
    };

    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [createLibraryOpen, creating]);

  const browseStorageRoot = async (rootId: string, relativePath = "") => {
    const query = new URLSearchParams({ path: relativePath });
    const payload = await api<StorageBrowse>(`/api/storage/roots/${rootId}/browse?${query}`);
    setSelectedRootId(rootId);
    setStorageBrowse(payload);
  };

  const createLibrary = async (event: FormEvent) => {
    event.preventDefault();
    if (!storageBrowse?.selectedPath) {
      setError("Choose a storage container folder for this library.");
      return;
    }

    setCreating(true);
    setError("");
    try {
      await api<{ library: { id: string } }>("/api/library/audiobook-libraries", {
        method: "POST",
        body: JSON.stringify({
          name: libraryName,
          sourcePath: storageBrowse.selectedPath,
          defaultLanguage: "en"
        })
      });
      setCreateLibraryOpen(false);
      setLibraryName("");
      setStorageBrowse(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create audiobook library");
    } finally {
      setCreating(false);
    }
  };

  const rescanLibrary = async (libraryId: string) => {
    setRescanningLibraryId(libraryId);
    setError("");
    try {
      await api(`/api/library/audiobook-libraries/${libraryId}/rescan`, { method: "POST", body: "{}" });
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to scan audiobook library");
    } finally {
      setRescanningLibraryId("");
    }
  };

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Audiobooks</h1>
        </div>
        <button
          className="icon-button with-label"
          disabled={!librarySettings?.thumbnailPathReady || storageRoots.length === 0}
          onClick={() => {
            setError("");
            setCreateLibraryOpen(true);
            const rootId = selectedRootId || storageRoots[0]?.id || "";
            if (rootId) {
              browseStorageRoot(rootId).catch((err) => setError(err instanceof Error ? err.message : "Unable to browse storage container"));
            }
          }}
          title="Add audiobook library"
        >
          <Plus size={18} />
          <span>Add library</span>
        </button>
      </div>

      {error && <MessageBox tone="error" title="Audiobook library error">{error}</MessageBox>}
      {(!librarySettings?.thumbnailPathReady || storageRoots.length === 0) && (
        <MessageBox tone="warning" title="Storage setup required">
          Configure thumbnail storage and at least one Digital Library container before adding libraries.
        </MessageBox>
      )}

      {libraries.length === 0 ? (
        <p className="management-empty">No audiobook libraries configured.</p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>Library</th>
                <th className="col-num">Books</th>
                <th className="col-num">Files</th>
                <th className="col-scan">Last scanned</th>
                <th>Status</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {libraries.map((library) => (
                <tr key={library.id}>
                  <td>
                    <div className="datagrid-primary">
                      <strong>{library.name}</strong>
                      <small>{library.sourcePath ?? "Source path hidden"}</small>
                    </div>
                  </td>
                  <td className="col-num datagrid-muted">{library.bookCount}</td>
                  <td className="col-num datagrid-muted">{library.fileCount}</td>
                  <td className="col-scan datagrid-muted">
                    {library.lastScannedAt ? formatManagedDate(library.lastScannedAt) : "Not yet"}
                  </td>
                  <td>
                    <span className={`status-badge ${library.scanStatus}`}>{library.scanStatus}</span>
                  </td>
                  <td className="col-actions">
                    <button
                      className="secondary-button compact-button rescan-library-button"
                      disabled={rescanningLibraryId === library.id}
                      onClick={() => rescanLibrary(library.id)}
                    >
                      <RefreshCw size={14} />
                      {rescanningLibraryId === library.id ? "Scanning..." : "Rescan"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createLibraryOpen && (
        <div className="modal-backdrop" onMouseDown={() => !creating && setCreateLibraryOpen(false)}>
          <form
            className="confirm-modal create-library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-library-title"
            onSubmit={createLibrary}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="create-library-title">Add audiobook library</h2>
            <p>Choose a configured storage container, then select the whole container or a folder inside it.</p>
            {(!librarySettings?.thumbnailPathReady || storageRoots.length === 0) && (
              <MessageBox tone="warning" title="Thumbnail storage required">
                Configure thumbnail storage and at least one Digital Library container first.
              </MessageBox>
            )}
            <Field label="Library name" value={libraryName} onChange={setLibraryName} />
            <label className="field">
              <span>Container</span>
              <select
                value={selectedRootId}
                onChange={(event) => browseStorageRoot(event.target.value).catch((err) => setError(err instanceof Error ? err.message : "Unable to browse storage container"))}
                required
              >
                {storageRoots.map((root) => (
                  <option value={root.id} key={root.id}>{root.name}</option>
                ))}
              </select>
            </label>
            {storageBrowse && (
              <section className="folder-browser" aria-label="Library folder browser">
                <div className="folder-browser-head">
                  <div>
                    <strong>{storageBrowse.currentPath || storageBrowse.root.name}</strong>
                    <span>{storageBrowse.selectedPath}</span>
                  </div>
                  {storageBrowse.parentPath !== null && (
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => browseStorageRoot(storageBrowse.root.id, storageBrowse.parentPath ?? "")}
                    >
                      Up
                    </button>
                  )}
                </div>
                <div className="folder-list">
                  {storageBrowse.entries.map((entry) => (
                    <button
                      className="folder-row"
                      type="button"
                      key={entry.relativePath}
                      onClick={() => browseStorageRoot(storageBrowse.root.id, entry.relativePath)}
                    >
                      {entry.name}
                    </button>
                  ))}
                  {storageBrowse.entries.length === 0 && <p className="management-empty">No child folders found. The current folder can still be used.</p>}
                </div>
              </section>
            )}
            {error && <MessageBox tone="error" title="Unable to add library">{error}</MessageBox>}
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => {
                  setCreateLibraryOpen(false);
                  setStorageBrowse(null);
                }}
                disabled={creating}
                autoFocus
              >
                Cancel
              </button>
              <button className="primary-button" disabled={creating || !librarySettings?.thumbnailPathReady || storageRoots.length === 0 || !storageBrowse}>
                {creating ? "Scanning..." : "Add and scan"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
