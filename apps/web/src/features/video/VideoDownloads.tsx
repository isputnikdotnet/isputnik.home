import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, Download, HardDrive, Loader, RotateCcw } from "lucide-react";
import { api } from "../../api";
import { estimateStorage, type StorageEstimate } from "../../offline/downloads";
import { downloadFraction, useVideoDownloads } from "../../offline/useVideoDownloads";
import { estimateVideoBytes, videoDownloads, warmVideoPlayer, type VideoDownloadRequest } from "../../offline/video";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { formatBytes } from "../../shared/utils";
import { VIDEO_API, type VideoKind, type VideoPlayInfo, type VideoQuality } from "./types";

// Download, on a film's page, a season and an episode: keeps it on this device
// to watch with no connection (offline/video.ts). The button says where that
// stands — nothing yet, on its way (the Downloads page has the rest), or here.

/** The quality downloaded last, in this browser: offered first the next time. */
const QUALITY_KEY = "isputnik.video.downloadQuality";
const DOWNLOADS_HREF = "/downloads";

const qualityValue = (quality: VideoQuality) => (quality === null ? "original" : String(quality));

export const videoQualityLabel = (quality: VideoQuality, t: TFunction) =>
  (quality === null ? t("video.quality.original") : t("video.quality.rung", { height: quality }));

function readQuality(): string | null {
  try {
    return window.localStorage.getItem(QUALITY_KEY);
  } catch {
    return null;
  }
}

/** The quality to offer first: the one chosen last, else 720p — a film for the
 *  road rather than the living room — else the smallest there is. */
function firstChoice(allowed: VideoQuality[]): VideoQuality {
  const kept = allowed.find((quality) => qualityValue(quality) === readQuality());
  if (kept !== undefined) return kept;
  if (allowed.includes(720)) return 720;
  const rungs = allowed.filter((quality): quality is 1080 | 720 | 480 => quality !== null);
  return rungs.length > 0 ? Math.min(...rungs) as VideoQuality : allowed[0] ?? null;
}

export interface VideoDownloadTarget {
  /** What the dialog and the button's label call it: the film, or "Season 2". */
  name: string;
  items: VideoDownloadRequest[];
  parent: { kind: VideoKind; id: string };
  posterUrl: string | null;
}

/** `compact`: an icon alone, for an episode's card. `label`: what the button
 *  says instead of Download ("Download season"). */
export function VideoDownloadButton({ target, compact = false, label }: { target: VideoDownloadTarget; compact?: boolean; label?: string }) {
  const { t } = useTranslation();
  const downloads = useVideoDownloads();
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  if (target.items.length === 0) return null;

  const records = target.items.map((item) => downloads.get(item.id) ?? null);
  const active = records.filter((record) => record && record.state !== "complete" && record.state !== "failed");
  const failed = records.some((record) => record?.state === "failed");
  const missing = target.items.filter((_, index) => !records[index] || records[index]!.state === "failed");
  const fraction = records.reduce((sum, record) => sum + (record ? downloadFraction(record) : 0), 0) / records.length;

  if (active.length > 0) {
    const waiting = active.every((record) => record!.state === "paused");
    const text = waiting ? t("video.download.paused") : t("video.download.downloading", { percent: Math.round(fraction * 100) });
    return (
      <a
        className={compact ? "video-download-status is-compact" : "text-button video-download-status"}
        href={DOWNLOADS_HREF}
        onClick={(event) => followRoute(event, DOWNLOADS_HREF)}
        aria-label={compact ? `${target.name}: ${text}` : undefined}
        title={compact ? text : undefined}
      >
        <Loader size={15} aria-hidden="true" className={waiting ? undefined : "video-download-spin"} />
        <span>{compact ? `${Math.round(fraction * 100)}%` : text}</span>
      </a>
    );
  }

  if (missing.length === 0) {
    return (
      <>
        <Button
          variant={compact ? "icon" : "text"}
          className="video-download-done"
          onClick={() => setRemoving(true)}
          aria-label={compact ? t("video.download.doneAria", { name: target.name }) : undefined}
          title={compact ? t("video.download.done") : undefined}
        >
          <Check size={compact ? 16 : 15} aria-hidden="true" />
          {!compact && <span>{t("video.download.done")}</span>}
        </Button>
        {removing && (
          <ConfirmDialog
            title={t("video.download.removeTitle", { name: target.name })}
            confirmLabel={t("video.download.removeConfirm")}
            danger
            onConfirm={() => {
              setRemoving(false);
              for (const item of target.items) void videoDownloads.remove(item.id);
            }}
            onCancel={() => setRemoving(false)}
          >
            {t("video.download.removeBody")}
          </ConfirmDialog>
        )}
      </>
    );
  }

  const text = failed ? t("video.download.retry") : label ?? t("video.download.open");
  return (
    <>
      <Button
        variant={compact ? "icon" : "text"}
        className="video-download-open"
        onClick={() => setAsking(true)}
        aria-label={compact ? t("video.download.openAria", { name: target.name }) : undefined}
        title={compact ? text : undefined}
      >
        {failed ? <RotateCcw size={compact ? 16 : 15} aria-hidden="true" /> : <Download size={compact ? 16 : 15} aria-hidden="true" />}
        {!compact && <span>{text}</span>}
      </Button>
      {asking && <DownloadVideoModal target={{ ...target, items: missing }} onClose={() => setAsking(false)} />}
    </>
  );
}

