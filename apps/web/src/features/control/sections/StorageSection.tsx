import { useState, useEffect, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Archive, Clapperboard, Database, Folder, HardDrive, Images, Plus, Smartphone, Sparkles, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { controlHref } from "../../../router";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SettingsCard } from "../../../shared/SettingsCard";
import { ActionRow, AddRow, GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { queryPageHref, useQueryPage } from "../../../shared/useQueryPage";
import { formatBytes } from "../../../shared/utils";
import type { StorageRoot } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { backupHref, withQuery } from "../links";
import { isRunning, useAppsStatus } from "./AppsSection";
import { SystemDataPanel } from "./storage/SystemDataPanel";
import { AppStoragePanel } from "./storage/AppStoragePanel";
import { isLowSpace, useDiskSpace } from "./storage/SpaceMeter";

// The Storage page — docs/system-data-plan.md.
//
// Every place the server keeps files, in four cards by what they are to the family,
// each saying whether Home's backups hold it: Your media (library locations, and
// personal libraries — set on Device Sync, shown and linked here), System data (what
// the app needs to run), App storage (what the family makes in the app), and the
// companion containers (the video cache and catalog, on the container's own disk —
// shown, changed on their own pages). The Recycle Bin's folder is a line at the foot.
//
// Library locations are grouped rows (control panel v2), each opening a page of its
// own; System data and App storage keep their panels for now. Three blocks: the library locations libraries may live in ("Digital Library
// containers" until 4.73 — "container" also meant the apps beside this server);
// System data, the folder the app needs to run (thumbnails, backups, metadata); and
// App storage, one switch for the Photo Inbox, App files, Renders and Map data. The
// two storage blocks are their own components because the setup guide shows them
// too. The Recycle Bin's location lives on the Recycle Bin page, and who may have a
// personal library — and how big — on Device Sync, with phone backup.

export function StorageSection() {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [rootNameInput, setRootNameInput] = useState("");
  const [rootPathInput, setRootPathInput] = useState("");
  const [createStorageRootOpen, setCreateStorageRootOpen] = useState(false);
  const [savingStorageRoot, setSavingStorageRoot] = useState(false);
  const [deletingRootId, setDeletingRootId] = useState("");
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const loadRoots = async () => {
    const payload = await api<{ roots: StorageRoot[] }>("/api/storage/roots");
    setStorageRoots(payload.roots);
  };

  useEffect(() => {
    loadRoots().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:storage.loadFailed")));
  }, [t]);

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
      await loadRoots();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:storage.saveContainerFailed"));
    } finally {
      setSavingStorageRoot(false);
    }
  };

  const deleteStorageRoot = async (root: StorageRoot): Promise<boolean> => {
    setDeletingRootId(root.id);
    setError("");
    try {
      await api(`/api/storage/roots/${root.id}`, { method: "DELETE" });
      await loadRoots();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:storage.deleteContainerFailed"));
      return false;
    } finally {
      setDeletingRootId("");
    }
  };

  // A library location opens a page of its own (?show=location:<id>).
  const [show, go] = useQueryPage();
  const openRoot = show?.startsWith("location:") ? storageRoots.find((root) => root.id === show.slice(9)) ?? null : null;

  return (
    <>
      <ControlSectionHead
        title={openRoot?.name}
        back={openRoot ? { href: queryPageHref(null), label: t("control:ui.back") } : undefined}
        section="storage"
        icon={<HardDrive size={30} />}
        iconClassName="storage"
        description={t("controlAdmin:storage.headDescription")}
      >
        <RefreshButton
          onRefresh={async () => {
            setError("");
            try {
              setRefreshKey((key) => key + 1);
              await loadRoots();
            } catch (err) {
              setError(err instanceof Error ? err.message : t("controlAdmin:storage.refreshFailed"));
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:storage.errorTitle")}>{error}</MessageBox>}

      {openRoot ? (
        <LocationPage
          root={openRoot}
          removing={deletingRootId === openRoot.id}
          onRemove={() => { void deleteStorageRoot(openRoot).then((ok) => { if (ok) go(null); }); }}
        />
      ) : (
        <>
          <div className="app-overview storage-overview">
          <div className="app-overview-col">
          <SettingsCard id="storage-containers" className="storage-card" icon={<Images size={20} />} title={t("controlAdmin:storage.mediaTitle")} description={t("controlAdmin:storage.mediaBody")}>
            <GroupedList
              title={t("controlAdmin:storage.containersTitle")}
              note={storageRoots.length === 0 ? t("controlAdmin:storage.noContainers") : t("controlAdmin:storage.containersDesc")}
            >
              {storageRoots.map((root) => (
                <LocationRow key={root.id} root={root} onOpen={() => go(`location:${root.id}`)} />
              ))}
              <AddRow
                icon={<Plus size={17} />}
                label={t("controlAdmin:storage.addContainer")}
                onClick={() => {
                  setError("");
                  setRootNameInput("");
                  setRootPathInput("");
                  setCreateStorageRootOpen(true);
                }}
              />
            </GroupedList>
            {/* Personal libraries' policy lives on Device Sync with phone backup (4.73):
                one editable copy, there; this row shows where they go and leads to it. */}
            <PersonalLibrariesRow refreshKey={refreshKey} />
          </SettingsCard>

          <AppStoragePanel refreshKey={refreshKey} card={{ icon: <Sparkles size={20} />, description: t("controlAdmin:storage.appBody") }} />
          </div>

          <div className="app-overview-col">
          <SystemDataPanel
            refreshKey={refreshKey}
            card={{ icon: <Database size={20} />, description: t("controlAdmin:storage.systemBody") }}
            onChanged={() => setRefreshKey((key) => key + 1)}
          />
          <CompanionCard refreshKey={refreshKey} />
          </div>
          </div>

          <p className="settings-page-note">
            <Trash2 size={17} aria-hidden="true" />
            <span>{t("controlAdmin:storage.recycleNote")}{" "}<a href={controlHref("recycleBin")}>{t("controlAdmin:storage.recycleLink")}</a></span>
          </p>
        </>
      )}

      {createStorageRootOpen && (
        <Modal
          title={t("controlAdmin:storage.addContainerTitle")}
          className="create-storage-modal"
          busy={savingStorageRoot}
          onClose={() => setCreateStorageRootOpen(false)}
          onSubmit={createStorageRoot}
        >
          <p>{t("controlAdmin:storage.containerModalIntro")}</p>
          <Field label={t("controlAdmin:storage.containerName")} value={rootNameInput} onChange={setRootNameInput} />
          <Field label={t("controlAdmin:storage.containerPath")} value={rootPathInput} onChange={setRootPathInput} />
          {error && <MessageBox tone="error" title={t("controlAdmin:storage.addContainerFailedTitle")}>{error}</MessageBox>}
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setCreateStorageRootOpen(false)} disabled={savingStorageRoot} autoFocus>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" type="submit" disabled={savingStorageRoot}>
              {savingStorageRoot ? t("controlAdmin:ui.saving") : t("controlAdmin:storage.saveContainer")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Personal libraries: whether members may have one, where new ones are made, and how
 *  many there are — set on Device Sync, so the row opens it there. */
function PersonalLibrariesRow({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation(["controlAdmin", "control"]);
  const [view, setView] = useState<{ settings: { enabled: boolean }; parentFolder: string | null; libraries: { sizeBytes: number }[] } | null>(null);
  useEffect(() => {
    api<NonNullable<typeof view>>("/api/storage/personal-libraries").then(setView, () => setView(null));
  }, [refreshKey]);
  const bytes = view?.libraries.reduce((sum, library) => sum + library.sizeBytes, 0) ?? 0;
  return (
    <GroupedList id="personal-libraries" title={t("controlAdmin:storage.personalTitle")}>
      <NavRow
        icon={<Smartphone size={17} />}
        label={t("controlAdmin:storage.personalRow")}
        sub={!view ? undefined : view.settings.enabled && view.parentFolder
          ? t("controlAdmin:storage.personalIn", { path: view.parentFolder })
          : t("controlAdmin:storage.personalOff")}
        value={view && view.libraries.length > 0
          ? `${t("control:appSetup.summaryLibraries", { count: view.libraries.length })} · ${formatBytes(bytes)}`
          : undefined}
        href={withQuery(controlHref("phoneSync"), { show: "personal" })}
      />
    </GroupedList>
  );
}

/** The companion containers' own files: the video engine's cache and catalog, on the
 *  container's disk, set by Docker — shown here, changed on their own pages. Only
 *  when a video container is set up. */
function CompanionCard({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { apps } = useAppsStatus();
  const video = apps?.find((app) => app.id === "video") ?? null;
  const running = Boolean(video && isRunning(video));
  const prefix = video && running ? video.prefix : null;
  const [copies, setCopies] = useState<{ settings: { limitGb: number }; folder: string; usedBytes: number; insideContainer?: boolean } | null>(null);
  useEffect(() => {
    if (!prefix) return;
    api<NonNullable<typeof copies>>(`${prefix}/api/admin/copies`).then(setCopies, () => setCopies(null));
  }, [prefix, refreshKey]);
  if (!video?.configured) return null;
  return (
    <SettingsCard className="storage-card" icon={<Clapperboard size={20} />} title={t("controlAdmin:storage.companionTitle")} description={t("controlAdmin:storage.companionBody")}>
      <GroupedList>
        <NavRow
          icon={<HardDrive size={17} />}
          iconTone={copies?.insideContainer ? "warn" : undefined}
          label={t("controlAdmin:storage.videoCache")}
          sub={!running ? t("controlAdmin:storage.videoNotAnswering")
            : copies ? t("controlAdmin:storage.videoCacheSub", { folder: copies.folder }) : undefined}
          value={copies
            ? copies.insideContainer
              ? t("controlAdmin:storage.videoCacheNotMapped")
              : t("controlAdmin:apps.videoSettings.copiesValue", { used: formatBytes(copies.usedBytes), limit: `${copies.settings.limitGb} GB` })
            : undefined}
          valueTone={copies?.insideContainer ? "warn" : undefined}
          href={withQuery(controlHref("videoSettings"), { show: "copies" })}
        />
        <NavRow
          icon={<Archive size={17} />}
          label={t("controlAdmin:storage.videoCatalog")}
          sub={t("controlAdmin:storage.videoCatalogSub")}
          href={backupHref("video")}
        />
      </GroupedList>
    </SettingsCard>
  );
}

/** One library location as a row: its name and folder, how many libraries use it,
 *  and the free space on its disk (warned when low). */
function LocationRow({ root, onOpen }: { root: StorageRoot; onOpen: () => void }) {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const space = useDiskSpace(root.path);
  const low = isLowSpace(space);
  return (
    <NavRow
      icon={<HardDrive size={17} />}
      iconTone={low ? "warn" : undefined}
      label={root.name}
      sub={root.path}
      value={space && space.total > 0
        ? t("controlAdmin:systemData.spaceFree", { free: formatBytes(space.free), total: formatBytes(space.total) })
        : t("control:appSetup.summaryLibraries", { count: root.libraryCount })}
      valueTone={low ? "warn" : undefined}
      onClick={onOpen}
    />
  );
}

/** One library location's page. Removing one leaves its files alone, so it is
 *  Remove, not Delete — and it waits until no library uses it. */
function LocationPage({ root, removing, onRemove }: { root: StorageRoot; removing: boolean; onRemove: () => void }) {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const space = useDiskSpace(root.path);
  return (
    <div className="grouped-page">
      <GroupedList>
        <InfoRow icon={<Folder size={17} />} label={t("controlAdmin:storage.containerPath")} value={<code>{root.path}</code>} />
        <InfoRow label={t("controlAdmin:storage.thLibraries")} value={root.libraryCount > 0 ? String(root.libraryCount) : "—"} />
        <InfoRow
          label={t("controlAdmin:storage.thFreeSpace")}
          value={space && space.total > 0
            ? t("controlAdmin:systemData.spaceFree", { free: formatBytes(space.free), total: formatBytes(space.total) })
            : "—"}
          valueTone={isLowSpace(space) ? "warn" : undefined}
        />
      </GroupedList>
      {isLowSpace(space) && (
        <MessageBox tone="warning" title={t("controlAdmin:systemData.lowTitle")}>{t("controlAdmin:systemData.lowBody")}</MessageBox>
      )}
      <GroupedList note={root.libraryCount > 0 ? t("controlAdmin:storage.deleteBlockedTitle") : t("controlAdmin:storage.removeLocationNote")}>
        <ActionRow
          tone="danger"
          label={removing ? t("controlAdmin:storage.removing") : t("controlAdmin:storage.remove")}
          disabled={root.libraryCount > 0 || removing}
          onClick={onRemove}
        />
      </GroupedList>
    </div>
  );
}
