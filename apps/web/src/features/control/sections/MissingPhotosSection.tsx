import { useEffect, useMemo, useState } from "react";
import { ImageOff, Trash2, UserRound } from "lucide-react";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";

interface MissingPhoto {
  id: string;
  libraryId: string;
  libraryName: string;
  path: string;
  title: string;
  coverUrl: string | null;
  detectedAt: string;
  purgesAt: string | null;
}

function formatWhen(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDay(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export function MissingPhotosSection() {
  const [items, setItems] = useState<MissingPhoto[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [retentionInput, setRetentionInput] = useState("30");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [savingRetention, setSavingRetention] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<MissingPhoto | null>(null);
  const [purging, setPurging] = useState(false);
  const [purgeAllOpen, setPurgeAllOpen] = useState(false);
  const [purgingAll, setPurgingAll] = useState(false);

  const load = async () => {
    const payload = await api<{ items: MissingPhoto[]; retentionDays: number }>("/api/library/gallery/missing");
    setItems(payload.items);
    setRetentionDays(payload.retentionDays);
    setRetentionInput(String(payload.retentionDays));
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load missing photos"))
      .finally(() => setLoaded(true));
  }, []);

  // Items already past their grace window (eligible for the scheduled purge).
  const eligibleCount = useMemo(() => {
    const now = Date.now();
    return items.filter((item) => item.purgesAt != null && new Date(item.purgesAt).getTime() <= now).length;
  }, [items]);

  const saveRetention = async () => {
    const value = Number.parseInt(retentionInput, 10);
    if (!Number.isFinite(value) || value < 0) {
      setActionError("Enter a number of days (0 to keep missing photos forever).");
      return;
    }
    setSavingRetention(true);
    setActionError("");
    try {
      const payload = await api<{ retentionDays: number }>("/api/library/gallery/missing/retention", {
        method: "PATCH",
        body: JSON.stringify({ retentionDays: value })
      });
      setRetentionDays(payload.retentionDays);
      setRetentionInput(String(payload.retentionDays));
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to save the retention window");
    } finally {
      setSavingRetention(false);
    }
  };

  const confirmPurge = async () => {
    if (!purgeTarget) return;
    setPurging(true);
    setActionError("");
    try {
      await api(`/api/library/gallery/missing/${purgeTarget.id}`, { method: "DELETE" });
      setPurgeTarget(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to remove the photo");
    } finally {
      setPurging(false);
    }
  };

  const confirmPurgeAll = async () => {
    setPurgingAll(true);
    setActionError("");
    try {
      await api("/api/library/gallery/missing/purge", { method: "POST", body: "{}" });
      setPurgeAllOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to purge missing photos");
    } finally {
      setPurgingAll(false);
    }
  };

  const busy = purging || purgingAll || savingRetention;

  return (
    <>
      <div className="section-head admin-section-head">
        <div className="admin-title-wrap">
          <span className="admin-page-icon" aria-hidden="true">
            <ImageOff size={30} />
          </span>
          <div className="admin-heading-copy">
            <p className="eyebrow">Digital Library</p>
            <h1>Missing photos</h1>
            <p className="section-description">
              Photos whose files have vanished from disk. They're hidden from the gallery but kept here — with their
              metadata and last-known thumbnail — in case the file comes back. Unmatched after the grace window, they're
              permanently removed by the weekly cleanup. If a drive was just offline, rescan the library and they revive.
            </p>
          </div>
        </div>
        {eligibleCount > 0 && (
          <Button variant="danger" compact disabled={busy} onClick={() => { setActionError(""); setPurgeAllOpen(true); }}>
            <Trash2 size={16} />
            <span>Purge {eligibleCount} eligible now</span>
          </Button>
        )}
      </div>

      <div className="missing-retention-row">
        <label htmlFor="missing-retention">Auto-purge missing photos after</label>
        <input
          id="missing-retention"
          type="number"
          min={0}
          max={3650}
          value={retentionInput}
          disabled={savingRetention}
          onChange={(event) => setRetentionInput(event.target.value)}
        />
        <span className="datagrid-muted">days (0 = keep forever)</span>
        <Button
          variant="secondary"
          compact
          disabled={savingRetention || retentionInput === String(retentionDays)}
          onClick={saveRetention}
        >
          {savingRetention ? "Saving…" : "Save"}
        </Button>
      </div>

      {error && <MessageBox tone="error" title="Unable to load missing photos">{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title="Action failed">{actionError}</MessageBox>}

      {loaded && items.length === 0 && !error ? (
        <p className="management-empty">No missing photos — every catalogued photo is present on disk.</p>
      ) : items.length > 0 ? (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th></th>
                <th>Photo</th>
                <th>Library</th>
                <th>Missing since</th>
                <th>Auto-removes</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="missing-thumb" aria-hidden="true">
                      {item.coverUrl ? <img src={item.coverUrl} alt="" loading="lazy" /> : <UserRound size={16} />}
                    </span>
                  </td>
                  <td>
                    <strong>{item.title}</strong>
                    <span className="datagrid-muted missing-path"> · {item.path}</span>
                  </td>
                  <td className="datagrid-muted">{item.libraryName}</td>
                  <td className="datagrid-muted">{formatWhen(item.detectedAt)}</td>
                  <td className="datagrid-muted">{formatDay(item.purgesAt)}</td>
                  <td className="col-actions">
                    <Button
                      variant="text"
                      danger
                      compact
                      disabled={busy}
                      onClick={() => { setActionError(""); setPurgeTarget(item); }}
                    >
                      Remove now
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
          title={`Permanently remove "${purgeTarget.title}"?`}
          confirmLabel="Remove permanently"
          busyLabel="Removing…"
          danger
          busy={purging}
          error={actionError}
          onConfirm={confirmPurge}
          onCancel={() => setPurgeTarget(null)}
        >
          Its catalog entry, cached thumbnail, and any detected faces are deleted. The file is already gone from disk, so
          there is nothing to restore — this only cleans up the leftover record. It cannot be undone.
        </ConfirmDialog>
      )}

      {purgeAllOpen && (
        <ConfirmDialog
          title={`Purge ${eligibleCount} missing photo${eligibleCount === 1 ? "" : "s"}?`}
          confirmLabel={`Purge ${eligibleCount}`}
          busyLabel="Purging…"
          danger
          busy={purgingAll}
          error={actionError}
          onConfirm={confirmPurgeAll}
          onCancel={() => setPurgeAllOpen(false)}
        >
          Every photo missing longer than {retentionDays} day{retentionDays === 1 ? "" : "s"} has its catalog entry,
          thumbnail, and detected faces permanently removed. The files are already gone from disk. This cannot be undone.
        </ConfirmDialog>
      )}
    </>
  );
}
