import { useState, useEffect, useCallback } from "react";
import { Archive, DatabaseBackup, Download, FlaskConical, Folder, Trash2, RotateCcw, Save } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
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
  const [pendingLoadTesting, setPendingLoadTesting] = useState(false);
  const [loadingTesting, setLoadingTesting] = useState(false);

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

  const loadTestingData = async () => {
    setLoadingTesting(true); setError(""); setNotice("");
    try {
      const res = await api<{ staged: boolean; backupName?: string }>("/api/testing/load-database", { method: "POST", body: "{}" });
      await load();
      setNotice(`Saved your current library${res.backupName ? ` as ${res.backupName}` : ""}. Testing database staged — restart the server to load it, then sign in with test@test.com / test1234.`);
      setPendingLoadTesting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load testing database");
    } finally {
      setLoadingTesting(false);
    }
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
            <button className="icon-button with-label backup-create-button" onClick={createBackup} disabled={creating}>
              <DatabaseBackup size={18} />
              <span>{creating ? "Backing up..." : "Create backup now"}</span>
            </button>
            <button className="icon-button with-label" onClick={() => { setError(""); setNotice(""); setPendingLoadTesting(true); }} title="Replace the database with generated testing data">
              <FlaskConical size={18} />
              <span>Load testing data</span>
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
        <div className="modal-backdrop" onMouseDown={() => !deleting && setPendingDelete(null)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-backup-title" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="delete-backup-title">Delete this backup?</h2>
            <p><strong>{pendingDelete.name}</strong> ({formatBytes(pendingDelete.sizeBytes)}) will be permanently removed.</p>
            {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingDelete(null)} disabled={deleting} autoFocus>Cancel</button>
              <button className="danger-button" onClick={deleteBackup} disabled={deleting}>
                <Trash2 size={15} /> {deleting ? "Deleting…" : "Delete backup"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingLoadTesting && (
        <div className="modal-backdrop" onMouseDown={() => !loadingTesting && setPendingLoadTesting(false)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="load-testing-title" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="load-testing-title">Load testing data?</h2>
            <p>A full backup of your current library is created automatically first, so nothing is lost. Then the generated testing dataset (fake audiobooks and a known admin) replaces the current database the next time the server starts.</p>
            <p><strong>You must restart the server to finish.</strong> After restart, sign in with <strong>test@test.com</strong> / <strong>test1234</strong>. To return to your real library later, restore the backup from the list below.</p>
            <p className="muted">If you haven't generated it yet, run <code>npm run seed:testing --workspace apps/server</code> first.</p>
            {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingLoadTesting(false)} disabled={loadingTesting} autoFocus>Cancel</button>
              <button className="primary-button" onClick={loadTestingData} disabled={loadingTesting}>
                <FlaskConical size={15} /> {loadingTesting ? "Staging…" : "Stage testing data"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRestore && (
        <div className="modal-backdrop" onMouseDown={() => !restoring && setPendingRestore(null)}>
          <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="restore-backup-title" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="restore-backup-title">Restore from this backup?</h2>
            <p>Cover art from <strong>{pendingRestore.name}</strong> is restored immediately. The database is staged and replaces the current one the next time the server starts (the current database is saved as an automatic backup first).</p>
            <p><strong>You must restart the server to finish</strong> — changes made since this backup will be lost.</p>
            {error && <MessageBox tone="error" title="Error">{error}</MessageBox>}
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setPendingRestore(null)} disabled={restoring} autoFocus>Cancel</button>
              <button className="primary-button" onClick={restoreBackup} disabled={restoring}>
                <RotateCcw size={15} /> {restoring ? "Staging…" : "Stage restore"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
