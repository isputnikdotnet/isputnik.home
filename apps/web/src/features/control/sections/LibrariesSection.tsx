import { useState, useEffect, useCallback, useMemo, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  Users,
  KeyRound,
  Headphones,
  BookOpen,
  Image,
  Info,
  Search,
  Folder,
  HardDrive,
  LayoutGrid,
  LibraryBig,
  Wand2,
  ScanFace
} from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute } from "../../../router";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectMenu } from "../../../shared/SelectMenu";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import type { AudiobookLibrary, PublicRole, LibraryMode, ScanSource, MetadataSourceInfo, LibraryTypeDefaults } from "../../audiobooks/types";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot } from "../types";
import { Field } from "../../../shared/Field";
import { LibraryAccessRows } from "../libraries/access-selects";
import { ExtensionsEditor } from "../libraries/ExtensionsEditor";
import { ScanSourcesEditor } from "../libraries/ScanSourcesEditor";
import { UploadSettingsFields } from "../libraries/UploadSettingsFields";
import { TagEncodingField } from "../libraries/TagEncodingField";
import { LibraryWizard } from "../libraries/LibraryWizard";
import { LibraryMembersModal } from "./LibraryMembersModal";
import { LayoutPanel } from "../layout/LayoutPanel";
import { GalleryFaceSettingsModal } from "../../gallery/GalleryFaceSettingsModal";
import { ControlSectionHead } from "../ControlSectionHead";
// Plain lookup functions rather than module-level consts, so a language switch
// is picked up (docs/i18n-plan.md's namespace-key typing pitfall #3).
import i18n from "../../../i18n";

type ManagedLibraryType = "audiobook" | "ebook" | "gallery";

// One row shape for every library type (the server serializes them identically).
interface ManagedLibrary extends Omit<AudiobookLibrary, "type" | "fileCount"> {
  type: ManagedLibraryType;
  fileCount: number | null;
}

const TYPE_ICON: Record<ManagedLibraryType, typeof Headphones> = {
  audiobook: Headphones,
  ebook: BookOpen,
  gallery: Image
};

function typeLabel(type: ManagedLibraryType): string {
  switch (type) {
    case "audiobook": return i18n.t("control:libraries.typeAudiobooks");
    case "ebook": return i18n.t("control:libraries.typeEbooks");
    case "gallery": return i18n.t("control:libraries.typeGallery");
  }
}

const TYPE_FILTER_VALUES: ("all" | ManagedLibraryType)[] = ["all", "audiobook", "ebook", "gallery"];

function typeFilterLabel(value: "all" | ManagedLibraryType): string {
  return value === "all" ? i18n.t("control:libraries.filterAll") : typeLabel(value);
}

function modeLabel(mode: LibraryMode): string {
  return mode === "managed" ? i18n.t("control:libraries.modeManaged") : i18n.t("control:libraries.modeExternal");
}

const ROLE_KEY: Record<string, "viewer" | "member" | "contributor" | "manager" | "deny"> = {
  viewer: "viewer",
  member: "member",
  contributor: "contributor",
  manager: "manager",
  deny: "deny"
};

function scanStatusLabel(status: ManagedLibrary["scanStatus"]): string {
  switch (status) {
    case "idle": return i18n.t("control:libraries.scanIdle");
    case "scanning": return i18n.t("control:libraries.scanScanning");
    case "error": return i18n.t("control:libraries.scanError");
  }
}

function formatCount(value: number | null | undefined) {
  return value == null ? "—" : value.toLocaleString();
}

function formatLibrarySize(value: number | null | undefined) {
  return value == null ? "—" : formatBytes(value);
}

function roleLabel(role: string | null | undefined) {
  const key = role ? ROLE_KEY[role] : undefined;
  return key ? i18n.t(`control:libraries.role.${key}`) : i18n.t("control:libraries.role.none");
}

function accessSummary(library: ManagedLibrary) {
  return library.visibility === "public" ? i18n.t("control:libraries.public") : i18n.t("control:libraries.private");
}

