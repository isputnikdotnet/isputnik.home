import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff, Trash2, UserRound } from "lucide-react";
import i18n from "../../../i18n";
import { api } from "../../../api";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";

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
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(i18n.language);
}

function formatDay(iso: string | null): string {
  if (!iso) return i18n.t("controlAdmin:ui.never");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(i18n.language);
}

export function MissingPhotosSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
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
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:missingPhotos.loadFailed")))
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
      setActionError(t("controlAdmin:missingPhotos.retentionInvalid"));
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
      setActionError(err instanceof Error ? err.message : t("controlAdmin:missingPhotos.saveRetentionFailed"));
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
      setActionError(err instanceof Error ? err.message : t("controlAdmin:missingPhotos.removeFailed"));
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
      setActionError(err instanceof Error ? err.message : t("controlAdmin:missingPhotos.purgeAllFailed"));
    } finally {
      setPurgingAll(false);
    }
  };

  const busy = purging || purgingAll || savingRetention;

  return (
    <>
      <ControlSectionHead
        section="missingPhotos"
        className="control-head-compact"
        icon={<ImageOff size={30} />}
        description={t("controlAdmin:missingPhotos.headDescription")}
      >
        {/* Refresh last, at the right edge — same position as on Scheduled jobs. */}
        <div className="row-actions control-head-actions">
          {eligibleCount > 0 && (
            <Button variant="danger" compact disabled={busy} onClick={() => { setActionError(""); setPurgeAllOpen(true); }}>
              <Trash2 size={16} />
              <span>{t("controlAdmin:missingPhotos.purgeEligible", { count: eligibleCount })}</span>
            </Button>
          )}
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("controlAdmin:missingPhotos.refreshFailed"));
                throw err;
              }
            }}
          />
        </div>
      </ControlSectionHead>

      <div className="missing-retention-row">
        <label htmlFor="missing-retention">{t("controlAdmin:missingPhotos.retentionLabel")}</label>
        <input
          id="missing-retention"
          type="number"
          min={0}
          max={3650}
          value={retentionInput}
          disabled={savingRetention}
          onChange={(event) => setRetentionInput(event.target.value)}
        />
        <span className="datagrid-muted">{t("controlAdmin:missingPhotos.daysSuffix")}</span>
        <Button
          variant="secondary"
          compact
          disabled={savingRetention || retentionInput === String(retentionDays)}
          onClick={saveRetention}
        >
          {savingRetention ? t("controlAdmin:ui.saving") : t("controlAdmin:ui.save")}
        </Button>
      </div>

      {error && <MessageBox tone="error" title={t("controlAdmin:missingPhotos.loadFailed")}>{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title={t("errors.actionFailed")}>{actionError}</MessageBox>}

      {loaded && items.length === 0 && !error ? (
        <p className="management-empty">{t("controlAdmin:missingPhotos.empty")}</p>
      ) : items.length > 0 ? (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th></th>
                <th>{t("controlAdmin:missingPhotos.thPhoto")}</th>
                <th>{t("controlAdmin:missingPhotos.thLibrary")}</th>
                <th>{t("controlAdmin:missingPhotos.thMissingSince")}</th>
                <th>{t("controlAdmin:missingPhotos.thAutoRemoves")}</th>
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
                      {t("controlAdmin:missingPhotos.removeNow")}
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
          title={t("controlAdmin:missingPhotos.confirmRemoveTitle", { title: purgeTarget.title })}
          confirmLabel={t("controlAdmin:missingPhotos.confirmRemoveLabel")}
          busyLabel={t("controlAdmin:missingPhotos.removing")}
          danger
          busy={purging}
          error={actionError}
          onConfirm={confirmPurge}
          onCancel={() => setPurgeTarget(null)}
        >
          {t("controlAdmin:missingPhotos.confirmRemoveBody")}
        </ConfirmDialog>
      )}

      {purgeAllOpen && (
        <ConfirmDialog
          title={t("controlAdmin:missingPhotos.confirmPurgeAllTitle", { count: eligibleCount })}
          confirmLabel={t("controlAdmin:missingPhotos.confirmPurgeAllLabel", { count: eligibleCount })}
          busyLabel={t("controlAdmin:missingPhotos.purging")}
          danger
          busy={purgingAll}
          error={actionError}
          onConfirm={confirmPurgeAll}
          onCancel={() => setPurgeAllOpen(false)}
        >
          {t("controlAdmin:missingPhotos.confirmPurgeAllBody", { count: retentionDays })}
        </ConfirmDialog>
      )}
    </>
  );
}
