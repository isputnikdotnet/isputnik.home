import { useState, useEffect, useCallback } from "react";
import { Archive, DatabaseBackup, Download, Folder, Trash2, RotateCcw, Save, UploadCloud } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Modal } from "../../../shared/Modal";
import { Button } from "../../../shared/Button";
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
}

export function BackupSection() {
  const [data, setData] = useState<BackupList | null>(null);
  const [form, setForm] = useState<BackupSettings>({ enabled: false, time: "03:00", retention: 10, includeCovers: true });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<BackupFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<BackupFile | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);

  const load = useCallback(async () => {
    const payload = await api<BackupList>("/api/backups");
    setData(payload);
    setForm(payload.settings);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Unable to load backups"));
  }, [load]);

  const createBackup = async () => {
    setCreating(true);
    setError(""); setNotice("");
    try {
      const payload = await api<{ backup: BackupFile }>("/api/backups", { method: "POST", body: "{}" });
      setNotice(`Created ${payload.backup.name}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create backup");
    } finally {
      setCreating(false);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    setError(""); setNotice("");
    try {
      await api("/api/backups/settings", { method: "PATCH", body: JSON.stringify(form) });
      setNotice(form.enabled ? `Scheduled daily backup at ${form.time}, keeping ${form.retention}.` : "Scheduled backups disabled.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save settings");
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
      setError(err instanceof Error ? err.message : "Unable to delete backup");
    } finally {
      setDeleting(false);
    }
  };

  const restoreBackup = async () => {
    if (!pendingRestore) return;
    setRestoring(true); setError("");
    try {
      await api(`/api/backups/${encodeURIComponent(pendingRestore.name)}/restore`, { method: "POST", body: "{}" });
      setNotice(`Restore staged from ${pendingRestore.name}. Restart the server to apply it.`);
      setPendingRestore(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to stage restore");
    } finally {
      setRestoring(false);
    }
  };

  const handleBackupUploaded = async (payload: unknown) => {
    const res = payload as { backup?: BackupFile };
    setShowUpload(false);
    setError("");
    setNotice(`Uploaded ${res.backup?.name ?? "the backup"}. It's ready to restore from the list below.`);
    await load();
  };

  return (
    <>
      <div className="backup-page">
        <div className="backup-hero">
          <div className="backup-hero-copy">
            <p className="eyebrow">Maintenance</p>
            <h1>Backup</h1>
            <p>
              Creates a consistent snapshot of the application database (accounts, libraries, metadata,
              listening progress, bookmarks, saved lists) while the server keeps running. Media files are
              never modified; thumbnail caches can be regenerated, and cover art can be included with
              backups below.
            </p>
            {data && (
              <span className="backup-path-pill">
                <Folder size={15} />
                <code>{data.backupPath}</code>
              </span>
            )}
          </div>
          <div className="backup-hero-actions">
            <button className="primary-button" onClick={createBackup} disabled={creating}>
              <DatabaseBackup size={18} />
              <span>{creating ? "Backing up..." : "Create backup now"}</span>
            </button>
            <button className="secondary-button" onClick={() => { setError(""); setNotice(""); setShowUpload(true); }} title="Upload a backup file from your computer">
              <UploadCloud size={18} />
              <span>Upload backup</span>
            </button>
          </div>
        </div>

        {error && <MessageBox tone="error" title="Backup error">{error}</MessageBox>}
        {notice && <MessageBox tone="success" title="Backups">{notice}</MessageBox>}

        <section className="backup-card backup-settings">
          <h2>Scheduled backups</h2>
          <div className="backup-settings-row">
            <label className="field-checkbox backup-auto-toggle">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
              <span>Run a backup automatically every day</span>
            </label>
            <label className="field backup-field-time">
              <span>Time</span>
              <input type="time" value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} disabled={!form.enabled} />
            </label>
            <label className="field backup-field-keep">
              <span>Keep newest</span>
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
                Include cover art
                {data && !data.coversAvailable && <small>(no thumbnail path configured)</small>}
              </span>
            </label>
          </div>
          <div className="backup-card-rule" />
          <div className="backup-settings-footer">
            <button className="primary-button compact-button backup-save-button" onClick={saveSettings} disabled={savingSettings}>
              <Save size={15} /> {savingSettings ? "Saving..." : "Save"}
            </button>
            <p className="muted backup-retention-note">
              Applies to manual and scheduled backups. Covers can't all be regenerated (uploaded and
              provider-fetched art), so including them is recommended. Older backups beyond the limit are
              removed automatically.
            </p>
          </div>
        </section>

        {data && data.backups.length === 0 ? (
          <section className="backup-card backup-empty-card">
            <span className="backup-empty-icon" aria-hidden="true">
              <Archive size={30} />
            </span>
            <h2>No backups yet</h2>
            <p className="muted">Click "Create backup now" to make one.</p>
          </section>
        ) : data && (
          <section className="backup-card backup-list-card">
            <div className="backup-list-head">
              <h2>Backups</h2>
              <span>
                Total: {formatBytes(data.totalSizeBytes)} across {data.backups.length} {data.backups.length === 1 ? "backup" : "backups"}.
              </span>
            </div>
            <div className="datagrid-wrap">
              <table className="datagrid">
                <thead>
                  <tr>
                    <th>Backup</th>
                    <th>Type</th>
                    <th className="col-scan">Created</th>
                    <th className="col-num">Size</th>
                    <th className="col-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.backups.map((backup) => (
                    <tr key={backup.name}>
                      <td><strong>{backup.name}</strong></td>
                      <td className="datagrid-muted">{backup.kind === "full" ? "Full (DB + covers)" : "Database only"}</td>
                      <td className="col-scan datagrid-muted">{formatManagedDate(backup.createdAt)}</td>
                      <td className="col-num datagrid-muted">{formatBytes(backup.sizeBytes)}</td>
                      <td className="col-actions">
                        <div className="row-actions">
                          <button className="secondary-button compact-button" title="Restore this backup" onClick={() => setPendingRestore(backup)}>
                            <RotateCcw size={14} /> Restore
                          </button>
                          <a className="icon-button" title="Download backup" href={`/api/backups/${encodeURIComponent(backup.name)}/download`} download>
                            <Download size={15} />
                          </a>
                          <button className="icon-button danger" title="Delete backup" onClick={() => setPendingDelete(backup)}>
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this backup?"
          confirmLabel="Delete backup"
          busyLabel="Deleting…"
          confirmIcon={<Trash2 size={15} />}
          danger
          busy={deleting}
          error={error}
          onConfirm={deleteBackup}
          onCancel={() => setPendingDelete(null)}
        >
          <strong>{pendingDelete.name}</strong> ({formatBytes(pendingDelete.sizeBytes)}) will be permanently removed.
        </ConfirmDialog>
      )}

      {pendingRestore && (
        <ConfirmDialog
          title="Restore from this backup?"
          confirmLabel="Stage restore"
          busyLabel="Staging…"
          confirmIcon={<RotateCcw size={15} />}
          rich
          busy={restoring}
          error={error}
          onConfirm={restoreBackup}
          onCancel={() => setPendingRestore(null)}
        >
          <p>Cover art from <strong>{pendingRestore.name}</strong> is restored immediately. The database is staged and replaces the current one the next time the server starts (the current database is saved as an automatic backup first).</p>
          <p><strong>You must restart the server to finish</strong> — changes made since this backup will be lost.</p>
        </ConfirmDialog>
      )}

      {showUpload && (
        <Modal
          variant="card"
          className="backup-upload-modal"
          title="Upload a backup file"
          icon={<UploadCloud size={20} />}
          busy={uploadBusy}
          onClose={() => setShowUpload(false)}
        >
          <p className="muted">
            Add a backup from your computer — a full <code>.zip</code> (database + covers) or a
            database-only <code>.sqlite</code>. It joins the list below, ready to restore.
          </p>
          <FileUpload
            endpoint="/api/backups/upload"
            accept={["zip", "sqlite"]}
            maxBytes={null}
            hint="isputnik backup: .zip or .sqlite"
            onUploaded={handleBackupUploaded}
            onBusyChange={setUploadBusy}
          />
          <div className="modal-actions">
            <Button variant="secondary" onClick={() => setShowUpload(false)} disabled={uploadBusy}>
              Close
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
