import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, SkipForward } from "lucide-react";
import { api, csrfToken } from "../../api";
import { followBack, followRoute, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { VIDEO_API, episodeCodeValues, formatPlayTime, videoHref, watchHref, type VideoPlayInfo } from "./types";
import "../../styles/video.css";

type HlsInstance = import("hls.js").default;

/** How often a playing film tells the engine where it is. */
const SAVE_EVERY_S = 15;
/** How long the end card waits before the next episode starts by itself. */
const NEXT_IN_S = 10;

/** A request that outlives the page (keepalive), with the CSRF token api() would add. */
function sendOnLeaving(url: string, method: "PUT" | "DELETE", body?: string): void {
  const headers: Record<string, string> = body ? { "content-type": "application/json" } : {};
  const token = csrfToken();
  if (token) headers["X-CSRF-Token"] = token;
  void fetch(url, { method, body, headers, keepalive: true, credentials: "same-origin" }).catch(() => undefined);
}

// The player (docs/apps-platform-plan.md → V2): the browser's own <video>. A
// file the browser plays as it is streams with byte ranges through the gateway;
// anything else comes as HLS the engine cuts as it goes — the sound converted
// to AAC, the picture too when it must be — played by hls.js (Safari plays HLS
// itself). Where the person got is saved as it plays and on the way out, and
// the next episode follows the end.
export function VideoPlayerPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<VideoPlayInfo | null>(null);
  const [error, setError] = useState("");
  const [cannotPlay, setCannotPlay] = useState(false);
  const [resumedAt, setResumedAt] = useState(0);
  const [nextIn, setNextIn] = useState<number | null>(null);
  const [preparing, setPreparing] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const lastSaved = useRef(0);

  useEffect(() => {
    let live = true;
    setInfo(null);
    setError("");
    setCannotPlay(false);
    setResumedAt(0);
    setNextIn(null);
    setPreparing(false);
    lastSaved.current = 0;
    api<VideoPlayInfo>(`${VIDEO_API}/play/${encodeURIComponent(id)}`)
      .then((payload) => { if (live) setInfo(payload); })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.loadFailed")); });
    return () => { live = false; };
  }, [id, t]);

  /** Where the player is, to the engine. `leaving` survives the page closing. */
  const save = useCallback((options: { watched?: boolean; leaving?: boolean } = {}) => {
    const element = video.current;
    if (!info || !element || !Number.isFinite(element.currentTime)) return;
    const duration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null;
    // Nothing played yet: nothing to remember.
    if (element.currentTime === 0 && options.watched === undefined) return;
    lastSaved.current = element.currentTime;
    const body = JSON.stringify({ position: element.currentTime, duration, ...(options.watched === undefined ? {} : { watched: options.watched }) });
    const url = `${VIDEO_API}/progress/${encodeURIComponent(info.id)}`;
    if (options.leaving) {
      sendOnLeaving(url, "PUT", body);
      return;
    }
    void api(url, { method: "PUT", body }).catch(() => undefined);
  }, [info]);

  // On the way out — another page, a closed tab, the phone locked.
  useEffect(() => {
    const leave = () => save({ leaving: true });
    // Once per hiding: some hosts repeat the event while the page stays hidden.
    let wasHidden = document.visibilityState === "hidden";
    const hidden = () => {
      const now = document.visibilityState === "hidden";
      if (now && !wasHidden) leave();
      wasHidden = now;
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      leave();
    };
  }, [save]);

  const playback = info?.available ? info.playback : null;
  const isHls = playback?.mode === "remux" || playback?.mode === "transcode";

  // HLS: hls.js where the browser has Media Source (every desktop browser, iOS
  // 17.1+), else the browser's own HLS (older iPhones). The engine stops
  // converting once the player goes.
  useEffect(() => {
    const element = video.current;
    if (!info || !element || !isHls || !playback?.url) return;
    const url = playback.url;
    let live = true;
    let hls: HlsInstance | null = null;
    setPreparing(true);
    void import("hls.js").then(({ default: Hls }) => {
      if (!live) return;
      if (!Hls.isSupported()) {
        if (element.canPlayType("application/vnd.apple.mpegurl")) element.src = url;
        else setCannotPlay(true);
        return;
      }
      const player = new Hls({
        startPosition: info.resumeAt > 0 ? info.resumeAt : -1,
        // The first play of a film reads all its keyframes before the playlist
        // exists, and a re-encode's first segment takes a while.
        manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 180_000, maxLoadTimeMs: 180_000, timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 } } },
        fragLoadPolicy: { default: { maxTimeToFirstByteMs: 60_000, maxLoadTimeMs: 120_000, timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } },
        maxBufferLength: 60
      });
      hls = player;
      player.on(Hls.Events.MANIFEST_PARSED, () => setPreparing(false));
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          player.recoverMediaError();
          return;
        }
        setPreparing(false);
        setCannotPlay(true);
      });
      player.loadSource(url);
      player.attachMedia(element);
    }, () => { if (live) setCannotPlay(true); });
    return () => {
      live = false;
      hls?.destroy();
      sendOnLeaving(`${VIDEO_API}/hls/${encodeURIComponent(info.id)}`, "DELETE");
    };
  }, [info, isHls, playback?.url]);

  // The end card counts down to the next episode.
  useEffect(() => {
    if (nextIn === null || !info?.next) return;
    if (nextIn <= 0) {
      navigate(watchHref(info.next.id));
      return;
    }
    const timer = window.setTimeout(() => setNextIn((value) => (value === null ? null : value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [nextIn, info]);

  const back = info ? (info.show ? videoHref("shows", info.show.id) : videoHref("movies", info.id)) : videoHref("shows");
  const code = info && info.season !== null && info.episode !== null ? t("video.episodeCode", episodeCodeValues(info.season!, info.episode!)) : null;
  const heading = info ? (info.show ? info.show.title : info.title) : "";
  const subheading = info?.show ? [code, info.title].filter(Boolean).join(" · ") : null;
  const unplayable = info ? !info.available || info.playback.mode === "none" || cannotPlay : false;

  return (
    <main className="video-player-page">
      <header className="video-player-bar">
        <a className="video-player-back" href={back} onClick={(event) => followBack(event, back)}>
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{info?.show ? info.show.title : t("video.movies")}</span>
        </a>
        {info && (
          <div className="video-player-heading">
            <h1>{heading}</h1>
            {subheading && <p>{subheading}</p>}
          </div>
        )}
      </header>

      {error && <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>}

      {info && unplayable && (
        <div className="video-player-message">
          <MessageBox tone="info" title={t("video.cantPlayTitle")}>
            {!info.available ? t("video.fileMissing") : info.playback.mode === "none" ? t("video.cantPlayFormat") : t("video.cantPlayBrowser")}
          </MessageBox>
        </div>
      )}

      {info && playback && playback.mode !== "none" && (
        <div className={`video-player-stage${cannotPlay ? " is-hidden" : ""}`}>
          <video
            ref={video}
            className="video-player"
            src={isHls ? undefined : playback.url ?? undefined}
            controls
            autoPlay
            playsInline
            preload="metadata"
            aria-label={subheading ? `${heading} · ${subheading}` : heading}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              // Resume, unless it was nearly over: then from the start.
              if (info.resumeAt > 0 && (!Number.isFinite(element.duration) || info.resumeAt < element.duration - 10)) {
                element.currentTime = info.resumeAt;
                setResumedAt(info.resumeAt);
              }
            }}
            onTimeUpdate={(event) => {
              if (Math.abs(event.currentTarget.currentTime - lastSaved.current) >= SAVE_EVERY_S) save();
            }}
            onPause={(event) => { if (!event.currentTarget.ended) save(); }}
            onSeeked={() => save()}
            onEnded={() => {
              save({ watched: true });
              if (info.next) setNextIn(NEXT_IN_S);
            }}
            onPlay={() => setNextIn(null)}
            onError={() => setCannotPlay(true)}
          />

          {preparing && !cannotPlay && (
            <div className="video-player-preparing" role="status">{t("video.preparing")}</div>
          )}

          {resumedAt > 0 && (
            <div className="video-player-resumed" role="status">
              <span>{t("video.resumedAt", { time: formatPlayTime(resumedAt) })}</span>
              <Button
                variant="text"
                onClick={() => {
                  if (video.current) video.current.currentTime = 0;
                  setResumedAt(0);
                }}
              >
                {t("video.startOver")}
              </Button>
            </div>
          )}

          {info.next && nextIn !== null && (
            <div className="video-player-next" role="status">
              <span>{t("video.nextIn", { count: nextIn })}</span>
              <strong>
                {t("video.episodeCode", episodeCodeValues(info.next.season!, info.next.episode!))}
                {info.next.title ? ` · ${info.next.title}` : ""}
              </strong>
              <div className="video-player-next-actions">
                <Button variant="secondary" onClick={() => setNextIn(null)}>{t("common.cancel")}</Button>
                <Button variant="primary" onClick={() => navigate(watchHref(info.next!.id))}>
                  <SkipForward size={16} aria-hidden="true" />
                  <span>{t("video.playNext")}</span>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {info?.next && nextIn === null && !unplayable && (
        <p className="video-player-after">
          <a href={watchHref(info.next.id)} onClick={(event) => followRoute(event, watchHref(info.next!.id))}>
            {t("video.upNext", { code: t("video.episodeCode", episodeCodeValues(info.next.season!, info.next.episode!)) })}
            {info.next.title ? ` · ${info.next.title}` : ""}
          </a>
        </p>
      )}
    </main>
  );
}
