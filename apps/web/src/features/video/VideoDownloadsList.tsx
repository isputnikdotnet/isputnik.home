import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Film, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { downloadFraction } from "../../offline/useVideoDownloads";
import { videoDownloads } from "../../offline/video";
import { POSTER_PART, type StoredVideoDownload } from "../../offline/video-store";
import { navigate } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { formatBytes } from "../../shared/utils";
import { videoQualityLabel } from "./VideoDownloads";
import { episodeCodeValues, watchHref } from "./types";

// The films and episodes on this device, on the Downloads page: what each is,
// how far along, and Play, Pause, Resume and Remove. It works with no
// connection — everything it shows is kept with the download.

const PROBLEM_KEYS = {
  connection: "video.download.problem.connection",
  busy: "video.download.problem.busy",
  space: "video.download.problem.space",
  gone: "video.download.problem.gone",
  format: "video.download.problem.format"
} as const;

function stateText(record: StoredVideoDownload, t: TFunction): string | null {
  if (record.state === "complete") return null;
  if (record.problem) return t(PROBLEM_KEYS[record.problem]);
  if (record.state === "queued") return t("video.download.queued");
  if (record.state === "paused") return t("video.download.paused");
  return t("video.download.downloading", { percent: Math.round(downloadFraction(record) * 100) });
}

/** The poster kept with a download, as an address for an <img>. */
function usePoster(id: string, has: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!has) return;
    let made: string | null = null;
    let live = true;
    void videoDownloads.store?.getPart(id, POSTER_PART).then((blob) => {
      if (!blob || !live) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }, () => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, has]);
  return url;
}

export function VideoDownloadsList({ records }: { records: StoredVideoDownload[] }) {
  return (
    <ul className="video-downloads">
      {records.map((record) => <VideoDownloadRow key={record.id} record={record} />)}
    </ul>
  );
}

function VideoDownloadRow({ record }: { record: StoredVideoDownload }) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  // Fetched once the download has started, so asked for again then.
  const poster = usePoster(record.id, record.kind !== null);
  const complete = record.state === "complete";
  const code = record.season !== null && record.episode !== null ? t("video.episodeCode", episodeCodeValues(record.season, record.episode)) : null;
  const heading = record.showTitle ?? record.title;
  const size = record.totalBytes ?? (complete ? record.downloadedBytes : null);
  const meta = [
    record.showTitle ? [code, record.title].filter(Boolean).join(" · ") : null,
    record.kind !== null || complete ? videoQualityLabel(record.quality, t) : null,
    size !== null ? formatBytes(size) : record.downloadedBytes > 0 ? formatBytes(record.downloadedBytes) : null
  ].filter(Boolean).join(" · ");
  const state = stateText(record, t);
  const name = record.showTitle ? `${record.showTitle} · ${[code, record.title].filter(Boolean).join(" · ")}` : record.title;
  const waiting = record.state === "paused" || record.state === "failed";

  return (
    <li className={`video-download${complete ? "" : " is-pending"}`}>
      <div className="video-download-poster" aria-hidden="true">
        {poster ? <img src={poster} alt="" /> : <Film size={22} />}
      </div>
      <div className="video-download-copy">
        <strong>{heading}</strong>
        {meta && <small className="muted">{meta}</small>}
        {state && <small className={record.state === "failed" ? "video-download-state is-failed" : "video-download-state"}>{state}</small>}
        {!complete && (
          <span className="video-download-track" role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(downloadFraction(record) * 100)}>
            <span style={{ width: `${Math.round(downloadFraction(record) * 100)}%` }} />
          </span>
        )}
      </div>
      <div className="video-download-actions">
        {complete && (
          <Button variant="icon" onClick={() => navigate(watchHref(record.id))} aria-label={t("home.playTitle", { title: name })} title={t("home.play")}>
            <Play size={16} />
          </Button>
        )}
        {(record.state === "queued" || record.state === "downloading") && (
          <Button variant="icon" onClick={() => void videoDownloads.pause(record.id)} aria-label={t("video.download.pauseAria", { name })} title={t("video.download.pause")}>
            <Pause size={16} />
          </Button>
        )}
        {waiting && (
          <Button variant="icon" onClick={() => void videoDownloads.resume(record.id)} aria-label={t("video.download.resumeAria", { name })} title={t("video.download.resume")}>
            <RotateCcw size={16} />
          </Button>
        )}
        <Button variant="icon" danger onClick={() => setRemoving(true)} aria-label={t("video.download.removeAria", { name })} title={t("video.download.removeConfirm")}>
          <Trash2 size={16} />
        </Button>
      </div>
      {removing && (
        <ConfirmDialog
          title={t("video.download.removeTitle", { name })}
          confirmLabel={t("video.download.removeConfirm")}
          danger
          onConfirm={() => {
            setRemoving(false);
            void videoDownloads.remove(record.id);
          }}
          onCancel={() => setRemoving(false)}
        >
          {t("video.download.removeBody")}
        </ConfirmDialog>
      )}
    </li>
  );
}
