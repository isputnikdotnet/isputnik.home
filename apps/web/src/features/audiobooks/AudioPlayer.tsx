import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, ChevronDown, FastForward, List, Pause, Play, Rewind, SkipBack, SkipForward, Volume2, VolumeX, X } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import type { AudiobookBookDetail, AudiobookFile, PlaybackProgress } from "./types";

export function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTimeRemaining(seconds: number) {
  if (seconds <= 0) return "0m left";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function AudioPlayer({
  book,
  showBookmark,
  popup
}: {
  book: AudiobookBookDetail;
  showBookmark?: boolean;
  popup?: boolean;
}) {
  const availableFiles = book.files.filter((f) => f.status === "available");
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const shouldAutoPlayRef = useRef(false);
  const saveIntervalRef = useRef<number | null>(null);

  const [fileIndex, setFileIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [fileDuration, setFileDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const [bookmarkSaved, setBookmarkSaved] = useState(false);

  const totalDuration = availableFiles.reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const completedDuration = availableFiles.slice(0, fileIndex).reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const bookPosition = completedDuration + currentTime;

  const currentFile: AudiobookFile | undefined = availableFiles[fileIndex];

  const chapterProgressFor = (file: AudiobookFile, index: number) => {
    const duration = file.durationSeconds ?? 0;
    if (duration <= 0) return { seconds: 0, percent: index < fileIndex ? 1 : 0 };
    if (index < fileIndex) return { seconds: duration, percent: 1 };
    if (index > fileIndex) return { seconds: 0, percent: 0 };
    const seconds = Math.max(0, Math.min(currentTime, duration));
    return { seconds, percent: Math.min(seconds / duration, 1) };
  };

  const saveProgress = useCallback((file: AudiobookFile, position: number) => {
    api(`/api/library/books/${book.id}/progress`, {
      method: "PATCH",
      body: JSON.stringify({ fileId: file.id, positionSeconds: Math.floor(position) })
    }).catch(() => {});
  }, [book.id]);

  const addBookmark = useCallback(() => {
    if (!currentFile || !audioRef.current) return;
    const position = Math.floor(audioRef.current.currentTime);
    const chapterTitle = currentFile.chapterTitle || currentFile.relativePath.split("/").at(-1) || `Chapter ${fileIndex + 1}`;
    const key = `bookmarks-${book.id}`;
    const existing: { fileId: string; position: number; chapterTitle: string; savedAt: number }[] =
      JSON.parse(localStorage.getItem(key) || "[]");
    existing.push({ fileId: currentFile.id, position, chapterTitle, savedAt: Date.now() });
    localStorage.setItem(key, JSON.stringify(existing));
    setBookmarkSaved(true);
    setTimeout(() => setBookmarkSaved(false), 2000);
  }, [book.id, currentFile, fileIndex]);

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const newTime = audio.currentTime + seconds;
    if (newTime < 0 && fileIndex > 0) {
      const prevDuration = availableFiles[fileIndex - 1].durationSeconds ?? 0;
      if (currentFile) saveProgress(currentFile, 0);
      shouldAutoPlayRef.current = playing;
      pendingSeekRef.current = Math.max(0, prevDuration + newTime);
      setFileIndex((prev) => prev - 1);
    } else if (fileDuration > 0 && newTime >= fileDuration && fileIndex < availableFiles.length - 1) {
      if (currentFile) saveProgress(currentFile, fileDuration);
      shouldAutoPlayRef.current = playing;
      pendingSeekRef.current = Math.max(0, newTime - fileDuration);
      setFileIndex((prev) => prev + 1);
    } else {
      const clamped = Math.max(0, Math.min(newTime, fileDuration));
      audio.currentTime = clamped;
      setCurrentTime(clamped);
    }
  }, [fileIndex, fileDuration, availableFiles, currentFile, playing, saveProgress]);

  const jumpToChapter = useCallback((index: number) => {
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
    shouldAutoPlayRef.current = playing;
    pendingSeekRef.current = 0;
    setFileIndex(index);
    setChaptersOpen(false);
  }, [currentFile, playing, saveProgress]);

  useEffect(() => {
    const saveCurrentProgress = () => {
      if (!currentFile || !audioRef.current) return;
      return fetch(`/api/library/books/${book.id}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: currentFile.id, positionSeconds: Math.floor(audioRef.current.currentTime) }),
        keepalive: true
      });
    };
    const handleBeforeUnload = () => { saveCurrentProgress(); };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      saveCurrentProgress();
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [book.id, currentFile]);

  // Set src whenever the current file changes. With preload="none" audio.load() only
  // resets the element — no network request happens until play() is called.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentFile) return;
    setCurrentTime(0);
    setFileDuration(0);
    setPlayerError("");
    audio.src = `/api/library/books/${book.id}/stream/${currentFile.id}`;
    audio.playbackRate = playbackRate;
    audio.load();
    if (shouldAutoPlayRef.current) {
      shouldAutoPlayRef.current = false;
      audio.play().catch(() => {});
    }
  }, [fileIndex, book.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (availableFiles.length === 0) return;
    api<{ progress: PlaybackProgress | null }>(`/api/library/books/${book.id}/progress`)
      .then(({ progress }) => {
        if (!progress?.fileId) return;
        const idx = availableFiles.findIndex((f) => f.id === progress.fileId);
        if (idx < 0) return;
        pendingSeekRef.current = progress.positionSeconds;
        if (idx !== 0) setFileIndex(idx);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) {
      if (saveIntervalRef.current) clearInterval(saveIntervalRef.current);
      return;
    }
    saveIntervalRef.current = window.setInterval(() => {
      if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
    }, 10000);
    return () => { if (saveIntervalRef.current) clearInterval(saveIntervalRef.current); };
  }, [playing, currentFile, saveProgress]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = muted ? 0 : volume;
    audio.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    if (!speedOpen) return;
    const close = () => setSpeedOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [speedOpen]);

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setFileDuration(isFinite(audio.duration) ? audio.duration : 0);
    if (pendingSeekRef.current !== null) {
      audio.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
  };

  const handleTimeUpdate = () => { if (audioRef.current) setCurrentTime(audioRef.current.currentTime); };

  const handleEnded = () => {
    if (!currentFile) return;
    saveProgress(currentFile, audioRef.current?.duration ?? 0);
    if (fileIndex < availableFiles.length - 1) {
      shouldAutoPlayRef.current = true;
      setFileIndex((prev) => prev + 1);
    } else {
      setPlaying(false);
    }
  };

  const handlePlay = () => { setPlaying(true); setPlayerError(""); };
  const handlePause = () => {
    setPlaying(false);
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
  };
  const handleSeeked = () => {
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
  };
  const handleError = useCallback(() => {
    setPlaying(false);
    const code = audioRef.current?.error?.code;
    if (code === 3) setPlayerError("Audio decoding error — the file may be corrupt.");
    else if (code === 2) setPlayerError("Network error while loading audio.");
    else setPlayerError("Unable to play this file.");
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      setPlayerError("");
      audio.play().catch((err) => {
        setPlayerError(err instanceof Error ? err.message : "Playback failed");
      });
    }
  };

  const goToPrev = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (currentTime > 3) {
      audio.currentTime = 0;
    } else if (fileIndex > 0) {
      if (currentFile) saveProgress(currentFile, 0);
      shouldAutoPlayRef.current = playing;
      setFileIndex((prev) => prev - 1);
    }
  };

  const goToNext = () => {
    if (fileIndex < availableFiles.length - 1) {
      if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
      shouldAutoPlayRef.current = playing;
      setFileIndex((prev) => prev + 1);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (audioRef.current) audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const changeRate = (rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
    setSpeedOpen(false);
  };

  const toggleMute = () => setMuted((m) => !m);
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolume(v);
    if (v > 0) setMuted(false);
  };
  const toggleSpeedMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSpeedOpen((open) => !open);
  };

  if (availableFiles.length === 0) return null;

  const chapterList = availableFiles.map((file, index) => {
    const progress = chapterProgressFor(file, index);
    return (
      <button
        key={file.id}
        className={`player-chapter-item${index === fileIndex ? " active" : ""}${progress.percent >= 0.98 ? " complete" : ""}`}
        onClick={() => jumpToChapter(index)}
      >
        <span className="player-chapter-item-num">{index + 1}</span>
        <span className="player-chapter-item-main">
          <span className="player-chapter-item-title">
            {file.chapterTitle || file.relativePath.split("/").at(-1) || `Chapter ${index + 1}`}
          </span>
          <span className="player-chapter-progress">
            <span style={{ width: `${Math.round(progress.percent * 100)}%` }} />
          </span>
        </span>
        {file.durationSeconds != null && (
          <span className="player-chapter-item-dur">
            {progress.seconds > 0 && progress.percent < 0.98
              ? `${formatTime(progress.seconds)} / ${formatTime(file.durationSeconds)}`
              : formatTime(file.durationSeconds)}
          </span>
        )}
      </button>
    );
  });

  const speedMenu = speedOpen && (
    <div className="player-speed-menu" onClick={(e) => e.stopPropagation()}>
      {RATES.map((rate) => (
        <button
          key={rate}
          className={`player-speed-option${playbackRate === rate ? " active" : ""}`}
          onClick={() => changeRate(rate)}
          aria-pressed={playbackRate === rate}
        >
          {rate === 1 ? "1×" : `${rate}×`}
        </button>
      ))}
    </div>
  );

  const audioEl = (
    <audio
      ref={audioRef}
      preload="none"
      onLoadedMetadata={handleLoadedMetadata}
      onTimeUpdate={handleTimeUpdate}
      onEnded={handleEnded}
      onPlay={handlePlay}
      onPause={handlePause}
      onSeeked={handleSeeked}
      onError={handleError}
    />
  );

  if (popup) {
    return (
      <>
        <div className="audio-player player--popup">
          {audioEl}

          <p className="player-popup-chapter">
            {currentFile?.chapterTitle || currentFile?.relativePath.split("/").at(-1) || ""}
          </p>

          <div className="player-seek-popup">
            <div className="player-seek-times">
              <span className="player-time">{formatTime(currentTime)}</span>
              {totalDuration > 0 && (
                <span className="player-time-remaining">{formatTimeRemaining(totalDuration - bookPosition)}</span>
              )}
              <span className="player-time">
                {fileDuration > currentTime ? `-${formatTime(fileDuration - currentTime)}` : formatTime(fileDuration)}
              </span>
            </div>
            <input
              type="range"
              className="player-seekbar"
              min={0}
              max={fileDuration || 0}
              step={1}
              value={currentTime}
              onChange={handleSeek}
              aria-label="Seek"
            />
          </div>

          <div className="player-controls player-controls--popup">
            <button
              className="player-btn player-btn-nav"
              onClick={goToPrev}
              disabled={fileIndex === 0 && currentTime <= 3}
              aria-label="Previous chapter"
            >
              <SkipBack size={20} />
            </button>
            <button className="player-btn player-btn-circle" onClick={() => skip(-30)} aria-label="Skip back 30 seconds">
              <Rewind size={18} />
              <span>30</span>
            </button>
            <button className="player-btn player-btn-primary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause size={26} /> : <Play size={26} />}
            </button>
            <button className="player-btn player-btn-circle" onClick={() => skip(30)} aria-label="Skip forward 30 seconds">
              <FastForward size={18} />
              <span>30</span>
            </button>
            <button
              className="player-btn player-btn-nav"
              onClick={goToNext}
              disabled={fileIndex >= availableFiles.length - 1}
              aria-label="Next chapter"
            >
              <SkipForward size={20} />
            </button>
          </div>

          <div className="player-aux player-aux--popup">
            <div className="player-popup-aux-item player-speed">
              <button
                className="player-popup-aux-btn"
                onClick={toggleSpeedMenu}
                aria-expanded={speedOpen}
                aria-label="Playback speed"
              >
                <span className="player-popup-aux-value">{playbackRate === 1 ? "1.0×" : `${playbackRate}×`}</span>
                <span className="player-popup-aux-label">Speed</span>
              </button>
              {speedMenu}
            </div>

            <div className="player-popup-aux-item">
              <button
                className="player-popup-aux-btn"
                onClick={() => setChaptersOpen((o) => !o)}
                aria-expanded={chaptersOpen}
                aria-label="Chapter list"
              >
                <List size={20} />
                <span className="player-popup-aux-label">Chapters</span>
              </button>
            </div>

            {showBookmark && (
              <div className="player-popup-aux-item">
                <button
                  className={`player-popup-aux-btn${bookmarkSaved ? " bookmark-saved" : ""}`}
                  onClick={addBookmark}
                  aria-label="Add bookmark"
                >
                  <Bookmark size={20} />
                  <span className="player-popup-aux-label">{bookmarkSaved ? "Saved!" : "Add a Bookmark"}</span>
                </button>
              </div>
            )}
          </div>

          {playerError && <MessageBox tone="error" title="Playback error">{playerError}</MessageBox>}
        </div>

        {chaptersOpen && (
          <>
            <div className="chapter-sheet-backdrop" onClick={() => setChaptersOpen(false)} />
            <div className="chapter-sheet">
              <div className="chapter-sheet-drag" />
              <div className="chapter-sheet-header">
                <h3 className="chapter-sheet-title">Chapters</h3>
                <button className="chapter-sheet-close" onClick={() => setChaptersOpen(false)} aria-label="Close chapters">
                  <X size={18} />
                </button>
              </div>
              <div className="chapter-sheet-list">
                {chapterList}
              </div>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <div className="audio-player">
      {audioEl}

      <div className="player-chapter">
        <span className="player-chapter-index">{fileIndex + 1} / {availableFiles.length}</span>
        <span className="player-chapter-title">
          {currentFile?.chapterTitle || currentFile?.relativePath.split("/").at(-1) || ""}
        </span>
      </div>

      <div className="player-controls">
        <button className="player-btn player-btn-skip" onClick={() => skip(-30)} aria-label="Skip back 30 seconds">
          <Rewind size={17} />
          <span>30</span>
        </button>
        <button className="player-btn" onClick={goToPrev} disabled={fileIndex === 0 && currentTime <= 3} aria-label="Previous chapter">
          <SkipBack size={20} />
        </button>
        <button className="player-btn player-btn-primary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button className="player-btn" onClick={goToNext} disabled={fileIndex >= availableFiles.length - 1} aria-label="Next chapter">
          <SkipForward size={20} />
        </button>
        <button className="player-btn player-btn-skip" onClick={() => skip(30)} aria-label="Skip forward 30 seconds">
          <FastForward size={17} />
          <span>30</span>
        </button>
      </div>

      <div className="player-seek">
        <span className="player-time">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="player-seekbar"
          min={0}
          max={fileDuration || 0}
          step={1}
          value={currentTime}
          onChange={handleSeek}
          aria-label="Seek"
        />
        <span className="player-time">{formatTime(fileDuration)}</span>
      </div>

      {totalDuration > 0 && (
        <div className="player-book-progress">
          <span className="player-time">{formatTime(bookPosition)}</span>
          <div className="player-book-bar" role="progressbar" aria-valuenow={bookPosition} aria-valuemax={totalDuration} aria-label="Book progress">
            <div className="player-book-bar-fill" style={{ width: `${Math.min(100, (bookPosition / totalDuration) * 100)}%` }} />
          </div>
          <span className="player-time">{formatTime(totalDuration)}</span>
        </div>
      )}

      <div className="player-aux">
        <div className="player-vol">
          <button className="player-vol-icon" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>
            {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </button>
          <input
            type="range"
            className="player-vol-slider"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={handleVolumeChange}
            aria-label="Volume"
          />
        </div>

        <div className="player-speed">
          <button
            className={`player-speed-btn${speedOpen ? " open" : ""}`}
            onClick={toggleSpeedMenu}
            aria-expanded={speedOpen}
            aria-label="Playback speed"
          >
            <span>{playbackRate === 1 ? "1×" : `${playbackRate}×`}</span>
            <ChevronDown size={13} />
          </button>
          {speedMenu}
        </div>

        <button
          className={`player-speed-btn${chaptersOpen ? " open" : ""}`}
          onClick={() => setChaptersOpen((o) => !o)}
          aria-expanded={chaptersOpen}
          aria-label="Chapter list"
        >
          <List size={15} />
          <span>Chapters</span>
        </button>

        {showBookmark && (
          <button
            className={`player-speed-btn${bookmarkSaved ? " bookmark-saved" : ""}`}
            onClick={addBookmark}
            aria-label="Add bookmark"
          >
            <Bookmark size={15} />
            <span>{bookmarkSaved ? "Saved!" : "Bookmark"}</span>
          </button>
        )}
      </div>

      {chaptersOpen && (
        <div className="player-chapter-list">
          {chapterList}
        </div>
      )}

      {playerError && <MessageBox tone="error" title="Playback error">{playerError}</MessageBox>}
    </div>
  );
}
