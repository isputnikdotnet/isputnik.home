import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronLeft, Flag, Info, RotateCcw, SkipForward, X } from "lucide-react";
import { api, csrfToken } from "../../api";
import { useSession } from "../../app/SessionContext";
import { followBack, navigate } from "../../router";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { formatBytes } from "../../shared/utils";
import { VideoMarksPanel } from "./VideoMarksPanel";
import { VideoPlayerControls } from "./VideoPlayerControls";
import type { PlayerMenuAction, PlayerMenuSection } from "./VideoPlayerMenu";
import { VIDEO_API, VIDEO_OVERVIEW_HREF, episodeCodeValues, formatPlayTime, videoHref, watchHref, type VideoAudioTrack, type VideoPlayInfo, type VideoQuality, type VideoQualityChoice, type VideoSubtitleTrack } from "./types";
import "../../styles/video.css";

type HlsInstance = import("hls.js").default;

/** How often a playing film tells the engine where it is. */
const SAVE_EVERY_S = 15;
/** How long the end card waits before the next episode starts by itself. */
const NEXT_IN_S = 10;
/** How long the controls stay over a playing film once the pointer and keys rest. */
const IDLE_MS = 3000;
/** How long "Resumed at" stays up. */
const RESUMED_FOR_MS = 8000;

const MODE_KEYS = {
  direct: "video.player.info.direct",
  remux: "video.player.info.remux",
  transcode: "video.player.info.transcode"
} as const;
const REASON_KEYS = {
  container: "video.player.info.reasonContainer",
  audio: "video.player.info.reasonAudio",
  video: "video.player.info.reasonVideo",
  subtitles: "video.player.info.reasonSubtitles",
  size: "video.player.info.reasonSize"
} as const;

/** The sound language last chosen, in this browser: the next episode (or film)
 *  starts in it when it has it — a dub watched once is the dub wanted. */
const AUDIO_LANGUAGE_KEY = "isputnik.video.audioLanguage";
/** …and the subtitles: a language, or "off" once they were turned off. */
const SUBTITLE_LANGUAGE_KEY = "isputnik.video.subtitleLanguage";
const SUBTITLES_OFF = "off";
/** …and the picture's quality: one choice at home and one away, since the reasons
 *  differ (docs/video-quality-plan.md). "original", or a rung's height. */
const qualityKey = (network: VideoQualityChoice["network"]) => `isputnik.video.quality.${network === "internet" ? "away" : "home"}`;
const QUALITY_ORIGINAL = "original";

/** A quality from its menu value or stored preference; undefined for anything else. */
function qualityOf(value: string | null): VideoQuality | undefined {
  if (value === QUALITY_ORIGINAL) return null;
  const height = Number(value);
  return height === 1080 || height === 720 || height === 480 ? height : undefined;
}

const qualityValue = (quality: VideoQuality) => (quality === null ? QUALITY_ORIGINAL : String(quality));

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string | null): void {
  try {
    if (value) window.localStorage.setItem(key, value);
  } catch {
    // Private window: chosen for this film only.
  }
}

/** A language code ("ru", "rus") in the reader's own words; null for none. */
function languageName(code: string | null, locale: string): string | null {
  if (!code || code === "und") return null;
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return code;
  }
}

/** Whether two codes name one language: files say "rus", file names "ru". */
function sameLanguage(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || languageName(a, "en") === languageName(b, "en");
}

/** "Russian · Дубляж · 5.1": the language in the reader's own words, the
 *  track's title, and its channels. */
export function audioTrackLabel(track: VideoAudioTrack, position: number, t: TFunction, locale: string): string {
  const named = languageName(track.language, locale) ?? t("video.audio.track", { number: position + 1 });
  const channels = track.channels === 1 ? t("video.audio.mono") : track.channels === 2 ? t("video.audio.stereo") : `${track.channels - 1}.1`;
  return [named, track.title, channels].filter(Boolean).join(" · ");
}

