import { useState, useEffect, useCallback, useMemo, type FormEvent, type ReactNode } from "react";
import {
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  Users,
  KeyRound,
  Headphones,
  BookOpen,
  Info,
  Search,
  Folder,
  LayoutGrid,
  LibraryBig
} from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { SelectMenu } from "../../../shared/SelectMenu";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import type { AudiobookLibrary, PublicRole, LibraryMode, ScanSource, MetadataSourceInfo, LibraryTypeDefaults } from "../../audiobooks/types";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot } from "../types";
import { LibraryCoreFields } from "../libraries/LibraryCoreFields";
import { ExtensionsEditor } from "../libraries/ExtensionsEditor";
import { ScanSourcesEditor } from "../libraries/ScanSourcesEditor";
import { UploadSettingsFields } from "../libraries/UploadSettingsFields";
import { TagEncodingField } from "../libraries/TagEncodingField";
import { LibraryWizard } from "../libraries/LibraryWizard";
import { LibraryMembersModal } from "./LibraryMembersModal";

type ManagedLibraryType = "audiobook" | "ebook";

// One row shape for every library type (the server serializes them identically).
interface ManagedLibrary extends Omit<AudiobookLibrary, "type" | "fileCount"> {
  type: ManagedLibraryType;
  fileCount: number | null;
}

const TYPE_META: Record<ManagedLibraryType, { label: string; icon: typeof Headphones }> = {
  audiobook: { label: "Audiobooks", icon: Headphones },
  ebook: { label: "Ebooks", icon: BookOpen }
};

const TYPE_FILTERS: { value: "all" | ManagedLibraryType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "audiobook", label: "Audiobooks" },
  { value: "ebook", label: "Ebooks" }
];

const MODE_LABEL: Record<LibraryMode, string> = {
  managed: "Managed",
  external: "External / read-only"
};

const ROLE_LABEL: Record<string, string> = {
  viewer: "Viewer",
  member: "Member",
  contributor: "Contributor",
  manager: "Manager",
  deny: "Denied"
};

const SCAN_STATUS_LABEL: Record<ManagedLibrary["scanStatus"], string> = {
  idle: "Idle",
  scanning: "Scanning",
  error: "Error"
};

function formatCount(value: number | null | undefined) {
  return value == null ? "—" : value.toLocaleString();
}

function formatLibrarySize(value: number | null | undefined) {
  return value == null ? "—" : formatBytes(value);
}

function roleLabel(role: string | null | undefined) {
  return role ? ROLE_LABEL[role] ?? role : "None";
}

function accessSummary(library: ManagedLibrary) {
  return library.visibility === "public" ? "Public" : "Private";
}

function capabilityLabels(library: ManagedLibrary) {
  return [
    library.canDownload ? "Download" : null,
    library.canWrite ? "Edit content" : null,
    library.canUpload ? "Upload" : null,
    library.canCurate ? "Curate" : null,
    library.canManageMembers ? "Manage members" : null,
    library.canManageLibrary ? "Manage settings" : null
  ].filter(Boolean) as string[];
}

