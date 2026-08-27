import { useState, useEffect, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { HardDrive, Plus } from "lucide-react";
import { api } from "../../../api";
import { Field } from "../../../shared/Field";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { RefreshButton } from "../../../shared/RefreshButton";
import type { LibrarySettings, StorageRoot } from "../types";
import { ControlSectionHead } from "../ControlSectionHead";
import { TrashRootEditor, type TrashRootSettings } from "./TrashRootEditor";

export function StorageSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const lockedLocationTitle = t("controlAdmin:recycleBin.locationLockedTitle");
  const [librarySettings, setLibrarySettings] = useState<LibrarySettings | null>(null);
  const [storageRoots, setStorageRoots] = useState<StorageRoot[]>([]);
  const [trashRoot, setTrashRoot] = useState<TrashRootSettings | null>(null);
  const [editTrashRootOpen, setEditTrashRootOpen] = useState(false);
  const [thumbnailPathInput, setThumbnailPathInput] = useState("");
  const [rootNameInput, setRootNameInput] = useState("");
  const [rootPathInput, setRootPathInput] = useState("");
  const [editThumbnailPathOpen, setEditThumbnailPathOpen] = useState(false);
  const [createStorageRootOpen, setCreateStorageRootOpen] = useState(false);
  const [savingLibrarySettings, setSavingLibrarySettings] = useState(false);
  const [savingStorageRoot, setSavingStorageRoot] = useState(false);
  const [deletingRootId, setDeletingRootId] = useState("");
  const [error, setError] = useState("");

  const loadStorage = async () => {
    const settingsPayload = await api<{ settings: LibrarySettings }>("/api/library/settings");
    setLibrarySettings(settingsPayload.settings);
    setThumbnailPathInput(settingsPayload.settings.thumbnailPath);

    const rootsPayload = await api<{ roots: StorageRoot[] }>("/api/storage/roots");
    setStorageRoots(rootsPayload.roots);

    const trashPayload = await api<TrashRootSettings>("/api/storage/trash-root");
    setTrashRoot(trashPayload);
  };

  useEffect(() => {
    loadStorage().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:storage.loadFailed")));
  }, []);

  useEffect(() => {
    if (!editThumbnailPathOpen && !createStorageRootOpen) {
      return;
    }

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingLibrarySettings && !savingStorageRoot) {
        setEditThumbnailPathOpen(false);
        setCreateStorageRootOpen(false);
      }
    };

    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [editThumbnailPathOpen, createStorageRootOpen, savingLibrarySettings, savingStorageRoot]);

  const saveLibrarySettings = async (event: FormEvent) => {
    event.preventDefault();
    setSavingLibrarySettings(true);
    setError("");
    try {
      const payload = await api<{ settings: LibrarySettings }>("/api/library/settings", {
        method: "PATCH",
        body: JSON.stringify({ thumbnailPath: thumbnailPathInput })
      });
      setLibrarySettings(payload.settings);
      setThumbnailPathInput(payload.settings.thumbnailPath);
      setEditThumbnailPathOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("controlAdmin:storage.saveSettingsFailed"));
    } finally {
      setSavingLibrarySettings(false);
    }
  };

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
      await loadStorage();
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
      await loadStorage();
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
              await loadStorage();
            } catch (err) {
              setError(err instanceof Error ? err.message : t("controlAdmin:storage.refreshFailed"));
              throw err;
            }
          }}
        />
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:storage.errorTitle")}>{error}</MessageBox>}

      <section className="library-settings-panel storage-settings-panel">
        <div>
          <h2>{t("controlAdmin:storage.thumbTitle")}</h2>
          <p>{t("controlAdmin:storage.thumbDesc")}</p>
        </div>
        <div className="storage-path-summary">
          <strong>{librarySettings?.thumbnailPath || t("controlAdmin:storage.notConfigured")}</strong>
        </div>
        <div className="library-settings-actions">
          {librarySettings?.thumbnailPathReady ? (
            <span className="setting-status ready">{t("controlAdmin:storage.ready")}</span>
          ) : (
            <span className="setting-status needs-attention">
              {librarySettings?.thumbnailPathError || t("controlAdmin:storage.requiredBeforeLibrary")}
            </span>
          )}
          <button
            className="secondary-button compact-button"
            onClick={() => {
              setError("");
              setThumbnailPathInput(librarySettings?.thumbnailPath ?? "");
              setEditThumbnailPathOpen(true);
            }}
          >
            {t("controlAdmin:storage.editPath")}
          </button>
        </div>
      </section>

      {/* Deliberately under thumbnail storage and above containers: like the thumbnail
          path, it is a decision that wants making before the first library exists. */}
      <section className="library-settings-panel storage-settings-panel">
        <div>
          <h2>{t("controlAdmin:storage.binTitle")}</h2>
          <p>
            <Trans i18nKey="storage.binDesc" ns="controlAdmin" components={{ cd: <code /> }} />
          </p>
        </div>
        <div className="storage-path-summary">
          <strong>{trashRoot?.path || t("controlAdmin:storage.defaultTrash")}</strong>
        </div>
        <div className="library-settings-actions">
          {/* Not a fault, just why the button is off — so it states the fact and the
              tooltip on the button explains what to do about it. */}
          {trashRoot && !trashRoot.editable && (
            <span className="setting-status">
              {t("controlAdmin:storage.itemsInBin", { count: trashRoot.itemsInBin })}
            </span>
          )}
          <Button
            variant="secondary"
            compact
            disabled={!trashRoot?.editable}
            title={trashRoot?.editable ? undefined : lockedLocationTitle}
            onClick={() => {
              setError("");
              setEditTrashRootOpen(true);
            }}
          >
            {t("controlAdmin:storage.editLocation")}
          </Button>
        </div>
      </section>

      <section className="storage-section">
        <div className="storage-section-head">
          <div>
            <h2>{t("controlAdmin:storage.containersTitle")}</h2>
            <p>{t("controlAdmin:storage.containersDesc")}</p>
          </div>
          <button
            className="primary-button"
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
          </button>
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
                      <button
                        className="text-button danger"
                        disabled={root.libraryCount > 0 || deletingRootId === root.id}
                        onClick={() => deleteStorageRoot(root)}
                        title={root.libraryCount > 0 ? t("controlAdmin:storage.deleteBlockedTitle") : undefined}
                      >
                        {deletingRootId === root.id ? t("controlAdmin:storage.deleting") : t("controlAdmin:storage.delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editThumbnailPathOpen && (
        <Modal
          title={t("controlAdmin:storage.editThumbTitle")}
          className="edit-thumbnail-modal"
          busy={savingLibrarySettings}
          onClose={() => setEditThumbnailPathOpen(false)}
          onSubmit={saveLibrarySettings}
        >
            <p>{t("controlAdmin:storage.thumbModalIntro")}</p>
            <Field label={t("controlAdmin:storage.thumbPathLabel")} value={thumbnailPathInput} onChange={setThumbnailPathInput} />
            {error && <MessageBox tone="error" title={t("controlAdmin:storage.savePathFailedTitle")}>{error}</MessageBox>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setEditThumbnailPathOpen(false)} disabled={savingLibrarySettings} autoFocus>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" type="submit" disabled={savingLibrarySettings}>
                {savingLibrarySettings ? t("controlAdmin:ui.saving") : t("controlAdmin:storage.savePath")}
              </Button>
            </div>
        </Modal>
      )}

      {editTrashRootOpen && (
        <TrashRootEditor
          current={trashRoot?.path ?? null}
          onSaved={loadStorage}
          onClose={() => { setError(""); setEditTrashRootOpen(false); }}
        />
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
