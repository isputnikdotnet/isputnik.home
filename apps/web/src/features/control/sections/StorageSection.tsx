import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Plus } from "lucide-react";
import { api } from "../../../api";
import { controlHref, navigate } from "../../../router";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { RefreshButton } from "../../../shared/RefreshButton";
import { queryPageHref, useQueryPage } from "../../../shared/useQueryPage";
import { formatBytes } from "../../../shared/utils";
import type { StorageRoot } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { withQuery } from "../links";
import { appLabel } from "../nav";
import { isRunning, useAppsStatus } from "./AppsSection";
import { SystemDataPanel, type SystemDataView } from "./storage/SystemDataPanel";
import { AppStoragePanel } from "./storage/AppStoragePanel";
import { StoragePathRow } from "./storage/StoragePathRow";
import { isLowSpace, SpaceMeter, useDiskSpace } from "./storage/SpaceMeter";

// The Storage page — docs/system-data-plan.md. Just the folders, in three numbered
// sections (Pairing's shape), every row a name, its folder and one button:
//   1. System locations: the system folder (Change), then what goes in it — each "In the system
//      folder" or, given a folder of its own, that folder — with Manage, which opens
//      the full System data and App storage panels on a page of their own (?show=system).
//   2. Library locations: the folders libraries may use, grouped by drive when there
//      are several (free space once per drive), each with Remove (greyed while a
//      library uses it); what goes in them, in a line, with one Manage to the
//      Libraries page; and, set apart, where personal libraries are made (set on
//      Device Sync, shown here).
//   3. Containers and applications: the applications whose storage the app manages —
//      Gallery's Inbox and kept maps, Stories' recordings, Videos' download cache —
//      each with Manage to its own settings. Waits for steps 1 and 2.
// The two storage panels are their own components because the setup guide shows them too.

interface AppStorageSummary {
  enabled: boolean;
  where: "system" | "custom";
  folder: string | null;
  parts: { part: "inbox" | "house" | "renders" | "maps"; folder: string | null }[];
}

interface PersonalSummary { settings: { enabled: boolean }; parentFolder: string | null; libraries: { sizeBytes: number }[] }

interface CopiesSummary { settings: { limitGb: number }; folder: string; usedBytes: number; insideContainer?: boolean }

const manageButton = (label: string, href: string) => (
  <Button variant="secondary" compact onClick={() => navigate(href)}>
    {label}
  </Button>
);

