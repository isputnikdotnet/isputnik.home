import { useState, useEffect, useCallback, useMemo, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  KeyRound,
  Headphones,
  BookOpen,
  Search,
  HardDrive,
  LayoutGrid,
  LibraryBig,
  Clapperboard
} from "lucide-react";
import { useVideoAvailable } from "../../../app/useVideoAvailable";
import { api } from "../../../api";
import { controlHref, followRoute, libraryManageHref, navigate } from "../../../router";
import { tasksHref } from "../links";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { SelectField } from "../../../shared/SelectField";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectMenu } from "../../../shared/SelectMenu";
import { ActionMenu } from "../../../shared/ActionMenu";
import { DEFAULT_BACK_SIDES, type PublicRole, type LibraryMode, type ScanSource, type MetadataSourceInfo, type LibraryTypeDefaults, type BackSidesSettings } from "../../audiobooks/types";
import { BackSidesEditor } from "../libraries/BackSidesEditor";
import { PhoneBackupsEditor } from "../libraries/PhoneBackupsEditor";
import type { LibrarySettings, ManagedUser, ManagedGroup, StorageRoot } from "../types";
import { Field } from "../../../shared/Field";
import { LibraryAccessRows } from "../libraries/access-selects";
import { ExtensionsEditor } from "../libraries/ExtensionsEditor";
import { ScanSourcesEditor } from "../libraries/ScanSourcesEditor";
import { UploadSettingsFields } from "../libraries/UploadSettingsFields";
import { TagEncodingField } from "../libraries/TagEncodingField";
import { LibraryWizard } from "../libraries/LibraryWizard";
import { VideoFolderPicker } from "../libraries/VideoFolderPicker";
import { LibraryMembersModal } from "./LibraryMembersModal";
import { LayoutPanel } from "../layout/LayoutPanel";
import { GalleryFaceSettingsModal } from "../../gallery/GalleryFaceSettingsModal";
import { ControlSectionHead } from "../ControlSectionHead";
import i18n from "../../../i18n";
import {
  TYPE_FILTER_VALUES,
  TYPE_ICON,
  VIDEO_LANGUAGES,
  accessSummary,
  formatCount,
  formatLibrarySize,
  languageLabel,
  phoneLinkable,
  rowTypeLabel,
  typeFilterLabel,
  typeLabel,
  type ManagedLibrary,
  type ManagedLibraryType
} from "../libraries/managed-library";
import { LibraryManagePage, type LibraryEditTab } from "../libraries/LibraryManagePage";
import { LibraryStatus } from "../libraries/LibraryStatus";
// Scan layouts' stylesheet: it loads with this section, not on every route (docs/css-map.md).
import "../../../styles/scan-layout.css";

