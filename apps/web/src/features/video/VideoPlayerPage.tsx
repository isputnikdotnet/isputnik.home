import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, AudioLines, SkipForward } from "lucide-react";
import { api, csrfToken } from "../../api";
import { followBack, followRoute, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { SelectMenu } from "../../shared/SelectMenu";
import { VIDEO_API, episodeCodeValues, formatPlayTime, videoHref, watchHref, type VideoAudioTrack, type VideoPlayInfo } from "./types";
import "../../styles/video.css";

type HlsInstance = import("hls.js").default;

/** How often a playing film tells the engine where it is. */
const SAVE_EVERY_S = 15;
/** How long the end card waits before the next episode starts by itself. */
const NEXT_IN_S = 10;

/** The sound language last chosen, in this browser: the next episode (or film)
 *  starts in it when it has it — a dub watched once is the dub wanted. */
const AUDIO_LANGUAGE_KEY = "isputnik.video.audioLanguage";

function preferredLanguage(): string | null {
  try {
    return window.localStorage.getItem(AUDIO_LANGUAGE_KEY);
  } catch {
    return null;
  }
}

function rememberLanguage(language: string | null): void {
  try {
    if (language) window.localStorage.setItem(AUDIO_LANGUAGE_KEY, language);
  } catch {
    // Private window: chosen for this film only.
  }
}

/** "Russian · Дубляж · 5.1": the language in the reader's own words, the
 *  track's title, and its channels. */
export function audioTrackLabel(track: VideoAudioTrack, position: number, t: TFunction, locale: string): string {
  let language: string | null = null;
  if (track.language && track.language !== "und") {
    try {
      language = new Intl.DisplayNames([locale], { type: "language" }).of(track.language) ?? null;
    } catch {
      language = track.language;
    }
  }
  const named = language ? language.charAt(0).toLocaleUpperCase(locale) + language.slice(1) : t("video.audio.track", { number: position + 1 });
  const channels = track.channels === 1 ? t("video.audio.mono") : track.channels === 2 ? t("video.audio.stereo") : `${track.channels - 1}.1`;
  return [named, track.title, channels].filter(Boolean).join(" · ");
}

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
  const { t, i18n } = useTranslation();
  const [info, setInfo] = useState<VideoPlayInfo | null>(null);
  const [error, setError] = useState("");
  const [cannotPlay, setCannotPlay] = useState(false);
  const [resumedAt, setResumedAt] = useState(0);
  const [nextIn, setNextIn] = useState<number | null>(null);
  const [preparing, setPreparing] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const lastSaved = useRef(0);
  /** Where playback starts: the saved place, or where a change of sound track left it. */
  const startAt = useRef(0);
  /** A change of sound track, not the first start: no "Resumed at". */
  const switched = useRef(false);

  useEffect(() => {
    let live = true;
    setInfo(null);
    setError("");
    setCannotPlay(false);
    setResumedAt(0);
    setNextIn(null);
    setPreparing(false);
    lastSaved.current = 0;
    const playUrl = `${VIDEO_API}/play/${encodeURIComponent(id)}`;
    api<VideoPlayInfo>(playUrl)
      .then(async (payload) => {
        // In the language chosen last time, when this one has it.
        const language = preferredLanguage();
        const wanted = language ? (payload.audioTracks ?? []).find((track) => track.language === language) : undefined;
        if (wanted && !wanted.selected) payload = await api<VideoPlayInfo>(`${playUrl}?audio=${wanted.index}`).catch(() => payload);
        if (!live) return;
        startAt.current = payload.resumeAt;
        switched.current = false;
        setInfo(payload);
      })
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
  const audioTracks = info?.audioTracks ?? [];

  /** Another sound track: the engine converts that one instead, from where the film is. */
  const chooseAudio = async (value: string) => {
    if (!info) return;
    const track = audioTracks.find((candidate) => String(candidate.index) === value);
    if (!track || track.selected) return;
    rememberLanguage(track.language);
    startAt.current = video.current?.currentTime ?? startAt.current;
    switched.current = true;
    setResumedAt(0);
    try {
      const payload = await api<VideoPlayInfo>(`${VIDEO_API}/play/${encodeURIComponent(info.id)}?audio=${track.index}`);
      setInfo((current) => (current && current.id === payload.id ? { ...current, playback: payload.playback, audioTracks: payload.audioTracks } : current));
    } catch {
      // The engine didn't answer: the sound playing now goes on.
    }
  };

  // Leaving the film stops the engine converting it (a change of sound track
  // replaces the conversion on the engine by itself).
  const convertingId = info && isHls ? info.id : null;
  useEffect(() => {
    if (!convertingId) return;
    return () => sendOnLeaving(`${VIDEO_API}/hls/${encodeURIComponent(convertingId)}`, "DELETE");
  }, [convertingId]);

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
        startPosition: startAt.current > 0 ? startAt.current : -1,
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
        {audioTracks.length > 1 && (
          <SelectMenu
            className="video-player-audio"
            label={t("video.audio.label")}
            triggerIcon={<AudioLines size={16} aria-hidden="true" />}
            value={String(audioTracks.find((track) => track.selected)?.index ?? audioTracks[0].index)}
            options={audioTracks.map((track, position) => ({ value: String(track.index), label: audioTrackLabel(track, position, t, i18n.resolvedLanguage ?? "en") }))}
            onChange={(value) => void chooseAudio(value)}
          />
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
              const at = startAt.current;
              if (at > 0 && (!Number.isFinite(element.duration) || at < element.duration - 10)) {
                element.currentTime = at;
                if (!switched.current) setResumedAt(at);
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
