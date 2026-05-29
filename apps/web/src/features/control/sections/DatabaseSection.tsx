import { useState, useEffect } from "react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { formatManagedDate } from "../../../shared/utils";
import type { DbInfo } from "../types";

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DatabaseSection() {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ db: DbInfo }>("/api/db/info")
      .then((payload) => setInfo(payload.db))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load database info"));
  }, []);

  return (
    <>
      <div className="section-head">
        <div>
          <p className="eyebrow">Application</p>
          <h1>Database</h1>
        </div>
      </div>

      {error && <MessageBox tone="error" title="Database error">{error}</MessageBox>}

      {info && (
        <div className="status-grid">
          <div className="status-card">
            <span className="status-card-label">File</span>
            <strong className="status-card-value">{info.filename}</strong>
          </div>
          <div className="status-card">
            <span className="status-card-label">Directory</span>
            <strong className="status-card-value" style={{ wordBreak: "break-all", fontSize: "0.82rem" }}>{info.directory}</strong>
          </div>
          <div className="status-card">
            <span className="status-card-label">Full path</span>
            <strong className="status-card-value" style={{ wordBreak: "break-all", fontSize: "0.82rem" }}>{info.path}</strong>
          </div>
          <div className="status-card">
            <span className="status-card-label">Database size</span>
            <strong className="status-card-value">{formatBytes(info.sizeBytes)}</strong>
          </div>
          <div className="status-card">
            <span className="status-card-label">WAL size</span>
            <strong className="status-card-value">{formatBytes(info.walSizeBytes)}</strong>
          </div>
          <div className="status-card">
            <span className="status-card-label">Total on disk</span>
            <strong className="status-card-value">{formatBytes(info.totalSizeBytes)}</strong>
          </div>
          <div className="status-card">
            <span className="status-card-label">Last modified</span>
            <strong className="status-card-value">{info.lastModified ? formatManagedDate(info.lastModified) : "—"}</strong>
          </div>
        </div>
      )}

      <p className="muted" style={{ marginTop: 24, fontSize: "0.88rem" }}>
        To back up the database, copy the file and its <code>-wal</code> and <code>-shm</code> companions from the directory above while the server is idle, or use <code>sqlite3 isputnik.sqlite .backup backup.sqlite</code> for a safe online backup.
      </p>
    </>
  );
}
