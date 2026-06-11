import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { Plus, RefreshCw, Pencil, Trash2, Users, KeyRound } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { formatManagedDate } from "../../../shared/utils";
import type { AudiobookLibrary, PublicRole, LibraryMode, ScanSource, MetadataSourceInfo, LibraryTypeDefaults } from "../../audiobooks/types";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot } from "../types";
import { LibraryCoreFields } from "../libraries/LibraryCoreFields";
import { ExtensionsEditor } from "../libraries/ExtensionsEditor";
import { ScanSourcesEditor } from "../libraries/ScanSourcesEditor";
import { UploadSettingsFields } from "../libraries/UploadSettingsFields";
import { TagEncodingField } from "../libraries/TagEncodingField";
import { LibraryWizard } from "../libraries/LibraryWizard";
import { LibraryMembersModal } from "./LibraryMembersModal";

const LIBRARY_TYPE = "audiobook";

export function LibrariesSection() {
  const [libraries, setLibraries] = useState<AudiobookLibrary[]>([]);
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [metadataSources, setMetadataSources] = useState<MetadataSourceInfo[]>([]);
  const [typeDefaults, setTypeDefaults] = useState<Record<string, LibraryTypeDefaults>>({});
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [selectedRootId, setSelectedRootId] = useState("");
  const [rescanTarget, setRescanTarget] = useState<AudiobookLibrary | null>(null);
  const [rescanSources, setRescanSources] = useState<ScanSource[]>([]);
  const [rescanEncoding, setRescanEncoding] = useState("auto");
  const [rescanRunning, setRescanRunning] = useState(false);
  const [membersLibrary, setMembersLibrary] = useState<AudiobookLibrary | null>(null);
  const [deleteConfirmLibrary, setDeleteConfirmLibrary] = useState<AudiobookLibrary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createLibraryOpen, setCreateLibraryOpen] = useState(false);
  const [editingLibrary, setEditingLibrary] = useState<AudiobookLibrary | null>(null);
  const [editName, setEditName] = useState("");
  const [editVisibility, setEditVisibility] = useState<"public" | "private">("public");
  const [editPublicRole, setEditPublicRole] = useState<PublicRole>("member");
  const [editMode, setEditMode] = useState<LibraryMode>("managed");
  const [editOwnerId, setEditOwnerId] = useState("");
  const [editOwnerType, setEditOwnerType] = useState<"user" | "group" | "">("");
  const [editExtensions, setEditExtensions] = useState<string[]>([]);
  const [editSources, setEditSources] = useState<ScanSource[]>([]);
  const [editMaxUploadMB, setEditMaxUploadMB] = useState("");
  const [editTagEncoding, setEditTagEncoding] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const typeSourceInfo = useMemo(
    () => metadataSources.filter((source) => source.appliesTo.includes(LIBRARY_TYPE)),
    [metadataSources]
  );
  const defaults = typeDefaults[LIBRARY_TYPE];
  const defaultSources = useMemo<ScanSource[]>(
    () => defaults?.sources ?? typeSourceInfo.map((source) => ({ id: source.id, enabled: source.defaultEnabled })),
    [defaults, typeSourceInfo]
  );

  const loadStorage = useCallback(async () => {
    const settingsPayload = await api<{
      settings: LibrarySettings;
      metadataSources?: MetadataSourceInfo[];
      typeDefaults?: Record<string, LibraryTypeDefaults>;
    }>("/api/library/settings");
    setLibrarySettings(settingsPayload.settings);
    setMetadataSources(settingsPayload.metadataSources ?? []);
    setTypeDefaults(settingsPayload.typeDefaults ?? {});

    const rootsPayload = await api<{ roots: StorageRoot[] }>("/api/storage/roots");
    setStorageRoots(rootsPayload.roots);
    setSelectedRootId((current) => current || rootsPayload.roots[0]?.id || "");
    return { settings: settingsPayload.settings, roots: rootsPayload.roots };
  }, []);

  const loadLibraries = useCallback(async () => {
    await loadStorage();
    const [librariesPayload, usersPayload, groupsPayload] = await Promise.all([
      api<{ libraries: AudiobookLibrary[] }>("/api/library/audiobook-libraries?manage=1"),
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

  const maxUploadValue = (raw: string) => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const openEdit = (library: AudiobookLibrary) => {
    setEditingLibrary(library);
    setEditName(library.name);
    setEditVisibility(library.visibility);
    setEditPublicRole(library.publicRole ?? "member");
    setEditMode(library.mode ?? "managed");
    setEditOwnerId(library.ownerId ?? "");
    setEditOwnerType(library.ownerType ?? "");
    setEditExtensions(library.settings?.scanExtensions ?? defaults?.extensions ?? []);
    setEditSources(library.settings?.scanSources ?? defaultSources);
    setEditMaxUploadMB(library.settings?.maxUploadMB != null ? String(library.settings.maxUploadMB) : "");
    setEditTagEncoding(library.settings?.tagEncoding ?? "");
    setError("");
  };

  const takeOwnership = async (library: AudiobookLibrary) => {
    setError("");
    try {
      await api(`/api/library/libraries/${library.id}/take-ownership`, { method: "POST", body: "{}" });
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to take ownership");
    }
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
          publicRole: editPublicRole,
          mode: editMode,
          ownerId: editOwnerId || null,
          ownerType: editOwnerType || null,
          scanExtensions: editExtensions,
          scanSources: editSources,
          maxUploadMB: maxUploadValue(editMaxUploadMB),
          tagEncoding: editTagEncoding || null
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
    setRescanSources(library.settings?.scanSources ?? defaultSources);
    setRescanEncoding(library.settings?.tagEncoding ?? "");
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
          sources: rescanSources,
          tagEncoding: rescanEncoding || undefined
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

  const openCreateLibrary = () => {
    setError("");
    setCreateLibraryOpen(true);
  };

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Digital Library</p>
          <h1>Audiobooks</h1>
        </div>
        <div className="row-actions">
          <button
            className="primary-button"
            disabled={!librarySettings?.thumbnailPathReady || storageRoots.length === 0}
            onClick={openCreateLibrary}
            title="Add audiobook library"
          >
            <Plus size={18} />
            <span>Add library</span>
          </button>
        </div>
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
                        {library.canManageLibrary ? (
                          <>
                            <button
                              className="icon-button"
                              title="Manage members & roles"
                              onClick={() => setMembersLibrary(library)}
                            >
                              <Users size={15} />
                            </button>
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
                          </>
                        ) : (
                          // Private library this admin can't access — take ownership (logged) to manage it.
                          <button
                            className="secondary-button compact-button"
                            title="This private library is owned by someone else. Take ownership to manage it (logged)."
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

      {createLibraryOpen && (
        <LibraryWizard
          initialType="audiobook"
          users={users}
          groups={groups}
          storageRoots={storageRoots}
          initialRootId={selectedRootId || storageRoots[0]?.id || ""}
          metadataSources={metadataSources}
          typeDefaults={typeDefaults}
          onClose={() => setCreateLibraryOpen(false)}
          onCreated={() => {
            loadLibraries().catch((err) => setError(err instanceof Error ? err.message : "Unable to load libraries"));
          }}
        />
      )}

      {membersLibrary && (
        <LibraryMembersModal
          library={membersLibrary}
          users={users}
          groups={groups}
          onClose={() => setMembersLibrary(null)}
        />
      )}

      {rescanTarget && (
        <Modal
          title={`Rescan "${rescanTarget.name}"`}
          className="rescan-modal"
          busy={rescanRunning}
          onClose={() => setRescanTarget(null)}
        >
            <p>Re-index this library from disk. Your files are never modified, and manually edited metadata is kept.</p>
            <ScanSourcesEditor
              sources={rescanSources}
              onChange={setRescanSources}
              sourceInfo={typeSourceInfo}
            />
            <p className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.4 }}>
              These choices apply to this scan only — edit the library to change its defaults.
            </p>
            <TagEncodingField
              value={rescanEncoding}
              onChange={setRescanEncoding}
              noneLabel="Library default — leave tags as-is"
            />
            {error && <MessageBox tone="error" title="Rescan error">{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setRescanTarget(null)} disabled={rescanRunning} autoFocus>
                Cancel
              </Button>
              <Button variant="primary" onClick={runRescan} disabled={rescanRunning}>
                <RefreshCw size={15} /> {rescanRunning ? "Starting…" : "Start rescan"}
              </Button>
            </div>
        </Modal>
      )}

      {deleteConfirmLibrary && (
        <ConfirmDialog
          title={`Delete "${deleteConfirmLibrary.name}"?`}
          confirmLabel="Yes, delete library"
          busyLabel="Deleting…"
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={error}
          onConfirm={deleteLibrary}
          onCancel={() => setDeleteConfirmLibrary(null)}
        >
          <p>This will remove the library and all its book records, metadata, series, and genres from the database.</p>
          <p><strong>Your files on disk will not be touched.</strong> You can re-add this library at any time and it will be re-scanned from the same folder.</p>
        </ConfirmDialog>
      )}

      {editingLibrary && (
        <Modal
          title="Edit library"
          className="edit-library-modal"
          busy={saving}
          onClose={() => setEditingLibrary(null)}
          onSubmit={saveEdit}
        >
            <LibraryCoreFields
              name={editName}
              onNameChange={setEditName}
              ownerId={editOwnerId}
              ownerType={editOwnerType}
              onOwnerChange={(type, id) => { setEditOwnerType(type); setEditOwnerId(id); }}
              visibility={editVisibility}
              onVisibilityChange={setEditVisibility}
              publicRole={editPublicRole}
              onPublicRoleChange={setEditPublicRole}
              mode={editMode}
              onModeChange={setEditMode}
              users={users}
              groups={groups}
            />
            <ScanSourcesEditor
              sources={editSources}
              onChange={setEditSources}
              sourceInfo={typeSourceInfo}
            />
            <TagEncodingField value={editTagEncoding} onChange={setEditTagEncoding} />
            <ExtensionsEditor
              extensions={editExtensions}
              onChange={setEditExtensions}
              defaults={defaults?.extensions ?? []}
            />
            <UploadSettingsFields
              maxUploadMB={editMaxUploadMB}
              onChange={setEditMaxUploadMB}
              mode={editMode}
            />
            {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setEditingLibrary(null)} disabled={saving} autoFocus>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={saving || !editName.trim() || editExtensions.length === 0}>
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
        </Modal>
      )}
    </>
  );
}
