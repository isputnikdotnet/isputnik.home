import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, Download, HardDrive, Loader, RotateCcw } from "lucide-react";
import { api } from "../../api";
import { estimateStorage, type StorageEstimate } from "../../offline/downloads";
import { downloadFraction, useVideoDownloads } from "../../offline/useVideoDownloads";
import { askVideoCopy, estimateVideoBytes, videoDownloads, warmVideoPlayer, type VideoCopyAnswer, type VideoDownloadRequest } from "../../offline/video";
import type { StoredVideoDownload } from "../../offline/video-store";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { SelectMenu } from "../../shared/SelectMenu";
import { formatBytes } from "../../shared/utils";
import { VIDEO_API, type VideoKind, type VideoPlayInfo, type VideoQuality } from "./types";

// Download, on a film's page, a season and an episode: keeps it on this device
// to watch with no connection (offline/video.ts). The button says where that
// stands — nothing yet, on its way (the Downloads page has the rest), or here.
//
// Two ways to have it (docs/video-quality-plan.md → Prepared copies): the full
// copy, which is the file as it is and starts at once; or one optimized for the
// device, a smaller picture the server prepares first — which takes a while, and
// needs nobody to wait for it.

type Rung = 1080 | 720 | 480;

/** The optimized quality picked last, in this browser: offered first the next time. */
const QUALITY_KEY = "isputnik.video.downloadQuality";
/** …and whether it was the full copy. */
const FULL_KEY = "isputnik.video.downloadFull";
const DOWNLOADS_HREF = "/downloads";
const NOTICES_API = "/api/video/copy-notices";

export const videoQualityLabel = (quality: VideoQuality, t: TFunction) =>
  (quality === null ? t("video.quality.original") : t("video.quality.rung", { height: quality }));

function readKept(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private window: asked again next time.
  }
}

/** What is in the hand: a phone gets the smallest picture, anything larger held
 *  by touch the middle one; a desk has room for that too. */
export function deviceKind(): "phone" | "tablet" | "computer" {
  const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  if (!touch) return "computer";
  return Math.min(window.screen.width, window.screen.height) < 600 ? "phone" : "tablet";
}

/** The quality suggested for this device, among those allowed: 480p for a phone,
 *  720p for a tablet or a computer; the nearest below when that is not on offer. */
export function suggestedRung(allowed: Rung[], device = deviceKind()): Rung | null {
  const wanted: Rung = device === "phone" ? 480 : 720;
  const fitting = allowed.filter((rung) => rung <= wanted);
  if (fitting.length > 0) return Math.max(...fitting) as Rung;
  return allowed.length > 0 ? (Math.min(...allowed) as Rung) : null;
}

/** "about 6 minutes", "about 1 hour 20 minutes". */
function aboutTime(seconds: number, t: TFunction): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return t("video.download.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  return rest > 0 ? `${t("video.download.hours", { count: hours })} ${t("video.download.minutes", { count: rest })}` : t("video.download.hours", { count: hours });
}

