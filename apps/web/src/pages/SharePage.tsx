import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Download, FastForward, Headphones, Image as ImageIcon, List, Moon, Pause, Play, Rewind, SkipBack, SkipForward, Volume2, VolumeX, X } from "lucide-react";
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
  // Display name of the member who created the link, or null if their account is gone.
  sharedBy: string | null;
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

interface GallerySharePayload {
  type: "gallery";
  share: ShareInfo;
  asset: {
    title: string;
    kind: "photo" | "video";
    description: string | null;
    coverUrl: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
  };
}

// A multi-photo quick link. Every URL is token-scoped and per-item.
interface GallerySetItem {
  id: string;
  title: string;
  kind: "photo" | "video";
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  takenAt: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
  fileUrl: string;
  downloadUrl: string;
}

interface GallerySetSharePayload {
  type: "gallery_set";
  share: ShareInfo;
  items: GallerySetItem[];
}

type SharePayload = AudiobookSharePayload | EbookSharePayload | GallerySharePayload | GallerySetSharePayload;

function formatTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Sleep-timer options for the guest player. Numeric values are minutes; "chapter"
// stops at the end of the chapter (each shared file is one chapter) that is playing
// when the timer is armed.
const SLEEP_MINUTES = [15, 30, 45, 60] as const;
type SleepMode = "off" | "chapter" | (typeof SLEEP_MINUTES)[number];

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

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
        const name = data.type === "gallery"
          ? data.asset.title
          : data.type === "gallery_set"
            ? data.share.label ?? `${data.items.length} shared ${data.items.length === 1 ? "photo" : "photos"}`
            : data.book.title;
        document.title = `${name} — shared on isputnik.home`;
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

  if (payload.type === "gallery") return <GalleryShareView token={token} payload={payload} />;
  if (payload.type === "gallery_set") return <GallerySetShareView token={token} payload={payload} />;
  return payload.type === "ebook"
    ? <EbookShareView token={token} payload={payload} />
    : <AudiobookShareView token={token} payload={payload} />;
}

