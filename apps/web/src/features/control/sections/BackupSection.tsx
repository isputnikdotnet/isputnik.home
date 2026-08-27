import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Archive, DatabaseBackup, Download, Folder, Trash2, RotateCcw, Save, UploadCloud } from "lucide-react";
import { api } from "../../../api";
import { controlHref, followRoute } from "../../../router";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
import { ToggleSwitch } from "../../../shared/ToggleSwitch";
import { FileUpload } from "../../../shared/FileUpload";
import { formatBytes, formatManagedDate } from "../../../shared/utils";

interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: "full" | "database";
}

interface BackupSettings {
  enabled: boolean;
  time: string;
  retention: number;
  includeCovers: boolean;
}

interface BackupList {
  backups: BackupFile[];
  backupPath: string;
  settings: BackupSettings;
  coversAvailable: boolean;
  totalSizeBytes: number;
  runningSince: string | null;
  lastError: string | null;
}

export function BackupSection() {
  const { t } = useTranslation(["common", "control"]);
  const [data, setData] = useState<BackupList | null>(null);
  const [form, setForm] = useState<BackupSettings>({ enabled: false, time: "03:00", retention: 10, includeCovers: true });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<BackupFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<BackupFile | null>(null);
  const [restoreCovers, setRestoreCovers] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);

  const load = useCallback(async () => {
    const payload = await api<BackupList>("/api/backups");
    setData(payload);
    setForm(payload.settings);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("control:backup.unableToLoad")));
  }, [load, t]);

  // A backup runs for minutes — far longer than a proxy will hold the request
  // open — so the server answers the start right away and the page watches the
  // list until the run is over. Scheduled runs and other admins are seen too:
  // any load that reports runningSince puts the page into the same waiting state.
  const running = Boolean(data?.runningSince);
  const sawRun = useRef(false);
  useEffect(() => {
    if (running) {
      sawRun.current = true;
      const timer = setTimeout(() => { load().catch(() => {}); }, 3000);
      return () => clearTimeout(timer);
    }
    if (sawRun.current) {
      sawRun.current = false;
      if (data?.lastError) {
        setError(t("control:backup.notFinished", { reason: data.lastError }));
      } else {
        setNotice(t("control:backup.created", { name: data?.backups[0]?.name ?? t("control:backup.createdFallback") }));
      }
    }
  }, [running, data, load, t]);

  const createBackup = async () => {
    setCreating(true);
    setError(""); setNotice("");
    try {
      await api<{ startedAt: string }>("/api/backups", { method: "POST", body: "{}" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:backup.unableToStart"));
    } finally {
      setCreating(false);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    setError(""); setNotice("");
    try {
      await api("/api/backups/settings", { method: "PATCH", body: JSON.stringify(form) });
      setNotice(form.enabled ? t("control:backup.scheduleEnabled", { time: form.time, retention: form.retention }) : t("control:backup.scheduleDisabled"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:backup.unableToSaveSettings"));
    } finally {
      setSavingSettings(false);
    }
  };

  const deleteBackup = async () => {
    if (!pendingDelete) return;
    setDeleting(true); setError("");
    try {
      await api(`/api/backups/${encodeURIComponent(pendingDelete.name)}`, { method: "DELETE" });
      setPendingDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:backup.unableToDelete"));
    } finally {
      setDeleting(false);
    }
  };

  const restoreBackup = async () => {
    if (!pendingRestore) return;
    const covers = pendingRestore.kind === "full" && restoreCovers;
    setRestoring(true); setError("");
    try {
      await api(`/api/backups/${encodeURIComponent(pendingRestore.name)}/restore`, {
        method: "POST",
        body: JSON.stringify({ covers })
      });
      setNotice(
        covers
          ? t("control:backup.restoredNotice", { name: pendingRestore.name })
          : t("control:backup.restoredNoticeDbOnly", { name: pendingRestore.name })
      );
      setPendingRestore(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("control:backup.unableToStageRestore"));
    } finally {
      setRestoring(false);
    }
  };

  const handleBackupUploaded = async (payload: unknown) => {
    const res = payload as { backup?: BackupFile };
    setShowUpload(false);
    setError("");
    setNotice(t("control:backup.uploaded", { name: res.backup?.name ?? t("control:backup.uploadedFallback") }));
    await load();
  };

  return (
    <>
      <div className="backup-page">
        <div className="backup-hero">
          <div className="backup-hero-copy">
            <p className="eyebrow">{t("control:backup.eyebrow")}</p>
            <h1>{t("control:backup.title")}</h1>
            <p>
              {t("control:backup.intro")}
            </p>
            {/* A path as the SERVER sees it. In Docker that's a path inside the
                container, which is not where you'd look on the host — say so, or it
                sends people hunting for a folder their machine doesn't have. */}
            {data && (
              <span
                className="backup-path-pill"
                title={t("control:backup.pathTitle")}
              >
                <Folder size={15} />
                <code>{data.backupPath}</code>
              </span>
            )}
          </div>
          <div className="backup-hero-actions">
            <button className="primary-button" onClick={createBackup} disabled={creating || running}>
              <DatabaseBackup size={18} />
              <span>{creating || running ? t("control:backup.backingUp") : t("control:backup.createNow")}</span>
            </button>
            <button className="secondary-button" onClick={() => { setError(""); setNotice(""); setShowUpload(true); }} title={t("control:backup.uploadBackupTitle")}>
              <UploadCloud size={18} />
              <span>{t("control:backup.uploadBackup")}</span>
            </button>
          </div>
        </div>

        {error && <MessageBox tone="error" title={t("control:backup.errorTitle")}>{error}</MessageBox>}
        {notice && <MessageBox tone="success" title={t("control:backup.listTitle")}>{notice}</MessageBox>}

        <section className="backup-card backup-settings">
          <h2>{t("control:backup.scheduledTitle")}</h2>
          <div className="backup-settings-row">
            <ToggleSwitch
              className="backup-auto-toggle"
              checked={form.enabled}
              onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              label={t("control:backup.runAutomatically")}
            />
            <label className="field backup-field-time">
              <span>{t("control:backup.time")}</span>
              <input type="time" value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} disabled={!form.enabled} />
            </label>
            <label className="field backup-field-keep">
              <span>{t("control:backup.keepNewest")}</span>
              <input type="number" min={1} max={100} value={form.retention} onChange={(e) => setForm((f) => ({ ...f, retention: Number(e.target.value) }))} />
            </label>
            <label className="field-checkbox backup-cover-toggle">
              <input
                type="checkbox"
                checked={form.includeCovers}
                disabled={!data?.coversAvailable}
                onChange={(e) => setForm((f) => ({ ...f, includeCovers: e.target.checked }))}
              />
              <span>
                {t("control:backup.includeCovers")}
                {data && !data.coversAvailable && (
                  <small>
                    {t("control:backup.noThumbnailStore")}{" "}
                    <a
                      href={controlHref("storage")}
                      onClick={(event) => followRoute(event, controlHref("storage"))}
                    >
                      {t("control:backup.storageLink")}
                    </a>
                  </small>
                )}
              </span>
            </label>
          </div>
          <div className="backup-card-rule" />
          <div className="backup-settings-footer">
            <button className="primary-button compact-button backup-save-button" onClick={saveSettings} disabled={savingSettings}>
              <Save size={15} /> {savingSettings ? t("control:ui.saving") : t("control:ui.save")}
            </button>
            <p className="muted backup-retention-note">
              {t("control:backup.retentionNote")}
            </p>
          </div>
        </section>

        {data && data.backups.length === 0 ? (
          <section className="backup-card backup-empty-card">
            <span className="backup-empty-icon" aria-hidden="true">
              <Archive size={30} />
            </span>
            <h2>{t("control:backup.emptyTitle")}</h2>
            <p className="muted">{t("control:backup.emptyBody")}</p>
          </section>
        ) : data && (
          <section className="backup-card backup-list-card">
            <div className="backup-list-head">
              <h2>{t("control:backup.listTitle")}</h2>
              <span>
                {t("control:backup.totalSummary", { size: formatBytes(data.totalSizeBytes), count: data.backups.length })}
              </span>
            </div>
            <div className="datagrid-wrap">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th>{t("control:backup.thBackup")}</th>
                    <th>{t("control:backup.thType")}</th>
                    <th className="col-scan">{t("control:backup.thCreated")}</th>
                    <th className="col-num">{t("control:backup.thSize")}</th>
                    <th className="col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.backups.map((backup) => {
                    // The file being written is already in the list and grows as we
                    // poll; it must not offer Restore/Download/Delete half-made.
                    const writing = running && data.runningSince != null && backup.createdAt >= data.runningSince;
                    return (
                      <tr key={backup.name}>
                        <td><strong>{backup.name}</strong></td>
                        <td className="datagrid-muted">{writing ? t("control:backup.writingInProgress") : backup.kind === "full" ? t("control:backup.kindFull") : t("control:backup.kindDatabase")}</td>
                        <td className="col-scan datagrid-muted">{formatManagedDate(backup.createdAt)}</td>
                        <td className="col-num datagrid-muted">{formatBytes(backup.sizeBytes)}</td>
                        <td className="col-actions">
                          {!writing && (
                            <div className="row-actions">
                              <button className="secondary-button compact-button" title={t("control:backup.restoreTitle")} onClick={() => { setRestoreCovers(true); setPendingRestore(backup); }}>
                                <RotateCcw size={14} /> {t("control:backup.restore")}
                              </button>
                              <a className="icon-button" title={t("control:backup.downloadTitle")} href={`/api/backups/${encodeURIComponent(backup.name)}/download`} download>
                                <Download size={15} />
                              </a>
                              <button className="icon-button danger" title={t("control:backup.deleteTitle")} onClick={() => setPendingDelete(backup)}>
                                <Trash2 size={15} />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={t("control:backup.deleteConfirmTitle")}
          confirmLabel={t("control:backup.deleteConfirmLabel")}
          busyLabel={t("control:ui.deleting")}
          confirmIcon={<Trash2 size={15} />}
          danger
          busy={deleting}
          error={error}
          onConfirm={deleteBackup}
          onCancel={() => setPendingDelete(null)}
        >
          {t("control:backup.willBeRemoved", { name: pendingDelete.name, size: formatBytes(pendingDelete.sizeBytes) })}
        </ConfirmDialog>
      )}

      {pendingRestore && (
        <ConfirmDialog
          title={t("control:backup.restoreConfirmTitle")}
          confirmLabel={t("control:backup.stageRestore")}
          busyLabel={t("control:backup.staging")}
          confirmIcon={<RotateCcw size={15} />}
          rich
          busy={restoring}
          error={error}
          onConfirm={restoreBackup}
          onCancel={() => setPendingRestore(null)}
        >
          <p>
            {t("control:backup.restoreBody", { name: pendingRestore.name })}
            {pendingRestore.kind === "full" && restoreCovers && t("control:backup.restoreCoversNote")}
          </p>
          {pendingRestore.kind === "full" && (
            <label className="field-checkbox backup-cover-toggle">
              <input
                type="checkbox"
                checked={restoreCovers}
                onChange={(e) => setRestoreCovers(e.target.checked)}
              />
              <span>
                {t("control:backup.alsoRestoreCovers")}
                <small>{t("control:backup.alsoRestoreCoversHint")}</small>
              </span>
            </label>
          )}
          <p><strong>{t("control:backup.restoreRestartWarning")}</strong></p>
        </ConfirmDialog>
      )}

      {showUpload && (
        <Modal
          variant="card"
          className="backup-upload-modal"
          title={t("control:backup.uploadModalTitle")}
          icon={<UploadCloud size={20} />}
          busy={uploadBusy}
          onClose={() => setShowUpload(false)}
        >
          <p className="muted">
            {t("control:backup.uploadModalBody")}
          </p>
          <FileUpload
            endpoint="/api/backups/upload"
            accept={["zip", "sqlite"]}
            maxBytes={null}
            hint={t("control:backup.uploadHint")}
            onUploaded={handleBackupUploaded}
            onBusyChange={setUploadBusy}
          />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setShowUpload(false)} disabled={uploadBusy}>
              {t("control:ui.close")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