/** What a download still on its way is doing, in a few words. */
export function downloadStateText(record: StoredVideoDownload, t: TFunction): string {
  if (record.state === "queued") return t("video.download.queued");
  if (record.state === "paused") return t("video.download.paused");
  if (record.state === "preparing") {
    const prepare = record.prepare;
    if (!prepare || (prepare.ahead > 0 && prepare.progress === 0)) return t("video.download.preparingQueued");
    if (prepare.paused) return t("video.download.preparingPaused");
    return t("video.download.preparing", { percent: Math.round(prepare.progress * 100) });
  }
  return t("video.download.downloading", { percent: Math.round(downloadFraction(record) * 100) });
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
  const active = records.filter((record): record is StoredVideoDownload => record !== null && record.state !== "complete" && record.state !== "failed");
  const failed = records.some((record) => record?.state === "failed");
  const missing = target.items.filter((_, index) => !records[index] || records[index]!.state === "failed");
  const fraction = records.reduce((sum, record) => sum + (record ? downloadFraction(record) : 0), 0) / records.length;

  if (active.length > 0) {
    const waiting = active.every((record) => record.state === "paused");
    // One thing: say what it is doing. Several: how far the lot has come.
    const fetching = active.some((record) => record.state === "downloading");
    const text = waiting ? t("video.download.paused")
      : active.length === 1 || !fetching ? downloadStateText(active.find((record) => record.state !== "queued") ?? active[0], t)
      : t("video.download.downloading", { percent: Math.round(fraction * 100) });
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

/** Full copy or optimized, at which quality, what it takes — and Download. */
function DownloadVideoModal({ target, onClose }: { target: VideoDownloadTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<VideoPlayInfo | null>(null);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [full, setFull] = useState(() => readKept(FULL_KEY) === "1");
  const [rung, setRung] = useState<Rung | null>(null);
  /** How the optimized copy of the first one stands on the server; null while
   *  unknown, or on an engine that prepares none. */
  const [copy, setCopy] = useState<VideoCopyAnswer | null>(null);
  /** This account can be emailed, on a server that sends email. */
  const [canNotify, setCanNotify] = useState(false);
  const [notify, setNotify] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const first = target.items[0];
  const single = target.items.length === 1;
  const device = deviceKind();

  // The first one says what may be picked here (everything at home, up to the
  // admin's limit away) and, for a single film, how big it is.
  useEffect(() => {
    let live = true;
    api<VideoPlayInfo>(`${VIDEO_API}/play/${encodeURIComponent(first.id)}`)
      .then((payload) => {
        if (!live) return;
        const rungs = (payload.playback.quality?.allowed ?? []).filter((quality): quality is Rung => quality !== null);
        const kept = rungs.find((quality) => String(quality) === readKept(QUALITY_KEY));
        setInfo(payload);
        setRung(kept ?? suggestedRung(rungs, device));
      })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.loadFailed")); });
    void estimateStorage().then((estimate) => { if (live) setStorage(estimate); }, () => undefined);
    api<{ available: boolean }>(NOTICES_API).then((answer) => { if (live) setCanNotify(answer.available); }, () => undefined);
    return () => { live = false; };
  }, [first.id, t, device]);

  // How the copy at this quality stands: ready, or about how long it takes.
  useEffect(() => {
    setCopy(null);
    if (!info || rung === null) return;
    let live = true;
    const audio = info.audioTracks?.find((track) => track.selected)?.index ?? null;
    askVideoCopy(first.id, rung, audio).then((answer) => { if (live) setCopy(answer); }, () => undefined);
    return () => { live = false; };
  }, [first.id, info, rung]);

  const rungs = (info?.playback.quality?.allowed ?? []).filter((quality): quality is Rung => quality !== null);
  const fullAllowed = !info || !info.playback.quality || info.playback.quality.allowed.includes(null);
  const suggested = suggestedRung(rungs, device);
  // Away from home the full copy may not be on offer at all; an old engine offers nothing else.
  const optimized = rungs.length > 0;
  const takeFull = (full && fullAllowed) || !optimized;
  const quality: VideoQuality = takeFull ? null : rung;

  const duration = info ? info.playback.duration ?? (info.runtimeMinutes ? info.runtimeMinutes * 60 : null) : null;
  const sizeAt = (choice: VideoQuality): number | null => {
    if (!info) return null;
    if (single) return estimateVideoBytes(info.sizeBytes, duration, choice);
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
  /** The server makes the copy first, and nobody has to wait for it here. */
  const prepares = !takeFull && copy !== null && (copy.state === "none" || copy.state === "queued" || copy.state === "running" || copy.state === "failed");

  // What choosing Optimized means for this one, in a line.
  const optimizedNote = (): string => {
    if (!info || rung === null) return "";
    if (!single) return t("video.download.optimizedSeveral");
    if (copy === null) return t("video.download.optimizedOpen");
    if (copy.state === "ready") return t("video.download.optimizedReady");
    if (copy.state === "unneeded") return t("video.download.optimizedUnneeded");
    if (copy.state === "queued" || copy.state === "running") return t("video.download.optimizedUnderWay");
    return copy.estimateSeconds ? t("video.download.optimizedPrepare", { time: aboutTime(copy.estimateSeconds, t) }) : t("video.download.optimizedPrepareUnknown");
  };

  const start = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!info || starting) return;
    setStarting(true);
    setError("");
    try {
      keep(FULL_KEY, takeFull ? "1" : "0");
      if (rung !== null && !takeFull) keep(QUALITY_KEY, String(rung));
      await videoDownloads.enqueue(target.items, { quality, parent: target.parent, posterUrl: target.posterUrl });
      // One email for the lot, once the server has them all ready. Not being able to ask is no reason to fail the download.
      if (notify && canNotify && quality !== null) {
        const batch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        void api(NOTICES_API, { method: "POST", body: JSON.stringify({ batch, items: target.items.map((item) => ({ id: item.id, quality, title: item.showTitle ? `${item.showTitle} · ${item.title}` : item.title })) }) }).catch(() => undefined);
      }
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
          <legend className="sr-only">{t("video.download.which")}</legend>
          {optimized && (
            <label className="video-download-quality">
              <input type="radio" name="video-download-kind" checked={!takeFull} onChange={() => setFull(false)} />
              <span>
                <strong>{t("video.download.optimized")}</strong>
                <small className="muted">{optimizedNote()}</small>
                {!takeFull && rung !== null && (
                  <span className="video-download-rung">
                    <SelectMenu
                      label={t("video.quality.label")}
                      value={String(rung)}
                      onChange={(value) => setRung(Number(value) as Rung)}
                      options={rungs.map((choice) => {
                        const size = sizeAt(choice);
                        const name = videoQualityLabel(choice, t);
                        const hint = choice === suggested ? t(`video.download.suggested.${device}`) : null;
                        return { value: String(choice), label: [name, size !== null ? t("video.download.about", { size: formatBytes(size) }) : null, hint].filter(Boolean).join(" · ") };
                      })}
                    />
                  </span>
                )}
              </span>
            </label>
          )}
          {fullAllowed && (
            <label className="video-download-quality">
              <input type="radio" name="video-download-kind" checked={takeFull} onChange={() => setFull(true)} />
              <span>
                <strong>{t("video.download.full")}</strong>
                <small className="muted">
                  {[t("video.download.fullNote"), sizeAt(null) !== null ? formatBytes(sizeAt(null)!) : null].filter(Boolean).join(" · ")}
                </small>
              </span>
            </label>
          )}
        </fieldset>
      )}

      {info && !unplayable && prepares && (
        <MessageBox tone="info" title={t("video.download.prepareTitle")}>
          {t("video.download.prepareBody")}
          {canNotify && (
            <label className="video-download-notify">
              <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
              <span>{t("video.download.notify")}</span>
            </label>
          )}
        </MessageBox>
      )}

      {/* An engine that prepares no copies converts while the app waits. */}
      {info && !unplayable && !takeFull && rung !== null && copy === null && info.playback.mode !== "direct" && (
        <p className="muted">{t("video.download.keepOpen")}</p>
      )}

      {free !== null && (
        <p className="muted video-download-free">
          <HardDrive size={15} aria-hidden="true" />
          <span>{t("video.download.free", { size: formatBytes(free) })}</span>
        </p>
      )}

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