// --- Gallery set share (quick link): a photo grid with a lightweight viewer.
// Prev/next and Escape work from the keyboard; each item downloads individually,
// and "Download all" zips the whole set.
function GallerySetShareView({ token, payload }: { token: string; payload: GallerySetSharePayload }) {
  const { items, share } = payload;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex != null ? items[openIndex] : null;

  useEffect(() => {
    if (openIndex == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenIndex(null);
      else if (event.key === "ArrowRight") setOpenIndex((i) => (i != null && i < items.length - 1 ? i + 1 : i));
      else if (event.key === "ArrowLeft") setOpenIndex((i) => (i != null && i > 0 ? i - 1 : i));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIndex, items.length]);

  const heading = share.label ?? `${items.length} shared ${items.length === 1 ? "photo" : "photos"}`;

  return (
    <div className="share-page">
      <div className="share-card share-card--set">
        <div className="share-book-header">
          <h1 className="share-title">{heading}</h1>
          {share.sharedBy && (
            <p className="share-shared-by">{share.sharedBy} shared these {items.length === 1 ? "photo" : "photos"} with you</p>
          )}
          <p className="share-authors">{items.length} {items.length === 1 ? "item" : "items"}</p>
        </div>

        {items.length > 0 && (
          <div className="share-actions">
            <a className="primary-button" href={`/api/share/${token}/download-all`} download>
              <Download size={16} /><span>Download all</span>
            </a>
          </div>
        )}

        {items.length === 0 ? (
          <p className="muted">The shared photos are no longer available.</p>
        ) : (
          <div className="share-set-grid">
            {items.map((item, index) => (
              <button key={item.id} type="button" className="share-set-tile" onClick={() => setOpenIndex(index)} aria-label={`Open ${item.title}`}>
                {item.coverUrl ? (
                  <img src={item.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="share-set-fallback"><ImageIcon size={24} aria-hidden="true" /></span>
                )}
                {item.kind === "video" && <span className="share-set-video-badge"><Play size={11} aria-hidden="true" />Video</span>}
              </button>
            ))}
          </div>
        )}

        <p className="share-footer muted">
          <ImageIcon size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
          Shared via isputnik.home · link expires {new Date(share.expiresAt).toLocaleDateString()}
        </p>
      </div>

      {open && createPortal(
        <div className="share-set-viewer" role="dialog" aria-modal="true" aria-label={open.title}>
          <div className="share-set-viewer-head">
            <span className="share-set-viewer-title">{open.title}</span>
            <div className="share-set-viewer-actions">
              <a className="secondary-button compact-button" href={open.downloadUrl} download>
                <Download size={15} /><span>Download</span>
              </a>
              <button className="icon-button" onClick={() => setOpenIndex(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
          </div>
          <div className="share-set-viewer-body">
            {openIndex! > 0 && (
              <button className="share-set-nav prev" onClick={() => setOpenIndex(openIndex! - 1)} aria-label="Previous">
                <ChevronLeft size={26} />
              </button>
            )}
            {open.kind === "video" ? (
              <video key={open.id} src={open.fileUrl} controls playsInline poster={open.previewUrl ?? undefined} />
            ) : (
              <img key={open.id} src={open.previewUrl ?? open.fileUrl} alt={open.title} />
            )}
            {openIndex! < items.length - 1 && (
              <button className="share-set-nav next" onClick={() => setOpenIndex(openIndex! + 1)} aria-label="Next">
                <ChevronRight size={26} />
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// --- Gallery share: a single photo or video shown full-bleed in the card, with a
// download. The whole file is delivered to view it, so view and download are peers.
function GalleryShareView({ token, payload }: { token: string; payload: GallerySharePayload }) {
  const { asset, share } = payload;
  const fileUrl = `/api/share/${token}/file`;
  const downloadUrl = `/api/share/${token}/download`;

  return (
    <div className="share-page">
      <div className="share-card">
        <div className="share-gallery-media">
          {asset.kind === "video" ? (
            <video src={fileUrl} controls playsInline poster={asset.coverUrl ?? undefined} />
          ) : (
            <img src={fileUrl} alt={asset.title} />
          )}
        </div>

        <div className="share-book-header">
          <h1 className="share-title">{asset.title}</h1>
          {share.sharedBy && (
            <p className="share-shared-by">{share.sharedBy} shared this {asset.kind === "video" ? "video" : "photo"} with you</p>
          )}
          <p className="share-authors">{asset.kind === "video" ? "Video" : "Photo"}</p>
        </div>

        <div className="share-actions">
          <a className="primary-button" href={downloadUrl} download>
            <Download size={16} /><span>Download</span>
          </a>
        </div>

        {asset.description && <p className="share-description">{asset.description}</p>}

        <p className="share-footer muted">
          <ImageIcon size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
          Shared via isputnik.home · link expires {new Date(share.expiresAt).toLocaleDateString()}
        </p>
      </div>
    </div>
  );
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
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [sleepMode, setSleepMode] = useState<SleepMode>("off");
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);
  const [sleepOpen, setSleepOpen] = useState(false);

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
  const toggleChapters = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSpeedOpen(false);
    setSleepOpen(false);
    setChaptersOpen((open) => !open);
  };

  // Apply volume/mute to the element whenever they change (and after a new src loads,
  // since the element resets — the load effect re-runs and this covers the value).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = muted ? 0 : volume;
    audio.muted = muted;
  }, [volume, muted, fileIndex]);

  // Apply the playback rate live and re-apply after a new file loads (the element
  // resets its rate to 1 on a new src).
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate, fileIndex]);

  // Close the speed / sleep / chapters menus on any outside click.
  useEffect(() => {
    if (!speedOpen && !sleepOpen && !chaptersOpen) return;
    const close = () => { setSpeedOpen(false); setSleepOpen(false); setChaptersOpen(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [speedOpen, sleepOpen, chaptersOpen]);

  // Timed sleep modes: tick down once a second while playing, then pause and disarm.
  // Counting only while playing means a manual pause also pauses the timer.
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

  const toggleMute = () => setMuted((m) => !m);
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolume(v);
    if (v > 0) setMuted(false);
  };
  const toggleSpeedMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSleepOpen(false);
    setChaptersOpen(false);
    setSpeedOpen((open) => !open);
  };
  const changeRate = (rate: number) => {
    setPlaybackRate(rate);
    setSpeedOpen(false);
  };
  const toggleSleepMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSpeedOpen(false);
    setChaptersOpen(false);
    setSleepOpen((open) => !open);
  };
  const chooseSleep = (mode: SleepMode) => {
    setSleepMode(mode);
    setSleepRemaining(typeof mode === "number" ? mode * 60 : null);
    setSleepOpen(false);
  };

  // Compact label for an armed timer: a live mm:ss countdown, or "Chapter".
  const sleepLabel = sleepMode === "off"
    ? null
    : sleepMode === "chapter"
      ? "Chapter"
      : formatTime(sleepRemaining ?? sleepMode * 60);

  const seekPct = fileDuration > 0 ? Math.min(100, (currentTime / fileDuration) * 100) : 0;

  return (
    <div className="share-page">
      <div className="share-card share-card--player">
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
            // End-of-chapter sleep: stop here instead of auto-advancing.
            if (sleepMode === "chapter") {
              setPlaying(false);
              setSleepMode("off");
            } else if (fileIndex < files.length - 1) {
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
              // Unplayed track uses a translucent --ink so it stays visible on light
              // themes (a hardcoded white was invisible against the light card).
              background: `linear-gradient(90deg, var(--mint), var(--gold) ${seekPct}%, var(--player-track-strong) ${seekPct}%)`
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

        <div className="share-tools">
          <div className="share-vol">
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

          <div className="share-menu-anchor">
            <button
              className={`share-tool-btn${speedOpen ? " open" : ""}`}
              onClick={toggleSpeedMenu}
              aria-expanded={speedOpen}
              aria-label="Playback speed"
              title="Playback speed"
            >
              <span>{playbackRate === 1 ? "1×" : `${playbackRate}×`}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {speedOpen && (
              <div className="share-menu" onClick={(e) => e.stopPropagation()}>
                {RATES.map((rate) => (
                  <button
                    key={rate}
                    className={`share-menu-option${playbackRate === rate ? " active" : ""}`}
                    onClick={() => changeRate(rate)}
                    aria-pressed={playbackRate === rate}
                  >
                    {rate === 1 ? "1×" : `${rate}×`}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="share-menu-anchor">
            <button
              className={`share-tool-btn${sleepOpen ? " open" : ""}${sleepMode !== "off" ? " active" : ""}`}
              onClick={toggleSleepMenu}
              aria-expanded={sleepOpen}
              aria-label="Sleep timer"
              title="Sleep timer"
            >
              <Moon size={15} aria-hidden="true" />
              <span>{sleepLabel ?? "Sleep"}</span>
            </button>
            {sleepOpen && (
              <div className="share-menu" onClick={(e) => e.stopPropagation()}>
                <button
                  className={`share-menu-option${sleepMode === "off" ? " active" : ""}`}
                  onClick={() => chooseSleep("off")}
                  aria-pressed={sleepMode === "off"}
                >
                  Off
                </button>
                {SLEEP_MINUTES.map((min) => (
                  <button
                    key={min}
                    className={`share-menu-option${sleepMode === min ? " active" : ""}`}
                    onClick={() => chooseSleep(min)}
                    aria-pressed={sleepMode === min}
                  >
                    {min} min
                  </button>
                ))}
                <button
                  className={`share-menu-option${sleepMode === "chapter" ? " active" : ""}`}
                  onClick={() => chooseSleep("chapter")}
                  aria-pressed={sleepMode === "chapter"}
                >
                  End of chapter
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="share-actions">
          {files.length > 1 && (
            <div className="share-menu-anchor">
              <button className="secondary-button" onClick={toggleChapters} aria-expanded={chaptersOpen}>
                <List size={16} /><span>Chapters</span>
              </button>
              {chaptersOpen && (
                <div className="share-chapter-menu" onClick={(e) => e.stopPropagation()}>
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
            </div>
          )}
          <a className="secondary-button" href={`/api/share/${token}/download`} download>
            <Download size={16} /><span>Download</span>
          </a>
        </div>

        {playerError && <p className="share-player-error">{playerError}</p>}

        {book.description && <p className="share-description">{book.description}</p>}

        <p className="share-footer muted">Shared via isputnik.home · link expires {new Date(share.expiresAt).toLocaleDateString()}</p>
      </div>
    </div>
  );
}
