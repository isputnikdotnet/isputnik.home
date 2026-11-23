import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, CirclePlay, Clock, Database, Download, FileVideo, Film, ListChecks, Settings, Smartphone, Zap } from "lucide-react";
import { api } from "../../../api";
import { followRoute } from "../../../router";
import { Button } from "../../../shared/Button";
import { formatBytes } from "../../../shared/utils";
import { guideHref } from "../../help/catalog";
import { KEEP_READY_URL, type KeepReadyState } from "../../video/KeepReadyModal";
import { Meter, VideoFlow } from "./VideoSettingsHero";
import type { ConversionState, CopiesState, JobsState } from "./VideoSettingsSection";

// The top of Videos › Video Downloads, in the shape of Video Streaming (owner,
// 2026-11-22): first HOW a download gets to a phone — the original file where that
// is asked for, a copy already kept where there is one, a copy prepared in the
// queue where there is not — then what the queue is doing and what is kept, as one
// row with the next few jobs beside it. The rules are the card under these
// (VideoSettingsSection's JobsCard). Read here; the two lists open from the head.

const GB = 1024 ** 3;
/** The guide on copies made for download. */
const COPIES_HREF = `${guideHref("apps")}#copies-for-download`;

/** Original file, a kept copy, or a copy prepared in the queue: two questions, as a flow. */
export function HowDownloadsWork({ copies }: { copies: CopiesState | null }) {
  const { t } = useTranslation(["controlAdmin"]);
  // No disk for video: nothing is kept or prepared, a smaller copy is converted as it comes down.
  const noDisk = copies?.insideContainer === true;
  return (
    <VideoFlow
      icon={<Download size={22} />}
      title={t("controlAdmin:apps.videoDownloads.flowTitle")}
      body={t("controlAdmin:apps.videoDownloads.flowBody")}
      aria={t("controlAdmin:apps.videoDownloads.flowAria")}
      learnHref={COPIES_HREF}
      source={{ icon: <Film size={26} />, title: t("controlAdmin:apps.videoHero.video"), sub: t("controlAdmin:apps.videoHero.videoSub") }}
      device={{ icon: <Smartphone size={26} />, title: t("controlAdmin:apps.videoDownloads.device"), sub: t("controlAdmin:apps.videoDownloads.deviceSub") }}
      askFirst={{ icon: <FileVideo size={20} />, text: t("controlAdmin:apps.videoDownloads.askOriginal") }}
      askSecond={{ icon: <Database size={20} />, text: t("controlAdmin:apps.videoDownloads.askKept") }}
      direct={{ icon: <ArrowDownToLine size={24} />, title: t("controlAdmin:apps.videoDownloads.original"), sub: t("controlAdmin:apps.videoDownloads.originalSub"), mark: <CirclePlay size={20} /> }}
      cache={{
        icon: <Database size={24} />, title: t("controlAdmin:apps.videoHero.cache"), mark: <Zap size={20} />, off: noDisk,
        sub: noDisk ? t("controlAdmin:apps.videoHero.cacheState.noDisk") : t("controlAdmin:apps.videoDownloads.cacheSub")
      }}
      convert={{
        icon: <Settings size={24} />, mark: <Clock size={20} />,
        title: noDisk ? t("controlAdmin:apps.videoDownloads.live") : t("controlAdmin:apps.videoDownloads.prepare"),
        sub: noDisk ? t("controlAdmin:apps.videoDownloads.liveSub") : t("controlAdmin:apps.videoDownloads.prepareSub")
      }}
    />
  );
}

