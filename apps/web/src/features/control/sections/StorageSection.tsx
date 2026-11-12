import { useState, useEffect, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Folder, HardDrive, Plus, Smartphone } from "lucide-react";
import { api } from "../../../api";
import { controlHref } from "../../../router";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ActionRow, AddRow, GroupedList, InfoRow, NavRow } from "../../../shared/GroupedList";
import { queryPageHref, useQueryPage } from "../../../shared/useQueryPage";
import { formatBytes } from "../../../shared/utils";
import type { StorageRoot } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { SystemDataPanel } from "./storage/SystemDataPanel";
import { AppStoragePanel } from "./storage/AppStoragePanel";
import { isLowSpace, useDiskSpace } from "./storage/SpaceMeter";

// The Storage page — docs/system-data-plan.md.
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
          <div className="grouped-page">
            <GroupedList
              id="storage-containers"
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
          </div>

          <SystemDataPanel refreshKey={refreshKey} onChanged={() => setRefreshKey((key) => key + 1)} />

          <AppStoragePanel refreshKey={refreshKey} />

          {/* Personal libraries' policy moved to Device Sync with phone backup (4.73):
              one editable copy, there; this row leads to it. */}
          <div className="grouped-page">
            <GroupedList id="personal-libraries" title={t("controlAdmin:storage.personalTitle")} note={t("controlAdmin:storage.personalMoved")}>
              <NavRow icon={<Smartphone size={17} />} label={t("controlAdmin:storage.openDeviceSync")} href={controlHref("phoneSync")} />
            </GroupedList>
          </div>
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
