import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { formatClock } from "../../shared/formatClock";

// Playback speeds every player offers.
export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

// Sleep-timer options. Numeric values are minutes; "chapter" stops at the end of
// the chapter that was playing when the timer was armed.
export const SLEEP_MINUTES = [15, 30, 45, 60] as const;
export type SleepMode = "off" | "chapter" | (typeof SLEEP_MINUTES)[number];

/** A speed as the menus print it: "1×", "1.5×". */
export function rateLabel(rate: number): string {
  return rate === 1 ? "1×" : `${rate}×`;
}

// The part of an audio player that is the same whoever is listening: one <audio>
// element and the state around it — playing, the playhead, the file's length,
// speed, volume, the sleep timer and its countdown, and the speed/sleep menus.
// The book player (AudioPlayer) and the guest share page each add their own sense
// of chapters, files and what "next" means on top; this hook knows nothing of that.
export function usePlayback({ playErrorMessage }: {
  /** What to tell the listener when play() is refused. */
  playErrorMessage: (err: unknown) => string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [fileDuration, setFileDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const [speedOpen, setSpeedOpen] = useState(false);
  const [sleepOpen, setSleepOpen] = useState(false);
  const [sleepMode, setSleepMode] = useState<SleepMode>("off");
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = muted ? 0 : volume;
    audio.muted = muted;
  }, [volume, muted]);

  // Sleep timer (timed modes): tick down once a second while playing, then pause
  // playback and disarm. Counting only while playing means a manual pause also
  // pauses the timer, which is what listeners expect.
  useEffect(() => {
    if (typeof sleepMode !== "number" || !playing) return;
    const id = window.setInterval(() => {
      setSleepRemaining((prev) => {
        const next = (prev ?? sleepMode * 60) - 1;
        if (next <= 0) {
          audioRef.current?.pause();
          setSleepMode("off");
          return null;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [sleepMode, playing]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      setPlayerError("");
      audio.play().catch((err) => setPlayerError(playErrorMessage(err)));
    }
  };

  const handleSeek = (e: ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (audioRef.current) audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const changeRate = (rate: number) => {
    setPlaybackRate(rate);
    // Both: a new src (the next chapter) runs load(), which resets playbackRate to
    // defaultPlaybackRate — setting only the first put every chapter back at 1×
    // while the button still said 1.5×.
    if (audioRef.current) {
      audioRef.current.defaultPlaybackRate = rate;
      audioRef.current.playbackRate = rate;
    }
    setSpeedOpen(false);
  };

  const toggleMute = () => setMuted((m) => !m);
  const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolume(v);
    if (v > 0) setMuted(false);
  };

  const chooseSleep = (mode: SleepMode) => {
    setSleepMode(mode);
    setSleepRemaining(typeof mode === "number" ? mode * 60 : null);
    setSleepOpen(false);
  };

  /** Compact label for an armed timer: a live countdown, `chapterWord`, or null when off. */
  const sleepLabel = (chapterWord: string): string | null => sleepMode === "off"
    ? null
    : sleepMode === "chapter"
      ? chapterWord
      : formatClock(sleepRemaining ?? sleepMode * 60);

  // A new src resets the element; put the listener's speed and volume back on it.
  const applySettings = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = muted ? 0 : volume;
    audio.muted = muted;
    audio.defaultPlaybackRate = playbackRate;
    audio.playbackRate = playbackRate;
  };

  return {
    audioRef,
    playing, setPlaying,
    currentTime, setCurrentTime,
    fileDuration, setFileDuration,
    playerError, setPlayerError,
    togglePlay, handleSeek,
    playbackRate, changeRate,
    volume, muted, toggleMute, handleVolumeChange,
    speedOpen, setSpeedOpen, sleepOpen, setSleepOpen,
    sleepMode, setSleepMode, sleepRemaining, chooseSleep, sleepLabel,
    applySettings
  };
}
