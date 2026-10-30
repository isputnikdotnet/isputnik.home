import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DatabaseBackup, Download, RotateCcw, Trash2, Undo2, UploadCloud } from "lucide-react";
import { api } from "../../../api";
import { appPageHref } from "../links";
import { followRoute } from "../../../router";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { FileUpload } from "../../../shared/FileUpload";
import { MessageBox } from "../../../shared/MessageBox";
import { Modal } from "../../../shared/Modal";
import { ToggleSwitch } from "../../../shared/ToggleSwitch";
import { formatBytes, formatManagedDate } from "../../../shared/utils";
import { useAppName } from "./AppsSection";

// A card per container on the Backup page: back it up, download it and restore it
// apart from Home and from the other containers (server: backups/app-backups.ts).
// Its backups are its own files and the copies inside Home's full and minimal zips;
// both download and restore alike, and only its own files can be deleted here.

interface AppBackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  version: string | null;
  source: "own" | "full" | "minimal";
}

interface AppBackupView {
  id: string;
  configured: boolean;
  problem: string | null;
  include: boolean;
  keep: number;
  files: AppBackupFile[];
  restoreSupported: boolean | null;
  undo: { takenAt: string; version: string; bytes: number } | null;
}

const apiPath = (id: string) => `/api/backups/apps/${encodeURIComponent(id)}`;
const filePath = (id: string, name: string) => `${apiPath(id)}/files/${encodeURIComponent(name)}`;

export function ContainerBackups() {
  const { t } = useTranslation(["common", "control"]);
  const [apps, setApps] = useState<AppBackupView[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    const payload = await api<{ apps: AppBackupView[] }>("/api/backups/apps");
    setApps(payload.apps);
  }, []);

  useEffect(() => {
    load().catch((err) => setLoadError(err instanceof Error ? err.message : t("control:containerBackup.loadFailed")));
  }, [load, t]);

  if (loadError) return <MessageBox tone="error" title={t("control:containerBackup.loadFailed")}>{loadError}</MessageBox>;
  if (!apps) return null;

  return (
    <div id="container-backups" className="container-backups">
      <div className="container-backups-head">
        <h2>{t("control:containerBackup.title")}</h2>
        <p className="muted">{t("control:containerBackup.intro")}</p>
      </div>
      {apps.map((app) => <ContainerCard key={app.id} app={app} reload={load} />)}
    </div>
  );
}