function capabilityLabels(library: ManagedLibrary) {
  return [
    library.canDownload ? i18n.t("control:libraries.capabilityDownload") : null,
    library.canWrite ? i18n.t("control:libraries.capabilityEdit") : null,
    library.canUpload ? i18n.t("control:libraries.capabilityUpload") : null,
    library.canCurate ? i18n.t("control:libraries.capabilityCurate") : null,
    library.canManageMembers ? i18n.t("control:libraries.capabilityManageMembers") : null,
    library.canManageLibrary ? i18n.t("control:libraries.capabilityManageSettings") : null
  ].filter(Boolean) as string[];
}

export function LibrariesSection() {
  const { t } = useTranslation(["common", "control"]);
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
  const [scanRulesLibrary, setScanRulesLibrary] = useState<ManagedLibrary | null>(null);
  const [faceSettingsOpen, setFaceSettingsOpen] = useState(false);
  const [takeOwnershipConfirmLibrary, setTakeOwnershipConfirmLibrary] = useState<ManagedLibrary | null>(null);
  const [takingOwnership, setTakingOwnership] = useState(false);
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
  const [editCompanions, setEditCompanions] = useState<string[]>([]);
  const [editSources, setEditSources] = useState<ScanSource[]>([]);
  const [editMaxUploadMB, setEditMaxUploadMB] = useState("");
  const [editTagEncoding, setEditTagEncoding] = useState("");
  const [editProgressMode, setEditProgressMode] = useState<"linear" | "episodic">("linear");
  const [editTab, setEditTab] = useState<"access" | "upload" | "scanning">("access");
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
    const [audiobooksPayload, ebooksPayload, galleryPayload, usersPayload, groupsPayload] = await Promise.all([
      api<{ libraries: ManagedLibrary[] }>("/api/library/audiobook-libraries?manage=1"),
      api<{ libraries: ManagedLibrary[] }>("/api/library/ebook-libraries?manage=1"),
      api<{ libraries: ManagedLibrary[] }>("/api/library/gallery-libraries?manage=1"),
      api<{ users: ManagedUser[] }>("/api/users"),
      api<{ groups: ManagedGroup[] }>("/api/groups")
    ]);
    setLibraries(
      [...audiobooksPayload.libraries, ...ebooksPayload.libraries, ...galleryPayload.libraries]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    );
    setUsers(usersPayload.users);
    setGroups(groupsPayload.groups);
  }, [loadStorage]);

  useEffect(() => {
    loadLibraries().catch((err) => setError(err instanceof Error ? err.message : t("control:libraries.unableToLoad")));
  }, [loadLibraries, t]);

  useEffect(() => {
    if (!libraries.some((library) => library.scanStatus === "scanning")) {
      return;
    }

    const timer = window.setInterval(() => {
      loadLibraries().catch((err) => setError(err instanceof Error ? err.message : t("control:libraries.unableToLoad")));
    }, 2500);

    return () => window.clearInterval(timer);
  }, [libraries, loadLibraries, t]);

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
    setEditCompanions(library.settings?.companionExtensions ?? typeDefaults[library.type]?.companions ?? []);
    setEditSources(library.settings?.scanSources ?? typeDefaults[library.type]?.sources ?? []);
    setEditMaxUploadMB(library.settings?.maxUploadMB != null ? String(library.settings.maxUploadMB) : "");
    setEditTagEncoding(library.settings?.tagEncoding ?? "");
    setEditProgressMode(library.settings?.progressMode ?? "linear");
    setEditTab("access");
    setError("");
  };

  const takeOwnership = async () => {
    if (!takeOwnershipConfirmLibrary) return;
    setTakingOwnership(true);
    setError("");
    try {
      await api(`/api/library/libraries/${takeOwnershipConfirmLibrary.id}/take-ownership`, { method: "POST", body: "{}" });
      setTakeOwnershipConfirmLibrary(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:libraries.unableToTakeOwnership"));
    } finally {
      setTakingOwnership(false);
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
          companionExtensions: editCompanions,
          scanSources: editSources,
          maxUploadMB: maxUploadValue(editMaxUploadMB),
          ...(editingLibrary.type === "audiobook" ? { tagEncoding: editTagEncoding || null, progressMode: editProgressMode } : {})
        })
      });
      setEditingLibrary(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:libraries.unableToSaveChanges"));
    } finally {
      setSaving(false);
    }
  };

  // Book libraries open the options dialog (sources; tag encoding for audiobooks);
  // galleries rescan straight away.
  const startRescan = (library: ManagedLibrary) => {
    if (library.type === "audiobook" || library.type === "ebook") {
      setRescanTarget(library);
      setRescanSources(library.settings?.scanSources ?? typeDefaults[library.type]?.sources ?? []);
      setRescanEncoding(library.type === "audiobook" ? library.settings?.tagEncoding ?? "" : "");
      setError("");
      return;
    }
    setRescanningId(library.id);
    setError("");
    api(`${apiBase(library)}/${library.id}/rescan`, { method: "POST", body: "{}" })
      .then(() => loadLibraries())
      .catch((err) => setError(err instanceof Error ? err.message : t("control:libraries.unableToStartRescan")))
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
          tagEncoding: rescanTarget.type === "audiobook" && rescanEncoding ? rescanEncoding : undefined
        })
      });
      setRescanTarget(null);
      await loadLibraries();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:libraries.unableToScanLibrary"));
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
      setError(err instanceof Error ? err.message : t("control:libraries.unableToDeleteLibrary"));
    } finally {
      setDeleting(false);
    }
  };

  const libraryOwnerLabel = useCallback(
    (library: ManagedLibrary) => {
      if (library.ownerType === "user") {
        return users.find((user) => user.id === library.ownerId)?.displayName ?? t("control:libraries.unknownUser");
      }
      if (library.ownerType === "group") {
        const groupName = groups.find((group) => group.id === library.ownerId)?.name ?? t("control:libraries.unknownGroup");
        return t("control:libraries.groupSuffix", { name: groupName });
      }
      return t("control:libraries.systemLibrary");
    },
    [groups, users, t]
  );

  const scanSourceSummary = useCallback(
    (library: ManagedLibrary) => {
      const sources = library.settings?.scanSources;
      if (!sources?.length) return t("control:libraries.scanDefault");
      const enabled = sources
        .filter((source) => source.enabled)
        .map((source) => metadataSources.find((info) => info.id === source.id)?.label ?? source.id);
      return enabled.length ? enabled.join(" > ") : t("control:libraries.scanNone");
    },
    [metadataSources, t]
  );

  const extensionSummary = useCallback(
    (library: ManagedLibrary) => {
      const extensions = library.settings?.scanExtensions ?? typeDefaults[library.type]?.extensions ?? [];
      return extensions.length ? extensions.join(", ") : t("control:libraries.notConfigured");
    },
    [typeDefaults, t]
  );

  const visibleLibraries = useMemo(
    () => {
      const typeFiltered = typeFilter === "all" ? libraries : libraries.filter((library) => library.type === typeFilter);
      const query = searchQuery.trim().toLowerCase();
      if (!query) return typeFiltered;
      return typeFiltered.filter((library) => [
        library.name,
        library.sourcePath ?? "",
        typeLabel(library.type),
        libraryOwnerLabel(library),
        accessSummary(library),
        library.scanStatus
      ].some((value) => value.toLowerCase().includes(query)));
    },
    [libraries, libraryOwnerLabel, searchQuery, typeFilter]
  );

  const setupReady = Boolean(librarySettings?.thumbnailPathReady) && storageRoots.length > 0;
  const scanningLibraries = libraries.filter((library) => library.scanStatus === "scanning");

  return (
    <>
      <ControlSectionHead
        section="libraries"
        className="library-section-head"
        icon={<LibraryBig size={30} />}
        description={t("control:libraries.description")}
      >
        <div className="row-actions">
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await loadLibraries();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("control:libraries.unableToRefresh"));
                throw err;
              }
            }}
          />
          <Button
            variant="primary"
            disabled={!setupReady}
            onClick={() => { setError(""); setCreateLibraryOpen(true); }}
            title={t("control:libraries.addLibrary")}
          >
            <Plus size={18} />
            <span>{t("control:libraries.addLibrary")}</span>
          </Button>
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("control:libraries.errorTitle")}>{error}</MessageBox>}
      {!setupReady && (
        <MessageBox
          tone="warning"
          title={t("control:libraries.storageSetupTitle")}
          action={
            <a
              className="primary-button compact-button"
              href={controlHref("storage")}
              onClick={(event) => followRoute(event, controlHref("storage"))}
            >
              <HardDrive size={16} aria-hidden="true" />
              {t("control:libraries.setUpStorage")}
            </a>
          }
        >
          {t("control:libraries.storageSetupBody")}
        </MessageBox>
      )}
      {scanningLibraries.length > 0 && (
        <MessageBox tone="info" title={t("control:libraries.scanInProgressTitle")}>
          {t("control:libraries.scanInProgress", { count: scanningLibraries.length, name: scanningLibraries[0]?.name })}
        </MessageBox>
      )}

      <div className="library-controls">
        <SelectMenu
          className="library-type-filter"
          value={typeFilter}
          label={t("control:libraries.filterByType")}
          onChange={setTypeFilter}
          options={TYPE_FILTER_VALUES.map((value) => ({
            value,
            label: typeFilterLabel(value),
            icon: value === "audiobook"
              ? <Headphones size={18} />
              : value === "ebook"
                ? <BookOpen size={18} />
                : <LayoutGrid size={18} />
          }))}
        />
        <label className="search-field library-search">
          <Search size={17} aria-hidden="true" />
          <span className="sr-only">{t("control:libraries.searchAria")}</span>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("control:libraries.searchPlaceholder")}
          />
        </label>
      </div>

      {visibleLibraries.length === 0 ? (
        <p className="management-empty">
          {libraries.length === 0 ? t("control:libraries.emptyNone") : t("control:libraries.emptyFiltered")}
        </p>
      ) : (
        <div className="datagrid-wrap library-table-wrap">
          <table className="datagrid library-table">
            <thead>
              <tr>
                <th>{t("control:libraries.thLibrary")}</th>
                <th>{t("control:libraries.thType")}</th>
                <th>{t("control:libraries.thAccess")}</th>
                <th className="col-num">{t("control:libraries.thFiles")}</th>
                <th className="col-num">{t("control:libraries.thSize")}</th>
                <th className="col-actions">{t("control:libraries.thActions")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleLibraries.map((library) => {
                const TypeIcon = TYPE_ICON[library.type];
                const scanning = library.scanStatus === "scanning" || rescanningId === library.id;
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
                              title={t("control:libraries.viewDetailsTitle", { name: library.name })}
                              aria-label={t("control:libraries.viewDetailsTitle", { name: library.name })}
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
                        <TypeIcon size={14} aria-hidden="true" /> {typeLabel(library.type)}
                      </span>
                    </td>
                    <td>
                      <span className="library-access-cell">
                        <span className={`status-badge ${library.visibility}`}>
                          {library.visibility === "public" ? t("control:libraries.public") : t("control:libraries.private")}
                        </span>
                      </span>
                    </td>
                    <td className="col-num datagrid-muted">{formatCount(library.fileCount)}</td>
                    <td className="col-num datagrid-muted">{formatLibrarySize(library.totalSizeBytes)}</td>
                    <td className="col-actions">
                      <div className="row-actions">
                        {library.canManageLibrary ? (
                          <>
                            {/* Leading type-specific slot — always reserved so the shared
                                icons below line up in the same columns across every library
                                type (book libraries get scan rules, galleries the face action). */}
                            {library.type === "ebook" || library.type === "audiobook" ? (
                              <Button
                                variant="icon"
                                title={t("control:libraries.scanRulesTitle")}
                                aria-label={t("control:libraries.scanRulesAria", { name: library.name })}
                                onClick={() => setScanRulesLibrary(library)}
                              >
                                <Wand2 size={15} />
                              </Button>
                            ) : library.type === "gallery" ? (
                              <Button
                                variant="icon"
                                title={t("control:libraries.faceRecognitionTitle")}
                                aria-label={t("control:libraries.faceRecognitionAria", { name: library.name })}
                                onClick={() => { setError(""); setFaceSettingsOpen(true); }}
                              >
                                <ScanFace size={15} />
                              </Button>
                            ) : (
                              <span className="library-action-spacer" aria-hidden="true" />
                            )}
                            <Button
                              variant="icon"
                              title={t("control:libraries.manageMembersTitle")}
                              aria-label={t("control:libraries.manageMembersAria", { name: library.name })}
                              onClick={() => setMembersLibrary(library)}
                            >
                              <Users size={15} />
                            </Button>
                            <Button
                              variant="icon"
                              title={t("control:libraries.editTitle")}
                              aria-label={t("control:libraries.editAria", { name: library.name })}
                              onClick={() => openEdit(library)}
                            >
                              <Pencil size={15} />
                            </Button>
                            <Button
                              variant="icon"
                              className="rescan-library-button"
                              disabled={scanning}
                              onClick={() => startRescan(library)}
                              title={scanning ? t("control:libraries.rescanningTitle") : t("control:libraries.rescanTitle")}
                              aria-label={scanning ? t("control:libraries.rescanningAria", { name: library.name }) : t("control:libraries.rescanAria", { name: library.name })}
                            >
                              {scanning ? (
                                <span className="icon-spin" aria-hidden="true">
                                  <RefreshCw size={14} />
                                </span>
                              ) : (
                                <RefreshCw size={14} />
                              )}
                            </Button>
                            <Button
                              variant="icon"
                              danger
                              title={t("control:libraries.deleteTitle")}
                              aria-label={t("control:libraries.deleteAria", { name: library.name })}
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
                            title={t("control:libraries.takeOwnershipTitle")}
                            onClick={() => {
                              setError("");
                              setTakeOwnershipConfirmLibrary(library);
                            }}
                          >
                            <KeyRound size={14} /> {t("control:libraries.takeOwnership")}
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
          initialType={typeFilter === "ebook" || typeFilter === "gallery" ? typeFilter : "audiobook"}
          users={users}
          groups={groups}
          storageRoots={storageRoots}
          initialRootId={selectedRootId || storageRoots[0]?.id || ""}
          metadataSources={metadataSources}
          typeDefaults={typeDefaults}
          onClose={() => setCreateLibraryOpen(false)}
          onCreated={() => {
            loadLibraries().catch((err) => setError(err instanceof Error ? err.message : t("control:libraries.unableToLoad")));
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

      {scanRulesLibrary && scanRulesLibrary.type !== "gallery" && (
        <LayoutPanel
          library={{ id: scanRulesLibrary.id, name: scanRulesLibrary.name, type: scanRulesLibrary.type }}
          sources={(scanRulesLibrary.settings?.scanSources ?? typeDefaults[scanRulesLibrary.type]?.sources ?? [])
            .filter((source) => !metadataSources.find((info) => info.id === source.id)?.affectsGrouping)
            .map((source) => ({ label: metadataSources.find((info) => info.id === source.id)?.label ?? source.id, enabled: source.enabled }))}
          legacyGrouping={
            scanRulesLibrary.settings?.scanSources?.some((source) => source.id === "single_file" && source.enabled) ? "single_file"
              : scanRulesLibrary.settings?.scanSources?.some((source) => source.id === "folder_structure" && source.enabled) ? "folder_structure"
              : null
          }
          onClose={() => setScanRulesLibrary(null)}
          onOpenSettings={() => { const target = scanRulesLibrary; setScanRulesLibrary(null); openEdit(target); }}
          onRescanLibrary={() => { const target = scanRulesLibrary; setScanRulesLibrary(null); startRescan(target); }}
        />
      )}

      {faceSettingsOpen && (
        <GalleryFaceSettingsModal
          onClose={() => setFaceSettingsOpen(false)}
          onChanged={() => { loadLibraries().catch((err) => setError(err instanceof Error ? err.message : t("control:libraries.unableToLoad"))); }}
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
          title={t("control:libraries.rescanModalTitle", { name: rescanTarget.name })}
          className="rescan-modal"
          busy={rescanRunning}
          onClose={() => setRescanTarget(null)}
        >
            <p>{t("control:libraries.rescanIntro")}</p>
            <ScanSourcesEditor
              sources={rescanSources}
              onChange={setRescanSources}
              sourceInfo={sourceInfoFor(rescanTarget.type)}
            />
            <p className="muted" style={{ fontSize: "0.8rem", lineHeight: 1.4 }}>
              {t("control:libraries.rescanScopeNote")}
            </p>
            {rescanTarget.type === "audiobook" && (
              <TagEncodingField
                value={rescanEncoding}
                onChange={setRescanEncoding}
                noneLabel={t("control:libraries.tagEncodingNoneLabel")}
              />
            )}
            {error && <MessageBox tone="error" title={t("control:libraries.rescanErrorTitle")}>{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setRescanTarget(null)} disabled={rescanRunning} autoFocus>
                {t("control:ui.cancel")}
              </Button>
              <Button variant="primary" onClick={runRescan} disabled={rescanRunning}>
                <RefreshCw size={15} /> {rescanRunning ? t("control:libraries.startingRescan") : t("control:libraries.startRescan")}
              </Button>
            </div>
        </Modal>
      )}

      {deleteConfirmLibrary && (
        <ConfirmDialog
          title={t("control:libraries.deleteConfirmTitle", { name: deleteConfirmLibrary.name })}
          confirmLabel={t("control:libraries.deleteConfirmLabel")}
          busyLabel={t("control:ui.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          rich
          busy={deleting}
          error={error}
          onConfirm={deleteLibrary}
          onCancel={() => setDeleteConfirmLibrary(null)}
        >
          <p>{t("control:libraries.deleteBody1")}</p>
          <p><strong>{t("control:libraries.deleteBody2")}</strong></p>
        </ConfirmDialog>
      )}

      {takeOwnershipConfirmLibrary && (
        <ConfirmDialog
          title={t("control:libraries.takeOwnershipConfirmTitle", { name: takeOwnershipConfirmLibrary.name })}
          confirmLabel={t("control:libraries.takeOwnershipConfirmLabel")}
          busyLabel={t("control:libraries.takingOwnership")}
          confirmIcon={<KeyRound size={15} />}
          rich
          busy={takingOwnership}
          error={error}
          onConfirm={takeOwnership}
          onCancel={() => setTakeOwnershipConfirmLibrary(null)}
        >
          <p>{t("control:libraries.takeOwnershipBody1")}</p>
          <p><strong>{t("control:libraries.takeOwnershipBody2")}</strong></p>
        </ConfirmDialog>
      )}

      {editingLibrary && (
        <Modal
          variant="panel"
          title={t("control:libraries.editModalTitle", { type: typeLabel(editingLibrary.type).toLowerCase() })}
          icon={<Pencil size={22} />}
          className="edit-library-panel"
          headerClassName="edit-library-header"
          busy={saving}
          onClose={() => setEditingLibrary(null)}
        >
          <div className="modal-tabs">
            <button type="button" className={`modal-tab${editTab === "access" ? " active" : ""}`} onClick={() => setEditTab("access")}>
              {t("control:libraries.tabAccess")}
            </button>
            <button type="button" className={`modal-tab${editTab === "upload" ? " active" : ""}`} onClick={() => setEditTab("upload")}>
              {t("control:libraries.tabUpload")}
            </button>
            <button type="button" className={`modal-tab${editTab === "scanning" ? " active" : ""}`} onClick={() => setEditTab("scanning")}>
              {t("control:libraries.tabScanning")}
            </button>
          </div>

          <form id="edit-library-form" className="modal-tab-content edit-library-content" onSubmit={saveEdit}>
            {editTab === "access" && (
              <>
                <Field label={t("control:libraries.libraryName")} value={editName} onChange={setEditName} />
                <LibraryAccessRows
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
              </>
            )}

            {editTab === "upload" && (
              <>
                <ExtensionsEditor
                  extensions={editExtensions}
                  onChange={setEditExtensions}
                  defaults={typeDefaults[editingLibrary.type]?.extensions ?? []}
                  label={t("control:libraries.extensionsLabel")}
                />
                <ExtensionsEditor
                  extensions={editCompanions}
                  onChange={setEditCompanions}
                  defaults={typeDefaults[editingLibrary.type]?.companions ?? []}
                  label={t("control:libraries.companionsLabel")}
                  emptyHint={t("control:libraries.companionsEmptyHint")}
                />
                <UploadSettingsFields
                  maxUploadMB={editMaxUploadMB}
                  onChange={setEditMaxUploadMB}
                  mode={editMode}
                />
              </>
            )}

            {editTab === "scanning" && (
              <>
                <ScanSourcesEditor
                  sources={editSources}
                  onChange={setEditSources}
                  sourceInfo={sourceInfoFor(editingLibrary.type)}
                />
                {editingLibrary.type === "audiobook" && (
                  <TagEncodingField value={editTagEncoding} onChange={setEditTagEncoding} />
                )}
                {editingLibrary.type === "audiobook" && (
                  <label className="field">
                    <span>{t("control:libraries.progressTracking")}</span>
                    <select value={editProgressMode} onChange={(event) => setEditProgressMode(event.target.value as "linear" | "episodic")}>
                      <option value="linear">{t("control:libraries.progressLinear")}</option>
                      <option value="episodic">{t("control:libraries.progressEpisodic")}</option>
                    </select>
                    <small className="muted">
                      {t("control:libraries.progressEpisodicHint")}
                    </small>
                  </label>
                )}
              </>
            )}
          </form>

          <div className="edit-library-footer">
            {error && <MessageBox tone="error" title={t("control:libraries.unableToSave")}>{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setEditingLibrary(null)} disabled={saving}>
                {t("control:ui.cancel")}
              </Button>
              <Button variant="primary" type="submit" form="edit-library-form" disabled={saving || !editName.trim() || editExtensions.length === 0}>
                {saving ? t("control:ui.saving") : t("control:ui.saveChanges")}
              </Button>
            </div>
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
  const { t } = useTranslation(["common", "control"]);
  const TypeIcon = TYPE_ICON[library.type];
  const capabilities = capabilityLabels(library);

  return (
    <Modal title={t("control:libraries.detailsTitle", { name: library.name })} className="library-info-modal" onClose={onClose}>
      <div className="library-info-hero">
        <span className={`library-type-icon ${library.type}`} aria-hidden="true">
          <TypeIcon size={22} />
        </span>
        <div>
          <strong>{library.name}</strong>
          <span>{typeLabel(library.type)}</span>
        </div>
      </div>

      <div className="library-info-grid">
        <section className="library-info-section">
          <h3>{t("control:libraries.sectionLibrary")}</h3>
          <dl className="library-info-list">
            <LibraryInfoRow label={t("control:libraries.fieldName")}>{library.name}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldType")}>{typeLabel(library.type)}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldPath")}>
              <code>{library.sourcePath ?? t("control:libraries.pathHidden")}</code>
            </LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldOwner")}>{ownerLabel}</LibraryInfoRow>
          </dl>
        </section>

        <section className="library-info-section">
          <h3>{t("control:libraries.sectionAccess")}</h3>
          <dl className="library-info-list">
            <LibraryInfoRow label={t("control:libraries.fieldAccess")}>{accessSummary(library)}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldMode")}>{modeLabel(library.mode ?? "managed")}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldYourRole")}>{roleLabel(library.myRole)}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldCapabilities")}>
              {capabilities.length > 0 ? (
                <span className="library-info-chips">
                  {capabilities.map((capability) => (
                    <span key={capability} className="library-info-chip">{capability}</span>
                  ))}
                </span>
              ) : (
                t("control:libraries.role.none")
              )}
            </LibraryInfoRow>
          </dl>
        </section>

        <section className="library-info-section">
          <h3>{t("control:libraries.sectionContents")}</h3>
          <dl className="library-info-list">
            <LibraryInfoRow label={t("control:libraries.fieldFiles")}>{formatCount(library.fileCount)}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldSize")}>{formatLibrarySize(library.totalSizeBytes)}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldStatus")}>
              <span className={`status-badge ${library.scanStatus}`}>{scanStatusLabel(library.scanStatus)}</span>
            </LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldLastScanned")}>
              {library.lastScannedAt ? formatManagedDate(library.lastScannedAt) : t("control:libraries.notYet")}
            </LibraryInfoRow>
          </dl>
        </section>

        <section className="library-info-section">
          <h3>{t("control:libraries.sectionScanning")}</h3>
          <dl className="library-info-list">
            <LibraryInfoRow label={t("control:libraries.fieldSources")}>{scanSources}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldExtensions")}>{extensions}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldUploadLimit")}>
              {library.settings?.maxUploadMB != null ? t("control:libraries.uploadLimitValue", { mb: library.settings.maxUploadMB }) : t("control:libraries.uploadLimitDefault")}
            </LibraryInfoRow>
            {library.type === "audiobook" && (
              <LibraryInfoRow label={t("control:libraries.fieldTagEncoding")}>
                {library.settings?.tagEncoding ?? t("control:libraries.tagEncodingDefault")}
              </LibraryInfoRow>
            )}
            <LibraryInfoRow label={t("control:libraries.fieldCreated")}>{formatManagedDate(library.createdAt)}</LibraryInfoRow>
            <LibraryInfoRow label={t("control:libraries.fieldUpdated")}>{formatManagedDate(library.updatedAt)}</LibraryInfoRow>
          </dl>
        </section>
      </div>

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} autoFocus>{t("control:ui.close")}</Button>
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