/** "English · SDH · Forced". */
export function subtitleTrackLabel(track: VideoSubtitleTrack, position: number, t: TFunction, locale: string): string {
  const named = languageName(track.language, locale) ?? t("video.subtitles.track", { number: position + 1 });
  return [named, track.title, track.forced ? t("video.subtitles.forced") : null].filter(Boolean).join(" · ");
}

/** The subtitles to start with: in the language chosen last time (full ones
 *  before forced, text before image), none once they were turned off, else the
 *  track the file marks as default. */
export function pickSubtitle(tracks: VideoSubtitleTrack[], preference: string | null): VideoSubtitleTrack | null {
  if (preference === SUBTITLES_OFF) return null;
  const rank = (track: VideoSubtitleTrack) => (track.forced ? 2 : 0) + (track.kind === "image" ? 1 : 0);
  if (preference) {
    const matching = tracks.filter((track) => sameLanguage(track.language, preference)).sort((a, b) => rank(a) - rank(b));
    if (matching.length > 0) return matching[0];
  }
  return tracks.find((track) => track.default && !track.forced) ?? null;
}

/** ?audio=…&subtitle=…: the sound track and the image subtitle burned in. */
/** What comes next, for the end card: "S01E03 · Title" for an episode, the
 *  film's own title after a film of a set. */
function nextName(t: TFunction, next: NonNullable<VideoPlayInfo["next"]>): string {
  if (next.season === null || next.episode === null) return next.title ?? "";
  const code = t("video.episodeCode", episodeCodeValues(next.season, next.episode));
  return next.title ? `${code} · ${next.title}` : code;
}

