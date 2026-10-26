import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, SkipForward } from "lucide-react";
import { api, csrfToken } from "../../api";
import { followBack, followRoute, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { VIDEO_API, episodeCodeValues, formatPlayTime, videoHref, watchHref, type VideoPlayInfo } from "./types";
import "../../styles/video.css";

/** How often a playing film tells the engine where it is. */
const SAVE_EVERY_S = 15;
/** How long the end card waits before the next episode starts by itself. */
const NEXT_IN_S = 10;

// The player (docs/apps-platform-plan.md → V2): the browser's own <video> over
// the engine's file, streamed with byte ranges through the gateway, so seeking
// works and nothing is converted. A file the browser cannot play says so;
// converting on the fly comes later. Where the person got is saved as it plays
// and on the way out, and the next episode follows the end.
export function VideoPlayerPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<VideoPlayInfo | null>(null);
  const [error, setError] = useState("");
  const [cannotPlay, setCannotPlay] = useState(false);
  const [resumedAt, setResumedAt] = useState(0);
  const [nextIn, setNextIn] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const lastSaved = useRef(0);

  useEffect(() => {
    let live = true;
    setInfo(null);
    setError("");
    setCannotPlay(false);
    setResumedAt(0);
    setNextIn(null);
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
      // keepalive lets the request finish after the page has gone.
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = csrfToken();
      if (token) headers["X-CSRF-Token"] = token;
      void fetch(url, { method: "PUT", body, headers, keepalive: true, credentials: "same-origin" }).catch(() => undefined);
      return;
    }
    void api(url, { method: "PUT", body }).catch(() => undefined);
  }, [info]);

  // On the way out — another page, a closed tab, the phone locked.
  useEffect(() => {
    const leave = () => save({ leaving: true });
    const hidden = () => { if (document.visibilityState === "hidden") leave(); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hidden);
      leave();
    };
  }, [save]);

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
  const unplayable = info ? !info.available || info.direct === "no" || cannotPlay : false;

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
            {!info.available ? t("video.fileMissing") : info.direct === "no" ? t("video.cantPlayFormat") : t("video.cantPlayBrowser")}
          </MessageBox>
        </div>
      )}

      {info && info.available && info.direct !== "no" && (
        <div className={`video-player-stage${cannotPlay ? " is-hidden" : ""}`}>
          <video
            ref={video}
            className="video-player"
            src={info.stream}
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
