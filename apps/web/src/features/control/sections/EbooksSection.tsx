import { useState, useEffect, useCallback, type FormEvent } from "react";
import { Plus, RefreshCw, Trash2, Users, KeyRound } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot, StorageBrowse } from "../types";
import type { PublicRole, LibraryMode } from "../../audiobooks/types";
import { PUBLIC_ROLE_OPTIONS } from "../../audiobooks/types";
import { LibraryMembersModal } from "./LibraryMembersModal";

interface EbookLibrary {
  id: string;
  name: string;
  sourcePath: string | null;
  scanStatus: string;
  lastScannedAt: string | null;
  ownerId: string | null;
  ownerType: "user" | "group" | null;
  visibility: "public" | "private";
  canManageLibrary: boolean;
  bookCount: number;
}

export function EbooksSection() {
  const [libraries, setLibraries] = useState<EbookLibrary[]>([]);
  const [settings, setSettings] = useState<LibrarySettings | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [publicRole, setPublicRole] = useState<PublicRole>("member");
  const [mode, setMode] = useState<LibraryMode>("managed");
  const [ownerId, setOwnerId] = useState("");
  const [selectedRootId, setSelectedRootId] = useState("");
  const [storageBrowse, setStorageBrowse] = useState<StorageBrowse | null>(null);
  const [creating, setCreating] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState<EbookLibrary | null>(null);
  const [membersLibrary, setMembersLibrary] = useState<EbookLibrary | null>(null);
  const [rescanningId, setRescanningId] = useState("");

  const load = useCallback(async () => {
    const [librariesPayload, settingsPayload, rootsPayload, usersPayload, groupsPayload] = await Promise.all([
      api<{ libraries: EbookLibrary[] }>("/api/library/ebook-libraries?manage=1"),
      api<{ settings: LibrarySettings }>("/api/library/settings"),
      api<{ roots: StorageRoot[] }>("/api/storage/roots"),
      api<{ users: ManagedUser[] }>("/api/users"),
      api<{ groups: ManagedGroup[] }>("/api/groups")
    ]);
    setLibraries(librariesPayload.libraries);
    setSettings(settingsPayload.settings);
    setStorageRoots(rootsPayload.roots);
    setSelectedRootId((current) => current || rootsPayload.roots[0]?.id || "");
    setUsers(usersPayload.users);
    setGroups(groupsPayload.groups);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load ebook libraries"));
  }, [load]);

  // Poll while a scan is running so book counts/status update live.
  useEffect(() => {
    if (!libraries.some((l) => l.scanStatus === "scanning")) return;
    const timer = window.setInterval(() => {
      load().catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [libraries, load]);

  const browse = async (rootId: string, relativePath = "") => {
    const query = new URLSearchParams({ path: relativePath });
    const payload = await api<StorageBrowse>(`/api/storage/roots/${rootId}/browse?${query}`);
    setSelectedRootId(rootId);
    setStorageBrowse(payload);
  };

  const openCreate = () => {
    setName("");
    setVisibility("public");
    setPublicRole("member");
    setMode("managed");
    setOwnerId("");
    setStorageBrowse(null);
    setError("");
    setCreateOpen(true);
    const rootId = selectedRootId || storageRoots[0]?.id || "";
    if (rootId) browse(rootId).catch((err) => setError(err instanceof Error ? err.message : "Unable to browse container"));
  };

  const createLibrary = async (event: FormEvent) => {
    event.preventDefault();
    if (!storageBrowse?.selectedPath) {
      setError("Choose a folder for this library.");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const ownerType = ownerId ? (users.some((u) => u.id === ownerId) ? "user" : "group") : null;
      await api("/api/library/ebook-libraries", {
        method: "POST",
        body: JSON.stringify({
          name,
          sourcePath: storageBrowse.selectedPath,
          defaultLanguage: "en",
          visibility,
          publicRole,
          mode,
          ownerId: ownerId || null,
          ownerType
        })
      });
      setCreateOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add ebook library");
    } finally {
      setCreating(false);
    }
  };

  const rescan = async (id: string) => {
    setRescanningId(id);
    setError("");
    try {
      await api(`/api/library/ebook-libraries/${id}/rescan`, { method: "POST", body: "{}" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rescan");
    } finally {
      setRescanningId("");
    }
  };

  const takeOwnership = async (library: EbookLibrary) => {
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/take-ownership`, { method: "POST", body: "{}" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to take ownership");
    }
  };

  const deleteLibrary = async () => {
    if (!deleteConfirm) return;
    try {
      await api(`/api/library/ebook-libraries/${deleteConfirm.id}`, { method: "DELETE" });
      setDeleteConfirm(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete library");
    }
  };

  const ready = Boolean(settings?.thumbnailPathReady) && storageRoots.length > 0;
  const canSubmit = Boolean(storageBrowse?.selectedPath) && Boolean(name.trim()) && ready;

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Ebooks</h1>
        </div>
        <button className="primary-button" onClick={openCreate} disabled={!ready}>
          <Plus size={16} /> <span>Add library</span>
        </button>
      </div>

      {error && <MessageBox tone="error" title="Ebooks error">{error}</MessageBox>}
      {!ready && (
        <MessageBox tone="info" title="Setup needed">
          Configure a thumbnail path and at least one storage container before adding an ebook library.
        </MessageBox>
      )}

      {libraries.length === 0 ? (
        <p className="management-empty">No ebook libraries yet.</p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>Library</th>
                <th>Visibility</th>
                <th className="col-num">Books</th>
                <th className="col-scan">Last scanned</th>
                <th>Status</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {libraries.map((library) => {
                const owner = library.ownerType === "user"
                  ? users.find((u) => u.id === library.ownerId)?.displayName
                  : library.ownerType === "group"
                    ? `${groups.find((g) => g.id === library.ownerId)?.name ?? "—"} (group)`
                    : null;
                return (
                  <tr key={library.id}>
                    <td>
                      <div className="datagrid-primary">
                        <strong>{library.name}</strong>
                        <small>{library.sourcePath ?? "Source path hidden"}</small>
                        {owner && <small>Owner: {owner}</small>}
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${library.visibility}`}>{library.visibility === "public" ? "Public" : "Private"}</span>
                    </td>
                    <td className="col-num datagrid-muted">{library.bookCount}</td>
                    <td className="col-scan datagrid-muted">{library.lastScannedAt ? formatManagedDate(library.lastScannedAt) : "Not yet"}</td>
                    <td><span className={`status-badge ${library.scanStatus}`}>{library.scanStatus}</span></td>
                    <td className="col-actions">
                      <div className="row-actions">
                        {library.canManageLibrary ? (
                          <>
                            <button
                              className="secondary-button compact-button rescan-library-button"
                              disabled={library.scanStatus === "scanning" || rescanningId === library.id}
                              onClick={() => rescan(library.id)}
                              title={library.scanStatus === "scanning" ? "Scan already in progress" : "Rescan library"}
                            >
                              <RefreshCw size={14} />
                              {library.scanStatus === "scanning" ? "Scanning..." : "Rescan"}
                            </button>
                            <button className="icon-button" title="Manage members & roles" onClick={() => setMembersLibrary(library)}>
                              <Users size={15} />
                            </button>
                            <button className="icon-button danger" title="Delete library" onClick={() => setDeleteConfirm(library)}>
                              <Trash2 size={15} />
                            </button>
                          </>
                        ) : (
                          <button
                            className="secondary-button compact-button"
                            title="Private library owned by someone else. Take ownership to manage it (logged)."
                            onClick={() => takeOwnership(library)}
                          >
                            <KeyRound size={14} /> Take ownership
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <div className="modal-backdrop" onMouseDown={() => !creating && setCreateOpen(false)}>
          <div className="metadata-modal create-library-modal" role="dialog" aria-modal="true" aria-label="Add ebook library" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-header"><h2>Add ebook library</h2></div>
            <form className="modal-tab-content" onSubmit={createLibrary}>
              <label className="field">
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Family Ebooks" autoFocus required />
              </label>

              <label className="field">
                <span>Container</span>
                <select value={selectedRootId} onChange={(e) => browse(e.target.value).catch((err) => setError(err instanceof Error ? err.message : "Unable to browse container"))} required>
                  {storageRoots.map((root) => <option value={root.id} key={root.id}>{root.name}</option>)}
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
                      <button className="secondary-button compact-button" type="button" onClick={() => browse(storageBrowse.root.id, storageBrowse.parentPath ?? "")}>Up</button>
                    )}
                  </div>
                  <div className="folder-list">
                    {storageBrowse.entries.map((entry) => (
                      <button className="folder-row" type="button" key={entry.relativePath} onClick={() => browse(storageBrowse.root.id, entry.relativePath)}>
                        {entry.name}
                      </button>
                    ))}
                    {storageBrowse.entries.length === 0 && <p className="management-empty">No child folders. The current folder can still be used.</p>}
                  </div>
                </section>
              )}

              <div className="override-grid">
                <label className="field">
                  <span>Visibility</span>
                  <select value={visibility} onChange={(e) => setVisibility(e.target.value as "public" | "private")}>
                    <option value="public">Public — all users</option>
                    <option value="private">Private — owner and admins</option>
                  </select>
                </label>
                {visibility === "public" && (
                  <label className="field">
                    <span>Public access</span>
                    <select value={publicRole} onChange={(e) => setPublicRole(e.target.value as PublicRole)}>
                      {PUBLIC_ROLE_OPTIONS.map((o) => <option value={o.value} key={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                )}
                <label className="field">
                  <span>Mode</span>
                  <select value={mode} onChange={(e) => setMode(e.target.value as LibraryMode)}>
                    <option value="managed">Managed — this app owns the files</option>
                    <option value="external">External (read-only)</option>
                  </select>
                </label>
                <label className="field">
                  <span>Owner (optional)</span>
                  <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                    <option value="">No owner</option>
                    <optgroup label="Users">
                      {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                    </optgroup>
                    <optgroup label="Groups">
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </optgroup>
                  </select>
                </label>
              </div>

              {error && <MessageBox tone="error" title="Unable to add library">{error}</MessageBox>}

              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</button>
                <button className="primary-button" type="submit" disabled={creating || !canSubmit}>{creating ? "Scanning…" : "Add and scan"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {membersLibrary && (
        <LibraryMembersModal
          library={membersLibrary}
          users={users}
          groups={groups}
          onClose={() => setMembersLibrary(null)}
        />
      )}

      {deleteConfirm && (
        <div className="modal-backdrop" onMouseDown={() => setDeleteConfirm(null)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Delete “{deleteConfirm.name}”?</h2>
            <p>The catalogue entry and covers are removed. Files on disk are never touched.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="danger-button" onClick={deleteLibrary}>Delete library</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