// Library › Libraries: every library in one list, and — with `libraryId` — one
// library's Manage page (libraries/LibraryManagePage). Both share the data and the
// dialogs below; the row's Manage button and ⋯ menu replaced its six icons in 4.73.
export function LibrariesSection({ libraryId }: { libraryId?: string } = {}) {
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
  const [loaded, setLoaded] = useState(false);
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
  const [editBackSides, setEditBackSides] = useState<BackSidesSettings>(DEFAULT_BACK_SIDES);
  const [editMaxUploadMB, setEditMaxUploadMB] = useState("");
  const [editTagEncoding, setEditTagEncoding] = useState("");
  const [editProgressMode, setEditProgressMode] = useState<"linear" | "episodic">("linear");
  const [editTab, setEditTab] = useState<LibraryEditTab>("access");
  // Phase 6 of Photo Sync: the phones that skip photos already here (null until the tab loads them).
  const [editPhoneLinks, setEditPhoneLinks] = useState<string[] | null>(null);
  const [editVideoFolder, setEditVideoFolder] = useState("");
  const [editVideoLanguage, setEditVideoLanguage] = useState("en");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [videoEngineDown, setVideoEngineDown] = useState(false);
  const videoAvailable = useVideoAvailable();

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
    const [audiobooksPayload, ebooksPayload, galleryPayload, videoPayload, usersPayload, groupsPayload] = await Promise.all([
      api<{ libraries: ManagedLibrary[] }>("/api/library/audiobook-libraries?manage=1"),
      api<{ libraries: ManagedLibrary[] }>("/api/library/ebook-libraries?manage=1"),
      api<{ libraries: ManagedLibrary[] }>("/api/library/gallery-libraries?manage=1"),
      // Rows here, counts from the video app; engineOnline false = it did not answer.
      api<{ libraries: ManagedLibrary[]; engineOnline: boolean | null }>("/api/library/video-libraries?manage=1"),
      api<{ users: ManagedUser[] }>("/api/users"),
      api<{ groups: ManagedGroup[] }>("/api/groups")
    ]);
    setLibraries(
      [...audiobooksPayload.libraries, ...ebooksPayload.libraries, ...galleryPayload.libraries, ...videoPayload.libraries]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    );
    setVideoEngineDown(videoPayload.engineOnline === false);
    setLoaded(true);
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

  const openEdit = (library: ManagedLibrary, tab: LibraryEditTab = "access") => {
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
    setEditBackSides(library.settings?.backSides ?? DEFAULT_BACK_SIDES);
    setEditMaxUploadMB(library.settings?.maxUploadMB != null ? String(library.settings.maxUploadMB) : "");
    setEditTagEncoding(library.settings?.tagEncoding ?? "");
    setEditProgressMode(library.settings?.progressMode ?? "linear");
    setEditVideoFolder(library.folder ?? "");
    setEditVideoLanguage(library.defaultLanguage ?? "en");
    setEditTab(tab);
    setEditPhoneLinks(null);
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
      // A video library is its access, folder and language; the video app reads the rest.
      const body = editingLibrary.type === "video"
        ? {
            name: editName,
            visibility: editVisibility,
            publicRole: editPublicRole,
            ownerId: editOwnerId || null,
            ownerType: editOwnerType || null,
            folder: editVideoFolder,
            defaultLanguage: editVideoLanguage
          }
        : null;
      await api(`${apiBase(editingLibrary)}/${editingLibrary.id}`, {
        method: "PATCH",
        body: body ? JSON.stringify(body) : JSON.stringify({
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
          ...(editingLibrary.type === "audiobook" ? { tagEncoding: editTagEncoding || null, progressMode: editProgressMode } : {}),
          ...(editingLibrary.type === "gallery" ? { backSides: editBackSides } : {})
        })
      });
      // Only when the Phone backups tab was opened: otherwise nothing there changed.
      if (editPhoneLinks !== null && phoneLinkable(editingLibrary)) {
        await api(`/api/photo-sync/libraries/${encodeURIComponent(editingLibrary.id)}/phones`, {
          method: "PUT",
          body: JSON.stringify({ deviceIds: editPhoneLinks })
        });
      }
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
      // Deleted from its own Manage page: back to the list it is no longer in.
      if (libraryId) navigate(controlHref("libraries"));
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
      return t("control:libraries.noOwner");
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
      // The Photo Inbox and App files are the app's own (docs/system-data-plan.md):
      // listed on the Storage page, whose Access link opens their editor here.
      const ordinary = libraries.filter((library) => !library.role);
      const typeFiltered = typeFilter === "all" ? ordinary : ordinary.filter((library) => library.type === typeFilter);
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
  const managed = libraryId ? libraries.find((library) => library.id === libraryId) ?? null : null;
  const listHref = controlHref("libraries");

  return (
    <>
      {libraryId ? (
        <>
          {error && <MessageBox tone="error" title={t("control:libraries.errorTitle")}>{error}</MessageBox>}
          {managed && managed.canManageLibrary ? (
            <LibraryManagePage
              library={managed}
              ownerLabel={libraryOwnerLabel(managed)}
              scanSources={scanSourceSummary(managed)}
              extensions={extensionSummary(managed)}
              scanning={managed.scanStatus === "scanning" || rescanningId === managed.id}
              videoEngineDown={videoEngineDown}
              onEdit={(tab) => openEdit(managed, tab)}
              onMembers={() => setMembersLibrary(managed)}
              onScanRules={() => setScanRulesLibrary(managed)}
              onFaces={() => { setError(""); setFaceSettingsOpen(true); }}
              onRescan={() => startRescan(managed)}
              onDelete={() => setDeleteConfirmLibrary(managed)}
            />
          ) : loaded ? (
            <MessageBox
              tone="warning"
              title={t("control:libraries.manage.notFoundTitle")}
              action={<a className="secondary-button compact-button" href={listHref} onClick={(event) => followRoute(event, listHref)}>{t("control:libraries.manage.backToList")}</a>}
            >
              {t("control:libraries.manage.notFoundBody")}
            </MessageBox>
          ) : (
            <p className="muted">{t("control:ui.loading")}</p>
          )}
        </>
      ) : (
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
      {videoEngineDown && (
        <MessageBox tone="warning" title={t("control:libraries.typeVideo")}>
          {t("control:libraries.video.engineDown")}
        </MessageBox>
      )}
      {scanningLibraries.length > 0 && (
        <MessageBox
          tone="info"
          title={t("control:libraries.scanInProgressTitle")}
          action={
            // One scan: its own tasks. Several: every task, since the list is one filter.
            <a
              className="secondary-button compact-button"
              href={tasksHref({ library: scanningLibraries.length === 1 ? scanningLibraries[0].id : undefined })}
              onClick={(event) => followRoute(event, tasksHref({ library: scanningLibraries.length === 1 ? scanningLibraries[0].id : undefined }))}
            >
              {t("control:libraries.followOnTasks")}
            </a>
          }
        >
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
                : value === "video"
                  ? <Clapperboard size={18} />
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
                <th>{t("control:libraries.thAccess")}</th>
                <th className="col-num">{t("control:libraries.thContents")}</th>
                <th>{t("control:libraries.thStatus")}</th>
                <th className="col-actions"><span className="sr-only">{t("control:libraries.thActions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {visibleLibraries.map((library) => {
                const TypeIcon = TYPE_ICON[library.type];
                const scanning = library.scanStatus === "scanning" || rescanningId === library.id;
                // Someone else's personal library: whose it is and its size, no actions.
                const othersPersonal = library.personal != null && !library.canManageLibrary;
                const manageHref = libraryManageHref(library.id);
                return (
                  <tr key={library.id} id={`library-${library.id}`}>
                    <td>
                      <div className="library-name-cell">
                        <span className={`library-folder-icon ${library.type}`} aria-hidden="true">
                          <TypeIcon size={19} />
                        </span>
                        <div className="library-name-copy">
                          <span className="library-name-line">
                            <strong>
                              {othersPersonal
                                ? t(library.personal!.orphaned ? "control:libraries.personalOrphaned" : "control:libraries.personalBadge", { name: library.personal!.ownerName })
                                : library.name}
                            </strong>
                          </span>
                          <small>{othersPersonal ? t("control:libraries.personalNote") : `${rowTypeLabel(library)} · ${libraryOwnerLabel(library)}`}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${library.visibility}`}>
                        {accessSummary(library)}
                      </span>
                    </td>
                    <td className="col-num library-contents-cell">
                      {library.fileCount != null && (
                        <span>{t("control:libraries.contentsFiles", { count: library.fileCount, formatted: formatCount(library.fileCount) })}</span>
                      )}
                      <small className="datagrid-muted">{formatLibrarySize(library.totalSizeBytes)}</small>
                    </td>
                    <td>
                      <LibraryStatus library={library} scanning={scanning} videoEngineDown={videoEngineDown} />
                    </td>
                    <td className="col-actions">
                      <div className="row-actions">
                        {othersPersonal ? null : library.canManageLibrary ? (
                          <>
                            <a
                              className="secondary-button compact-button"
                              href={manageHref}
                              aria-label={t("control:libraries.manageAria", { name: library.name })}
                              onClick={(event) => followRoute(event, manageHref)}
                            >
                              {t("control:libraries.manageAction")}
                            </a>
                            <ActionMenu
                              trigger="icon"
                              compact
                              label={t("control:libraries.moreActions", { name: library.name })}
                              items={[
                                {
                                  key: "rescan",
                                  label: scanning ? t("control:libraries.rescanningTitle") : t("control:libraries.manage.rescan"),
                                  icon: <RefreshCw size={15} />,
                                  disabledReason: scanning ? t("control:libraries.rescanningTitle") : undefined,
                                  onSelect: () => startRescan(library)
                                },
                                // A system library is made and removed by the app, never here.
                                ...(library.role ? [] : [{
                                  key: "delete",
                                  label: t("control:libraries.manage.deleteAction"),
                                  icon: <Trash2 size={15} />,
                                  danger: true,
                                  onSelect: () => setDeleteConfirmLibrary(library)
                                }])
                              ]}
                            />
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
      </>
      )}

      {createLibraryOpen && (
        <LibraryWizard
          initialType={typeFilter === "ebook" || typeFilter === "gallery" || (typeFilter === "video" && videoAvailable) ? typeFilter : "audiobook"}
          videoAvailable={videoAvailable}
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

      {/* Scan rules are the book libraries' own (the row offers them only there). */}
      {scanRulesLibrary && (scanRulesLibrary.type === "audiobook" || scanRulesLibrary.type === "ebook") && (
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
          {/* A video library's catalog is the video app's: say what goes, there. */}
          <p>{deleteConfirmLibrary.type === "video" ? t("control:libraries.video.deleteBody1") : t("control:libraries.deleteBody1")}</p>
          <p><strong>{deleteConfirmLibrary.type === "video" ? t("control:libraries.video.deleteBody2") : t("control:libraries.deleteBody2")}</strong></p>
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
          <div className="modal-tabs" role="tablist">
            <Button variant="tab" className="modal-tab" selected={editTab === "access"} onClick={() => setEditTab("access")}>
              {t("control:libraries.tabAccess")}
            </Button>
            {editingLibrary.type === "video" ? (
              <Button variant="tab" className="modal-tab" selected={editTab === "video"} onClick={() => setEditTab("video")}>
                {t("control:libraries.video.tabVideo")}
              </Button>
            ) : (
              <>
                <Button variant="tab" className="modal-tab" selected={editTab === "upload"} onClick={() => setEditTab("upload")}>
                  {t("control:libraries.tabUpload")}
                </Button>
                <Button variant="tab" className="modal-tab" selected={editTab === "scanning"} onClick={() => setEditTab("scanning")}>
                  {t("control:libraries.tabScanning")}
                </Button>
                {phoneLinkable(editingLibrary) && (
                  <Button variant="tab" className="modal-tab" selected={editTab === "phones"} onClick={() => setEditTab("phones")}>
                    {t("control:libraries.tabPhoneBackups")}
                  </Button>
                )}
              </>
            )}
          </div>

          <form id="edit-library-form" className="modal-tab-content edit-library-content" onSubmit={saveEdit}>
            {editTab === "access" && (
              <>
                <Field label={t("control:libraries.libraryName")} value={editName} onChange={setEditName} disabled={Boolean(editingLibrary.role)} />
                {editingLibrary.role && (
                  <MessageBox tone="info" title={t("control:libraries.systemNoteTitle")}>{t("control:libraries.systemNoteBody")}</MessageBox>
                )}
                <LibraryAccessRows
                  ownerId={editOwnerId}
                  ownerType={editOwnerType}
                  onOwnerChange={(type, id) => { setEditOwnerType(type); setEditOwnerId(id); }}
                  visibility={editVisibility}
                  onVisibilityChange={setEditVisibility}
                  publicRole={editPublicRole}
                  onPublicRoleChange={setEditPublicRole}
                  mode={editingLibrary.type === "video" ? undefined : editMode}
                  onModeChange={editingLibrary.type === "video" ? undefined : setEditMode}
                  users={users}
                  groups={groups}
                />
              </>
            )}

            {editTab === "video" && editingLibrary.type === "video" && (
              <>
                <p className="muted">
                  {editingLibrary.kind === "movies" ? t("control:libraries.video.editKindMovies") : t("control:libraries.video.editKindShows")}
                </p>
                <VideoFolderPicker value={editVideoFolder} onChange={setEditVideoFolder} onError={setError} />
                {editVideoFolder !== (editingLibrary.folder ?? "") && (
                  <MessageBox tone="info" title={t("control:libraries.video.folderChangeTitle")}>{t("control:libraries.video.folderChangeHint")}</MessageBox>
                )}
                <SelectField
                  label={t("control:libraries.video.languageLabel")}
                  hint={t("control:libraries.video.languageHint")}
                  value={editVideoLanguage}
                  onChange={setEditVideoLanguage}
                  options={[...new Set([...VIDEO_LANGUAGES, editVideoLanguage])].map((code) => ({ value: code, label: languageLabel(code, i18n.resolvedLanguage ?? "en") }))}
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
                {editingLibrary.type === "gallery" && (
                  <BackSidesEditor value={editBackSides} onChange={setEditBackSides} libraryId={editingLibrary.id} />
                )}
                {editingLibrary.type === "audiobook" && (
                  <TagEncodingField value={editTagEncoding} onChange={setEditTagEncoding} />
                )}
                {editingLibrary.type === "audiobook" && (
                  <SelectField
                    label={t("control:libraries.progressTracking")}
                    value={editProgressMode}
                    onChange={(value) => setEditProgressMode(value as "linear" | "episodic")}
                    hint={t("control:libraries.progressEpisodicHint")}
                    options={[
                      { value: "linear", label: t("control:libraries.progressLinear") },
                      { value: "episodic", label: t("control:libraries.progressEpisodic") }
                    ]}
                  />
                )}
              </>
            )}
            {editTab === "phones" && phoneLinkable(editingLibrary) && (
              <PhoneBackupsEditor libraryId={editingLibrary.id} value={editPhoneLinks} onChange={setEditPhoneLinks} />
            )}
          </form>

          <div className="edit-library-footer">
            {error && <MessageBox tone="error" title={t("control:libraries.unableToSave")}>{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setEditingLibrary(null)} disabled={saving}>
                {t("control:ui.cancel")}
              </Button>
              <Button
                variant="primary"
                type="submit"
                form="edit-library-form"
                disabled={saving || !editName.trim() || (editingLibrary.type === "video" ? !editVideoFolder : editExtensions.length === 0)}
              >
                {saving ? t("control:ui.saving") : t("control:ui.saveChanges")}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
