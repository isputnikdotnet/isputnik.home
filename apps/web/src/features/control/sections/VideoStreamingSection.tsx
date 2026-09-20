import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileVideo, Lock, Zap } from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { CLIP_LENGTH, formatClock } from "../../../shared/formatClock";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { RefreshButton } from "../../../shared/RefreshButton";
import { ControlSectionHead } from "../ControlSectionHead";

// Videos whose index sits at the end of the file, and the button that moves it to
// the front (server: modules/library/gallery/faststart.ts). Nothing here runs on a
// schedule: the fix rewrites the original file, so it is always something an admin
// asked for, one video or all of them.

interface VideoCandidate {
  itemId: string;
  libraryId: string;
  libraryName: string;
  title: string;
  relativePath: string;
  size: number | null;
  durationSeconds: number | null;
  blocked: "library" | "locked" | null;
  queued: boolean;
}

export function VideoStreamingSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [items, setItems] = useState<VideoCandidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [queueing, setQueueing] = useState(false);
  const [optimiseAllOpen, setOptimiseAllOpen] = useState(false);
  const [target, setTarget] = useState<VideoCandidate | null>(null);
  const [queuedNow, setQueuedNow] = useState(0);

  const load = async () => {
    const payload = await api<{ items: VideoCandidate[] }>("/api/library/gallery/video-streaming");
    setItems(payload.items);
  };

  useEffect(() => {
    load()
      .catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:videoStreaming.loadFailed")))
      .finally(() => setLoaded(true));
  }, [t]);

  // What "Optimise all" would actually take on: everything not already queued and
  // not held back by its library or a folder lock.
  const ready = useMemo(() => items.filter((item) => item.blocked === null && !item.queued), [items]);
  const readyBytes = useMemo(() => ready.reduce((sum, item) => sum + (item.size ?? 0), 0), [ready]);

  const optimise = async (which: VideoCandidate | "all") => {
    setQueueing(true);
    setActionError("");
    try {
      const body = which === "all" ? { all: true } : { itemIds: [which.itemId] };
      const payload = await api<{ queued: number }>("/api/library/gallery/video-streaming/optimise", {
        method: "POST",
        body: JSON.stringify(body)
      });
      setQueuedNow((count) => count + payload.queued);
      setTarget(null);
      setOptimiseAllOpen(false);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : t("controlAdmin:videoStreaming.queueFailed"));
    } finally {
      setQueueing(false);
    }
  };

  return (
    <>
      <ControlSectionHead
        section="videoStreaming"
        className="control-head-compact"
        icon={<FileVideo size={30} />}
        description={t("controlAdmin:videoStreaming.headDescription")}
      >
        <div className="row-actions control-head-actions">
          {ready.length > 0 && (
            <Button variant="primary" compact disabled={queueing} onClick={() => { setActionError(""); setOptimiseAllOpen(true); }}>
              <Zap size={16} />
              <span>{t("controlAdmin:videoStreaming.optimiseAll", { count: ready.length })}</span>
            </Button>
          )}
          <RefreshButton
            onRefresh={async () => {
              setError("");
              try {
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : t("controlAdmin:videoStreaming.refreshFailed"));
                throw err;
              }
            }}
          />
        </div>
      </ControlSectionHead>

      {error && <MessageBox tone="error" title={t("controlAdmin:videoStreaming.loadFailed")}>{error}</MessageBox>}
      {actionError && <MessageBox tone="error" title={t("errors.actionFailed")}>{actionError}</MessageBox>}
      {queuedNow > 0 && (
        <MessageBox tone="success" title={t("controlAdmin:videoStreaming.queuedTitle", { count: queuedNow })}>
          {t("controlAdmin:videoStreaming.queuedBody")}
        </MessageBox>
      )}

      {loaded && items.length === 0 && !error ? (
        <p className="management-empty">{t("controlAdmin:videoStreaming.empty")}</p>
      ) : items.length > 0 ? (
        <div className="datagrid-wrap">
          <table className="datagrid">
            <thead>
              <tr>
                <th>{t("controlAdmin:videoStreaming.thVideo")}</th>
                <th>{t("controlAdmin:videoStreaming.thLibrary")}</th>
                <th>{t("controlAdmin:videoStreaming.thLength")}</th>
                <th>{t("controlAdmin:videoStreaming.thSize")}</th>
                <th className="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.itemId}>
                  <td>
                    <strong>{item.title}</strong>
                    <span className="datagrid-muted missing-path"> · {item.relativePath}</span>
                  </td>
                  <td className="datagrid-muted">{item.libraryName}</td>
                  <td className="datagrid-muted">
                    {item.durationSeconds ? formatClock(item.durationSeconds, CLIP_LENGTH) : "—"}
                  </td>
                  <td className="datagrid-muted">{item.size ? formatBytes(item.size) : "—"}</td>
                  <td className="col-actions">
                    {item.queued ? (
                      <span className="datagrid-muted">{t("controlAdmin:videoStreaming.queued")}</span>
                    ) : item.blocked ? (
                      <span className="datagrid-muted video-blocked">
                        <Lock size={14} aria-hidden="true" />
                        {item.blocked === "locked"
                          ? t("controlAdmin:videoStreaming.blockedLocked")
                          : t("controlAdmin:videoStreaming.blockedLibrary")}
                      </span>
                    ) : (
                      <Button
                        variant="text"
                        compact
                        disabled={queueing}
                        onClick={() => { setActionError(""); setTarget(item); }}
                      >
                        {t("controlAdmin:videoStreaming.optimise")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {target && (
        <ConfirmDialog
          title={t("controlAdmin:videoStreaming.confirmOneTitle", { title: target.title })}
          confirmLabel={t("controlAdmin:videoStreaming.confirmOne")}
          busy={queueing}
          onCancel={() => setTarget(null)}
          onConfirm={() => void optimise(target)}
        >
          <p>{t("controlAdmin:videoStreaming.confirmBody")}</p>
          <p>{t("controlAdmin:videoStreaming.confirmKept")}</p>
        </ConfirmDialog>
      )}

      {optimiseAllOpen && (
        <ConfirmDialog
          title={t("controlAdmin:videoStreaming.confirmAllTitle", { count: ready.length })}
          confirmLabel={t("controlAdmin:videoStreaming.confirmAll", { count: ready.length })}
          busy={queueing}
          onCancel={() => setOptimiseAllOpen(false)}
          onConfirm={() => void optimise("all")}
        >
          <p>{t("controlAdmin:videoStreaming.confirmAllBody", { size: formatBytes(readyBytes) })}</p>
          <p>{t("controlAdmin:videoStreaming.confirmKept")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
