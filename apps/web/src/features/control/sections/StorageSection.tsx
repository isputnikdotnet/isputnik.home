import { useState, useEffect, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, HardDrive, Plus } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute } from "../../../router";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import type { StorageRoot } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { SystemDataPanel } from "./storage/SystemDataPanel";
import { AppStoragePanel } from "./storage/AppStoragePanel";
import { SpaceMeter, useDiskSpace } from "./storage/SpaceMeter";

// The Storage page — docs/system-data-plan.md.
//
// Three blocks: the library locations libraries may live in ("Digital Library
// containers" until 4.73 — "container" also meant the apps beside this server);
// System data, the folder the app needs to run (thumbnails, backups, metadata); and
// App storage, one switch for the Photo Inbox, App files, Renders and Map data. The
// two storage blocks are their own components because the setup guide shows them
// too. The Recycle Bin's location lives on the Recycle Bin page, and who may have a
// personal library — and how big — on Device Sync, with phone backup.

export function StorageSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
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
    }
  };

  return (
    <>
      <ControlSectionHead
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

      <section id="storage-containers" className="storage-section">
        <div className="storage-section-head">
          <div>
            <h2>{t("controlAdmin:storage.containersTitle")}</h2>
            <p>{t("controlAdmin:storage.containersDesc")}</p>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              setError("");
              setRootNameInput("");
              setRootPathInput("");
              setCreateStorageRootOpen(true);
            }}
            title={t("controlAdmin:storage.addContainerTitle")}
          >
            <Plus size={18} />
            <span>{t("controlAdmin:storage.addContainer")}</span>
          </Button>
        </div>

        {storageRoots.length === 0 ? (
          <p className="management-empty">{t("controlAdmin:storage.noContainers")}</p>
        ) : (
          <div className="datagrid-wrap">
            <table className="datagrid datagrid-phone-stack storage-locations-table">
              <thead>
                <tr>
                  <th>{t("controlAdmin:storage.thName")}</th>
                  <th className="col-num">{t("controlAdmin:storage.thLibraries")}</th>
                  <th>{t("controlAdmin:storage.thFreeSpace")}</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {storageRoots.map((root) => (
                  <LocationRow
                    key={root.id}
                    root={root}
                    removing={deletingRootId === root.id}
                    onRemove={() => deleteStorageRoot(root)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <SystemDataPanel refreshKey={refreshKey} onChanged={() => setRefreshKey((key) => key + 1)} />

      <AppStoragePanel refreshKey={refreshKey} />

      {/* Personal libraries' policy moved to Device Sync with phone backup (4.73):
          one editable copy, there; this says where to find it. */}
      <section id="personal-libraries" className="storage-section storage-pointer">
        <div className="storage-section-head">
          <div>
            <h2>{t("controlAdmin:storage.personalTitle")}</h2>
            <p>{t("controlAdmin:storage.personalMoved")}</p>
          </div>
          <a
            className="secondary-button compact-button"
            href={controlHref("phoneSync")}
            onClick={(event) => followRoute(event, controlHref("phoneSync"))}
          >
            {t("controlAdmin:storage.openDeviceSync")}
            <ArrowRight size={15} aria-hidden="true" />
          </a>
        </div>
      </section>

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

/** One library location: its name and folder, how many libraries use it, and the
 *  free space on its disk. Removing one leaves its files alone, so it is Remove,
 *  not Delete — and it waits until no library uses it. */
function LocationRow({ root, removing, onRemove }: { root: StorageRoot; removing: boolean; onRemove: () => void }) {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const space = useDiskSpace(root.path);
  return (
    <tr>
      <td>
        <strong>{root.name}</strong>
        <div className="datagrid-muted storage-path-cell"><code>{root.path}</code></div>
      </td>
      <td className="col-num" data-label={t("controlAdmin:storage.thLibraries")}>
        {root.libraryCount > 0 ? (
          <span className="count-badge">{root.libraryCount}</span>
        ) : (
          <span className="datagrid-muted">—</span>
        )}
      </td>
      <td data-label={t("controlAdmin:storage.thFreeSpace")}>
        <SpaceMeter space={space} />
      </td>
      <td className="col-actions">
        <Button
          variant="text"
          danger
          disabled={root.libraryCount > 0 || removing}
          onClick={onRemove}
          title={root.libraryCount > 0 ? t("controlAdmin:storage.deleteBlockedTitle") : undefined}
        >
          {removing ? t("controlAdmin:storage.removing") : t("controlAdmin:storage.remove")}
        </Button>
      </td>
    </tr>
  );
}
