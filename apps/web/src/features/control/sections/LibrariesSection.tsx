import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Plus, RefreshCw, Pencil, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import type { AudiobookLibrary } from "../../audiobooks/types";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot, StorageBrowse } from "../types";

export function LibrariesSection() {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [selectedRootId, setSelectedRootId] = useState("");
  const [storageBrowse, setStorageBrowse] = useState<StorageBrowse | null>(null);
  const [libraryName, setLibraryName] = useState("");
  const [libraryVisibility, setLibraryVisibility] = useState<"public" | "private">("public");
  const [libraryIgnoreSidecar, setLibraryIgnoreSidecar] = useState(false);
  const [libraryOwnerId, setLibraryOwnerId] = useState("");
  const [libraryOwnerType, setLibraryOwnerType] = useState<"user" | "group" | "">("");
  const [rescanTarget, setRescanTarget] = useState<AudiobookLibrary | null>(null);
  const [rescanSkipSidecar, setRescanSkipSidecar] = useState(false);
  const [rescanEncoding, setRescanEncoding] = useState("auto");
  const [rescanRunning, setRescanRunning] = useState(false);
  const [deleteConfirmLibrary, setDeleteConfirmLibrary] = useState<AudiobookLibrary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createLibraryOpen, setCreateLibraryOpen] = useState(false);
  const [editingLibrary, setEditingLibrary] = useState<AudiobookLibrary | null>(null);
  const [editName, setEditName] = useState("");
  const [editVisibility, setEditVisibility] = useState<"public" | "private">("public");
  const [editOwnerId, setEditOwnerId] = useState("");
  const [editOwnerType, setEditOwnerType] = useState<"user" | "group" | "">("");
  const [saving, setSaving] = useState(false);
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
    const [librariesPayload, usersPayload, groupsPayload] = await Promise.all([
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries"),
      api<{ users: ManagedUser[] }>("/api/users"),
      api<{ groups: ManagedGroup[] }>("/api/groups")
    ]);
    setLibraries(librariesPayload.libraries);
    setUsers(usersPayload.users);
    setGroups(groupsPayload.groups);
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
          defaultLanguage: "en",
          ignoreSidecar: libraryIgnoreSidecar,
          visibility: libraryVisibility,
          ownerId: libraryOwnerId || null,
          ownerType: libraryOwnerType || null
        })
      });
      setCreateLibraryOpen(false);
      setLibraryName("");
      setLibraryVisibility("public");
      setLibraryIgnoreSidecar(false);
      setLibraryOwnerId("");
      setLibraryOwnerType("");
      setStorageBrowse(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create audiobook library");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (library: AudiobookLibrary) => {
    setEditingLibrary(library);
    setEditName(library.name);
    setEditVisibility(library.visibility);
    setEditOwnerId(library.ownerId ?? "");
    setEditOwnerType(library.ownerType ?? "");
    setError("");
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingLibrary) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/audiobook-libraries/${editingLibrary.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName,
          visibility: editVisibility,
          ownerId: editOwnerId || null,
          ownerType: editOwnerType || null
        })
      });
      setEditingLibrary(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setSaving(false);
    }
  };

  const openRescan = (library: AudiobookLibrary) => {
    setRescanTarget(library);
    setRescanSkipSidecar(library.ignoreSidecar);
    setRescanEncoding("auto");
    setError("");
  };

  const runRescan = async () => {
    if (!rescanTarget) return;
    setRescanRunning(true);
    setError("");
    try {
      await api(`/api/library/audiobook-libraries/${rescanTarget.id}/rescan`, {
        method: "POST",
        body: JSON.stringify({
          skipSidecar: rescanSkipSidecar,
          tagEncoding: rescanEncoding === "auto" ? undefined : rescanEncoding
        })
      });
      setRescanTarget(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to scan audiobook library");
    } finally {
      setRescanRunning(false);
    }
  };

  const deleteLibrary = async () => {
    if (!deleteConfirmLibrary) return;
    setDeleting(true);
    setError("");
    try {
      await api(`/api/library/audiobook-libraries/${deleteConfirmLibrary.id}`, { method: "DELETE" });
      setDeleteConfirmLibrary(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete library");
    } finally {
      setDeleting(false);
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
                <th>Visibility</th>
                <th className="col-num">Books</th>
                <th className="col-num">Files</th>
                <th className="col-scan">Last scanned</th>
                <th>Status</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {libraries.map((library) => {
                const ownerUser = library.ownerType === "user" ? users.find((u) => u.id === library.ownerId) : null;
                const ownerGroup = library.ownerType === "group" ? groups.find((g) => g.id === library.ownerId) : null;
                return (
                  <tr key={library.id}>
                    <td>
                      <div className="datagrid-primary">
                        <strong>{library.name}</strong>
                        <small>{library.sourcePath ?? "Source path hidden"}</small>
                        {ownerUser && <small>Owner: {ownerUser.displayName}</small>}
                        {ownerGroup && <small>Owner: {ownerGroup.name} (group)</small>}
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${library.visibility}`}>
                        {library.visibility === "public" ? "Public" : "Private"}
                      </span>
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
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          title="Edit library"
                          onClick={() => openEdit(library)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="secondary-button compact-button rescan-library-button"
                          disabled={library.scanStatus === "scanning"}
                          onClick={() => openRescan(library)}
                          title={library.scanStatus === "scanning" ? "Scan already in progress" : "Rescan library"}
                        >
                          <RefreshCw size={14} />
                          {library.scanStatus === "scanning" ? "Scanning..." : "Rescan"}
                        </button>
                        <button
                          className="icon-button danger"
                          title="Delete library"
                          onClick={() => setDeleteConfirmLibrary(library)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
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
              <span>Owner</span>
              <select
                value={libraryOwnerId ? `${libraryOwnerType}:${libraryOwnerId}` : ""}
                onChange={(event) => {
                  const val = event.target.value;
                  if (!val) { setLibraryOwnerId(""); setLibraryOwnerType(""); return; }
                  const [type, id] = val.split(":");
                  setLibraryOwnerType(type as "user" | "group");
                  setLibraryOwnerId(id);
                }}
              >
                <option value="">No owner (system library)</option>
                {users.length > 0 && (
                  <optgroup label="Users">
                    {users.map((user) => (
                      <option value={`user:${user.id}`} key={user.id}>{user.displayName} ({user.email})</option>
                    ))}
                  </optgroup>
                )}
                {groups.length > 0 && (
                  <optgroup label="Groups">
                    {groups.map((group) => (
                      <option value={`group:${group.id}`} key={group.id}>{group.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="field">
              <span>Visibility</span>
              <select value={libraryVisibility} onChange={(event) => setLibraryVisibility(event.target.value as "public" | "private")}>
                <option value="public">Public — all users can access</option>
                <option value="private">Private — owner and admins only</option>
              </select>
            </label>
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
            <label className="field-checkbox">
              <input
                type="checkbox"
                checked={libraryIgnoreSidecar}
                onChange={(event) => setLibraryIgnoreSidecar(event.target.checked)}
              />
              <span>Do not read metadata.json files</span>
            </label>
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

      {rescanTarget && (
        <div className="modal-backdrop" onMouseDown={() => !rescanRunning && setRescanTarget(null)}>
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rescan-library-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="rescan-library-title">Rescan "{rescanTarget.name}"</h2>
            <p>Re-index this library from disk. Your files are never modified, and manually edited metadata is kept.</p>
            <label className="field-checkbox">
              <input
                type="checkbox"
                checked={rescanSkipSidecar}
                onChange={(event) => setRescanSkipSidecar(event.target.checked)}
              />
              <span>Skip metadata.json sidecar files (read tags only)</span>
            </label>
            <label className="field">
              <span>Tag text encoding</span>
              <select value={rescanEncoding} onChange={(event) => setRescanEncoding(event.target.value)}>
                <option value="auto">Auto — leave tags as-is</option>
                <option value="windows-1251">Windows-1251 (Cyrillic)</option>
                <option value="windows-1250">Windows-1250 (Central European)</option>
                <option value="windows-1252">Windows-1252 (Western European)</option>
                <option value="koi8-r">KOI8-R (Cyrillic)</option>
              </select>
            </label>
            {rescanEncoding !== "auto" && (
              <p className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.4 }}>
                Repairs garbled tag text (e.g. "Ðàíåå" → "Ранее") for files whose tags were saved in this legacy encoding. Correctly stored tags are left untouched.
              </p>
            )}
            {error && <MessageBox tone="error" title="Rescan error">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setRescanTarget(null)} disabled={rescanRunning} autoFocus>
                Cancel
              </button>
              <button className="primary-button" onClick={runRescan} disabled={rescanRunning}>
                <RefreshCw size={15} /> {rescanRunning ? "Starting…" : "Start rescan"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmLibrary && (
        <div className="modal-backdrop" onMouseDown={() => !deleting && setDeleteConfirmLibrary(null)}>
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-library-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="delete-library-title">Delete "{deleteConfirmLibrary.name}"?</h2>
            <p>This will remove the library and all its book records, metadata, series, and genres from the database.</p>
            <p><strong>Your files on disk will not be touched.</strong> You can re-add this library at any time and it will be re-scanned from the same folder.</p>
            {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setDeleteConfirmLibrary(null)}
                disabled={deleting}
                autoFocus
              >
                Cancel
              </button>
              <button className="danger-button" onClick={deleteLibrary} disabled={deleting}>
                <Trash2 size={15} /> {deleting ? "Deleting…" : "Yes, delete library"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingLibrary && (
        <div className="modal-backdrop" onMouseDown={() => !saving && setEditingLibrary(null)}>
          <form
            className="confirm-modal edit-library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-library-title"
            onSubmit={saveEdit}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="edit-library-title">Edit library</h2>
            <Field label="Library name" value={editName} onChange={setEditName} />
            <label className="field">
              <span>Owner</span>
              <select
                value={editOwnerId ? `${editOwnerType}:${editOwnerId}` : ""}
                onChange={(event) => {
                  const val = event.target.value;
                  if (!val) { setEditOwnerId(""); setEditOwnerType(""); return; }
                  const [type, id] = val.split(":");
                  setEditOwnerType(type as "user" | "group");
                  setEditOwnerId(id);
                }}
              >
                <option value="">No owner (system library)</option>
                {users.length > 0 && (
                  <optgroup label="Users">
                    {users.map((user) => (
                      <option value={`user:${user.id}`} key={user.id}>{user.displayName} ({user.email})</option>
                    ))}
                  </optgroup>
                )}
                {groups.length > 0 && (
                  <optgroup label="Groups">
                    {groups.map((group) => (
                      <option value={`group:${group.id}`} key={group.id}>{group.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="field">
              <span>Visibility</span>
              <select value={editVisibility} onChange={(event) => setEditVisibility(event.target.value as "public" | "private")}>
                <option value="public">Public — all users can access</option>
                <option value="private">Private — owner and admins only</option>
              </select>
            </label>
            {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setEditingLibrary(null)} disabled={saving} autoFocus>
                Cancel
              </button>
              <button className="primary-button" disabled={saving || !editName.trim()}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