/** Which quality, how much room it takes, and Download. */
function DownloadVideoModal({ target, onClose }: { target: VideoDownloadTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<VideoPlayInfo | null>(null);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [quality, setQuality] = useState<VideoQuality>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const first = target.items[0];
  const single = target.items.length === 1;

  // The first one says what may be picked here (everything at home, up to the
  // admin's limit away) and, for a single film, how big it is.
  useEffect(() => {
    let live = true;
    api<VideoPlayInfo>(`${VIDEO_API}/play/${encodeURIComponent(first.id)}`)
      .then((payload) => {
        if (!live) return;
        setInfo(payload);
        setQuality(firstChoice(payload.playback.quality?.allowed ?? [null]));
      })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.loadFailed")); });
    void estimateStorage().then((estimate) => { if (live) setStorage(estimate); }, () => undefined);
    return () => { live = false; };
  }, [first.id, t]);

  const allowed = info?.playback.quality?.allowed ?? [null];
  const sizeAt = (choice: VideoQuality): number | null => {
    if (!info) return null;
    if (single) return estimateVideoBytes(info.sizeBytes, info.playback.duration ?? (info.runtimeMinutes ? info.runtimeMinutes * 60 : null), choice);
    // Several: each one's length is known, their files' sizes are not.
    if (choice === null) return null;
    let total = 0;
    for (const item of target.items) {
      const bytes = estimateVideoBytes(null, item.runtimeMinutes ? item.runtimeMinutes * 60 : null, choice);
      if (bytes === null) return null;
      total += bytes;
    }
    return total;
  };
  const free = storage && storage.quota > 0 ? Math.max(0, storage.quota - storage.usage) : null;
  const needed = sizeAt(quality);
  const tooBig = free !== null && needed !== null && needed > free;
  const unplayable = info !== null && (!info.available || info.playback.mode === "none");

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!info || starting) return;
    setStarting(true);
    setError("");
    try {
      try {
        window.localStorage.setItem(QUALITY_KEY, qualityValue(quality));
      } catch {
        // Private window: asked again next time.
      }
      await videoDownloads.enqueue(target.items, { quality, parent: target.parent, posterUrl: target.posterUrl });
      // The player's code, kept for when there is no connection to fetch it over.
      warmVideoPlayer();
      onClose();
    } catch {
      setError(t("video.download.noStorage"));
      setStarting(false);
    }
  };

  return (
    <Modal title={t("video.download.title", { name: target.name })} onClose={onClose} onSubmit={(event) => void start(event)} busy={starting}>
      <p>{single ? t("video.download.intro") : t("video.download.introSeveral", { count: target.items.length })}</p>

      {!info && !error && <p className="muted" role="status">{t("video.download.checking")}</p>}

      {info && !unplayable && (
        <fieldset className="video-download-qualities">
          <legend>{t("video.quality.label")}</legend>
          {allowed.map((choice) => {
            const size = sizeAt(choice);
            return (
              <label key={qualityValue(choice)} className="video-download-quality">
                <input type="radio" name="video-download-quality" checked={quality === choice} onChange={() => setQuality(choice)} />
                <span>
                  <strong>{videoQualityLabel(choice, t)}</strong>
                  <small className="muted">
                    {size !== null ? t("video.download.about", { size: formatBytes(size) }) : choice === null ? t("video.download.asItIs") : ""}
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {free !== null && (
        <p className="muted video-download-free">
          <HardDrive size={15} aria-hidden="true" />
          <span>{t("video.download.free", { size: formatBytes(free) })}</span>
        </p>
      )}

      {info && !unplayable && <p className="muted">{t("video.download.keepOpen")}</p>}

      {unplayable && <MessageBox tone="info" title={t("video.download.failedTitle")}>{t("video.download.problem.format")}</MessageBox>}
      {tooBig && <MessageBox tone="warning" title={t("video.download.tooBigTitle")}>{t("video.download.tooBig", { size: formatBytes(needed) })}</MessageBox>}
      {error && <MessageBox tone="error" title={t("video.download.failedTitle")}>{error}</MessageBox>}

      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={starting}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={!info || unplayable || tooBig || starting}>
          <Download size={16} aria-hidden="true" />
          <span>{t("video.download.open")}</span>
        </Button>
      </div>
    </Modal>
  );
}
