import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";
import { drawBars, formatSeconds, peaksFromUrl, STRIP_HEIGHT, STRIP_WIDTH } from "./wave";

// The one audio player (docs/lightbox-panel.md, phase 3): the wave strip of
// what is playing, the seek control under it, then play/pause, who or what it
// is, and the time. The same card plays a photo's recordings, a story's
// narration, and a fresh take in the recording dialog before it is saved.
//
// The strip is the picture; the range under it is the control (keyboard and
// screen reader). A click on the strip seeks too. `wave` is either the bars to
// draw (a take the microphone just produced), "decode" to read them from the
// file itself, or "none".

export interface AudioPlayerHandle {
  toggle: () => void;
  pause: () => void;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, {
  src: string;
  /** Who is speaking, or the recording's title. */
  title?: ReactNode;
  /** When it was made, under the title. */
  subtitle?: ReactNode;
  /** Known length, shown until the file reports its own. */
  durationSeconds?: number | null;
  wave?: number[] | "decode" | "none";
  autoPlay?: boolean;
  /** "none" until pressed — a story with several narrations should not fetch them all. */
  preload?: "none" | "metadata";
  large?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onPlayingChange?: (playing: boolean) => void;
}>(function AudioPlayer({
  src,
  title,
  subtitle,
  durationSeconds,
  wave = "decode",
  autoPlay = false,
  preload = "metadata",
  large = false,
  disabled = false,
  ariaLabel,
  onPlayingChange
}, ref) {
  const { t } = useTranslation("common");
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(durationSeconds ?? 0);
  const [peaks, setPeaks] = useState<number[] | null>(Array.isArray(wave) ? wave : null);

  useImperativeHandle(ref, () => ({
    toggle: () => {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) void audio.play()?.catch?.(() => { /* interrupted */ });
      else audio.pause();
    },
    pause: () => audioRef.current?.pause()
  }), []);

  // A new source starts from the top, with what we know of its length.
  useEffect(() => {
    setTime(0);
    setLength(durationSeconds ?? 0);
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    if (autoPlay) void audio.play()?.catch?.(() => { /* autoplay refused: the button still works */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // The strip: the bars handed in, or read from the file once it is here.
  useEffect(() => {
    if (Array.isArray(wave)) { setPeaks(wave); return; }
    setPeaks(null);
    if (wave !== "decode") return;
    let alive = true;
    void peaksFromUrl(src).then((result) => { if (alive) setPeaks(result); });
    return () => { alive = false; };
  }, [src, wave]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawBars(canvas, peaks ?? [], length > 0 ? time / length : null);
  }, [peaks, time, length]);

  const setPlayingBoth = (next: boolean) => { setPlaying(next); onPlayingChange?.(next); };
  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setTime(audio.currentTime);
  };
  const max = Math.max(length, 1);
  const iconSize = large ? 22 : 18;

  return (
    <div className={`audio-player${large ? " is-large" : ""}${wave === "none" ? " no-wave" : ""}`} aria-label={ariaLabel}>
      <audio
        ref={audioRef}
        src={src}
        preload={preload}
        onPlay={() => setPlayingBoth(true)}
        onPause={() => setPlayingBoth(false)}
        onEnded={() => setPlayingBoth(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setLength(event.currentTarget.duration); }}
        onDurationChange={(event) => { if (Number.isFinite(event.currentTarget.duration)) setLength(event.currentTarget.duration); }}
      />
      {wave !== "none" && (
        <div
          className="audio-wave"
          aria-hidden="true"
          onClick={(event) => {
            if (length <= 0) return;
            const box = event.currentTarget.getBoundingClientRect();
            seekTo(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * length);
          }}
        >
          <canvas ref={canvasRef} width={STRIP_WIDTH} height={STRIP_HEIGHT} />
        </div>
      )}
      <input
        type="range"
        className="audio-seek"
        min={0}
        max={max}
        step={0.1}
        value={Math.min(time, max)}
        onChange={(event) => seekTo(Number(event.target.value))}
        aria-label={t("audio.seekAria")}
        disabled={disabled}
      />
      <div className="audio-player-row">
        <button
          type="button"
          className="audio-play"
          onClick={() => { const audio = audioRef.current; if (!audio) return; if (audio.paused) void audio.play()?.catch?.(() => { /* interrupted */ }); else audio.pause(); }}
          aria-label={playing ? t("audio.pause") : t("audio.play")}
          disabled={disabled}
        >
          {playing ? <Pause size={iconSize} aria-hidden="true" /> : <Play size={iconSize} aria-hidden="true" />}
        </button>
        <div className="audio-player-name">
          {title}
          {subtitle && <small>{subtitle}</small>}
        </div>
        <div className="audio-player-times">
          <span>{formatSeconds(time)}</span>
          <span className="muted"> / {formatSeconds(length)}</span>
        </div>
      </div>
    </div>
  );
});