/** The queue and what is kept, as one row, and the next few jobs beside it. */
export function DownloadsStatusCard({ queue, copies, conversion, streamingHref, onOpenQueue, onOpenKept }: {
  queue: JobsState | null;
  copies: CopiesState | null;
  conversion: ConversionState | null;
  /** Video Streaming's Disk & memory card, where the room is set. */
  streamingHref: string;
  onOpenQueue: () => void;
  onOpenKept: () => void;
}) {
  const { t } = useTranslation(["controlAdmin"]);
  const titleId = useId();
  const nextId = useId();
  // The titles kept ready (engine 0.35+); an older engine answers 404 and the count stays a dash.
  const [keepReady, setKeepReady] = useState<KeepReadyState | null>(null);
  useEffect(() => {
    let live = true;
    api<KeepReadyState>(KEEP_READY_URL).then((answer) => { if (live && Array.isArray(answer?.titles)) setKeepReady(answer); }, () => undefined);
    return () => { live = false; };
  }, []);

  const running = queue?.jobs.filter((job) => job.state === "running").length ?? 0;
  const waiting = queue?.jobs.filter((job) => job.state === "queued").length ?? 0;
  const ready = copies?.copies.filter((copy) => copy.state === "ready").length ?? 0;
  const room = copies && !copies.insideContainer ? copies : null;
  const usedBytes = room ? room.usedBytes + (room.keptBytes ?? 0) : 0;
  const keptReadyBytes = keepReady?.titles.reduce((sum, title) => sum + title.sizeBytes, 0) ?? 0;
  const noDisk = conversion?.disk ? !conversion.disk.mapped : copies?.insideContainer === true;

  return (
    <section className="settings-card video-hw" id="video-copies" aria-labelledby={titleId}>
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true"><ListChecks size={22} /></span>
        <div>
          <h3 id={titleId}>{t("controlAdmin:apps.videoDownloads.statusTitle")}</h3>
          <p>{t("controlAdmin:apps.videoDownloads.statusBody")}</p>
        </div>
        <div className="settings-card-head-actions">
          {queue && <Button variant="secondary" onClick={onOpenQueue}>{t("controlAdmin:apps.videoDownloads.openQueue")}</Button>}
          {copies && <Button variant="secondary" onClick={onOpenKept}>{t("controlAdmin:apps.videoDownloads.openKept")}</Button>}
        </div>
      </header>

      <div className="video-hw-top">
        <div className="video-hw-box is-even">
          <div className="video-hw-item is-metric">
            <span className="video-hw-text">
              <small><ListChecks size={15} aria-hidden="true" />{t("controlAdmin:apps.jobs.queueTitle")}</small>
              <strong>{queue ? t("controlAdmin:apps.videoDownloads.queueCounts", { running, waiting }) : "—"}</strong>
              {queue && (
                <span className={`video-hw-state ${queue.gate.open && running > 0 ? "is-inUse" : queue.gate.open ? "is-none" : "is-setAside"}`}>
                  <i aria-hidden="true" />
                  <b>{!queue.gate.open ? t(`controlAdmin:apps.videoDownloads.gate.${queue.gate.reason}`)
                    : running > 0 ? t("controlAdmin:apps.videoDownloads.working") : t("controlAdmin:apps.videoDownloads.idle")}</b>
                </span>
              )}
            </span>
          </div>
          <div className="video-hw-item is-metric">
            <span className="video-hw-text">
              <small><Download size={15} aria-hidden="true" />{t("controlAdmin:apps.videoDownloads.copies")}</small>
              <strong>{copies ? t("controlAdmin:apps.videoDownloads.copiesReady", { count: ready }) : "—"}</strong>
              {copies && <small>{formatBytes(copies.usedBytes)}</small>}
            </span>
          </div>
          <div className="video-hw-item is-metric">
            <span className="video-hw-text">
              <small><Clock size={15} aria-hidden="true" />{t("controlAdmin:apps.videoDownloads.keptReady")}</small>
              <strong>{keepReady ? t("controlAdmin:apps.videoDownloads.keptReadyTitles", { count: keepReady.titles.length }) : "—"}</strong>
              {keepReady && <small>{formatBytes(keptReadyBytes)}</small>}
            </span>
          </div>
          <div className="video-hw-item is-metric">
            <span className="video-hw-text">
              <small><Database size={15} aria-hidden="true" />{t("controlAdmin:apps.videoDownloads.room")}</small>
              {room ? (
                <>
                  <strong>{t("controlAdmin:apps.videoHero.usedOf", { used: formatBytes(usedBytes), total: `${room.settings.limitGb} GB` })}</strong>
                  <Meter used={usedBytes} total={room.settings.limitGb * GB} label={t("controlAdmin:apps.videoDownloads.room")} />
                </>
              ) : (
                <strong className={noDisk ? "is-warn" : undefined}>{noDisk ? t("controlAdmin:apps.conversion.placeNotSetUp") : "—"}</strong>
              )}
              <small><a className="diag-link" href={streamingHref} onClick={(event) => followRoute(event, streamingHref)}>{t("controlAdmin:apps.videoDownloads.roomSetOn")}</a></small>
            </span>
          </div>
        </div>

        {queue && (
          <section className="video-hw-advice" aria-labelledby={nextId}>
            <h4 id={nextId}><Clock size={17} aria-hidden="true" />{t("controlAdmin:apps.videoDownloads.nextUp")}</h4>
            {queue.jobs.length === 0 ? <p className="muted">{t("controlAdmin:apps.jobs.queueEmpty")}</p> : (
              <ul>
                {queue.jobs.slice(0, 3).map((job) => (
                  <li key={job.id} className={job.state === "running" ? "is-ok" : "is-todo"}>
                    {job.state === "running" ? <Settings size={16} aria-hidden="true" /> : <Clock size={16} aria-hidden="true" />}
                    <span>
                      {job.title}
                      <small>{[
                        job.quality ? t("controlAdmin:apps.conversion.rung", { height: job.quality }) : null,
                        job.state === "running"
                          ? (job.paused ? t("controlAdmin:apps.jobs.paused") : t("controlAdmin:apps.jobs.running", { percent: Math.round(job.progress * 100) }))
                          : t("controlAdmin:apps.jobs.waiting")
                      ].filter(Boolean).join(" · ")}</small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
