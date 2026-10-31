import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, FileVideo, Lock, Zap } from "lucide-react";
import { api } from "../../../api";
import { formatBytes } from "../../../shared/utils";
import { CLIP_LENGTH, formatClock } from "../../../shared/formatClock";
import { MessageBox } from "../../../shared/MessageBox";
import { Button } from "../../../shared/Button";
import { ConfirmDialog } from "../../../shared/ConfirmDialog";
import { Pager } from "../../../shared/Pager";
import { PageSizeMenu, usePageSize } from "../../../shared/PageSizeMenu";
import { RefreshButton } from "../../../shared/RefreshButton";
import { SelectMenu } from "../../../shared/SelectMenu";
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
  failure: string | null;
  queued: boolean;
}

type Show = "all" | "ready" | "unable";

interface VideoPage {
  items: VideoCandidate[];
  page: number;
  totalPages: number;
  summary: { total: number; ready: number; readyBytes: number; queued: number; unable: number };
}

export function VideoStreamingSection() {
  const { t } = useTranslation(["common", "controlAdmin"]);
  const [data, setData] = useState<VideoPage | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize("isputnik.videoStreaming.pageSize");
  const [show, setShow] = useState<Show>("all");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [queueing, setQueueing] = useState(false);
  const [optimiseAllOpen, setOptimiseAllOpen] = useState(false);
  const [target, setTarget] = useState<VideoCandidate | null>(null);
  const [queuedNow, setQueuedNow] = useState(0);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize, show });
    setData(await api<VideoPage>(`/api/library/gallery/video-streaming?${params}`));
  }, [page, pageSize, show]);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : t("controlAdmin:videoStreaming.loadFailed")));
  }, [load, t]);

  const summary = data?.summary;
  const ready = summary?.ready ?? 0;

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
          {ready > 0 && (
            <Button variant="primary" compact disabled={queueing} onClick={() => { setActionError(""); setOptimiseAllOpen(true); }}>
              <Zap size={16} />
              <span>{t("controlAdmin:videoStreaming.optimiseAll", { count: ready })}</span>
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

      {data && summary && summary.total === 0 && !error ? (
        <p className="management-empty">{t("controlAdmin:videoStreaming.empty")}</p>
      ) : data && summary ? (
        <>
          <div className="video-streaming-bar">
            <p className="datagrid-muted video-streaming-summary">
              {[
                t("controlAdmin:videoStreaming.summaryVideos", { count: summary.total }),
                t("controlAdmin:videoStreaming.summaryReady", { count: summary.ready }),
                ...(summary.queued > 0 ? [t("controlAdmin:videoStreaming.summaryQueued", { count: summary.queued })] : []),
                ...(summary.unable > 0 ? [t("controlAdmin:videoStreaming.summaryUnable", { count: summary.unable })] : [])
              ].join(" · ")}
            </p>
            <div className="row-actions">
              <SelectMenu
                value={show}
                options={[
                  { value: "all", label: t("controlAdmin:videoStreaming.showAll") },
                  { value: "ready", label: t("controlAdmin:videoStreaming.showReady") },
                  { value: "unable", label: t("controlAdmin:videoStreaming.showUnable") }
                ]}
                label={t("controlAdmin:videoStreaming.showLabel")}
                onChange={(next) => { setShow(next as Show); setPage(1); }}
              />
              <PageSizeMenu value={pageSize} onChange={(next) => { setPageSize(next); setPage(1); }} />
            </div>
          </div>

          {data.items.length === 0 ? (
            <p className="management-empty">{t("controlAdmin:videoStreaming.emptyFiltered")}</p>
          ) : (
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
                  {data.items.map((item) => (
                    <tr key={item.itemId}>
                      <td>
                        <strong>{item.title}</strong>
                        <span className="datagrid-muted missing-path"> · {item.relativePath}</span>
                        {item.failure && !item.queued && !item.blocked && <p className="video-failure">{item.failure}</p>}
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
                        ) : item.failure ? (
                          <span className="video-failed-actions">
                            <span className="datagrid-muted video-blocked">
                              <AlertTriangle size={14} aria-hidden="true" />
                              {t("controlAdmin:videoStreaming.failed")}
                            </span>
                            <Button
                              variant="text"
                              compact
                              disabled={queueing}
                              onClick={() => { setActionError(""); setTarget(item); }}
                            >
                              {t("controlAdmin:videoStreaming.tryAgain")}
                            </Button>
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
          )}

          <Pager
            page={data.page}
            totalPages={data.totalPages}
            onChange={setPage}
            label={t("controlAdmin:videoStreaming.pagerLabel")}
          />
        </>
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

      {optimiseAllOpen && summary && (
        <ConfirmDialog
          title={t("controlAdmin:videoStreaming.confirmAllTitle", { count: ready })}
          confirmLabel={t("controlAdmin:videoStreaming.confirmAll", { count: ready })}
          busy={queueing}
          onCancel={() => setOptimiseAllOpen(false)}
          onConfirm={() => void optimise("all")}
        >
          <p>{t("controlAdmin:videoStreaming.confirmAllBody", { size: formatBytes(summary.readyBytes) })}</p>
          <p>{t("controlAdmin:videoStreaming.confirmKept")}</p>
          {summary.unable > 0 && <p>{t("controlAdmin:videoStreaming.confirmAllSkips", { count: summary.unable })}</p>}
        </ConfirmDialog>
      )}
    </>
  );
}