export function StorageSection() {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [rootsLoaded, setRootsLoaded] = useState(false);
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
    setRootsLoaded(true);
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

  const [removeRoot, setRemoveRoot] = useState<StorageRoot | null>(null);
  const deleteStorageRoot = async (root: StorageRoot) => {
    setDeletingRootId(root.id);
    setError("");
    try {
      await api(`/api/storage/roots/${root.id}`, { method: "DELETE" });
      await loadRoots();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:storage.deleteContainerFailed"));
    } finally {
      setDeletingRootId("");
      setRemoveRoot(null);
    }
  };

  // Manage on what goes in the system folder opens the full panels (?show=system).
  const [show, go] = useQueryPage();
  const systemPage = show === "system";

  return (
    <>
      <ControlSectionHead
        title={systemPage ? t("controlAdmin:storage.systemManageTitle") : undefined}
        back={systemPage ? { href: queryPageHref(null), label: t("control:ui.back") } : undefined}
        section="storage"
        icon={<HardDrive size={30} />}
        iconClassName="storage"
        description={systemPage ? t("controlAdmin:storage.systemManageDescription") : t("controlAdmin:storage.headDescription")}
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

      {systemPage ? (
        <div className="storage-steps">
          <SystemDataPanel layout="paths" refreshKey={refreshKey} onChanged={() => setRefreshKey((key) => key + 1)} />
          <AppStoragePanel layout="paths" refreshKey={refreshKey} />
        </div>
      ) : (
        <StorageSteps
          refreshKey={refreshKey}
          roots={storageRoots}
          rootsLoaded={rootsLoaded}
          onChanged={() => setRefreshKey((key) => key + 1)}
          onRemoveRoot={setRemoveRoot}
          onOpenSystem={() => go("system")}
          onAddRoot={() => {
            setError("");
            setRootNameInput("");
            setRootPathInput("");
            setCreateStorageRootOpen(true);
          }}
        />
      )}

      {removeRoot && (
        <ConfirmDialog
          title={t("controlAdmin:storage.removeLocationConfirm", { name: removeRoot.name })}
          confirmLabel={t("controlAdmin:storage.locationRemoveTitle")}
          busyLabel={t("controlAdmin:storage.removing")}
          busy={deletingRootId === removeRoot.id}
          onConfirm={() => void deleteStorageRoot(removeRoot)}
          onCancel={() => setRemoveRoot(null)}
        >
          <p>{t("controlAdmin:storage.removeLocationNote")}</p>
        </ConfirmDialog>
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

/** A numbered section of the page, like Pairing's steps. */
function Step({ n, title, id, locked, lockedNote, action, children }: {
  n: number; title: string; id?: string; locked?: boolean; lockedNote?: string; action?: ReactNode; children?: ReactNode;
}) {
  return (
    <section className={`storage-step${locked ? " is-locked" : ""}`} id={id} aria-labelledby={`storage-step-${n}`}>
      <header className="storage-step-head">
        <span className="storage-step-n" aria-hidden="true">{n}</span>
        <h2 id={`storage-step-${n}`}>{title}</h2>
        {locked ? <small>{lockedNote}</small> : action}
      </header>
      {!locked && children}
    </section>
  );
}

function StorageSteps({ refreshKey, roots, rootsLoaded, onChanged, onRemoveRoot, onOpenSystem, onAddRoot }: {
  refreshKey: number;
  roots: StorageRoot[];
  rootsLoaded: boolean;
  onChanged: () => void;
  onRemoveRoot: (root: StorageRoot) => void;
  onOpenSystem: () => void;
  onAddRoot: () => void;
}) {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const [system, setSystem] = useState<SystemDataView | null>(null);
  const [app, setApp] = useState<AppStorageSummary | null>(null);
  const [personal, setPersonal] = useState<PersonalSummary | null>(null);

  useEffect(() => {
    api<SystemDataView>("/api/storage/system-data").then(setSystem, () => setSystem(null));
    api<AppStorageSummary>("/api/storage/app-storage").then(setApp, () => setApp(null));
    api<PersonalSummary>("/api/storage/personal-libraries").then(setPersonal, () => setPersonal(null));
  }, [refreshKey]);

  const inSystem = t("controlAdmin:storage.inSystemFolder");
  // Where an item is: "In the system folder", or the folder it was given of its own.
  const where = (path: string | null | undefined, own: boolean) => own && path ? <code>{path}</code> : inSystem;
  const inside = (path: string | null | undefined) => Boolean(system?.path && path && path.toLowerCase().startsWith(system.path.toLowerCase()));
  const setUp = Boolean(system?.path) && roots.length > 0;
  const appFolder = (part: AppStorageSummary["parts"][number]["part"]) => app?.parts.find((entry) => entry.part === part)?.folder ?? null;
  // Personal libraries' settings are a section of Device Sync's page now.
  const personalHref = `${controlHref("phoneSync")}#personal-libraries`;
  const bytes = personal?.libraries.reduce((sum, library) => sum + library.sizeBytes, 0) ?? 0;

  return (
    <div className="storage-steps">
      <Step n={1} id="system-data" title={t("controlAdmin:storage.sectionSystem")}>
        <SystemDataPanel folderRow refreshKey={refreshKey} onChanged={onChanged} />
        {system?.path && (
          <div className="storage-inside">
            <div className="storage-inside-head">
              <div>
                <strong>{t("controlAdmin:storage.whatGoesHere")}</strong>
                <small>{t("controlAdmin:storage.whatGoesHereBody")}</small>
              </div>
              <Button variant="secondary" compact onClick={onOpenSystem}>{t("controlAdmin:storage.manage")}</Button>
            </div>
            <dl className="storage-inside-list">
              <dt>{t("controlAdmin:systemData.database")}</dt>
              <dd>{where(system.database, !inside(system.database))}</dd>
              <dt>{t("controlAdmin:systemData.thumbnails")}</dt>
              <dd>{where(system.thumbnails.path, system.thumbnails.source !== "system")}</dd>
              <dt>{t("controlAdmin:systemData.backups")}</dt>
              <dd>
                {where(system.backups.path, system.backups.source !== "system")}
                {system.backups.sameDiskAsDatabase && <small className="is-warn">{t("controlAdmin:storage.sameDiskShort")}</small>}
              </dd>
              <dt>{t("controlAdmin:systemData.metadata")}</dt>
              <dd>{where(system.metadata.path, system.metadata.source !== "system")}</dd>
              <dt id="app-storage">{t("controlAdmin:appStorage.title")}</dt>
              <dd>{!app ? "…" : !app.enabled ? t("controlAdmin:storage.appStorageOff") : where(app.folder, app.where !== "system")}</dd>
            </dl>
          </div>
        )}
      </Step>

      <Step
        n={2}
        id="storage-containers"
        title={t("controlAdmin:storage.sectionLibraries")}
        action={<Button variant="secondary" compact onClick={onAddRoot}><Plus size={14} aria-hidden="true" /> {t("controlAdmin:storage.addContainer")}</Button>}
      >
        {rootsLoaded && roots.length === 0 && <p className="storage-step-empty">{t("controlAdmin:storage.noContainers")}</p>}
        {roots.length > 0 && (
          <div className="storage-inside">
            <div className="storage-inside-head">
              <div>
                <strong>{t("controlAdmin:storage.whatGoesHere")}</strong>
                <small>{t("controlAdmin:storage.kindsLine")}</small>
              </div>
              <Button variant="secondary" compact onClick={() => navigate(controlHref("libraries"))}>{t("controlAdmin:storage.manage")}</Button>
            </div>
          </div>
        )}
        <div className="storage-locations">
          <LocationRows roots={roots} onRemove={onRemoveRoot} />
        </div>
        {roots.length > 0 && (
          <div className="storage-sub is-personal" id="personal-libraries">
            <div className="storage-inside-head">
              <div>
                <strong>{t("controlAdmin:storage.personalRow")}</strong>
                <small>{t("controlAdmin:storage.personalWhat")}</small>
              </div>
            </div>
            <StoragePathRow
              label={t("controlAdmin:storage.personalFolder")}
              path={personal?.settings.enabled && personal.parentFolder ? <code>{personal.parentFolder}</code> : t("controlAdmin:storage.personalOffValue")}
              detail={personal && personal.libraries.length > 0
                ? `${t("control:appSetup.summaryLibraries", { count: personal.libraries.length })} · ${formatBytes(bytes)}`
                : undefined}
              action={manageButton(personal?.settings.enabled ? t("controlAdmin:systemData.change") : t("controlAdmin:storage.setUp"), personalHref)}
            />
          </div>
        )}
      </Step>

      <Step
        n={3}
        id="storage-applications"
        title={t("controlAdmin:storage.sectionApps")}
        locked={!setUp}
        lockedNote={t("controlAdmin:storage.afterSetup")}
      >
        <StoragePathRow
          label={appLabel("gallery")}
          sub={t("controlAdmin:storage.galleryUses")}
          path={app?.enabled
            ? <><code>{appFolder("inbox")}</code><code>{appFolder("maps")}</code></>
            : t("controlAdmin:storage.needsAppStorage")}
          action={manageButton(t("controlAdmin:storage.manage"), controlHref("mapSetup"))}
        />
        <StoragePathRow
          label={appLabel("stories")}
          sub={t("controlAdmin:storage.storiesUses")}
          path={app?.enabled ? <code>{appFolder("house")}</code> : t("controlAdmin:storage.needsAppStorage")}
          action={manageButton(t("controlAdmin:storage.manage"), controlHref("storySettings"))}
        />
        <VideoCacheRow refreshKey={refreshKey} />
      </Step>
    </div>
  );
}

/** Videos' download cache: a folder inside the video container (its Docker mapping),
 *  whose room is set on Videos › Settings. Only while a video container is set up. */
function VideoCacheRow({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation(["controlAdmin"]);
  const { apps } = useAppsStatus();
  const video = apps?.find((entry) => entry.id === "video") ?? null;
  const prefix = video && isRunning(video) ? video.prefix : null;
  const [copies, setCopies] = useState<CopiesSummary | null>(null);
  useEffect(() => {
    if (!prefix) return;
    api<CopiesSummary>(`${prefix}/api/admin/copies`).then(setCopies, () => setCopies(null));
  }, [prefix, refreshKey]);
  if (!video?.configured) return null;
  return (
    <StoragePathRow
      label={appLabel("videos")}
      sub={t("controlAdmin:storage.videosUses")}
      path={!prefix ? t("controlAdmin:storage.videoNotAnswering") : copies ? <code>{copies.folder}</code> : "…"}
      detail={copies && !copies.insideContainer
        ? t("controlAdmin:apps.videoSettings.copiesValue", { used: formatBytes(copies.usedBytes), limit: `${copies.settings.limitGb} GB` })
        : undefined}
      warn={copies?.insideContainer ? t("controlAdmin:storage.videoCacheNotMapped") : undefined}
      action={manageButton(t("controlAdmin:storage.manage"), withQuery(controlHref("videoSettings"), { show: "copies" }))}
    />
  );
}

/** The drive a folder is on, as a person names it: "D:" on Windows, the share on a
 *  network path, and elsewhere its first two levels ("/mnt/user"), which on a NAS is
 *  the pool the folders share. */
export function driveOf(folder: string): string {
  const letter = /^([a-zA-Z]):/.exec(folder);
  if (letter) return `${letter[1].toUpperCase()}:`;
  const share = /^\\\\[^\\]+\\[^\\]+/.exec(folder);
  if (share) return share[0];
  return `/${folder.split("/").filter(Boolean).slice(0, 2).join("/")}`;
}

/** The library locations. One is a row with its free space; several are grouped by
 *  drive, the free space said once over each drive instead of on every row. */
function LocationRows({ roots, onRemove }: { roots: StorageRoot[]; onRemove: (root: StorageRoot) => void }) {
  if (roots.length < 2) return <>{roots.map((root) => <LocationRow key={root.id} root={root} withSpace onRemove={() => onRemove(root)} />)}</>;
  const drives = new Map<string, StorageRoot[]>();
  for (const root of roots) {
    const drive = driveOf(root.path);
    drives.set(drive, [...(drives.get(drive) ?? []), root]);
  }
  return (
    <>
      {[...drives].map(([drive, list]) => (
        <div className="storage-drive" key={drive}>
          <DriveHead drive={drive} folder={list[0].path} />
          {list.map((root) => <LocationRow key={root.id} root={root} onRemove={() => onRemove(root)} />)}
        </div>
      ))}
    </>
  );
}

function DriveHead({ drive, folder }: { drive: string; folder: string }) {
  const { t } = useTranslation(["controlAdmin"]);
  const space = useDiskSpace(folder);
  return (
    <div className="storage-drive-head">
      <strong><HardDrive size={15} aria-hidden="true" /> {t("controlAdmin:storage.driveTitle", { drive })}</strong>
      <SpaceMeter space={space} />
    </div>
  );
}

/** One library location: its name, how many libraries use it, and its folder — with
 *  its free space when it is the only one. Remove is always there, greyed (and saying
 *  why) while a library uses the location. */
function LocationRow({ root, withSpace, onRemove }: { root: StorageRoot; withSpace?: boolean; onRemove: () => void }) {
  const { t } = useTranslation(["common", "controlAdmin", "control"]);
  const space = useDiskSpace(withSpace ? root.path : "");
  const low = isLowSpace(space);
  const free = space && space.total > 0 ? t("controlAdmin:systemData.spaceFree", { free: formatBytes(space.free), total: formatBytes(space.total) }) : undefined;
  return (
    <StoragePathRow
      label={root.name}
      sub={root.libraryCount > 0 ? t("control:appSetup.summaryLibraries", { count: root.libraryCount }) : t("controlAdmin:storage.locationNotUsed")}
      path={<code>{root.path}</code>}
      detail={low ? undefined : free}
      warn={low ? free : undefined}
      action={
        <span title={root.libraryCount > 0 ? t("controlAdmin:storage.removeInUse") : undefined}>
          <Button variant="danger" compact disabled={root.libraryCount > 0} onClick={onRemove}>{t("controlAdmin:storage.remove")}</Button>
        </span>
      }
    />
  );
}
