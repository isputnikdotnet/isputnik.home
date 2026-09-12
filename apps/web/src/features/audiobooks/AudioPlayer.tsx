import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, BookmarkPlus, ChevronDown, Clock, Heart, List, Moon, Pencil, PieChart, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { api } from "../../api";
import i18n from "../../i18n";
import { getDownloadedFileUrl } from "../../offline/downloads";
import { getLocalProgress, persistProgress } from "../../offline/progress";
import { cx } from "../../shared/cx";
import { formatClock as formatTime } from "../../shared/formatClock";
import { MessageBox } from "../../shared/MessageBox";
import { ProgressRing } from "../../shared/ProgressRing";
import { PlayerControls } from "./PlayerControls";
import type { AudiobookBookDetail, AudiobookFile, Bookmark as BookmarkEntry, PlaybackProgress } from "./types";
import { RATES, rateLabel, SLEEP_MINUTES, usePlayback, type SleepMode } from "./usePlayback";
import { Button } from "../../shared/Button";

function formatTimeRemaining(seconds: number) {
  if (seconds <= 0) return i18n.t("reader:player.leftM", { m: 0 });
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? i18n.t("reader:player.leftHM", { h, m }) : i18n.t("reader:player.leftM", { m });
}

// A navigable chapter, flattened across files. For multi-file books each file is
// one chapter; for a single m4b/MP3 the file's embedded markers become many. Offsets
// are within the owning file; bookStart is the cumulative position across all files.
interface FlatChapter {
  fileIndex: number;
  fileId: string;
  title: string;
  startOffset: number;
  endOffset: number;
  bookStart: number;
}

