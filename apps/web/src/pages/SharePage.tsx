import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Download, FastForward, Headphones, List, Pause, Play, Rewind, SkipBack, SkipForward, X } from "lucide-react";
import { EbookReader } from "../features/audiobooks/reader/EbookReader";
import { isFoliateFormat } from "../shared/utils";

interface ShareFile {
  id: string;
  trackNumber: number | null;
  chapterTitle: string | null;
  durationSeconds: number | null;
}

interface ShareInfo {
  label: string | null;
  expiresAt: string;
}

interface AudiobookSharePayload {
  type: "audiobook";
  share: ShareInfo;
  book: {
    title: string;
    authors: string[];
    narrators: string[];
    description: string | null;
    durationSeconds: number | null;
    coverUrl: string | null;
    files: ShareFile[];
  };
}

interface EbookSharePayload {
  type: "ebook";
  share: ShareInfo;
  book: {
    title: string;
    authors: string[];
    description: string | null;
    coverUrl: string | null;
    format: string;
  };
}

type SharePayload = AudiobookSharePayload | EbookSharePayload;

function formatTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SharePage({ token }: { token: string }) {
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "This share is no longer available.");
        }
        return res.json() as Promise<SharePayload>;
      })
      .then((data) => {
        setPayload(data);
        document.title = `${data.book.title} — shared on isputnik.home`;
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : "This share is no longer available."));
  }, [token]);

  if (loadError) {
    return (
      <div className="share-page">
        <div className="share-card share-card--message">
          <BookOpen size={40} aria-hidden="true" />
          <h1>Share unavailable</h1>
          <p className="muted">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="share-page">
        <div className="share-card share-card--message">
          <p className="muted">Loading…</p>
        </div>
      </div>
    );
  }

  return payload.type === "ebook"
    ? <EbookShareView token={token} payload={payload} />
    : <AudiobookShareView token={token} payload={payload} />;
}