export function LibrariesSection() {
  const [libraries, setLibraries] = useState<ManagedLibrary[]>([]);
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [metadataSources, setMetadataSources] = useState<MetadataSourceInfo[]>([]);
  const [typeDefaults, setTypeDefaults] = useState<Record<string, LibraryTypeDefaults>>({});
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [selectedRootId, setSelectedRootId] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | ManagedLibraryType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [infoLibrary, setInfoLibrary] = useState<ManagedLibrary | null>(null);
  const [rescanTarget, setRescanTarget] = useState<ManagedLibrary | null>(null);
  const [rescanSources, setRescanSources] = useState<ScanSource[]>([]);
  const [rescanEncoding, setRescanEncoding] = useState("");
  const [rescanRunning, setRescanRunning] = useState(false);
  const [rescanningId, setRescanningId] = useState("");
  const [membersLibrary, setMembersLibrary] = useState<ManagedLibrary | null>(null);
  const [deleteConfirmLibrary, setDeleteConfirmLibrary] = useState<ManagedLibrary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createLibraryOpen, setCreateLibraryOpen] = useState(false);
  const [editingLibrary, setEditingLibrary] = useState<ManagedLibrary | null>(null);
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

  // API prefix for a row's type-specific endpoints (rescan/PATCH/DELETE).
  const apiBase = (library: ManagedLibrary) => `/api/library/${library.type}-libraries`;

  const sourceInfoFor = useCallback(
    (type: ManagedLibraryType) => metadataSources.filter((source) => source.appliesTo.includes(type)),
    [metadataSources]
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
  }, []);

  const loadLibraries = useCallback(async () => {
    await loadStorage();
    const [audiobooksPayload, ebooksPayload, usersPayload, groupsPayload] = await Promise.all([
      api<{ libraries: ManagedLibrary[] }>("/api/library/audiobook-libraries?manage=1"),
      api<{ libraries: ManagedLibrary[] }>("/api/library/ebook-libraries?manage=1"),
      api<{ users: ManagedUser[] }>("/api/users"),
      api<{ groups: ManagedGroup[] }>("/api/groups")
    ]);
    setLibraries(
      [...audiobooksPayload.libraries, ...ebooksPayload.libraries]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    );
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

  const openEdit = (library: ManagedLibrary) => {
    setEditingLibrary(library);
    setEditName(library.name);
    setEditVisibility(library.visibility);
    setEditPublicRole(library.publicRole ?? "member");
    setEditMode(library.mode ?? "managed");
    setEditOwnerId(library.ownerId ?? "");
    setEditOwnerType(library.ownerType ?? "");
    setEditExtensions(library.settings?.scanExtensions ?? typeDefaults[library.type]?.extensions ?? []);
    setEditSources(library.settings?.scanSources ?? typeDefaults[library.type]?.sources ?? []);
    setEditMaxUploadMB(library.settings?.maxUploadMB != null ? String(library.settings.maxUploadMB) : "");
    setEditTagEncoding(library.settings?.tagEncoding ?? "");
    setError("");
  };

  const takeOwnership = async (library: ManagedLibrary) => {
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
      await api(`${apiBase(editingLibrary)}/${editingLibrary.id}`, {
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
          ...(editingLibrary.type === "audiobook" ? { tagEncoding: editTagEncoding || null } : {})
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

  // Audiobook rescans open the options dialog; other types run straight away.
  const startRescan = (library: ManagedLibrary) => {
    if (library.type === "audiobook") {
      setRescanTarget(library);
      setRescanSources(library.settings?.scanSources ?? typeDefaults.audiobook?.sources ?? []);
      setRescanEncoding(library.settings?.tagEncoding ?? "");
      setError("");
      return;
    }
    setRescanningId(library.id);
    setError("");
    api(`${apiBase(library)}/${library.id}/rescan`, { method: "POST", body: "{}" })
      .then(() => loadLibraries())
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to rescan"))
      .finally(() => setRescanningId(""));
  };

  const runRescan = async () => {
    if (!rescanTarget) return;
    setRescanRunning(true);
    setError("");
    try {
      await api(`${apiBase(rescanTarget)}/${rescanTarget.id}/rescan`, {
        method: "POST",
        body: JSON.stringify({
          sources: rescanSources,
          tagEncoding: rescanEncoding || undefined
        })
      });
      setRescanTarget(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to scan library");
    } finally {
      setRescanRunning(false);
    }
  };

  const deleteLibrary = async () => {
    if (!deleteConfirmLibrary) return;
    setDeleting(true);
    setError("");
    try {
      await api(`${apiBase(deleteConfirmLibrary)}/${deleteConfirmLibrary.id}`, { method: "DELETE" });
      setDeleteConfirmLibrary(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete library");
    } finally {
      setDeleting(false);
    }
  };

  const libraryOwnerLabel = useCallback(
    (library: ManagedLibrary) => {
      if (library.ownerType === "user") {
        return users.find((user) => user.id === library.ownerId)?.displayName ?? "Unknown user";
      }
      if (library.ownerType === "group") {
        const groupName = groups.find((group) => group.id === library.ownerId)?.name ?? "Unknown group";
        return `${groupName} (group)`;
      }
      return "System library";
    },
    [groups, users]
  );

  const scanSourceSummary = useCallback(
    (library: ManagedLibrary) => {
      const sources = library.settings?.scanSources;
      if (!sources?.length) return "Default";
      const enabled = sources
        .filter((source) => source.enabled)
        .map((source) => metadataSources.find((info) => info.id === source.id)?.label ?? source.id);
      return enabled.length ? enabled.join(" > ") : "None";
    },
    [metadataSources]
  );

  const extensionSummary = useCallback(
    (library: ManagedLibrary) => {
      const extensions = library.settings?.scanExtensions ?? typeDefaults[library.type]?.extensions ?? [];
      return extensions.length ? extensions.join(", ") : "Not configured";
    },
    [typeDefaults]
  );

  const visibleLibraries = useMemo(
    () => {
      const typeFiltered = typeFilter === "all" ? libraries : libraries.filter((library) => library.type === typeFilter);
      const query = searchQuery.trim().toLowerCase();
      if (!query) return typeFiltered;
      return typeFiltered.filter((library) => [
        library.name,
        library.sourcePath ?? "",
        TYPE_META[library.type].label,
        libraryOwnerLabel(library),
        accessSummary(library),
        library.scanStatus
      ].some((value) => value.toLowerCase().includes(query)));
    },
    [libraries, libraryOwnerLabel, searchQuery, typeFilter]
  );

  const setupReady = Boolean(librarySettings?.thumbnailPathReady) && storageRoots.length > 0;

  return (
    <>
      <div className="section-head library-section-head">
        <div className="library-title-wrap">
          <span className="library-page-icon" aria-hidden="true">
            <LibraryBig size={30} />
          </span>
          <div className="library-heading-copy">
            <p className="eyebrow">Digital Library</p>
            <h1>Libraries</h1>
            <p className="section-description">Manage your digital libraries and their content.</p>
          </div>
        </div>
        <div className="row-actions">
          <Button
            variant="primary"
            disabled={!setupReady}
            onClick={() => { setError(""); setCreateLibraryOpen(true); }}
            title="Add library"
          >
            <Plus size={18} />
            <span>Add library</span>
          </Button>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Library error">{error}</MessageBox>}
      {!setupReady && (
        <MessageBox tone="warning" title="Storage setup required">
          Configure thumbnail storage and at least one Digital Library container before adding libraries.
        </MessageBox>
      )}

      <div className="library-controls">
        <SelectMenu
          className="library-type-filter"
          value={typeFilter}
          label="Filter by library type"
          onChange={setTypeFilter}
          options={TYPE_FILTERS.map((option) => ({
            ...option,
            icon: option.value === "audiobook"
              ? <Headphones size={18} />
              : option.value === "ebook"
                ? <BookOpen size={18} />
                : <LayoutGrid size={18} />
          }))}
        />
        <label className="search-field library-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">Search libraries</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search libraries..."
          />
        </label>
      </div>

      {visibleLibraries.length === 0 ? (
        <p className="management-empty">
          {libraries.length === 0 ? "No libraries configured." : "No libraries match these filters."}
        </p>
      ) : (
        <div className="datagrid-wrap library-table-wrap">
          <table className="datagrid library-table">
            <thead>
              <tr>
                <th>Library</th>
                <th>Type</th>
                <th>Access</th>
                <th className="col-num">Files</th>
                <th className="col-num">Size</th>
                <th className="col-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleLibraries.map((library) => {
                const TypeIcon = TYPE_META[library.type].icon;
                return (
                  <tr key={library.id}>
                    <td>
                      <div className="library-name-cell">
                        <span className={`library-folder-icon ${library.type}`} aria-hidden="true">
                          <Folder size={21} />
                        </span>
                        <div className="library-name-copy">
                          <span className="library-name-line">
                            <strong>{library.name}</strong>
                            <Button
                              variant="icon"
                              compact
                              className="library-info-button"
                              title={`View ${library.name} details`}
                              aria-label={`View ${library.name} details`}
                              onClick={() => setInfoLibrary(library)}
                            >
                              <Info size={14} />
                            </Button>
                          </span>
                          <small>{libraryOwnerLabel(library)}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="library-type-cell">
                        <TypeIcon size={14} aria-hidden="true" /> {TYPE_META[library.type].label}
                      </span>
                    </td>
                    <td>
                      <span className="library-access-cell">
                        <span className={`status-badge ${library.visibility}`}>
                          {library.visibility === "public" ? "Public" : "Private"}
                        </span>
                      </span>
                    </td>
                    <td className="col-num datagrid-muted">{formatCount(library.fileCount)}</td>
                    <td className="col-num datagrid-muted">{formatLibrarySize(library.totalSizeBytes)}</td>
                    <td className="col-actions">
                      <div className="row-actions">
                        {library.canManageLibrary ? (
                          <>
                            <Button
                              variant="icon"
                              title="Manage members & roles"
                              aria-label={`Manage ${library.name} members and roles`}
                              onClick={() => setMembersLibrary(library)}
                            >
                              <Users size={15} />
                            </Button>
                            <Button
                              variant="icon"
                              title="Edit library"
                              aria-label={`Edit ${library.name}`}
                              onClick={() => openEdit(library)}
                            >
                              <Pencil size={15} />
                            </Button>
                            <Button
                              variant="icon"
                              className="rescan-library-button"
                              disabled={library.scanStatus === "scanning" || rescanningId === library.id}
                              onClick={() => startRescan(library)}
                              title={library.scanStatus === "scanning" ? "Scanning..." : "Rescan library"}
                              aria-label={`${library.scanStatus === "scanning" ? "Scanning" : "Rescan"} ${library.name}`}
                            >
                              <RefreshCw size={14} />
                            </Button>
                            <Button
                              variant="icon"
                              danger
                              title="Delete library"
                              aria-label={`Delete ${library.name}`}
                              onClick={() => setDeleteConfirmLibrary(library)}
                            >
                              <Trash2 size={15} />
                            </Button>
                          </>
                        ) : (
                          // Private library this admin can't access — take ownership (logged) to manage it.
                          <Button
                            variant="secondary"
                            compact
                            title="This private library is owned by someone else. Take ownership to manage it (logged)."
                            onClick={() => takeOwnership(library)}
                          >
                            <KeyRound size={14} /> Take ownership
                          </Button>
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
          initialType={typeFilter === "ebook" ? "ebook" : "audiobook"}
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

      {infoLibrary && (
        <LibraryDetailsModal
          library={infoLibrary}
          ownerLabel={libraryOwnerLabel(infoLibrary)}
          scanSources={scanSourceSummary(infoLibrary)}
          extensions={extensionSummary(infoLibrary)}
          onClose={() => setInfoLibrary(null)}
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
              sourceInfo={sourceInfoFor(rescanTarget.type)}
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
          confirmLabel="Delete library"
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
          title={`Edit ${TYPE_META[editingLibrary.type].label.toLowerCase()} library`}
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
              sourceInfo={sourceInfoFor(editingLibrary.type)}
            />
            {editingLibrary.type === "audiobook" && (
              <TagEncodingField value={editTagEncoding} onChange={setEditTagEncoding} />
            )}
            <ExtensionsEditor
              extensions={editExtensions}
              onChange={setEditExtensions}
              defaults={typeDefaults[editingLibrary.type]?.extensions ?? []}
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

function LibraryDetailsModal({
  library,
  ownerLabel,
  scanSources,
  extensions,
  onClose
}: {
  library: ManagedLibrary;
  ownerLabel: string;
  scanSources: string;
  extensions: string;
  onClose: () => void;
}) {
  const TypeIcon = TYPE_META[library.type].icon;
  const capabilities = capabilityLabels(library);

  return (
    <Modal title={`${library.name} details`} className="library-info-modal" onClose={onClose}>
      <div className="library-info-hero">
        <span className={`library-type-icon ${library.type}`} aria-hidden="true">
          <TypeIcon size={22} />
        </span>
        <div>
          <strong>{library.name}</strong>
          <span>{TYPE_META[library.type].label}</span>
        </div>
      </div>

      <div className="library-info-grid">
        <section className="library-info-section">
          <h3>Library</h3>
          <dl className="library-info-list">
            <LibraryInfoRow label="Name">{library.name}</LibraryInfoRow>
            <LibraryInfoRow label="Type">{TYPE_META[library.type].label}</LibraryInfoRow>
            <LibraryInfoRow label="Path">
              <code>{library.sourcePath ?? "Source path hidden"}</code>
            </LibraryInfoRow>
            <LibraryInfoRow label="Owner">{ownerLabel}</LibraryInfoRow>
          </dl>
        </section>

        <section className="library-info-section">
          <h3>Access</h3>
          <dl className="library-info-list">
            <LibraryInfoRow label="Access">{accessSummary(library)}</LibraryInfoRow>
            <LibraryInfoRow label="Mode">{MODE_LABEL[library.mode ?? "managed"]}</LibraryInfoRow>
            <LibraryInfoRow label="Your role">{roleLabel(library.myRole)}</LibraryInfoRow>
            <LibraryInfoRow label="Capabilities">
              {capabilities.length > 0 ? (
                <span className="library-info-chips">
                  {capabilities.map((capability) => (
                    <span key={capability} className="library-info-chip">{capability}</span>
                  ))}
                </span>
              ) : (
                "None"
              )}
            </LibraryInfoRow>
          </dl>
        </section>

        <section className="library-info-section">
          <h3>Contents</h3>
          <dl className="library-info-list">
            <LibraryInfoRow label="Files">{formatCount(library.fileCount)}</LibraryInfoRow>
            <LibraryInfoRow label="Size">{formatLibrarySize(library.totalSizeBytes)}</LibraryInfoRow>
            <LibraryInfoRow label="Status">
              <span className={`status-badge ${library.scanStatus}`}>{SCAN_STATUS_LABEL[library.scanStatus]}</span>
            </LibraryInfoRow>
            <LibraryInfoRow label="Last scanned">
              {library.lastScannedAt ? formatManagedDate(library.lastScannedAt) : "Not yet"}
            </LibraryInfoRow>
          </dl>
        </section>

        <section className="library-info-section">
          <h3>Scanning</h3>
          <dl className="library-info-list">
            <LibraryInfoRow label="Sources">{scanSources}</LibraryInfoRow>
            <LibraryInfoRow label="Extensions">{extensions}</LibraryInfoRow>
            <LibraryInfoRow label="Upload limit">
              {library.settings?.maxUploadMB != null ? `${library.settings.maxUploadMB} MB` : "No limit"}
            </LibraryInfoRow>
            {library.type === "audiobook" && (
              <LibraryInfoRow label="Tag encoding">
                {library.settings?.tagEncoding ?? "Library default"}
              </LibraryInfoRow>
            )}
            <LibraryInfoRow label="Created">{formatManagedDate(library.createdAt)}</LibraryInfoRow>
            <LibraryInfoRow label="Updated">{formatManagedDate(library.updatedAt)}</LibraryInfoRow>
          </dl>
        </section>
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} autoFocus>Close</Button>
      </div>
    </Modal>
  );
}

function LibraryInfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