function ContainerCard({ app, reload }: { app: AppBackupView; reload: () => Promise<void> }) {
  const { t } = useTranslation(["common", "control"]);
  const appName = useAppName();
  const name = appName(app.id);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [backingUp, setBackingUp] = useState(false);
  const [keep, setKeep] = useState(app.keep);
  const [saving, setSaving] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<AppBackupFile | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AppBackupFile | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setKeep(app.keep); }, [app.keep]);

  const canRestore = app.configured && app.restoreSupported === true;
  const clear = () => { setError(""); setNotice(""); };

  const backUp = async () => {
    setBackingUp(true);
    clear();
    try {
      const payload = await api<{ backup: { name: string } }>(apiPath(app.id), { method: "POST" });
      setNotice(t("control:containerBackup.backedUp", { name: payload.backup.name }));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:containerBackup.backUpFailed"));
    } finally {
      setBackingUp(false);
    }
  };

  const saveSettings = async (patch: { include?: boolean; keep?: number }) => {
    setSaving(true);
    clear();
    try {
      await api(`${apiPath(app.id)}/settings`, { method: "PATCH", body: JSON.stringify(patch) });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:containerBackup.saveFailed"));
      setKeep(app.keep);
    } finally {
      setSaving(false);
    }
  };

  /** A box left empty or out of range goes back to what the server last said. */
  const commitKeep = () => {
    const wanted = Math.floor(keep);
    if (!Number.isFinite(wanted) || wanted < 1 || wanted > 100) {
      setKeep(app.keep);
      return;
    }
    if (wanted !== app.keep) void saveSettings({ keep: wanted });
  };

  const act = async (run: () => Promise<unknown>, done: string, failed: string, close: () => void) => {
    setBusy(true);
    clear();
    try {
      await run();
      setNotice(done);
      close();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    } finally {
      setBusy(false);
    }
  };

  const restore = (file: AppBackupFile) =>
    act(
      () => api(`${filePath(app.id, file.name)}/restore`, { method: "POST", body: "{}" }),
      t("control:containerBackup.restored", { app: name, date: formatManagedDate(file.createdAt) }),
      t("control:containerBackup.restoreFailed"),
      () => setPendingRestore(null)
    );

  const undo = () =>
    act(
      () => api(`${apiPath(app.id)}/undo`, { method: "POST", body: "{}" }),
      t("control:containerBackup.undone", { app: name }),
      t("control:containerBackup.undoFailed"),
      () => setUndoOpen(false)
    );

  const remove = (file: AppBackupFile) =>
    act(
      () => api(filePath(app.id, file.name), { method: "DELETE" }),
      t("control:containerBackup.deleted", { name: file.name }),
      t("control:containerBackup.deleteFailed"),
      () => setPendingDelete(null)
    );

  const sourceLabel = (file: AppBackupFile) =>
    file.source === "own"
      ? t("control:containerBackup.sourceOwn")
      : file.source === "full"
        ? t("control:containerBackup.sourceFull")
        : t("control:containerBackup.sourceMinimal");

  const setupHref = appPageHref("appsSetup", app.id);

  return (
    <section id={`container-backup-${app.id}`} className="backup-card backup-list-card container-backup-card">
      <div className="backup-list-head">
        <h2>{name}</h2>
        <div className="row-actions">
          <Button variant="primary" compact disabled={!app.configured || backingUp} onClick={() => void backUp()}>
            <DatabaseBackup size={15} />
            <span>{backingUp ? t("control:backup.backingUp") : t("control:containerBackup.backUpNow")}</span>
          </Button>
          <Button variant="secondary" compact onClick={() => { clear(); setUploadOpen(true); }}>
            <UploadCloud size={15} />
            <span>{t("control:containerBackup.upload")}</span>
          </Button>
        </div>
      </div>

      {!app.configured && (
        <MessageBox tone="info" title={t("control:containerBackup.notSetUpTitle", { app: name })}>
          {app.problem ?? t("control:containerBackup.notSetUpBody")}{" "}
          <a href={setupHref} onClick={(event) => followRoute(event, setupHref)}>{t("control:containerBackup.setupLink")}</a>
        </MessageBox>
      )}
      {app.configured && app.restoreSupported === false && (
        <MessageBox tone="warning" title={t("control:containerBackup.tooOldTitle")}>
          {t("control:containerBackup.tooOldBody", { app: name })}
        </MessageBox>
      )}
      {app.configured && app.restoreSupported === null && (
        <MessageBox tone="warning" title={t("control:containerBackup.noAnswerTitle", { app: name })}>
          {t("control:containerBackup.noAnswerBody")}
        </MessageBox>
      )}
      {error && <MessageBox tone="error" title={t("control:backup.errorTitle")}>{error}</MessageBox>}
      {notice && <MessageBox tone="success" title={t("control:containerBackup.doneTitle")}>{notice}</MessageBox>}

      {app.undo && (
        <div className="container-backup-undo">
          <span className="muted">{t("control:containerBackup.undoNote", { date: formatManagedDate(app.undo.takenAt) })}</span>
          <Button variant="secondary" compact onClick={() => { clear(); setUndoOpen(true); }}>
            <Undo2 size={15} />
            <span>{t("control:containerBackup.undoOpen")}</span>
          </Button>
        </div>
      )}

      <div className="container-backup-settings">
        <ToggleSwitch
          checked={app.include}
          disabled={saving}
          label={t("control:containerBackup.includeLabel")}
          onChange={(next) => void saveSettings({ include: next })}
        />
        <label className="backup-keep-inline">
          <span>{t("control:containerBackup.keepLabel")}</span>
          <input
            type="number"
            min={1}
            max={100}
            value={keep}
            disabled={saving}
            onChange={(event) => setKeep(Number(event.target.value))}
            onBlur={commitKeep}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          />
        </label>
      </div>

      {app.files.length === 0 ? (
        <p className="muted">{t("control:containerBackup.empty")}</p>
      ) : (
        <div className="datagrid-wrap">
          <table className="datagrid datagrid-phone-stack stack-actions-below">
            <thead>
              <tr>
                <th>{t("control:containerBackup.thCreated")}</th>
                <th>{t("control:containerBackup.thFrom")}</th>
                <th>{t("control:containerBackup.thVersion")}</th>
                <th className="col-num">{t("control:backup.thSize")}</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {app.files.map((file) => (
                <tr key={`${file.source}:${file.name}`}>
                  <td title={file.name}><strong>{formatManagedDate(file.createdAt)}</strong></td>
                  <td className="datagrid-muted">{sourceLabel(file)}</td>
                  <td className="datagrid-muted">{file.version ?? "—"}</td>
                  <td className="col-num datagrid-muted">{formatBytes(file.sizeBytes)}</td>
                  <td className="col-actions">
                    <div className="row-actions">
                      <Button
                        variant="secondary"
                        compact
                        disabled={!canRestore}
                        title={t("control:containerBackup.restoreTitle", { app: name })}
                        onClick={() => { clear(); setPendingRestore(file); }}
                      >
                        <RotateCcw size={14} /> {t("control:backup.restore")}
                      </Button>
                      <a className="icon-button" title={t("control:containerBackup.downloadTitle")} href={`${filePath(app.id, file.name)}/download`} download>
                        <Download size={15} />
                      </a>
                      {file.source === "own" && (
                        <Button variant="icon" danger title={t("control:backup.deleteTitle")} aria-label={t("control:backup.deleteTitle")} onClick={() => { clear(); setPendingDelete(file); }}>
                          <Trash2 size={15} />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingRestore && (
        <ConfirmDialog
          title={t("control:containerBackup.restoreConfirmTitle", { app: name, date: formatManagedDate(pendingRestore.createdAt) })}
          confirmLabel={t("control:containerBackup.restoreConfirm", { app: name })}
          busyLabel={t("control:containerBackup.restoring")}
          confirmIcon={<RotateCcw size={15} />}
          danger
          rich
          busy={busy}
          error={error}
          onConfirm={() => void restore(pendingRestore)}
          onCancel={() => setPendingRestore(null)}
        >
          <p>{app.id === "games" ? t("control:containerBackup.restoreBodyGames") : app.id === "video" ? t("control:containerBackup.restoreBodyVideo") : t("control:containerBackup.restoreBodyOther")}</p>
          <p>{t("control:containerBackup.restoreKept")}</p>
        </ConfirmDialog>
      )}

      {undoOpen && (
        <ConfirmDialog
          title={t("control:containerBackup.undoConfirmTitle", { app: name })}
          confirmLabel={t("control:containerBackup.undoConfirm")}
          busyLabel={t("control:containerBackup.undoing")}
          confirmIcon={<Undo2 size={15} />}
          danger
          rich
          busy={busy}
          error={error}
          onConfirm={() => void undo()}
          onCancel={() => setUndoOpen(false)}
        >
          <p>{t("control:containerBackup.undoBody", { date: app.undo ? formatManagedDate(app.undo.takenAt) : "" })}</p>
        </ConfirmDialog>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={t("control:containerBackup.deleteConfirmTitle", { name: pendingDelete.name })}
          confirmLabel={t("control:backup.deleteConfirmLabel")}
          busyLabel={t("control:ui.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          busy={busy}
          error={error}
          onConfirm={() => void remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        >
          {t("control:containerBackup.deleteBody", { app: name, size: formatBytes(pendingDelete.sizeBytes) })}
        </ConfirmDialog>
      )}

      {uploadOpen && (
        <Modal
          variant="card"
          className="backup-upload-modal"
          title={t("control:containerBackup.uploadTitle", { app: name })}
          icon={<UploadCloud size={20} />}
          busy={uploadBusy}
          onClose={() => setUploadOpen(false)}
        >
          <p className="muted">{t("control:containerBackup.uploadBody")}</p>
          <FileUpload
            endpoint={`${apiPath(app.id)}/upload`}
            accept={["sqlite"]}
            maxBytes={512 * 1024 * 1024}
            hint={t("control:containerBackup.uploadHint")}
            onUploaded={(payload) => {
              const uploaded = (payload as { backup?: { name?: string } }).backup?.name;
              setUploadOpen(false);
              setNotice(t("control:containerBackup.uploaded", { name: uploaded ?? "" }));
              void reload();
            }}
            onBusyChange={setUploadBusy}
          />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setUploadOpen(false)} disabled={uploadBusy}>
              {t("control:ui.close")}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