// --- Ebook share: a landing card that opens the in-browser reader (EPUB) or the
// browser's native viewer (PDF). The whole file is delivered to read it, so Read
// and Download are peers — neither protects the content more than the other.
function EbookShareView({ token, payload }: { token: string; payload: EbookSharePayload }) {
  const { book, share } = payload;
  const [reading, setReading] = useState(false);
  const fileUrl = `/api/share/${token}/file`;
  const downloadUrl = `/api/share/${token}/download`;
  // EPUB and FB2 render in the foliate reader; anything else (PDF) uses the iframe.
  const isReadable = isFoliateFormat(book.format);

  return (
    <>
      <div className="share-page">
        <div className="share-card">
          <div className="share-book-header">
            {book.coverUrl ? (
              <img src={book.coverUrl} alt="" className="share-cover" />
            ) : (
              <div className="share-cover share-cover--empty"><BookOpen size={48} /></div>
            )}
            <h1 className="share-title">{book.title}</h1>
            {book.authors.length > 0 && <p className="share-authors">{book.authors.join(", ")}</p>}
          </div>

          <div className="share-actions">
            <button className="primary-button" onClick={() => setReading(true)}>
              <BookOpen size={16} /><span>Read</span>
            </button>
            <a className="secondary-button" href={downloadUrl} download>
              <Download size={16} /><span>Download</span>
            </a>
          </div>

          {book.description && <p className="share-description">{book.description}</p>}

          <p className="share-footer muted">Shared via isputnik.home · link expires {new Date(share.expiresAt).toLocaleDateString()}</p>
        </div>
      </div>

      {reading && isReadable && createPortal(
        <EbookReader
          bookId="share"
          documentId="share"
          format={book.format}
          url={fileUrl}
          storageKey={`isputnik:epub-share:${token}`}
          initialProgress={null}
          title={book.title}
          author={book.authors.join(", ")}
          coverUrl={book.coverUrl}
          downloadUrl={downloadUrl}
          onExit={() => setReading(false)}
          guest
        />,
        document.body
      )}

      {reading && !isReadable && createPortal(
        <div className="share-doc-viewer" role="dialog" aria-modal="true" aria-label={book.title}>
          <div className="share-doc-viewer-head">
            <span className="share-doc-viewer-title">{book.title}</span>
            <div className="share-doc-viewer-actions">
              <a className="secondary-button compact-button" href={downloadUrl} download>
                <Download size={15} /><span>Download</span>
              </a>
              <button className="icon-button" onClick={() => setReading(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>
          <iframe className="share-doc-viewer-frame" src={fileUrl} title={book.title} />
        </div>,
        document.body
      )}
    </>
  );
}

// --- Audiobook share: a self-contained lightweight player (no progress sync for
// guests) plus a ZIP download.
function AudiobookShareView({ token, payload }: { token: string; payload: AudiobookSharePayload }) {
  const { book, share } = payload;
  const audioRef = useRef<HTMLAudioElement>(null);
  const autoPlayRef = useRef(false);
  const [playerError, setPlayerError] = useState("");

  const [fileIndex, setFileIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [fileDuration, setFileDuration] = useState(0);
  const [chaptersOpen, setChaptersOpen] = useState(false);

  const files = book.files;
  const currentFile = files[fileIndex];

  // Point the audio element at the current file. preload="none" means no request
  // until play() — each visit streams fresh (no progress is stored for guests).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentFile) return;
    setCurrentTime(0);
    setFileDuration(0);
    audio.src = `/api/share/${token}/stream/${currentFile.id}`;
    audio.load();
    if (autoPlayRef.current) {
      autoPlayRef.current = false;
      audio.play().catch(() => {});
    }
  }, [fileIndex, token, currentFile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) audio.pause();
    else { setPlayerError(""); audio.play().catch(() => setPlayerError("Your browser could not play this audio format.")); }
  };

  const goToPrev = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (currentTime > 3) {
      audio.currentTime = 0;
    } else if (fileIndex > 0) {
      autoPlayRef.current = playing;
      setFileIndex((i) => i - 1);
    }
  };

  const goToNext = () => {
    if (fileIndex < files.length - 1) {
      autoPlayRef.current = playing;
      setFileIndex((i) => i + 1);
    }
  };

  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.currentTime + seconds, fileDuration));
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (audioRef.current) audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const jumpToChapter = (index: number) => {
    autoPlayRef.current = playing;
    setFileIndex(index);
    setChaptersOpen(false);
  };

  const seekPct = fileDuration > 0 ? Math.min(100, (currentTime / fileDuration) * 100) : 0;

  return (
    <div className="share-page">
      <div className="share-card">
        <div className="share-book-header">
          {book.coverUrl ? (
            <img src={book.coverUrl} alt="" className="share-cover" />
          ) : (
            <div className="share-cover share-cover--empty"><Headphones size={48} /></div>
          )}
          <h1 className="share-title">{book.title}</h1>
          {book.authors.length > 0 && <p className="share-authors">{book.authors.join(", ")}</p>}
          {book.narrators.length > 0 && <p className="share-narrators">Narrated by {book.narrators.join(", ")}</p>}
        </div>

        <audio
          ref={audioRef}
          preload="none"
          onLoadedMetadata={() => setFileDuration(isFinite(audioRef.current?.duration ?? 0) ? audioRef.current!.duration : 0)}
          onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            if (fileIndex < files.length - 1) {
              autoPlayRef.current = true;
              setFileIndex((i) => i + 1);
            } else {
              setPlaying(false);
            }
          }}
          onError={() => { setPlaying(false); setPlayerError("Your browser could not play this audio format."); }}
        />

        {currentFile && (
          <div className="share-chapter">
            <strong>Chapter {fileIndex + 1} / {files.length}</strong>
            <span>{currentFile.chapterTitle || `Chapter ${fileIndex + 1}`}</span>
          </div>
        )}

        <div className="share-seek">
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
            style={{
              background: `linear-gradient(90deg, var(--mint), var(--gold) ${seekPct}%, rgba(255, 255, 255, 0.16) ${seekPct}%)`
            }}
          />
          <span className="player-time">{formatTime(fileDuration)}</span>
        </div>

        <div className="share-controls">
          <button className="player-btn" onClick={goToPrev} disabled={fileIndex === 0 && currentTime <= 3} aria-label="Previous chapter">
            <SkipBack size={20} />
          </button>
          <button className="player-btn player-btn-circle" onClick={() => skip(-30)} aria-label="Skip back 30 seconds">
            <Rewind size={15} /><span>30</span>
          </button>
          <button className="player-btn player-btn-primary" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <button className="player-btn player-btn-circle" onClick={() => skip(30)} aria-label="Skip forward 30 seconds">
            <FastForward size={15} /><span>30</span>
          </button>
          <button className="player-btn" onClick={goToNext} disabled={fileIndex >= files.length - 1} aria-label="Next chapter">
            <SkipForward size={20} />
          </button>
        </div>

        <div className="share-actions">
          {files.length > 1 && (
            <button className="secondary-button" onClick={() => setChaptersOpen((o) => !o)} aria-expanded={chaptersOpen}>
              <List size={16} /><span>Chapters</span>
            </button>
          )}
          <a className="secondary-button" href={`/api/share/${token}/download`} download>
            <Download size={16} /><span>Download</span>
          </a>
        </div>

        {chaptersOpen && files.length > 1 && (
          <div className="share-chapter-list">
            {files.map((file, index) => (
              <button
                key={file.id}
                className={`share-chapter-item${index === fileIndex ? " active" : ""}`}
                onClick={() => jumpToChapter(index)}
              >
                <span className="share-chapter-num">{index + 1}</span>
                <span className="share-chapter-name">{file.chapterTitle || `Chapter ${index + 1}`}</span>
                {file.durationSeconds != null && (
                  <span className="share-chapter-dur">{formatTime(file.durationSeconds)}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {playerError && <p className="share-player-error">{playerError}</p>}

        {book.description && <p className="share-description">{book.description}</p>}

        <p className="share-footer muted">Shared via isputnik.home · link expires {new Date(share.expiresAt).toLocaleDateString()}</p>
      </div>
    </div>
  );
}
