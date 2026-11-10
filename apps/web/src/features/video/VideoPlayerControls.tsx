import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Captions, Ellipsis, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, Settings, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { followRoute } from "../../router";
import { Button } from "../../shared/Button";
import { VideoPlayerMenu, type PlayerMenuAction, type PlayerMenuSection } from "./VideoPlayerMenu";
import { formatPlayTime } from "./types";

/** How far the arrows and the two round buttons jump. */
const JUMP_S = 10;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
/** How loud, and whether muted, in this browser: the next film starts the same. */
const VOLUME_KEY = "isputnik.video.volume";
const MUTED_KEY = "isputnik.video.muted";

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private window: for this film only.
  }
}

// The player's own controls (docs/apps-platform-plan.md → V2), drawn over the
// bottom of the picture in place of the browser's: a thin seek line with the time,
// then play, ten seconds either way and the next episode on the left; volume,
// subtitles, settings, more and full screen on the right. The page decides when
// they show; this follows the <video> it is given and drives it, keyboard included
// (Space or K, the arrows, M).
export function VideoPlayerControls({ videoRef, element, fallbackDuration, next, settings, subtitles, more, fullscreen }: {
  /** The <video>, to drive. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The same element: a new one for each address, so what follows it starts again. */
  element: HTMLVideoElement | null;
  /** The engine's length, until the element knows its own. */
  fallbackDuration: number | null;
  next: { href: string; label: string } | null;
  /** Quality and sound, where there is a choice; Speed is added here. */
  settings: PlayerMenuSection[];
  subtitles: PlayerMenuSection | null;
  more: PlayerMenuAction[];
  /** null where only the browser's own full screen exists and it can't be asked for. */
  fullscreen: { active: boolean; toggle: () => void } | null;
}) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(() => {
    const kept = Number(stored(VOLUME_KEY));
    return stored(VOLUME_KEY) !== null && kept >= 0 && kept <= 1 ? kept : 1;
  });
  const [muted, setMuted] = useState(() => stored(MUTED_KEY) === "1");
  const [speed, setSpeed] = useState(1);
  /** Where the seek line is being dragged to, before it is let go. */
  const [scrub, setScrub] = useState<number | null>(null);
  /** The time under the pointer, and where along the line, for the tip. */
  const [hover, setHover] = useState<{ at: number; left: number } | null>(null);
  const seekInput = useRef<HTMLInputElement | null>(null);

  const duration = length > 0 ? length : fallbackDuration ?? 0;

  // What the element says, as it says it.
  useEffect(() => {
    if (!element) return;
    const follow = () => {
      setPaused(element.paused);
      setTime(Number.isFinite(element.currentTime) ? element.currentTime : 0);
      setLength(Number.isFinite(element.duration) ? element.duration : 0);
      const ranges = element.buffered;
      let end = 0;
      for (let index = 0; index < (ranges?.length ?? 0); index += 1) {
        if (ranges.start(index) <= element.currentTime + 1) end = Math.max(end, ranges.end(index));
      }
      setBuffered(end);
    };
    follow();
    const events = ["play", "pause", "timeupdate", "durationchange", "progress", "seeking", "seeked", "loadedmetadata"];
    for (const name of events) element.addEventListener(name, follow);
    return () => {
      for (const name of events) element.removeEventListener(name, follow);
    };
  }, [element]);

  // A new element starts as the last one was left: as loud, as fast.
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.volume = volume;
    videoRef.current.muted = muted;
  }, [videoRef, element, volume, muted]);
  useEffect(() => {
    const apply = () => {
      if (videoRef.current) videoRef.current.playbackRate = speed;
    };
    apply();
    // Loading a source puts the rate back to normal.
    element?.addEventListener("loadedmetadata", apply);
    return () => element?.removeEventListener("loadedmetadata", apply);
  }, [videoRef, element, speed]);

  const togglePlay = useCallback(() => {
    const playing = videoRef.current;
    if (!playing) return;
    if (playing.paused) void playing.play()?.catch(() => undefined);
    else playing.pause();
  }, [videoRef]);

  const seekTo = useCallback((at: number) => {
    const playing = videoRef.current;
    if (!playing) return;
    const end = Number.isFinite(playing.duration) && playing.duration > 0 ? playing.duration : duration;
    playing.currentTime = Math.max(0, end > 0 ? Math.min(at, end) : at);
  }, [videoRef, duration]);

  const jump = useCallback((by: number) => {
    if (videoRef.current) seekTo(videoRef.current.currentTime + by);
  }, [videoRef, seekTo]);

  const loudness = useCallback((value: number) => {
    const next = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    setVolume(next);
    setMuted(next === 0);
    store(VOLUME_KEY, String(next));
    store(MUTED_KEY, next === 0 ? "1" : "0");
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((value) => {
      store(MUTED_KEY, value ? "0" : "1");
      return !value;
    });
    // Unmuting silence would change nothing to the ear.
    setVolume((value) => (value === 0 ? 0.5 : value));
  }, []);

  // Dragging shows where it would land; letting go (the native "change", which
  // React's onChange is not) goes there. A converted film is cut again from every
  // place asked for, so not from each one passed on the way.
  useEffect(() => {
    const input = seekInput.current;
    if (!input) return;
    const commit = () => {
      seekTo(Number(input.value));
      // After React's own handler for the same event, which would set it again.
      queueMicrotask(() => setScrub(null));
    };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, [seekTo]);

  // By the key's place, so another layout's letter counts. Keys pressed in a menu,
  // the marking panel or a field are theirs.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="menu"], [role="tablist"], textarea, select, input:not([type="range"])')) return;
      // The volume line's arrows are its own.
      if (target instanceof HTMLInputElement && target !== seekInput.current && event.code.startsWith("Arrow")) return;
      switch (event.code) {
        case "Space":
          // On a button it presses the button.
          if (event.repeat || target?.closest("button, a")) return;
          togglePlay();
          break;
        case "KeyK":
          if (event.repeat) return;
          togglePlay();
          break;
        case "ArrowLeft":
          jump(-JUMP_S);
          break;
        case "ArrowRight":
          jump(JUMP_S);
          break;
        case "ArrowUp":
          loudness((muted ? 0 : volume) + 0.05);
          break;
        case "ArrowDown":
          loudness((muted ? 0 : volume) - 0.05);
          break;
        case "KeyM":
          if (event.repeat) return;
          toggleMute();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [togglePlay, jump, loudness, toggleMute, muted, volume]);

  const shown = scrub ?? time;
  const percent = (value: number) => `${duration > 0 ? Math.max(0, Math.min(100, (value / duration) * 100)) : 0}%`;
  const heard = muted ? 0 : volume;
  const VolumeIcon = heard === 0 ? VolumeX : heard < 0.5 ? Volume1 : Volume2;

  const speedSection: PlayerMenuSection = {
    id: "speed",
    label: t("video.player.speed"),
    value: String(speed),
    options: SPEEDS.map((rate) => ({ value: String(rate), label: rate === 1 ? t("video.player.speedNormal") : t("video.player.speedRate", { rate }) })),
    onChange: (value) => setSpeed(Number(value))
  };

  return (
    <div className="video-player-controls">
      <div className="video-player-timeline">
        <div
          className="video-player-seek"
          onPointerMove={(event) => {
            if (duration <= 0) return;
            const box = event.currentTarget.getBoundingClientRect();
            if (box.width <= 0) return;
            const part = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
            setHover({ at: part * duration, left: part * box.width });
          }}
          onPointerLeave={() => setHover(null)}
        >
          <input
            ref={seekInput}
            type="range"
            min={0}
            max={duration > 0 ? duration : 0}
            step={1}
            value={Math.min(shown, duration)}
            disabled={duration <= 0}
            aria-label={t("video.player.seek")}
            aria-valuetext={t("video.player.position", { time: formatPlayTime(shown), duration: formatPlayTime(duration) })}
            style={{ "--played": percent(shown), "--buffered": percent(Math.max(buffered, shown)) } as CSSProperties}
            onChange={(event) => setScrub(Number(event.currentTarget.value))}
          />
          {hover && <span className="video-player-seek-tip" style={{ left: hover.left }}>{formatPlayTime(hover.at)}</span>}
        </div>
        <span className="video-player-time">{formatPlayTime(shown)} / {formatPlayTime(duration)}</span>
      </div>

      <div className="video-player-buttons">
        <Button variant="bare" className="video-player-button is-play" aria-label={paused ? t("video.play") : t("video.player.pause")} title={paused ? t("video.play") : t("video.player.pause")} onClick={togglePlay}>
          {paused ? <Play size={26} fill="currentColor" aria-hidden="true" /> : <Pause size={26} fill="currentColor" aria-hidden="true" />}
        </Button>
        <Button variant="bare" className="video-player-button is-jump" aria-label={t("video.player.back10")} title={t("video.player.back10")} onClick={() => jump(-JUMP_S)}>
          <RotateCcw size={30} strokeWidth={1.6} aria-hidden="true" />
          <span aria-hidden="true">{JUMP_S}</span>
        </Button>
        <Button variant="bare" className="video-player-button is-jump" aria-label={t("video.player.forward10")} title={t("video.player.forward10")} onClick={() => jump(JUMP_S)}>
          <RotateCw size={30} strokeWidth={1.6} aria-hidden="true" />
          <span aria-hidden="true">{JUMP_S}</span>
        </Button>
        {next && (
          <a className="video-player-button" href={next.href} aria-label={next.label} title={next.label} onClick={(event) => followRoute(event, next.href)}>
            <SkipForward size={24} aria-hidden="true" />
          </a>
        )}

        <span className="video-player-buttons-gap" />

        <div className="video-player-volume">
          <Button variant="bare" className="video-player-button" aria-label={heard === 0 ? t("video.player.unmute") : t("video.player.mute")} title={heard === 0 ? t("video.player.unmute") : t("video.player.mute")} onClick={toggleMute}>
            <VolumeIcon size={26} aria-hidden="true" />
          </Button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={heard}
            aria-label={t("video.player.volume")}
            style={{ "--played": `${heard * 100}%`, "--buffered": `${heard * 100}%` } as CSSProperties}
            onChange={(event) => loudness(Number(event.currentTarget.value))}
          />
        </div>
        {subtitles && <VideoPlayerMenu label={subtitles.label} icon={<Captions size={26} aria-hidden="true" />} sections={[subtitles]} single />}
        <VideoPlayerMenu label={t("video.player.settings")} icon={<Settings size={25} aria-hidden="true" />} sections={[...settings, speedSection]} />
        <VideoPlayerMenu label={t("video.player.more")} icon={<Ellipsis size={26} aria-hidden="true" />} actions={more} />
        {fullscreen && (
          <Button variant="bare" className="video-player-button" aria-label={fullscreen.active ? t("video.fullscreenLeave") : t("video.fullscreen")} title={fullscreen.active ? t("video.fullscreenLeave") : t("video.fullscreen")} onClick={fullscreen.toggle}>
            {fullscreen.active ? <Minimize size={24} aria-hidden="true" /> : <Maximize size={24} aria-hidden="true" />}
          </Button>
        )}
      </div>
    </div>
  );
}