function playQuery(audio: number | null | undefined, burn: string | null | undefined, quality?: VideoQuality): string {
  const params = new URLSearchParams();
  if (audio !== null && audio !== undefined) params.set("audio", String(audio));
  if (burn) params.set("subtitle", burn);
  if (quality !== undefined) params.set("quality", qualityValue(quality));
  const query = params.toString();
  return query ? `?${query}` : "";
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
// the next episode follows the end — or the start of the credits, where the file
// says where they are; its intro, likewise, offers Skip intro.
//
// Nothing is on screen but the film while it plays: the title over the top and
// the controls over the bottom (VideoPlayerControls — the page's own, not the
// browser's) fade in with the pointer or a key and out again after IDLE_MS; they
// stay while it is paused.
//
// Full screen is this page's, not the <video>'s: a video element in full screen
// hides everything drawn over it (Skip intro, the end card), and a new episode
// would drop out of it. Where the browser can't (iPhones), its own stays.
export function VideoPlayerPage({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const { user } = useSession();
  const [info, setInfo] = useState<VideoPlayInfo | null>(null);
  /** Admins: the panel for marking the intro and credits is open. */
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState("");
  const [cannotPlay, setCannotPlay] = useState(false);
  const [resumedAt, setResumedAt] = useState(0);
  const [nextIn, setNextIn] = useState<number | null>(null);
  const [preparing, setPreparing] = useState(false);
  /** The recap or intro playing now, which Skip passes over. */
  const [skipping, setSkipping] = useState<"recap" | "intro" | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** The subtitle shown: a track id, or "off". */
  const [subtitle, setSubtitle] = useState<string>(SUBTITLES_OFF);
  /** Bumped by "Try again" when every place to watch converted video was taken. */
  const [attempt, setAttempt] = useState(0);
  /** Nothing playing: the controls stay up. */
  const [paused, setPaused] = useState(true);
  /** The pointer or a key moved within IDLE_MS. */
  const [awake, setAwake] = useState(true);
  /** Playing, but waiting for more of the film to arrive. */
  const [waiting, setWaiting] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  /** The same element as state, for what must follow a change of it. */
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const attach = useCallback((mounted: HTMLVideoElement | null) => {
    video.current = mounted;
    setElement(mounted);
    if (mounted) setPaused(mounted.paused);
    setWaiting(false);
  }, []);
  const idleTimer = useRef<number | undefined>(undefined);
  /** A touch that only brought the controls up: its click is not a pause. */
  const tapWoke = useRef(false);
  const page = useRef<HTMLElement | null>(null);
  /** The credits have brought the end card up, and aren't to again until seeked back from. */
  const creditsOffered = useRef(false);
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
    setSubtitle(SUBTITLES_OFF);
    setSkipping(null);
    creditsOffered.current = false;
    lastSaved.current = 0;
    const playUrl = `${VIDEO_API}/play/${encodeURIComponent(id)}`;
    api<VideoPlayInfo>(playUrl)
      .then(async (payload) => {
        // In the languages chosen last time, when this one has them; an image
        // subtitle is burned in, so the engine is asked again for it.
        const language = readPreference(AUDIO_LANGUAGE_KEY);
        const wanted = language ? (payload.audioTracks ?? []).find((track) => track.language === language) : undefined;
        const shown = pickSubtitle(payload.subtitleTracks ?? [], readPreference(SUBTITLE_LANGUAGE_KEY));
        const burn = shown?.kind === "image" ? shown.id : null;
        // The quality chosen last here (at home, or away), where the engine allows it.
        const choice = payload.playback.quality;
        const kept = choice ? qualityOf(readPreference(qualityKey(choice.network))) : undefined;
        const quality = choice && kept !== undefined && kept !== choice.current && choice.allowed.includes(kept) ? kept : undefined;
        if ((wanted && !wanted.selected) || burn || quality !== undefined) {
          const audio = wanted?.index ?? payload.audioTracks?.find((track) => track.selected)?.index;
          payload = await api<VideoPlayInfo>(`${playUrl}${playQuery(audio, burn, quality)}`).catch(() => payload);
        }
        if (!live) return;
        startAt.current = payload.resumeAt;
        switched.current = false;
        setSubtitle(shown && (shown.kind === "text" || payload.subtitleTracks?.some((track) => track.id === shown.id && track.burned)) ? shown.id : SUBTITLES_OFF);
        setInfo(payload);
      })
      .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : t("video.loadFailed")); });
    return () => { live = false; };
  }, [id, t, attempt]);

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
  const busy = playback?.busy ?? null;
  const audioTracks = info?.audioTracks ?? [];
  const subtitleTracks = info?.subtitleTracks ?? [];
  const selectedAudio = audioTracks.find((track) => track.selected)?.index;
  const burnedId = subtitleTracks.find((track) => track.burned)?.id ?? null;

  /** The film again from the engine, with this sound and image subtitle, from
   *  where it is now. */
  const replay = async (audio: number | null | undefined, burn: string | null, quality: VideoQuality | undefined = info?.playback.quality?.current): Promise<boolean> => {
    if (!info) return false;
    const at = video.current?.currentTime ?? startAt.current;
    try {
      const payload = await api<VideoPlayInfo>(`${VIDEO_API}/play/${encodeURIComponent(info.id)}${playQuery(audio, burn, quality)}`);
      startAt.current = at;
      switched.current = true;
      setResumedAt(0);
      setInfo((current) => (current && current.id === payload.id
        ? { ...current, playback: payload.playback, audioTracks: payload.audioTracks, subtitleTracks: payload.subtitleTracks }
        : current));
      return true;
    } catch {
      // The engine didn't answer: what plays now goes on.
      return false;
    }
  };

  /** Another sound track: the engine converts that one instead, from where the film is. */
  const chooseAudio = async (value: string) => {
    const track = audioTracks.find((candidate) => String(candidate.index) === value);
    if (!track || track.selected) return;
    writePreference(AUDIO_LANGUAGE_KEY, track.language);
    await replay(track.index, burnedId);
  };

  /** Text subtitles the browser shows at once; an image one, or leaving one,
   *  has the engine draw the picture again. */
  const chooseSubtitle = async (value: string) => {
    const track = subtitleTracks.find((candidate) => candidate.id === value) ?? null;
    writePreference(SUBTITLE_LANGUAGE_KEY, track ? track.language : SUBTITLES_OFF);
    const burn = track?.kind === "image" ? track.id : null;
    if (burn !== burnedId && !(await replay(selectedAudio, burn))) return;
    setSubtitle(track ? track.id : SUBTITLES_OFF);
  };

  // The picture's quality: what plays and what may be picked (engine 0.31+); the
  // menu is there once there is a choice — always at home, away only under a
  // cap that leaves more than one rung.
  const qualityChoice = info?.playback.quality;
  const qualityOptions = qualityChoice && qualityChoice.allowed.length > 1 ? qualityChoice.allowed : [];

  /** A smaller picture, or the full one: the engine makes that instead, from where the film is. */
  const chooseQuality = async (value: string) => {
    const quality = qualityOf(value);
    if (quality === undefined || !qualityChoice || quality === qualityChoice.current) return;
    writePreference(qualityKey(qualityChoice.network), value);
    await replay(selectedAudio, burnedId, quality);
  };

  // The text track chosen is shown, the rest hidden. The browser adds a <track>
  // as disabled, and only loads its file once it is shown.
  const textIds = subtitleTracks.filter((track) => track.kind === "text").map((track) => track.id).join(" ");
  useEffect(() => {
    const list = video.current?.textTracks;
    // jsdom's is a bare stand-in.
    if (!list || typeof list.addEventListener !== "function") return;
    const ours = new Set(textIds.split(" "));
    const apply = () => {
      for (const track of Array.from(list)) {
        if (ours.has(track.id)) track.mode = track.id === subtitle ? "showing" : "disabled";
      }
    };
    apply();
    list.addEventListener("addtrack", apply);
    return () => list.removeEventListener("addtrack", apply);
  }, [subtitle, textIds, info?.playback.url]);

  // HLS: hls.js where the browser has Media Source (every desktop browser, iOS
  // 17.1+), else the browser's own HLS (older iPhones). The engine stops
  // converting once the player goes.
  useEffect(() => {
    const element = video.current;
    if (!info || !element || !isHls || !playback?.url || busy) return;
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
        // Turned away because every place to convert was taken meanwhile? The
        // engine says so on a fresh look; anything else this browser can't play.
        const audio = info.audioTracks?.find((track) => track.selected)?.index;
        const burn = info.subtitleTracks?.find((track) => track.burned)?.id;
        api<VideoPlayInfo>(`${VIDEO_API}/play/${encodeURIComponent(info.id)}${playQuery(audio, burn, info.playback.quality?.current)}`).then(
          (payload) => {
            if (!live) return;
            if (payload.playback.busy) setInfo((current) => (current && current.id === payload.id ? { ...current, playback: payload.playback } : current));
            else setCannotPlay(true);
          },
          () => { if (live) setCannotPlay(true); }
        );
      });
      player.loadSource(url);
      player.attachMedia(element);
    }, () => { if (live) setCannotPlay(true); });
    return () => {
      live = false;
      hls?.destroy();
    };
  }, [info, isHls, playback?.url, busy]);

  // Leaving the film stops the engine converting it (a change of sound track
  // replaces the conversion on the engine by itself): another page or a closed
  // tab. After the effect above, so hls.js has hung up before the engine hears.
  const convertingId = info && isHls && !busy ? info.id : null;
  useEffect(() => {
    if (!convertingId) return;
    const stop = () => sendOnLeaving(`${VIDEO_API}/hls/${encodeURIComponent(convertingId)}`, "DELETE");
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [convertingId]);

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

  /** Skip recap or Skip intro while one plays; the end card once the credits start, unless paused there. */
  const followMarkers = (element: HTMLVideoElement) => {
    const at = element.currentTime;
    const recap = info?.markers?.recap;
    const intro = info?.markers?.intro;
    setSkipping(recap && at >= recap.start && at < recap.end ? "recap" : intro && at >= intro.start && at < intro.end ? "intro" : null);
    const credits = info?.markers?.credits;
    if (!credits || !info?.next) return;
    if (at < credits.start) {
      if (creditsOffered.current) {
        creditsOffered.current = false;
        setNextIn(null);
      }
    } else if (!creditsOffered.current && !element.paused) {
      creditsOffered.current = true;
      // The card may move on without the page ever saying where it was.
      save();
      setNextIn(NEXT_IN_S);
    }
  };

  /** Where Skip lands: the end of the recap or intro playing. */
  const skipTo = skipping === null ? null : info?.markers?.[skipping]?.end ?? null;
  const skip = useCallback(() => {
    if (video.current && skipTo !== null) video.current.currentTime = skipTo;
    setSkipping(null);
  }, [skipTo]);

  const canFullscreen = document.fullscreenEnabled === true;
  /** iPhones: no page full screen, only the <video>'s own, with the phone's controls. */
  const ownFullscreen = !canFullscreen && typeof (element as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen === "function";
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenEnabled !== true) {
      (video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
      return;
    }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void page.current?.requestFullscreen().catch(() => undefined);
  }, []);

  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  // The controls come up with the pointer or a key and go again after a few
  // seconds of neither, unless the pointer rests on them or one of their menus is
  // open. Paused, they stay.
  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(idleTimer.current);
    const rest = () => {
      const hovering = window.matchMedia?.("(hover: hover)").matches ? ".video-player-controls:hover, .video-player-top a:hover, " : "";
      if (page.current?.querySelector(`${hovering}.video-player-chrome [aria-expanded="true"]`)) {
        idleTimer.current = window.setTimeout(rest, IDLE_MS);
        return;
      }
      setAwake(false);
    };
    idleTimer.current = window.setTimeout(rest, IDLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  // "Resumed at" has said it after a few seconds; Start over stays under More.
  useEffect(() => {
    if (resumedAt <= 0) return;
    const timer = window.setTimeout(() => setResumedAt(0), RESUMED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [resumedAt]);

  // S skips the recap or intro, F is full screen; by the key's place, so a Russian
  // layout's "ы" counts. The rest of the keyboard is the controls' own.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      wake();
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      if (event.code === "KeyS" && skipping) skip();
      else if (event.code === "KeyF" && canFullscreen) toggleFullscreen();
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [skipping, skip, canFullscreen, toggleFullscreen, wake]);

  const togglePlay = () => {
    const playing = video.current;
    if (!playing) return;
    if (playing.paused) void playing.play()?.catch(() => undefined);
    else playing.pause();
  };

  const startOver = () => {
    if (video.current) video.current.currentTime = 0;
    setResumedAt(0);
  };

  const locale = i18n.resolvedLanguage ?? "en";
  const back = info ? (info.show ? videoHref("shows", info.show.id) : videoHref("movies", info.id)) : VIDEO_OVERVIEW_HREF;
  const code = info && info.season !== null && info.episode !== null ? t("video.episodeCode", episodeCodeValues(info.season!, info.episode!)) : null;
  const heading = info ? (info.show ? info.show.title : info.title) : "";
  const subheading = info?.show ? [code, info.title].filter(Boolean).join(" · ") : null;
  const unplayable = info ? !info.available || info.playback.mode === "none" || cannotPlay : false;
  const staged = Boolean(info && playback && playback.mode !== "none" && !busy && !cannotPlay);
  const chromeShown = !staged || paused || awake || marking;

  const qualityLabel = (quality: VideoQuality) => (quality === null ? t("video.quality.original") : t("video.quality.rung", { height: quality }));
  const playingAudio = audioTracks.find((track) => track.selected) ?? audioTracks[0];
  const shownSubtitle = subtitleTracks.find((track) => track.id === subtitle);

  // Settings: the picture's quality and the sound track, each where there is a
  // choice; the controls add Speed.
  const settings: PlayerMenuSection[] = [
    ...(qualityChoice && qualityOptions.length > 0
      ? [{
          id: "quality",
          label: t("video.quality.label"),
          value: qualityValue(qualityChoice.current),
          options: qualityOptions.map((quality) => ({ value: qualityValue(quality), label: qualityLabel(quality) })),
          onChange: (value: string) => void chooseQuality(value)
        }]
      : []),
    ...(audioTracks.length > 1
      ? [{
          id: "audio",
          label: t("video.audio.label"),
          value: String(playingAudio.index),
          options: audioTracks.map((track, position) => ({ value: String(track.index), label: audioTrackLabel(track, position, t, locale) })),
          onChange: (value: string) => void chooseAudio(value)
        }]
      : [])
  ];
  const subtitleSection: PlayerMenuSection | null = subtitleTracks.length > 0
    ? {
        id: "subtitles",
        label: t("video.subtitles.label"),
        value: subtitle,
        options: [
          { value: SUBTITLES_OFF, label: t("video.subtitles.off") },
          ...subtitleTracks.map((track, position) => ({ value: track.id, label: subtitleTrackLabel(track, position, t, locale) }))
        ],
        onChange: (value) => void chooseSubtitle(value)
      }
    : null;
  const more: PlayerMenuAction[] = [
    { id: "startOver", label: t("video.startOver"), icon: <RotateCcw size={16} />, onSelect: startOver },
    ...(user.role === "admin" && info?.available
      ? [{
          id: "marks",
          label: t("video.marks.open"),
          icon: <Flag size={16} />,
          onSelect: () => {
            // The panel sits under the picture, which full screen has no room for.
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
            setMarking((value) => !value);
          }
        }]
      : []),
    { id: "info", label: t("video.player.info.open"), icon: <Info size={16} />, onSelect: () => setShowInfo((value) => !value) }
  ];

  const nextLabel = info?.next
    ? info.next.season === null || info.next.episode === null
      ? t("video.set.upNext", { title: info.next.title ?? "" })
      : `${t("video.upNext", { code: t("video.episodeCode", episodeCodeValues(info.next.season, info.next.episode)) })}${info.next.title ? ` · ${info.next.title}` : ""}`
    : null;

  return (
    <main
      ref={page}
      className={`video-player-page${fullscreen ? " is-fullscreen" : ""}${chromeShown ? "" : " is-idle"}`}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <div className="video-player-frame">
        <header className={`video-player-top video-player-chrome${chromeShown ? "" : " is-hidden"}`}>
          <a className="video-player-back" href={back} aria-label={t("video.back")} title={t("video.back")} onClick={(event) => followBack(event, back)}>
            <ChevronLeft size={34} strokeWidth={1.75} aria-hidden="true" />
          </a>
          {info && (
            <div className="video-player-heading">
              <h1>{heading}</h1>
              {subheading && <p>{subheading}</p>}
            </div>
          )}
        </header>

        {error && (
          <div className="video-player-message">
            <MessageBox tone="warning" title={t("video.unavailableTitle")}>{error}</MessageBox>
          </div>
        )}

        {info && unplayable && (
          <div className="video-player-message">
            <MessageBox tone="info" title={t("video.cantPlayTitle")}>
              {!info.available ? t("video.fileMissing") : info.playback.mode === "none" ? t("video.cantPlayFormat") : t("video.cantPlayBrowser")}
            </MessageBox>
          </div>
        )}

        {info && busy && (
          <div className="video-player-message">
            <MessageBox
              tone="info"
              title={busy.reason === "person" ? t("video.busyPersonTitle") : t("video.busyTitle")}
              action={<Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>{t("video.busyRetry")}</Button>}
            >
              {busy.reason === "person"
                ? busy.title ? t("video.busyPersonBody", { title: busy.title }) : t("video.busyPersonBodyUnnamed")
                : t("video.busyBody", { count: busy.limit })}
            </MessageBox>
          </div>
        )}

        {info && playback && playback.mode !== "none" && !busy && (
          <div className={`video-player-stage${cannotPlay ? " is-hidden" : ""}`}>
            <video
              // A new element for each address: hls.js letting go of the old one
              // must not take a direct file's src with it.
              key={playback.url ?? ""}
              ref={attach}
              className="video-player"
              src={isHls ? undefined : playback.url ?? undefined}
              autoPlay
              playsInline
              preload="metadata"
              aria-label={subheading ? `${heading} · ${subheading}` : heading}
              onPointerDown={(event) => {
                // A finger on a picture with nothing over it brings the controls up; it doesn't pause.
                tapWoke.current = event.pointerType === "touch" && !chromeShown;
              }}
              onClick={() => {
                if (tapWoke.current) tapWoke.current = false;
                else togglePlay();
              }}
              onDoubleClick={canFullscreen ? toggleFullscreen : undefined}
              onLoadedMetadata={(event) => {
                const loaded = event.currentTarget;
                // Resume, unless it was nearly over: then from the start.
                const at = startAt.current;
                if (at > 0 && (!Number.isFinite(loaded.duration) || at < loaded.duration - 10)) {
                  loaded.currentTime = at;
                  if (!switched.current) setResumedAt(at);
                }
              }}
              onTimeUpdate={(event) => {
                if (Math.abs(event.currentTarget.currentTime - lastSaved.current) >= SAVE_EVERY_S) save();
                followMarkers(event.currentTarget);
              }}
              onPause={(event) => {
                setPaused(true);
                if (event.currentTarget.ended) return;
                save();
                // Stopped in the credits: nothing moves on by itself.
                setNextIn(null);
              }}
              onSeeked={() => save()}
              onEnded={() => {
                save({ watched: true });
                // Already counting from the credits: it goes on, not over.
                if (info.next) setNextIn((value) => value ?? NEXT_IN_S);
              }}
              onPlay={() => {
                setPaused(false);
                setNextIn(null);
                wake();
              }}
              onWaiting={() => setWaiting(true)}
              onPlaying={() => setWaiting(false)}
              onCanPlay={() => setWaiting(false)}
              onError={() => setCannotPlay(true)}
            >
              {subtitleTracks.filter((track) => track.kind === "text" && track.url).map((track, position) => (
                <track
                  key={track.id}
                  id={track.id}
                  kind="subtitles"
                  src={track.url!}
                  srcLang={track.language ?? undefined}
                  label={subtitleTrackLabel(track, position, t, locale)}
                />
              ))}
            </video>

            {preparing && !cannotPlay && (
              <div className="video-player-preparing" role="status">{t("video.preparing")}</div>
            )}
            {waiting && !preparing && !cannotPlay && (
              <div className="video-player-spinner" role="status" aria-label={t("video.player.buffering")} />
            )}

            {resumedAt > 0 && (
              <div className="video-player-resumed" role="status">
                <span>{t("video.resumedAt", { time: formatPlayTime(resumedAt) })}</span>
                <Button variant="text" onClick={startOver}>{t("video.startOver")}</Button>
              </div>
            )}

            {skipping && nextIn === null && (
              <Button variant="secondary" className="video-player-skip" onClick={skip}>
                <SkipForward size={16} aria-hidden="true" />
                <span>{t(skipping === "recap" ? "video.skipRecap" : "video.skipIntro")}</span>
              </Button>
            )}

            {info.next && nextIn !== null && (
              <div className="video-player-next" role="status">
                <span>{info.next.season === null ? t("video.set.nextIn", { count: nextIn }) : t("video.nextIn", { count: nextIn })}</span>
                <strong>{nextName(t, info.next)}</strong>
                <div className="video-player-next-actions">
                  <Button variant="secondary" onClick={() => setNextIn(null)}>{t("common.cancel")}</Button>
                  <Button variant="primary" onClick={() => navigate(watchHref(info.next!.id))}>
                    <SkipForward size={16} aria-hidden="true" />
                    <span>{t("video.playNext")}</span>
                  </Button>
                </div>
              </div>
            )}

            {showInfo && (
              <section className="video-player-info" aria-label={t("video.player.info.open")}>
                <header>
                  <strong>{t("video.player.info.open")}</strong>
                  <Button variant="bare" className="video-player-button is-small" aria-label={t("common.close")} title={t("common.close")} onClick={() => setShowInfo(false)}>
                    <X size={16} aria-hidden="true" />
                  </Button>
                </header>
                <dl>
                  <dt>{t("video.player.info.playback")}</dt>
                  <dd>{t(MODE_KEYS[playback.mode === "remux" || playback.mode === "transcode" ? playback.mode : "direct"])}</dd>
                  {playback.reasons.length > 0 && (
                    <>
                      <dt>{t("video.player.info.why")}</dt>
                      <dd>{playback.reasons.map((reason) => t(REASON_KEYS[reason])).join(", ")}</dd>
                    </>
                  )}
                  {qualityChoice && (
                    <>
                      <dt>{t("video.quality.label")}</dt>
                      <dd>{qualityLabel(qualityChoice.current)}</dd>
                    </>
                  )}
                  {element && element.videoWidth > 0 && (
                    <>
                      <dt>{t("video.player.info.picture")}</dt>
                      <dd>{element.videoWidth} × {element.videoHeight}</dd>
                    </>
                  )}
                  {playingAudio && (
                    <>
                      <dt>{t("video.player.info.sound")}</dt>
                      <dd>{audioTrackLabel(playingAudio, audioTracks.indexOf(playingAudio), t, locale)} · {playingAudio.codec.toUpperCase()}</dd>
                    </>
                  )}
                  {shownSubtitle && (
                    <>
                      <dt>{t("video.player.info.subtitles")}</dt>
                      <dd>{subtitleTrackLabel(shownSubtitle, subtitleTracks.indexOf(shownSubtitle), t, locale)}</dd>
                    </>
                  )}
                  {info.sizeBytes !== null && (
                    <>
                      <dt>{t("video.player.info.size")}</dt>
                      <dd>{formatBytes(info.sizeBytes)}</dd>
                    </>
                  )}
                  {qualityChoice && (
                    <>
                      <dt>{t("video.player.info.network")}</dt>
                      <dd>{t(qualityChoice.network === "internet" ? "video.player.info.networkAway" : "video.player.info.networkHome")}</dd>
                    </>
                  )}
                </dl>
              </section>
            )}

            <div className={`video-player-bottom video-player-chrome${chromeShown ? "" : " is-hidden"}`}>
              <VideoPlayerControls
                videoRef={video}
                element={element}
                fallbackDuration={playback.duration}
                next={info.next && nextLabel ? { href: watchHref(info.next.id), label: nextLabel } : null}
                settings={settings}
                subtitles={subtitleSection}
                more={more}
                fullscreen={canFullscreen || ownFullscreen ? { active: fullscreen, toggle: toggleFullscreen } : null}
              />
            </div>
          </div>
        )}
      </div>

      {marking && info && !unplayable && !busy && (
        <VideoMarksPanel
          key={info.id}
          info={info}
          video={video}
          onSeek={(at) => { if (video.current) video.current.currentTime = at; }}
          onMarkers={(markers) => setInfo((current) => (current && current.id === info.id ? { ...current, markers } : current))}
          onClose={() => setMarking(false)}
        />
      )}
    </main>
  );
}
