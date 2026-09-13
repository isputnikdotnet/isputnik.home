import { useState, useEffect, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { HardDrive, Plus } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import type { StorageRoot } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { SystemDataPanel } from "./storage/SystemDataPanel";
import { AppStoragePanel } from "./storage/AppStoragePanel";

// The Storage page — docs/system-data-plan.md.
//
// Three blocks: the containers libraries may live in; System data, the folder the
// app needs to run (thumbnails, backups, metadata); and App storage, one switch for
// the Photo Inbox, App files, Renders and Map data. The two storage blocks are their
// own components because the setup guide shows them too. The Recycle Bin's location
// lives on the Recycle Bin page.

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

      <section className="storage-section">
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
            <table className="datagrid">
              <thead>
                <tr>
                  <th>{t("controlAdmin:storage.thName")}</th>
                  <th>{t("controlAdmin:storage.thPath")}</th>
                  <th className="col-num">{t("controlAdmin:storage.thLibraries")}</th>
                  <th className="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {storageRoots.map((root) => (
                  <tr key={root.id}>
                    <td><strong>{root.name}</strong></td>
                    <td className="datagrid-muted storage-path-cell">{root.path}</td>
                    <td className="col-num">
                      {root.libraryCount > 0 ? (
                        <span className="count-badge">{root.libraryCount}</span>
                      ) : (
                        <span className="datagrid-muted">—</span>
                      )}
                    </td>
                    <td className="col-actions">
                      <Button
                        variant="text" danger
                        disabled={root.libraryCount > 0 || deletingRootId === root.id}
                        onClick={() => deleteStorageRoot(root)}
                        title={root.libraryCount > 0 ? t("controlAdmin:storage.deleteBlockedTitle") : undefined}
                      >
                        {deletingRootId === root.id ? t("controlAdmin:storage.deleting") : t("controlAdmin:storage.delete")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <SystemDataPanel refreshKey={refreshKey} onChanged={() => setRefreshKey((key) => key + 1)} />

      <AppStoragePanel refreshKey={refreshKey} />

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
