import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { Plus, RefreshCw, Pencil, Trash2, Users, KeyRound } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import type { AudiobookLibrary, PublicRole, LibraryMode, ScanSource, MetadataSourceInfo, LibraryTypeDefaults } from "../../audiobooks/types";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot, StorageBrowse } from "../types";
import { LibraryCoreFields } from "../libraries/LibraryCoreFields";
import { ExtensionsEditor } from "../libraries/ExtensionsEditor";
import { ScanSourcesEditor } from "../libraries/ScanSourcesEditor";
import { UploadSettingsFields } from "../libraries/UploadSettingsFields";
import { SourceFolderPicker } from "../libraries/SourceFolderPicker";
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
  const [storageBrowse, setStorageBrowse] = useState<StorageBrowse | null>(null);
  const [libraryName, setLibraryName] = useState("");
  const [libraryVisibility, setLibraryVisibility] = useState<"public" | "private">("public");
  const [libraryPublicRole, setLibraryPublicRole] = useState<PublicRole>("member");
  const [libraryMode, setLibraryMode] = useState<LibraryMode>("managed");
  const [libraryOwnerId, setLibraryOwnerId] = useState("");
  const [libraryOwnerType, setLibraryOwnerType] = useState<"user" | "group" | "">("");
  const [libraryExtensions, setLibraryExtensions] = useState<string[]>([]);
  const [librarySources, setLibrarySources] = useState<ScanSource[]>([]);
  const [libraryMaxUploadMB, setLibraryMaxUploadMB] = useState("");
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
  const [saving, setSaving] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
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

  const maxUploadValue = (raw: string) => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
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
          visibility: libraryVisibility,
          publicRole: libraryPublicRole,
          mode: libraryMode,
          ownerId: libraryOwnerId || null,
          ownerType: libraryOwnerType || null,
          scanExtensions: libraryExtensions,
          scanSources: librarySources,
          maxUploadMB: maxUploadValue(libraryMaxUploadMB)
        })
      });
      setCreateLibraryOpen(false);
      setLibraryName("");
      setLibraryVisibility("public");
      setLibraryPublicRole("member");
      setLibraryMode("managed");
      setLibraryOwnerId("");
      setLibraryOwnerType("");
      setLibraryMaxUploadMB("");
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
    setEditPublicRole(library.publicRole ?? "member");
    setEditMode(library.mode ?? "managed");
    setEditOwnerId(library.ownerId ?? "");
    setEditOwnerType(library.ownerType ?? "");
    setEditExtensions(library.settings?.scanExtensions ?? defaults?.extensions ?? []);
    setEditSources(library.settings?.scanSources ?? defaultSources);
    setEditMaxUploadMB(library.settings?.maxUploadMB != null ? String(library.settings.maxUploadMB) : "");
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
          maxUploadMB: maxUploadValue(editMaxUploadMB)
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
          sources: rescanSources,
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

  const openCreateLibrary = () => {
    setError("");
    setWizardStep(0);
    setLibraryExtensions(defaults?.extensions ?? []);
    setLibrarySources(defaultSources);
    setLibraryMaxUploadMB("");
    setCreateLibraryOpen(true);
    const rootId = selectedRootId || storageRoots[0]?.id || "";
    if (rootId) {
      browseStorageRoot(rootId).catch((err) => setError(err instanceof Error ? err.message : "Unable to browse storage container"));
    }
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

      {createLibraryOpen && (() => {
        const steps: ("details" | "scanning" | "source")[] = ["details", "scanning", "source"];
        const lastStep = steps.length - 1;
        const current = Math.min(wizardStep, lastStep);
        const stepKey = steps[current];
        const stepTitles: Record<typeof steps[number], string> = {
          details: "Details",
          scanning: "Scanning & upload",
          source: "Source folder"
        };
        const canLeaveDetails = libraryName.trim().length >= 2;
        const canSubmit = Boolean(storageBrowse?.selectedPath) && Boolean(librarySettings?.thumbnailPathReady) && storageRoots.length > 0;
        const closeWizard = () => { setCreateLibraryOpen(false); setStorageBrowse(null); };
        const goNext = () => {
          if (stepKey === "details" && !canLeaveDetails) {
            setError("Enter a library name (at least 2 characters) to continue.");
            return;
          }
          if (stepKey === "scanning" && libraryExtensions.length === 0) {
            setError("Add at least one file extension to scan.");
            return;
          }
          setError("");
          setWizardStep(current + 1);
        };
        const onWizardSubmit = (event: FormEvent) => {
          if (current < lastStep) { event.preventDefault(); goNext(); return; }
          createLibrary(event);
        };

        return (
        <div className="modal-backdrop" onMouseDown={() => !creating && closeWizard()}>
          <form
            className="confirm-modal create-library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-library-title"
            onSubmit={onWizardSubmit}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div>
              <h2 id="create-library-title">Add audiobook library</h2>
              <p className="wizard-step-indicator">Step {current + 1} of {steps.length} — {stepTitles[stepKey]}</p>
            </div>
            {(!librarySettings?.thumbnailPathReady || storageRoots.length === 0) && (
              <MessageBox tone="warning" title="Thumbnail storage required">
                Configure thumbnail storage and at least one Digital Library container first.
              </MessageBox>
            )}

            {stepKey === "details" && (
              <LibraryCoreFields
                name={libraryName}
                onNameChange={setLibraryName}
                ownerId={libraryOwnerId}
                ownerType={libraryOwnerType}
                onOwnerChange={(type, id) => { setLibraryOwnerType(type); setLibraryOwnerId(id); }}
                visibility={libraryVisibility}
                onVisibilityChange={setLibraryVisibility}
                publicRole={libraryPublicRole}
                onPublicRoleChange={setLibraryPublicRole}
                mode={libraryMode}
                onModeChange={setLibraryMode}
                users={users}
                groups={groups}
              />
            )}

            {stepKey === "scanning" && (
              <>
                <ScanSourcesEditor
                  sources={librarySources}
                  onChange={setLibrarySources}
                  sourceInfo={typeSourceInfo}
                />
                <ExtensionsEditor
                  extensions={libraryExtensions}
                  onChange={setLibraryExtensions}
                  defaults={defaults?.extensions ?? []}
                />
                <UploadSettingsFields
                  maxUploadMB={libraryMaxUploadMB}
                  onChange={setLibraryMaxUploadMB}
                  mode={libraryMode}
                />
              </>
            )}

            {stepKey === "source" && (
              <SourceFolderPicker
                storageRoots={storageRoots}
                selectedRootId={selectedRootId}
                storageBrowse={storageBrowse}
                onBrowse={browseStorageRoot}
                onError={setError}
              />
            )}

            {error && <MessageBox tone="error" title="Unable to add library">{error}</MessageBox>}

            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={current > 0 ? () => setWizardStep(current - 1) : closeWizard}
                disabled={creating}
              >
                {current > 0 ? "Back" : "Cancel"}
              </button>
              {current < lastStep ? (
                <button className="primary-button" type="submit">
                  Next
                </button>
              ) : (
                <button className="primary-button" type="submit" disabled={creating || !canSubmit}>
                  {creating ? "Scanning..." : "Add and scan"}
                </button>
              )}
            </div>
          </form>
        </div>
        );
      })()}

      {membersLibrary && (
        <LibraryMembersModal
          library={membersLibrary}
          users={users}
          groups={groups}
          onClose={() => setMembersLibrary(null)}
        />
      )}

      {rescanTarget && (
        <div className="modal-backdrop" onMouseDown={() => !rescanRunning && setRescanTarget(null)}>
          <div
            className="confirm-modal rescan-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rescan-library-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="rescan-library-title">Rescan "{rescanTarget.name}"</h2>
            <p>Re-index this library from disk. Your files are never modified, and manually edited metadata is kept.</p>
            <ScanSourcesEditor
              sources={rescanSources}
              onChange={setRescanSources}
              sourceInfo={typeSourceInfo}
            />
            <p className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.4 }}>
              These choices apply to this scan only — edit the library to change its defaults.
            </p>
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
              <button className="secondary-button" type="button" onClick={() => setEditingLibrary(null)} disabled={saving} autoFocus>
                Cancel
              </button>
              <button className="primary-button" disabled={saving || !editName.trim() || editExtensions.length === 0}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
