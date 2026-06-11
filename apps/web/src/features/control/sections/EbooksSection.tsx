import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { Plus, RefreshCw, Pencil, Trash2, Users, KeyRound } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { formatManagedDate } from "../../../shared/utils";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot } from "../types";
import type { PublicRole, LibraryMode, ScanSource, MetadataSourceInfo, LibraryTypeDefaults, AdminLibrarySettings } from "../../audiobooks/types";
import { LibraryCoreFields } from "../libraries/LibraryCoreFields";
import { ExtensionsEditor } from "../libraries/ExtensionsEditor";
import { ScanSourcesEditor } from "../libraries/ScanSourcesEditor";
import { UploadSettingsFields } from "../libraries/UploadSettingsFields";
import { LibraryWizard } from "../libraries/LibraryWizard";
import { LibraryMembersModal } from "./LibraryMembersModal";

const LIBRARY_TYPE = "ebook";

interface EbookLibrary {
  id: string;
  name: string;
  sourcePath: string | null;
  settings?: AdminLibrarySettings;
  scanStatus: string;
  lastScannedAt: string | null;
  ownerId: string | null;
  ownerType: "user" | "group" | null;
  visibility: "public" | "private";
  publicRole: PublicRole;
  mode: LibraryMode;
  canManageLibrary: boolean;
  bookCount: number;
}

export function EbooksSection() {
  const [libraries, setLibraries] = useState<EbookLibrary[]>([]);
  const [settings, setSettings] = useState<LibrarySettings | null>(null);
  const [metadataSources, setMetadataSources] = useState<MetadataSourceInfo[]>([]);
  const [typeDefaults, setTypeDefaults] = useState<Record<string, LibraryTypeDefaults>>({});
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedRootId, setSelectedRootId] = useState("");

  const [editing, setEditing] = useState<EbookLibrary | null>(null);
  const [editName, setEditName] = useState("");
  const [editVisibility, setEditVisibility] = useState<"public" | "private">("public");
  const [editPublicRole, setEditPublicRole] = useState<PublicRole>("member");
  const [editMode, setEditMode] = useState<LibraryMode>("managed");
  const [editOwnerId, setEditOwnerId] = useState("");
  const [editOwnerType, setEditOwnerType] = useState<"user" | "group" | "">("");
  const [editExtensions, setEditExtensions] = useState<string[]>([]);
  const [editScanSources, setEditScanSources] = useState<ScanSource[]>([]);
  const [editMaxUploadMB, setEditMaxUploadMB] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState<EbookLibrary | null>(null);
  const [membersLibrary, setMembersLibrary] = useState<EbookLibrary | null>(null);
  const [rescanningId, setRescanningId] = useState("");

  const typeSourceInfo = useMemo(
    () => metadataSources.filter((source) => source.appliesTo.includes(LIBRARY_TYPE)),
    [metadataSources]
  );
  const defaults = typeDefaults[LIBRARY_TYPE];
  const defaultSources = useMemo<ScanSource[]>(
    () => defaults?.sources ?? typeSourceInfo.map((source) => ({ id: source.id, enabled: source.defaultEnabled })),
    [defaults, typeSourceInfo]
  );

  const load = useCallback(async () => {
    const [librariesPayload, settingsPayload, rootsPayload, usersPayload, groupsPayload] = await Promise.all([
      api<{ libraries: EbookLibrary[] }>("/api/library/ebook-libraries?manage=1"),
      api<{
        settings: LibrarySettings;
        metadataSources?: MetadataSourceInfo[];
        typeDefaults?: Record<string, LibraryTypeDefaults>;
      }>("/api/library/settings"),
      api<{ roots: StorageRoot[] }>("/api/storage/roots"),
      api<{ users: ManagedUser[] }>("/api/users"),
      api<{ groups: ManagedGroup[] }>("/api/groups")
    ]);
    setLibraries(librariesPayload.libraries);
    setSettings(settingsPayload.settings);
    setMetadataSources(settingsPayload.metadataSources ?? []);
    setTypeDefaults(settingsPayload.typeDefaults ?? {});
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

  const maxUploadValue = (raw: string) => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const openCreate = () => {
    setError("");
    setCreateOpen(true);
  };

  const openEdit = (library: EbookLibrary) => {
    setEditing(library);
    setEditName(library.name);
    setEditVisibility(library.visibility);
    setEditPublicRole(library.publicRole ?? "member");
    setEditMode(library.mode ?? "managed");
    setEditOwnerId(library.ownerId ?? "");
    setEditOwnerType(library.ownerType ?? "");
    setEditExtensions(library.settings?.scanExtensions ?? defaults?.extensions ?? []);
    setEditScanSources(library.settings?.scanSources ?? defaultSources);
    setEditMaxUploadMB(library.settings?.maxUploadMB != null ? String(library.settings.maxUploadMB) : "");
    setError("");
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/library/ebook-libraries/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName,
          visibility: editVisibility,
          publicRole: editPublicRole,
          mode: editMode,
          ownerId: editOwnerId || null,
          ownerType: editOwnerType || null,
          scanExtensions: editExtensions,
          scanSources: editScanSources,
          maxUploadMB: maxUploadValue(editMaxUploadMB)
        })
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save changes");
    } finally {
      setSaving(false);
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
                            <button className="icon-button" title="Manage members & roles" onClick={() => setMembersLibrary(library)}>
                              <Users size={15} />
                            </button>
                            <button className="icon-button" title="Edit library" onClick={() => openEdit(library)}>
                              <Pencil size={15} />
                            </button>
                            <button
                              className="secondary-button compact-button rescan-library-button"
                              disabled={library.scanStatus === "scanning" || rescanningId === library.id}
                              onClick={() => rescan(library.id)}
                              title={library.scanStatus === "scanning" ? "Scan already in progress" : "Rescan library"}
                            >
                              <RefreshCw size={14} />
                              {library.scanStatus === "scanning" ? "Scanning..." : "Rescan"}
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
        <LibraryWizard
          initialType="ebook"
          users={users}
          groups={groups}
          storageRoots={storageRoots}
          initialRootId={selectedRootId || storageRoots[0]?.id || ""}
          metadataSources={metadataSources}
          typeDefaults={typeDefaults}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load ebook libraries"));
          }}
        />
      )}

      {editing && (
        <Modal
          title="Edit library"
          className="edit-library-modal"
          busy={saving}
          onClose={() => setEditing(null)}
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
            <ScanSourcesEditor sources={editScanSources} onChange={setEditScanSources} sourceInfo={typeSourceInfo} />
            <ExtensionsEditor extensions={editExtensions} onChange={setEditExtensions} defaults={defaults?.extensions ?? []} />
            <UploadSettingsFields maxUploadMB={editMaxUploadMB} onChange={setEditMaxUploadMB} mode={editMode} />
            {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving} autoFocus>
                Cancel
              </Button>
              <Button variant="primary" type="submit" disabled={saving || editName.trim().length < 2 || editExtensions.length === 0}>
                {saving ? "Saving..." : "Save changes"}
              </Button>
            </div>
        </Modal>
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
        <ConfirmDialog
          title={`Delete “${deleteConfirm.name}”?`}
          confirmLabel="Delete library"
          danger
          onConfirm={deleteLibrary}
          onCancel={() => setDeleteConfirm(null)}
        >
          The catalogue entry and covers are removed. Files on disk are never touched.
        </ConfirmDialog>
      )}
    </>
  );
}
