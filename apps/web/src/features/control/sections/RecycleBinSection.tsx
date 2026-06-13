import { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { formatBytes } from "../../../shared/utils";

interface TrashedItem {
  id: string;
  libraryId: string;
  libraryType: string;
  libraryName: string;
  title: string;
  fileCount: number;
  sizeBytes: number;
  trashedAt: string;
  trashedByName: string | null;
  purgesAt: string | null;
}

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC.
function formatWhen(value: string): string {
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDay(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export function RecycleBinSection() {
  const [items, setItems] = useState<TrashedItem[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [restoringId, setRestoringId] = useState("");
  const [purgeTarget, setPurgeTarget] = useState<TrashedItem | null>(null);
  const [purging, setPurging] = useState(false);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);
  const [actionError, setActionError] = useState("");

  const load = async () => {
    const payload = await api<{ items: TrashedItem[]; retentionDays: number }>("/api/library/trash");
    setItems(payload.items);
    setRetentionDays(payload.retentionDays);
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load the Recycle Bin"))
      .finally(() => setLoaded(true));
  }, []);

  const restore = async (item: TrashedItem) => {
    setRestoringId(item.id);
    setActionError("");
    try {
      await api(`/api/library/trash/${item.id}/restore`, { method: "POST" });
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to restore the item");
    } finally {
      setRestoringId("");
    }
  };

  const confirmPurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    setActionError("");
    try {
      await api(`/api/library/trash/${purgeTarget.id}`, { method: "DELETE" });
      setPurgeTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to delete the item");
    } finally {
      setPurging(false);
    }
  };

  const confirmEmpty = async () => {
    setEmptying(true);
    setActionError("");
    try {
      await api("/api/library/trash/empty", { method: "POST", body: "{}" });
      setEmptyOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to empty the Recycle Bin");
    } finally {
      setEmptying(false);
    }
  };

  const retentionBlurb = retentionDays > 0
    ? `Deleted items keep their files here for ${retentionDays} day${retentionDays === 1 ? "" : "s"}, then they're permanently removed. Restore anything before then.`
    : "Deleted items keep their files here until you remove them. Restore anything you need.";

  return (
    <>
      <div className="section-head admin-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon" aria-hidden="true">
            <Trash2 size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">Digital Library</p>
            <h1>Recycle Bin</h1>
            <p className="section-description">{retentionBlurb}</p>
          </div>
        </div>
        {items.length > 0 && (
          <Button variant="danger" compact onClick={() => { setActionError(""); setEmptyOpen(true); }}>
            <Trash2 size={16} />
            <span>Empty Recycle Bin</span>
          </Button>
        )}
      </div>

      {error && <MessageBox tone="error" title="Unable to load the Recycle Bin">{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>}

      {loaded && items.length === 0 && !error ? (
        <p className="management-empty">The Recycle Bin is empty.</p>
      ) : items.length > 0 ? (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>Item</th>
                <th>Library</th>
                <th className="col-num">Size</th>
                <th>Deleted</th>
                <th>Auto-removes</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.title}</strong>
                    <span className="datagrid-muted"> · {item.fileCount} file{item.fileCount === 1 ? "" : "s"}</span>
                  </td>
                  <td className="datagrid-muted">{item.libraryName} <span className="count-badge">{item.libraryType}</span></td>
                  <td className="col-num datagrid-muted">{formatBytes(item.sizeBytes)}</td>
                  <td className="datagrid-muted">
                    {formatWhen(item.trashedAt)}{item.trashedByName ? ` · ${item.trashedByName}` : ""}
                  </td>
                  <td className="datagrid-muted">{formatDay(item.purgesAt)}</td>
                  <td className="col-actions">
                    <Button
                      variant="text"
                      compact
                      disabled={restoringId === item.id || purging || emptying}
                      onClick={() => restore(item)}
                    >
                      <RotateCcw size={15} />
                      {restoringId === item.id ? "Restoring…" : "Restore"}
                    </Button>
                    <Button
                      variant="text"
                      danger
                      compact
                      disabled={restoringId === item.id || purging || emptying}
                      onClick={() => { setActionError(""); setPurgeTarget(item); }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {purgeTarget && (
        <ConfirmDialog
          title={`Permanently delete "${purgeTarget.title}"?`}
          confirmLabel="Delete permanently"
          busyLabel="Deleting…"
          danger
          busy={purging}
          error={actionError}
          onConfirm={confirmPurge}
          onCancel={() => setPurgeTarget(null)}
        >
          Its {purgeTarget.fileCount} file{purgeTarget.fileCount === 1 ? "" : "s"} will be erased from disk. This cannot be undone — restore it instead if you might want it back.
        </ConfirmDialog>
      )}

      {emptyOpen && (
        <ConfirmDialog
          title="Empty the Recycle Bin?"
          confirmLabel="Empty Recycle Bin"
          busyLabel="Emptying…"
          danger
          busy={emptying}
          error={actionError}
          onConfirm={confirmEmpty}
          onCancel={() => setEmptyOpen(false)}
        >
          Every item in the bin will be permanently deleted, including all their files on disk. This cannot be undone.
        </ConfirmDialog>
      )}
    </>
  );
}