export function AudioPlayer({
  book,
  showBookmark,
  popup,
  saved,
  onToggleSave,
  savingSave,
  autoPlay,
  onEndReached
}: {
  book: AudiobookBookDetail;
  showBookmark?: boolean;
  popup?: boolean;
  saved?: boolean;
  onToggleSave?: () => void;
  savingSave?: boolean;
  // Begin playing as soon as the first chapter loads (used when auto-advancing
  // to the next book in a collection/playlist).
  autoPlay?: boolean;
  // Fires when the final chapter ends. When set, the player defers the
  // end-of-book behaviour to the parent (queue advance) instead of just stopping.
  onEndReached?: () => void;
}) {
  const { t } = useTranslation(["common", "reader"]);
  // Memoized because half the callbacks below list it: a fresh array every render
  // would rebuild `skip`, `jumpToBookmark` and everything holding them each time.
  const availableFiles = useMemo(() => book.files.filter((f) => f.status === "available"), [book.files]);
  const playback = usePlayback({
    playErrorMessage: (err) => (err instanceof Error ? err.message : t("reader:player.playbackFailed"))
  });
  // usePlayback hands back the audio element's ref and plain state setters, so every
  // one of these is stable for the life of the player. They still have to be named in
  // the dependency arrays below — coming out of a custom hook, the linter cannot see
  // that for itself — and listing them changes nothing about when an effect runs.
  const {
    audioRef, playing, setPlaying, currentTime, setCurrentTime, fileDuration, setFileDuration,
    playerError, setPlayerError, togglePlay, handleSeek, playbackRate, volume, muted,
    toggleMute, handleVolumeChange, speedOpen, setSpeedOpen, sleepOpen, setSleepOpen, sleepMode, setSleepMode
  } = playback;
  const pendingSeekRef = useRef<number | null>(null);
  const shouldAutoPlayRef = useRef(autoPlay ?? false);
  const saveIntervalRef = useRef<number | null>(null);
  // Object URL for a locally-downloaded chapter, revoked when we move off it.
  const localUrlRef = useRef<string | null>(null);
  // Latest media-control callbacks, so OS lock-screen handlers (registered once)
  // always invoke current closures without re-registering.
  const mediaHandlersRef = useRef<Record<string, (arg?: MediaSessionActionDetails) => void>>({});

  const [fileIndex, setFileIndex] = useState(0);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  // The chapter index to finish on when sleepMode === "chapter".
  const sleepChapterTargetRef = useRef<number | null>(null);
  const [bookmarkSaved, setBookmarkSaved] = useState(false);
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  // Ids for what each toggle opens (aria-controls), and for the armed sleep
  // timer's countdown, which the timer button's fixed name would otherwise hide.
  const ids = useId();
  const speedMenuId = `${ids}-speed`;
  const sleepMenuId = `${ids}-sleep`;
  const chaptersId = `${ids}-chapters`;
  const bookmarksId = `${ids}-bookmarks`;
  const sleepStateId = `${ids}-sleep-state`;
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const totalDuration = availableFiles.reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const completedDuration = availableFiles.slice(0, fileIndex).reduce((sum, f) => sum + (f.durationSeconds ?? 0), 0);
  const bookPosition = completedDuration + currentTime;
  const bookPercent = totalDuration > 0 ? Math.round((bookPosition / totalDuration) * 100) : 0;

  const currentFile: AudiobookFile | undefined = availableFiles[fileIndex];

  // The navigable chapter list. Files with embedded chapters (m4b `chap`, MP3 CHAP)
  // expand into one entry per marker; files without any contribute a single
  // full-span chapter, so multi-file books behave exactly as before.
  const chapters = useMemo<FlatChapter[]>(() => {
    const files = book.files.filter((file) => file.status === "available");
    const list: FlatChapter[] = [];
    let base = 0; // cumulative book seconds at the start of the current file
    files.forEach((file, index) => {
      const fileDuration = file.durationSeconds ?? 0;
      const embedded = (file.chapters ?? []).filter((chapter) => chapter.startSeconds >= 0);
      if (embedded.length > 0) {
        embedded.forEach((chapter, position) => {
          const startOffset = Math.min(chapter.startSeconds, fileDuration || chapter.startSeconds);
          // m4b chapters carry no end, so fall back to the next marker, then the file end.
          const endOffset = chapter.endSeconds ?? embedded[position + 1]?.startSeconds ?? (fileDuration || startOffset);
          list.push({
            fileIndex: index,
            fileId: file.id,
            title: chapter.title || t("reader:player.chapterN", { num: list.length + 1 }),
            startOffset,
            endOffset,
            bookStart: base + startOffset
          });
        });
      } else {
        list.push({
          fileIndex: index,
          fileId: file.id,
          title: file.chapterTitle || file.relativePath.split("/").at(-1) || t("reader:player.chapterN", { num: index + 1 }),
          startOffset: 0,
          endOffset: fileDuration,
          bookStart: base
        });
      }
      base += fileDuration;
    });
    return list;
  }, [book.files, t]);

  // Active chapter = the last one in the current file whose start is at/under the
  // playhead (a small tolerance avoids flicker right at a boundary).
  const currentChapterIndex = useMemo(() => {
    let pick = -1;
    for (let i = 0; i < chapters.length; i += 1) {
      const chapter = chapters[i];
      if (chapter.fileIndex !== fileIndex) {
        if (chapter.fileIndex > fileIndex) break;
        continue;
      }
      if (pick === -1) pick = i; // first chapter in this file
      if (currentTime + 0.25 >= chapter.startOffset) pick = i;
      else break;
    }
    return pick;
  }, [chapters, fileIndex, currentTime]);

  const currentChapter = chapters[currentChapterIndex];
  // Books with embedded markers (m4b) have real chapters; multi-file books are just
  // tracks (one file each). Label by what's actually navigated so a 55-track book
  // doesn't call track 5 "Chapter 5".
  const navUnitLabel = chapters.length > availableFiles.length ? t("reader:player.chapter") : t("reader:player.track");

  const chapterProgressFor = (chapter: FlatChapter, index: number) => {
    const span = Math.max(0, chapter.endOffset - chapter.startOffset);
    if (index < currentChapterIndex) return { seconds: span, percent: 1 };
    if (index > currentChapterIndex) return { seconds: 0, percent: 0 };
    if (span <= 0) return { seconds: 0, percent: 0 };
    const seconds = Math.max(0, Math.min(currentTime - chapter.startOffset, span));
    return { seconds, percent: Math.min(seconds / span, 1) };
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
    const label = currentChapter?.title || currentFile.relativePath.split("/").at(-1) || t("reader:player.chapterN", { num: fileIndex + 1 });
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
      setPlayerError(t("reader:player.unableSaveBookmark"));
    }
  }, [book.id, currentFile, currentChapter, fileIndex, t, audioRef, setPlayerError]);

  const saveBookmarkNote = useCallback(async (id: string, note: string) => {
    try {
      const { bookmark } = await api<{ bookmark: BookmarkEntry }>(`/api/library/books/${book.id}/bookmarks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ note })
      });
      setBookmarks((prev) => prev.map((b) => (b.id === id ? bookmark : b)));
      setEditingBookmarkId(null);
    } catch {
      setPlayerError(t("reader:player.unableSaveNote"));
    }
  }, [book.id, t, setPlayerError]);

  const deleteBookmark = useCallback(async (id: string) => {
    try {
      await api(`/api/library/books/${book.id}/bookmarks/${id}`, { method: "DELETE" });
      setBookmarks((prev) => prev.filter((b) => b.id !== id));
      setEditingBookmarkId((current) => (current === id ? null : current));
    } catch {
      setPlayerError(t("reader:player.unableDeleteBookmark"));
    }
  }, [book.id, t, setPlayerError]);

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
  }, [fileIndex, fileDuration, availableFiles, currentFile, playing, saveProgress, audioRef, setCurrentTime]);

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
  }, [fileIndex, playing, audioRef, setCurrentTime]);

  // Seek to a chapter, switching files first when it lives in a different one.
  const goToChapter = useCallback((index: number) => {
    const chapter = chapters[index];
    if (!chapter) return;
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
    seekTo(chapter.fileIndex, chapter.startOffset);
  }, [chapters, currentFile, saveProgress, seekTo, audioRef]);

  // Jump and close the sheet. The setter is named in the deps for the same reason as
  // the ones above — stable, but only a reader who knows that can tell.
  const jumpToChapter = useCallback((index: number) => {
    goToChapter(index);
    setChaptersOpen(false);
  }, [goToChapter, setChaptersOpen]);

  const jumpToBookmark = useCallback((bookmark: BookmarkEntry) => {
    const index = availableFiles.findIndex((f) => f.id === bookmark.fileId);
    if (index < 0) return;
    if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
    seekTo(index, bookmark.positionSeconds);
    setBookmarksOpen(false);
  }, [availableFiles, currentFile, saveProgress, seekTo, audioRef, setBookmarksOpen]);

  // The position on leaving: the page going away (beforeunload) or the player
  // unmounting. Same store as every other save — local row plus the server
  // through api(), which carries the CSRF header a bare fetch would lack — with
  // keepalive so the request outlives the page.
  useEffect(() => {
    const saveCurrentProgress = () => {
      if (!currentFile || !audioRef.current) return;
      void persistProgress(book.id, currentFile.id, audioRef.current.currentTime, { keepalive: true });
    };
    const handleBeforeUnload = () => { saveCurrentProgress(); };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      saveCurrentProgress();
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [book.id, currentFile, audioRef]);

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
      // load() resets playbackRate to defaultPlaybackRate, so the speed must be the
      // default too, or the new chapter plays at 1× under a button saying otherwise.
      audio.defaultPlaybackRate = playbackRate;
      audio.playbackRate = playbackRate;
      audio.load();
      if (shouldAutoPlayRef.current) {
        shouldAutoPlayRef.current = false;
        audio.play().catch(() => {});
      }
    });

    return () => { cancelled = true; };
    // Keyed on the chapter alone, deliberately. Everything else this reads — the
    // file it resolves to, the chosen speed, the setters — is either derived from
    // fileIndex or stable, and re-running on any of them would re-src the element
    // mid-listen: the position resets to 0 and playback stops. A speed change is
    // applied to the live element by changeRate(); it must not reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIndex, book.id]);

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
  }, [book.id]);

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
    // Once, on open: where to resume is a question asked when the player appears.
    // Re-asking it after the listener has moved would drag them back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!playing) {
      if (saveIntervalRef.current) clearInterval(saveIntervalRef.current);
      return;
    }
    saveIntervalRef.current = window.setInterval(() => {
      if (audioRef.current && currentFile) saveProgress(currentFile, audioRef.current.currentTime);
    }, 10000);
    return () => { if (saveIntervalRef.current) clearInterval(saveIntervalRef.current); };
  }, [playing, currentFile, saveProgress, audioRef]);

  useEffect(() => {
    if (!speedOpen) return;
    const close = () => setSpeedOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [speedOpen, setSpeedOpen]);

  useEffect(() => {
    if (!sleepOpen) return;
    const close = () => setSleepOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [sleepOpen, setSleepOpen]);

  // Sleep timer ("end of chapter"): pause once playback crosses out of the chapter
  // that was active when the timer was armed.
  useEffect(() => {
    if (sleepMode !== "chapter") return;
    const target = sleepChapterTargetRef.current;
    if (target !== null && currentChapterIndex > target) {
      audioRef.current?.pause();
      setSleepMode("off");
      sleepChapterTargetRef.current = null;
    }
  }, [sleepMode, currentChapterIndex, audioRef, setSleepMode]);

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
    } else if (onEndReached) {
      setPlaying(false);
      onEndReached();
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
    if (code === 3) setPlayerError(t("reader:player.decodeError"));
    else if (code === 2) setPlayerError(t("reader:player.networkError"));
    else setPlayerError(t("reader:player.unablePlayFile"));
  }, [t, audioRef, setPlayerError, setPlaying]);

  const goToPrev = () => {
    const audio = audioRef.current;
    if (!audio || !currentChapter) return;
    // Past the first few seconds of a chapter, "previous" restarts it; otherwise it
    // steps to the previous chapter (which may live in the previous file).
    if (audio.currentTime > currentChapter.startOffset + 3) {
      seekTo(currentChapter.fileIndex, currentChapter.startOffset);
    } else if (currentChapterIndex > 0) {
      goToChapter(currentChapterIndex - 1);
    } else {
      seekTo(currentChapter.fileIndex, currentChapter.startOffset);
    }
  };

  const goToNext = () => {
    if (currentChapterIndex >= 0 && currentChapterIndex < chapters.length - 1) {
      goToChapter(currentChapterIndex + 1);
    }
  };

  const changeRate = (rate: number) => {
    playback.changeRate(rate);
    updateMediaPositionState();
  };

  const toggleSpeedMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSpeedOpen((open) => !open);
  };
  const toggleSleepMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSleepOpen((open) => !open);
  };
  const chooseSleep = (mode: SleepMode) => {
    playback.chooseSleep(mode);
    sleepChapterTargetRef.current = mode === "chapter" ? currentChapterIndex : null;
  };

  // Keep the lock-screen action handlers pointed at the latest closures. Written
  // after the commit rather than during the render: the readers are the OS media
  // buttons, and nothing can press one before the frame is on screen.
  useEffect(() => {
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
  });

  // Publish "now playing" metadata (cover, chapter, author) per chapter.
  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentFile) return;
    const chapterTitle = currentChapter?.title || currentFile.relativePath.split("/").at(-1) || t("reader:player.chapterN", { num: fileIndex + 1 });
    const cover = book.coverLargeUrl ?? book.coverUrl;
    const artwork = cover
      ? [{ src: new URL(cover, window.location.origin).href, sizes: "512x512", type: "image/jpeg" }]
      : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapterTitle,
        artist: book.authors.join(", ") || t("reader:player.unknownAuthor"),
        album: book.title,
        artwork
      });
    } catch { /* unsupported metadata */ }
    // Keyed on which chapter is playing, not on the objects that describe it: the
    // file and chapter are found afresh on every render, so listing them would
    // hand the OS a new MediaMetadata several times a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, fileIndex, currentChapterIndex]);

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

  const chapterList = chapters.map((chapter, index) => {
    const progress = chapterProgressFor(chapter, index);
    const span = Math.max(0, chapter.endOffset - chapter.startOffset);
    return (
      <Button
        variant="bare"
        key={`${chapter.fileId}-${index}`}
        className={`player-chapter-item${index === currentChapterIndex ? " active" : ""}${progress.percent >= 0.98 ? " complete" : ""}`}
        aria-current={index === currentChapterIndex ? "true" : undefined}
        // jumpToChapter reaches the <audio> element through its ref; a click on a
        // chapter row is as far from render as an interaction gets.
        // eslint-disable-next-line react-hooks/refs
        onClick={() => jumpToChapter(index)}
      >
        <span className="player-chapter-item-num">
          <ProgressRing progress={progress.percent} complete={progress.percent >= 0.98} center={index + 1} size={28} />
        </span>
        <span className="player-chapter-item-main">
          <span className="player-chapter-item-title">{chapter.title}</span>
        </span>
        {span > 0 && (
          <span className="player-chapter-item-dur">
            {progress.seconds > 0 && progress.percent < 0.98
              ? `${formatTime(progress.seconds)} / ${formatTime(span)}`
              : formatTime(span)}
          </span>
        )}
      </Button>
    );
  });

  const speedMenu = speedOpen && (
    <div id={speedMenuId} className="player-speed-menu" onClick={(e) => e.stopPropagation()}>
      {RATES.map((rate) => (
        <Button
          variant="bare"
          key={rate}
          className={cx("player-speed-option", playbackRate === rate && "active")}
          onClick={() => changeRate(rate)}
          aria-pressed={playbackRate === rate}
        >
          {rateLabel(rate)}
        </Button>
      ))}
    </div>
  );

  // Compact label for the armed sleep timer: a live mm:ss countdown, or "Chapter".
  const sleepLabel = playback.sleepLabel(t("reader:player.chapter"));

  const sleepMenu = sleepOpen && (
    <div id={sleepMenuId} className="player-speed-menu player-sleep-menu" onClick={(e) => e.stopPropagation()}>
      <Button
        variant="bare"
        className={cx("player-speed-option", sleepMode === "off" && "active")}
        onClick={() => chooseSleep("off")}
        aria-pressed={sleepMode === "off"}
      >
        {t("reader:player.off")}
      </Button>
      {SLEEP_MINUTES.map((min) => (
        <Button
          variant="bare"
          key={min}
          className={cx("player-speed-option", sleepMode === min && "active")}
          onClick={() => chooseSleep(min)}
          aria-pressed={sleepMode === min}
        >
          {t("reader:player.min", { n: min })}
        </Button>
      ))}
      <Button
        variant="bare"
        className={cx("player-speed-option", sleepMode === "chapter" && "active")}
        onClick={() => chooseSleep("chapter")}
        aria-pressed={sleepMode === "chapter"}
      >
        {t("reader:player.endOfChapter")}
      </Button>
    </div>
  );

  const bookmarkList = (
    <div id={bookmarksId} className="player-bookmark-list">
      <Button variant="bare" className="player-bookmark-add" onClick={addBookmark}>
        <BookmarkPlus size={15} />
        <span>{bookmarkSaved ? t("reader:player.bookmarkAdded") : t("reader:player.bookmarkThisMoment")}</span>
      </Button>
      {bookmarks.length === 0 ? (
        <p className="player-bookmark-empty">{t("reader:player.noBookmarks")}</p>
      ) : (
        bookmarks.map((bm) => {
          const editing = editingBookmarkId === bm.id;
          return (
            <div className={`player-bookmark-item${editing ? " editing" : ""}`} key={bm.id}>
              <div className="player-bookmark-row">
                <Button variant="bare" className="player-bookmark-jump" onClick={() => jumpToBookmark(bm)} disabled={!availableFiles.some((f) => f.id === bm.fileId)}>
                  <Bookmark size={13} />
                  <span className="player-bookmark-time">{formatTime(bm.bookPositionSeconds ?? bm.positionSeconds)}</span>
                  <span className="player-bookmark-label">{bm.label || t("reader:player.bookmark")}</span>
                </Button>
                <div className="player-bookmark-actions">
                  <Button
                    variant="bare"
                    onClick={() => { setEditingBookmarkId(bm.id); setNoteDraft(bm.note ?? ""); }}
                    aria-label={t("reader:player.editNote")}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button variant="bare" onClick={() => deleteBookmark(bm.id)} aria-label={t("reader:player.deleteBookmark")}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
              {editing ? (
                <div className="player-bookmark-edit">
                  <textarea
                    className="player-bookmark-note-input"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder={t("reader:player.addNotePlaceholder")}
                    rows={2}
                    autoFocus
                  />
                  <div className="player-bookmark-edit-actions">
                    <Button variant="bare" className="player-bookmark-save" onClick={() => saveBookmarkNote(bm.id, noteDraft)}>{t("reader:player.save")}</Button>
                    <Button variant="bare" className="player-bookmark-cancel" onClick={() => setEditingBookmarkId(null)}>{t("common:common.cancel")}</Button>
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

  // The transport row, the same in the inline and the pop-out player.
  const controls = {
    playing,
    onTogglePlay: togglePlay,
    onPrev: goToPrev,
    onNext: goToNext,
    onSkip: skip,
    prevDisabled: currentChapterIndex <= 0 && currentTime <= 3,
    nextDisabled: currentChapterIndex >= chapters.length - 1,
    labels: {
      prev: t("reader:player.prevChapter"),
      next: t("reader:player.nextChapter"),
      back30: t("reader:player.skipBack30"),
      forward30: t("reader:player.skipForward30"),
      play: t("reader:player.play"),
      pause: t("reader:player.pause")
    }
  };

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
                <PieChart size={15} aria-hidden="true" /> {t("reader:player.percentComplete", { percent: bookPercent })}
              </span>
              <span className="player-popup-progress-sep" aria-hidden="true">•</span>
              <span className="player-popup-progress-item">
                <Clock size={15} aria-hidden="true" /> {formatTimeRemaining(totalDuration - bookPosition)}
              </span>
            </div>
          )}

          <div className="player-popup-chapter">
            <strong><Bookmark size={15} aria-hidden="true" /> {navUnitLabel} {currentChapterIndex + 1}</strong>
            <span>{currentChapter?.title || currentFile?.relativePath.split("/").at(-1) || ""}</span>
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
              aria-label={t("reader:player.seek")}
              style={{ ["--seek-fill" as string]: `${fileDuration > 0 ? (currentTime / fileDuration) * 100 : 0}%` }}
            />
            <div className="player-seek-times">
              <span className="player-time">{formatTime(currentTime)}</span>
              <span className="player-time">
                {fileDuration > currentTime ? `-${formatTime(fileDuration - currentTime)}` : formatTime(fileDuration)}
              </span>
            </div>
          </div>

          <PlayerControls layout="popup" {...controls} />

          <div className="player-volume-popup">
            <div className="player-volume-control">
              <Button variant="bare" className="player-vol-icon" onClick={toggleMute} aria-label={muted ? t("reader:player.unmute") : t("reader:player.mute")}>
                {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </Button>
              <input
                type="range"
                className="player-vol-slider"
                min={0}
                max={1}
                step={0.02}
                value={muted ? 0 : volume}
                onChange={handleVolumeChange}
                aria-label={t("reader:player.volume")}
                style={{ ["--volume-fill" as string]: `${(muted ? 0 : volume) * 100}%` }}
              />
              <Volume2 size={16} className="player-vol-max" aria-hidden="true" />
            </div>

            <div className="player-volume-menu player-speed">
              <Button
                variant="bare"
                className={`player-volume-action-btn${speedOpen ? " open" : ""}`}
                onClick={toggleSpeedMenu}
                aria-expanded={speedOpen}
                aria-controls={speedOpen ? speedMenuId : undefined}
                aria-label={t("reader:player.playbackSpeed")}
              >
                <span>{playbackRate === 1 ? "1.0×" : `${playbackRate}×`}</span>
              </Button>
              {speedMenu}
            </div>

            <div className="player-volume-menu player-speed">
              <Button
                variant="bare"
                className={`player-volume-action-btn${sleepOpen ? " open" : ""}${sleepMode !== "off" ? " active" : ""}`}
                onClick={toggleSleepMenu}
                aria-expanded={sleepOpen}
                aria-controls={sleepOpen ? sleepMenuId : undefined}
                aria-label={t("reader:player.sleepTimer")}
                // Armed, the button shows a countdown its fixed name hides; the
                // description carries it to a screen reader.
                aria-describedby={sleepLabel ? sleepStateId : undefined}
                title={t("reader:player.sleepTimer")}
              >
                <Moon size={15} aria-hidden="true" />
                <span id={sleepStateId}>{sleepLabel ?? t("reader:player.sleep")}</span>
              </Button>
              {sleepMenu}
            </div>
          </div>

          <div className="player-aux player-aux--popup">
            <div className="player-popup-aux-row">
              {onToggleSave && (
                <div className="player-popup-aux-item">
                  <Button
                    variant="bare"
                    className={`player-popup-aux-btn${saved ? " is-liked" : ""}`}
                    onClick={onToggleSave}
                    disabled={savingSave}
                    aria-pressed={saved ?? false}
                    aria-label={saved ? t("reader:player.unlike") : t("reader:player.like")}
                  >
                    <Heart size={18} fill={saved ? "currentColor" : "none"} />
                    <span className="player-popup-aux-label">{t("reader:player.like")}</span>
                  </Button>
                </div>
              )}

              {showBookmark && (
                <div className="player-popup-aux-item">
                  <Button
                    variant="bare"
                    className="player-popup-aux-btn"
                    onClick={() => setBookmarksOpen((o) => !o)}
                    aria-expanded={bookmarksOpen}
                    aria-controls={bookmarksOpen ? bookmarksId : undefined}
                    aria-label={t("reader:player.bookmarks")}
                  >
                    <Bookmark size={18} />
                    <span className="player-popup-aux-label">Bookmarks{bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}</span>
                  </Button>
                </div>
              )}

              <div className="player-popup-aux-item">
                <Button
                  variant="bare"
                  className={`player-popup-aux-btn${chaptersOpen ? " open" : ""}`}
                  onClick={() => setChaptersOpen((o) => !o)}
                  aria-expanded={chaptersOpen}
                  aria-controls={chaptersOpen ? chaptersId : undefined}
                  aria-label={t("reader:player.chapterList")}
                >
                  <List size={18} />
                  <span className="player-popup-aux-label">{t("reader:player.chapters")}</span>
                </Button>
              </div>
            </div>
          </div>

          {playerError && <MessageBox tone="error" title={t("reader:player.playbackError")}>{playerError}</MessageBox>}
        </div>

        {chaptersOpen && (
          <>
            <div className="chapter-sheet-backdrop" onClick={() => setChaptersOpen(false)} />
            <div id={chaptersId} className="chapter-sheet">
              <div className="chapter-sheet-drag" />
              <div className="chapter-sheet-header">
                <h3 className="chapter-sheet-title">{t("reader:player.chapters")}</h3>
                <Button variant="bare" className="chapter-sheet-close" onClick={() => setChaptersOpen(false)} aria-label={t("reader:player.closeChapters")}>
                  <X size={18} />
                </Button>
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
                <h3 className="chapter-sheet-title">{t("reader:player.bookmarks")}</h3>
                <Button variant="bare" className="chapter-sheet-close" onClick={() => setBookmarksOpen(false)} aria-label={t("reader:player.closeBookmarks")}>
                  <X size={18} />
                </Button>
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
        <span className="player-chapter-index">{navUnitLabel} {currentChapterIndex + 1} / {chapters.length}</span>
        <span className="player-chapter-title">
          {currentChapter?.title || currentFile?.relativePath.split("/").at(-1) || ""}
        </span>
      </div>

      <PlayerControls layout="bar" {...controls} />

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
          aria-label={t("reader:player.seek")}
        />
        <span className="player-time">{formatTime(fileDuration)}</span>
      </div>

      {totalDuration > 0 && (
        <div className="player-book-progress">
          <span className="player-time">{formatTime(bookPosition)}</span>
          <div className="player-book-bar" role="progressbar" aria-valuenow={bookPosition} aria-valuemax={totalDuration} aria-label={t("reader:player.bookProgress")}>
            <div className="player-book-bar-fill" style={{ width: `${Math.min(100, (bookPosition / totalDuration) * 100)}%` }} />
          </div>
          <span className="player-time">{formatTime(totalDuration)}</span>
        </div>
      )}

      <div className="player-aux">
        <div className="player-vol">
          <Button variant="bare" className="player-vol-icon" onClick={toggleMute} aria-label={muted ? t("reader:player.unmute") : t("reader:player.mute")}>
            {muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </Button>
          <input
            type="range"
            className="player-vol-slider"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={handleVolumeChange}
            aria-label={t("reader:player.volume")}
          />
        </div>

        <div className="player-speed">
          <Button
            variant="bare"
            className={`player-speed-btn${speedOpen ? " open" : ""}`}
            onClick={toggleSpeedMenu}
            aria-expanded={speedOpen}
            aria-controls={speedOpen ? speedMenuId : undefined}
            aria-label={t("reader:player.playbackSpeed")}
          >
            <span>{rateLabel(playbackRate)}</span>
            <ChevronDown size={13} />
          </Button>
          {speedMenu}
        </div>

        <div className="player-speed player-sleep">
          <Button
            variant="bare"
            className={`player-speed-btn${sleepOpen ? " open" : ""}${sleepMode !== "off" ? " active" : ""}`}
            onClick={toggleSleepMenu}
            aria-expanded={sleepOpen}
            aria-controls={sleepOpen ? sleepMenuId : undefined}
            aria-label={t("reader:player.sleepTimer")}
            aria-describedby={sleepLabel ? sleepStateId : undefined}
            title={t("reader:player.sleepTimer")}
          >
            <Moon size={15} />
            <span id={sleepStateId}>{sleepLabel ?? t("reader:player.sleep")}</span>
          </Button>
          {sleepMenu}
        </div>

        <Button
          variant="bare"
          className={`player-speed-btn${chaptersOpen ? " open" : ""}`}
          onClick={() => setChaptersOpen((o) => !o)}
          aria-expanded={chaptersOpen}
          aria-controls={chaptersOpen ? chaptersId : undefined}
          aria-label={t("reader:player.chapterList")}
        >
          <List size={15} />
          <span>{t("reader:player.chapters")}</span>
        </Button>

        {showBookmark && (
          <>
            <Button
              variant="bare"
              className={`player-speed-btn${bookmarksOpen ? " open" : ""}`}
              onClick={() => setBookmarksOpen((o) => !o)}
              aria-expanded={bookmarksOpen}
              aria-controls={bookmarksOpen ? bookmarksId : undefined}
              aria-label={t("reader:player.bookmarks")}
            >
              <Bookmark size={15} />
              <span>Bookmarks{bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}</span>
            </Button>
            {onToggleSave && (
              <Button
                variant="bare"
                className={`player-speed-btn${saved ? " is-liked" : ""}`}
                onClick={onToggleSave}
                disabled={savingSave}
                aria-pressed={saved ?? false}
                aria-label={saved ? t("reader:player.unlike") : t("reader:player.like")}
              >
                <Heart size={15} fill={saved ? "currentColor" : "none"} />
                <span>{saved ? t("reader:player.liked") : t("reader:player.like")}</span>
              </Button>
            )}
          </>
        )}
      </div>

      {chaptersOpen && (
        <div id={chaptersId} className="player-chapter-list">
          {chapterList}
        </div>
      )}

      {bookmarksOpen && bookmarkList}

      {playerError && <MessageBox tone="error" title={t("reader:player.playbackError")}>{playerError}</MessageBox>}
    </div>
  );
}
