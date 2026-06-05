import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, BookmarkPlus, CheckCircle2, ChevronDown, ChevronUp, Clock, FastForward, Heart, List, Pause, Pencil, PieChart, Play, Rewind, SkipBack, SkipForward, StickyNote, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { api } from "../../api";
import { getDownloadedFileUrl } from "../../offline/downloads";
import { getLocalProgress, persistProgress } from "../../offline/progress";
import { MessageBox } from "../../shared/MessageBox";
import type { AudiobookBookDetail, AudiobookFile, Bookmark as BookmarkEntry, PlaybackProgress } from "./types";

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
  popup,
  saved,
  onToggleSave,
  savingSave,
  onAddNote,
  onMarkFinished
}: {
  book: AudiobookBookDetail;
  showBookmark?: boolean;
  popup?: boolean;
  saved?: boolean;
  onToggleSave?: () => void;
  savingSave?: boolean;
  onAddNote?: () => void;
  onMarkFinished?: () => void;
}) {
  const availableFiles = book.files.filter((f) => f.status === "available");
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const shouldAutoPlayRef = useRef(false);
  const saveIntervalRef = useRef<number | null>(null);
  // Object URL for a locally-downloaded chapter, revoked when we move off it.
  const localUrlRef = useRef<string | null>(null);
  // Latest media-control callbacks, so OS lock-screen handlers (registered once)
  // always invoke current closures without re-registering.
  const mediaHandlersRef = useRef<Record<string, (arg?: MediaSessionActionDetails) => void>>({});

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
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const totalDuration = availableFiles.reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const completedDuration = availableFiles.slice(0, fileIndex).reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const bookPosition = completedDuration + currentTime;
  const bookPercent = totalDuration > 0 ? Math.round((bookPosition / totalDuration) * 100) : 0;

  const currentFile: AudiobookFile | undefined = availableFiles[fileIndex];

  const chapterProgressFor = (file: AudiobookFile, index: number) => {
    const duration = file.durationSeconds ?? 0;
    if (duration <= 0) return { seconds: 0, percent: index < fileIndex ? 1 : 0 };
    if (index < fileIndex) return { seconds: duration, percent: 1 };
    if (index > fileIndex) return { seconds: 0, percent: 0 };
    const seconds = Math.max(0, Math.min(currentTime, duration));
    return { seconds, percent: Math.min(seconds / duration, 1) };
  };

  // Always record locally (survives offline) and push to the server when possible;
  // unsynced writes are flushed on reconnect.
  const saveProgress = useCallback((file: AudiobookFile, position: number) => {
    void persistProgress(book.id, file.id, position);
  }, [book.id]);

  const sortBookmarks = (list: BookmarkEntry[]) =>
    [...list].sort((a, b) => (a.bookPositionSeconds ?? a.positionSeconds) - (b.bookPositionSeconds ?? b.positionSeconds));

  const addBookmark = useCallback(async () => {
    if (!currentFile || !audioRef.current) return;
    const position = Math.floor(audioRef.current.currentTime);
    const label = currentFile.chapterTitle || currentFile.relativePath.split("/").at(-1) || `Chapter ${fileIndex + 1}`;
    try {
      const { bookmark } = await api<{ bookmark: BookmarkEntry }>(`/api/library/books/${book.id}/bookmarks`, {
        method: "POST",
        body: JSON.stringify({ fileId: currentFile.id, positionSeconds: position, label })
      });
      setBookmarks((prev) => sortBookmarks([...prev, bookmark]));
      setBookmarkSaved(true);
      setTimeout(() => setBookmarkSaved(false), 2000);
      // Open the list with this bookmark ready for a note — "bookmark and jot a note" in one gesture.
      setNoteDraft("");
      setEditingBookmarkId(bookmark.id);
      setBookmarksOpen(true);
    } catch {
      setPlayerError("Unable to save bookmark.");
    }
  }, [book.id, currentFile, fileIndex]);

  const saveBookmarkNote = useCallback(async (id: string, note: string) => {
    try {
      const { bookmark } = await api<{ bookmark: BookmarkEntry }>(`/api/library/books/${book.id}/bookmarks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ note })
      });
      setBookmarks((prev) => prev.map((b) => (b.id === id ? bookmark : b)));
      setEditingBookmarkId(null);
    } catch {
      setPlayerError("Unable to save note.");
    }
  }, [book.id]);

  const deleteBookmark = useCallback(async (id: string) => {
    try {
      await api(`/api/library/books/${book.id}/bookmarks/${id}`, { method: "DELETE" });
      setBookmarks((prev) => prev.filter((b) => b.id !== id));
      setEditingBookmarkId((current) => (current === id ? null : current));
    } catch {
      setPlayerError("Unable to delete bookmark.");
    }
  }, [book.id]);

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

  // Seek to a position in a (possibly different) file. The pendingSeekRef path only fires
  // on a file change, so same-file jumps must seek the already-loaded element directly.
  const seekTo = useCallback((targetIndex: number, position: number) => {
    if (targetIndex < 0) return;
    if (targetIndex === fileIndex) {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = position;
        setCurrentTime(position);
      }
    } else {
      shouldAutoPlayRef.current = playing;
      pendingSeekRef.current = position;
      setFileIndex(targetIndex);
    }
  }, [fileIndex, playing]);

  const jumpToChapter = useCallback((index: number) => {
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
    seekTo(index, 0);
    setChaptersOpen(false);
  }, [currentFile, saveProgress, seekTo]);

  const jumpToBookmark = useCallback((bookmark: BookmarkEntry) => {
    const index = availableFiles.findIndex((f) => f.id === bookmark.fileId);
    if (index < 0) return;
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
    seekTo(index, bookmark.positionSeconds);
    setBookmarksOpen(false);
  }, [availableFiles, currentFile, saveProgress, seekTo]);

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
  // If the chapter is downloaded for offline use, play from the local blob (which
  // also gives native seeking) instead of the network stream.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentFile) return;
    let cancelled = false;
    setCurrentTime(0);
    setFileDuration(0);
    setPlayerError("");

    const revokeLocal = () => {
      if (localUrlRef.current) {
        URL.revokeObjectURL(localUrlRef.current);
        localUrlRef.current = null;
      }
    };

    const fileId = currentFile.id;
    getDownloadedFileUrl(fileId).then((localUrl) => {
      if (cancelled) {
        if (localUrl) URL.revokeObjectURL(localUrl);
        return;
      }
      revokeLocal();
      if (localUrl) localUrlRef.current = localUrl;
      audio.src = localUrl ?? `/api/library/books/${book.id}/stream/${fileId}`;
      audio.playbackRate = playbackRate;
      audio.load();
      if (shouldAutoPlayRef.current) {
        shouldAutoPlayRef.current = false;
        audio.play().catch(() => {});
      }
    });

    return () => { cancelled = true; };
  }, [fileIndex, book.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Revoke any lingering local object URL on unmount.
  useEffect(() => () => {
    if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
  }, []);

  // Load bookmarks, migrating any legacy localStorage bookmarks to the server once.
  useEffect(() => {
    let cancelled = false;
    const key = `bookmarks-${book.id}`;
    const run = async () => {
      // Claim the legacy data up front (remove before awaiting) so a double-mount can't re-migrate.
      const raw = localStorage.getItem(key);
      if (raw) {
        localStorage.removeItem(key);
        try {
          const legacy = JSON.parse(raw) as { fileId?: string; position?: number; chapterTitle?: string }[];
          for (const entry of legacy) {
            if (!entry.fileId) continue;
            await api(`/api/library/books/${book.id}/bookmarks`, {
              method: "POST",
              body: JSON.stringify({
                fileId: entry.fileId,
                positionSeconds: Math.floor(entry.position ?? 0),
                label: entry.chapterTitle
              })
            }).catch(() => {});
          }
        } catch {
          // ignore malformed legacy data
        }
      }
      const result = await api<{ bookmarks: BookmarkEntry[] }>(`/api/library/books/${book.id}/bookmarks`)
        .catch(() => ({ bookmarks: [] as BookmarkEntry[] }));
      if (!cancelled) setBookmarks(sortBookmarks(result.bookmarks));
    };
    void run();
    return () => { cancelled = true; };
  }, [book.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (availableFiles.length === 0) return;
    let cancelled = false;
    (async () => {
      const local = await getLocalProgress(book.id);
      let resume: { fileId: string | null; positionSeconds: number } | null = null;
      if (local && !local.synced) {
        // An unsynced local write is newer than anything the server has.
        resume = { fileId: local.fileId, positionSeconds: local.positionSeconds };
      } else {
        try {
          const { progress } = await api<{ progress: PlaybackProgress | null }>(`/api/library/books/${book.id}/progress`);
          resume = progress ? { fileId: progress.fileId, positionSeconds: progress.positionSeconds } : null;
        } catch {
          // Offline — fall back to the last position we stored locally.
          resume = local ? { fileId: local.fileId, positionSeconds: local.positionSeconds } : null;
        }
      }
      if (cancelled || !resume?.fileId) return;
      const idx = availableFiles.findIndex((f) => f.id === resume!.fileId);
      if (idx < 0) return;
      pendingSeekRef.current = resume.positionSeconds;
      if (idx !== 0) setFileIndex(idx);
    })();
    return () => { cancelled = true; };
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

  // Report the current chapter's position to the OS so the lock-screen / car
  // scrubber stays in sync. Guards against the not-yet-known duration.
  const updateMediaPositionState = () => {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    const audio = audioRef.current;
    if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(Math.max(audio.currentTime, 0), audio.duration)
      });
    } catch { /* invalid state — ignore */ }
  };

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setFileDuration(isFinite(audio.duration) ? audio.duration : 0);
    if (pendingSeekRef.current !== null) {
      audio.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = null;
    }
    updateMediaPositionState();
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
    updateMediaPositionState();
  };

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
    updateMediaPositionState();
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

  // Keep the lock-screen action handlers pointed at the latest closures.
  mediaHandlersRef.current = {
    play: () => { audioRef.current?.play().catch(() => {}); },
    pause: () => audioRef.current?.pause(),
    prev: () => goToPrev(),
    next: () => goToNext(),
    back: (d) => skip(-(d?.seekOffset || 30)),
    forward: (d) => skip(d?.seekOffset || 30),
    seekTo: (d) => {
      const audio = audioRef.current;
      if (audio && typeof d?.seekTime === "number") {
        audio.currentTime = d.seekTime;
        setCurrentTime(d.seekTime);
        updateMediaPositionState();
      }
    }
  };

  // Publish "now playing" metadata (cover, chapter, author) per chapter.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentFile) return;
    const chapter = currentFile.chapterTitle || currentFile.relativePath.split("/").at(-1) || `Chapter ${fileIndex + 1}`;
    const cover = book.coverLargeUrl ?? book.coverUrl;
    const artwork = cover
      ? [{ src: new URL(cover, window.location.origin).href, sizes: "512x512", type: "image/jpeg" }]
      : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapter,
        artist: book.authors.join(", ") || "Unknown author",
        album: book.title,
        artwork
      });
    } catch { /* unsupported metadata */ }
  }, [book.id, fileIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register OS media-control handlers once; they delegate through the ref.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const actions: [MediaSessionAction, (d?: MediaSessionActionDetails) => void][] = [
      ["play", () => mediaHandlersRef.current.play?.()],
      ["pause", () => mediaHandlersRef.current.pause?.()],
      ["previoustrack", () => mediaHandlersRef.current.prev?.()],
      ["nexttrack", () => mediaHandlersRef.current.next?.()],
      ["seekbackward", (d) => mediaHandlersRef.current.back?.(d)],
      ["seekforward", (d) => mediaHandlersRef.current.forward?.(d)],
      ["seekto", (d) => mediaHandlersRef.current.seekTo?.(d)]
    ];
    for (const [action, handler] of actions) {
      try { ms.setActionHandler(action, handler); } catch { /* action unsupported */ }
    }
    return () => {
      for (const [action] of actions) {
        try { ms.setActionHandler(action, null); } catch { /* ignore */ }
      }
    };
  }, []);

  // Reflect play/pause in the OS so the right button shows on the lock screen.
  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [playing]);

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

  const bookmarkList = (
    <div className="player-bookmark-list">
      <button className="player-bookmark-add" onClick={addBookmark}>
        <BookmarkPlus size={15} />
        <span>{bookmarkSaved ? "Bookmark added" : "Bookmark this moment"}</span>
      </button>
      {bookmarks.length === 0 ? (
        <p className="player-bookmark-empty">No bookmarks yet. Tap “Bookmark this moment” to save your spot and add a note.</p>
      ) : (
        bookmarks.map((bm) => {
          const editing = editingBookmarkId === bm.id;
          return (
            <div className={`player-bookmark-item${editing ? " editing" : ""}`} key={bm.id}>
              <div className="player-bookmark-row">
                <button className="player-bookmark-jump" onClick={() => jumpToBookmark(bm)} disabled={!availableFiles.some((f) => f.id === bm.fileId)}>
                  <Bookmark size={13} />
                  <span className="player-bookmark-time">{formatTime(bm.bookPositionSeconds ?? bm.positionSeconds)}</span>
                  <span className="player-bookmark-label">{bm.label || "Bookmark"}</span>
                </button>
                <div className="player-bookmark-actions">
                  <button
                    onClick={() => { setEditingBookmarkId(bm.id); setNoteDraft(bm.note ?? ""); }}
                    aria-label="Edit note"
                  >
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => deleteBookmark(bm.id)} aria-label="Delete bookmark">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {editing ? (
                <div className="player-bookmark-edit">
                  <textarea
                    className="player-bookmark-note-input"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="Add a note…"
                    rows={2}
                    autoFocus
                  />
                  <div className="player-bookmark-edit-actions">
                    <button className="player-bookmark-save" onClick={() => saveBookmarkNote(bm.id, noteDraft)}>Save</button>
                    <button className="player-bookmark-cancel" onClick={() => setEditingBookmarkId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                bm.note && <p className="player-bookmark-note">{bm.note}</p>
              )}
            </div>
          );
        })
      )}
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

          {totalDuration > 0 && (
            <div className="player-popup-progress">
              <span className="player-popup-progress-item">
                <PieChart size={15} aria-hidden="true" /> {bookPercent}% Complete
              </span>
              <span className="player-popup-progress-sep" aria-hidden="true">•</span>
              <span className="player-popup-progress-item">
                <Clock size={15} aria-hidden="true" /> {formatTimeRemaining(totalDuration - bookPosition)}
              </span>
            </div>
          )}

          <div className="player-popup-chapter">
            <strong><Bookmark size={15} aria-hidden="true" /> Chapter {fileIndex + 1}</strong>
            <span>{currentFile?.chapterTitle || currentFile?.relativePath.split("/").at(-1) || ""}</span>
          </div>

          <div className="player-seek-popup">
            <input
              type="range"
              className="player-seekbar"
              min={0}
              max={fileDuration || 0}
              step={1}
              value={currentTime}
              onChange={handleSeek}
              aria-label="Seek"
              style={{ ["--seek-fill" as string]: `${fileDuration > 0 ? (currentTime / fileDuration) * 100 : 0}%` }}
            />
            <div className="player-seek-times">
              <span className="player-time">{formatTime(currentTime)}</span>
              <span className="player-time">
                {fileDuration > currentTime ? `-${formatTime(fileDuration - currentTime)}` : formatTime(fileDuration)}
              </span>
            </div>
          </div>

          <div className="player-controls player-controls--popup">
            <button
              className="player-btn player-btn-nav"
              onClick={goToPrev}
              disabled={fileIndex === 0 && currentTime <= 3}
              aria-label="Previous chapter"
            >
              <SkipBack size={18} />
            </button>
            <button className="player-btn player-btn-circle" onClick={() => skip(-30)} aria-label="Skip back 30 seconds">
              <Rewind size={15} />
              <span>30</span>
            </button>
            <button className="player-btn player-btn-primary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause size={21} /> : <Play size={21} />}
            </button>
            <button className="player-btn player-btn-circle" onClick={() => skip(30)} aria-label="Skip forward 30 seconds">
              <FastForward size={15} />
              <span>30</span>
            </button>
            <button
              className="player-btn player-btn-nav"
              onClick={goToNext}
              disabled={fileIndex >= availableFiles.length - 1}
              aria-label="Next chapter"
            >
              <SkipForward size={18} />
            </button>
          </div>

          <div className="player-volume-popup">
            <button className="player-vol-icon" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>
              {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
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
            <Volume2 size={16} className="player-vol-max" aria-hidden="true" />
          </div>

          <div className="player-aux player-aux--popup">
            <div className="player-popup-aux-row">
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

              {onToggleSave && (
                <div className="player-popup-aux-item">
                  <button
                    className={`player-popup-aux-btn${saved ? " bookmark-saved" : ""}`}
                    onClick={onToggleSave}
                    disabled={savingSave}
                    aria-pressed={saved ?? false}
                    aria-label={saved ? "Remove from Favorites" : "Add to Favorites"}
                  >
                    <Heart size={18} fill={saved ? "currentColor" : "none"} />
                    <span className="player-popup-aux-label">Favorites</span>
                  </button>
                </div>
              )}

              {showBookmark && (
                <div className="player-popup-aux-item">
                  <button
                    className="player-popup-aux-btn"
                    onClick={() => setBookmarksOpen((o) => !o)}
                    aria-expanded={bookmarksOpen}
                    aria-label="Bookmarks"
                  >
                    <Bookmark size={18} />
                    <span className="player-popup-aux-label">Bookmarks{bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}</span>
                  </button>
                </div>
              )}

              {onAddNote && (
                <div className="player-popup-aux-item">
                  <button className="player-popup-aux-btn" onClick={onAddNote} aria-label="Add a note">
                    <StickyNote size={18} />
                    <span className="player-popup-aux-label">Add Note</span>
                  </button>
                </div>
              )}

              {onMarkFinished && (
                <div className="player-popup-aux-item">
                  <button className="player-popup-aux-btn" onClick={onMarkFinished} aria-label="Mark as finished">
                    <CheckCircle2 size={18} />
                    <span className="player-popup-aux-label">Mark as Finished</span>
                  </button>
                </div>
              )}
            </div>

            <button
              className="player-popup-chapters-btn"
              onClick={() => setChaptersOpen((o) => !o)}
              aria-expanded={chaptersOpen}
              aria-label="Chapter list"
            >
              <span className="player-popup-chapters-btn-label"><List size={16} /> Chapters</span>
              {chaptersOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
            </button>
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

        {bookmarksOpen && (
          <>
            <div className="chapter-sheet-backdrop" onClick={() => setBookmarksOpen(false)} />
            <div className="chapter-sheet">
              <div className="chapter-sheet-drag" />
              <div className="chapter-sheet-header">
                <h3 className="chapter-sheet-title">Bookmarks</h3>
                <button className="chapter-sheet-close" onClick={() => setBookmarksOpen(false)} aria-label="Close bookmarks">
                  <X size={18} />
                </button>
              </div>
              <div className="chapter-sheet-list">
                {bookmarkList}
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
          <>
            <button
              className={`player-speed-btn${bookmarksOpen ? " open" : ""}`}
              onClick={() => setBookmarksOpen((o) => !o)}
              aria-expanded={bookmarksOpen}
              aria-label="Bookmarks"
            >
              <Bookmark size={15} />
              <span>Bookmarks{bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}</span>
            </button>
            {onToggleSave && (
              <button
                className={`player-speed-btn${saved ? " bookmark-saved" : ""}`}
                onClick={onToggleSave}
                disabled={savingSave}
                aria-pressed={saved ?? false}
                aria-label={saved ? "Remove from Favorites" : "Add to Favorites"}
              >
                <Heart size={15} fill={saved ? "currentColor" : "none"} />
                <span>{saved ? "Favorited" : "Favorites"}</span>
              </button>
            )}
          </>
        )}
      </div>

      {chaptersOpen && (
        <div className="player-chapter-list">
          {chapterList}
        </div>
      )}

      {bookmarksOpen && bookmarkList}

      {playerError && <MessageBox tone="error" title="Playback error">{playerError}</MessageBox>}
    </div>
  );
}
