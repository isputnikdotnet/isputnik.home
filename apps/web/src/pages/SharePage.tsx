import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Download, Headphones, Image as ImageIcon, List, Moon, Play, Volume2, VolumeX, X } from "lucide-react";
import { EbookReader } from "../features/audiobooks/reader/EbookReader";
import { PlayerControls } from "../features/audiobooks/PlayerControls";
import { RATES, rateLabel, SLEEP_MINUTES, usePlayback } from "../features/audiobooks/usePlayback";
import { StoryShareView, type StorySharePayload } from "./StoryShareView";
import { cx } from "../shared/cx";
import { formatClock } from "../shared/formatClock";
import { isFoliateFormat } from "../shared/utils";
// The guest pages' stylesheet, shared with DropPage: it loads with them, not on every route (docs/css-map.md).
import "../styles/share-page.css";
import { Button } from "../shared/Button";

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

type SharePayload = AudiobookSharePayload | EbookSharePayload | GallerySharePayload | GallerySetSharePayload | StorySharePayload;

export function SharePage({ token }: { token: string }) {
  const { t } = useTranslation(["common", "user"]);
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    fetch(`/api/share/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || t("user:sharePage.gone"));
        }
        return res.json() as Promise<SharePayload>;
      })
      .then((data) => {
        setPayload(data);
        const name = data.type === "gallery"
          ? data.asset.title
          : data.type === "story"
            ? data.story.title
            : data.type === "gallery_set"
              ? data.share.label ?? t("user:sharePage.sharedPhotos", { count: data.items.length })
              : data.book.title;
        document.title = t("user:sharePage.docTitle", { name });
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("user:sharePage.gone")));
  }, [token]);

  if (loadError) {
    return (
      <div className="share-page">
        <div className="share-card share-card--message">
          <BookOpen size={40} aria-hidden="true" />
          <h1>{t("user:sharePage.unavailableTitle")}</h1>
          <p className="muted">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="share-page">
        <div className="share-card share-card--message">
          <p className="muted">{t("user:common.loading")}</p>
        </div>
      </div>
    );
  }

  if (payload.type === "story") return <StoryShareView token={token} payload={payload} />;
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
  const { t } = useTranslation(["common", "user"]);
  const { items, share } = payload;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const open = openIndex != null ? items[openIndex] : null;

  useEffect(() => {
    if (openIndex == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return; // a dialog on top already answered it
      if (event.key === "Escape") setOpenIndex(null);
      else if (event.key === "ArrowRight") setOpenIndex((i) => (i != null && i < items.length - 1 ? i + 1 : i));
      else if (event.key === "ArrowLeft") setOpenIndex((i) => (i != null && i > 0 ? i - 1 : i));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIndex, items.length]);

  const heading = share.label ?? t("user:sharePage.sharedPhotos", { count: items.length });

  return (
    <div className="share-page">
      <div className="share-card share-card--set">
        <div className="share-book-header">
          <h1 className="share-title">{heading}</h1>
          {share.sharedBy && (
            <p className="share-shared-by">{t("user:sharePage.sharedTheseBy", { name: share.sharedBy, count: items.length })}</p>
          )}
          <p className="share-authors">{t("user:count.items", { count: items.length })}</p>
        </div>

        {items.length > 0 && (
          <div className="share-actions">
            <a className="primary-button" href={`/api/share/${token}/download-all`} download>
              <Download size={16} /><span>{t("user:sharePage.downloadAll")}</span>
            </a>
          </div>
        )}

        {items.length === 0 ? (
          <p className="muted">{t("user:sharePage.photosGone")}</p>
        ) : (
          <div className="share-set-grid">
            {items.map((item, index) => (
              <Button variant="tile" key={item.id} className="share-set-tile" onClick={() => setOpenIndex(index)} aria-label={t("user:viewer.openItem", { title: item.title })}>
                {item.coverUrl ? (
                  <img src={item.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="share-set-fallback"><ImageIcon size={24} aria-hidden="true" /></span>
                )}
                {item.kind === "video" && <span className="share-set-video-badge"><Play size={11} aria-hidden="true" />{t("user:viewer.video")}</span>}
              </Button>
            ))}
          </div>
        )}

        <p className="share-footer muted">
          <ImageIcon size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
          {t("user:sharePage.footer", { date: new Date(share.expiresAt).toLocaleDateString() })}
        </p>
      </div>

      {open && createPortal(
        <div className="share-set-viewer" role="dialog" aria-modal="true" aria-label={open.title}>
          <div className="share-set-viewer-head">
            <span className="share-set-viewer-title">{open.title}</span>
            <div className="share-set-viewer-actions">
              <a className="secondary-button compact-button" href={open.downloadUrl} download>
                <Download size={15} /><span>{t("user:actions.download")}</span>
              </a>
              <Button variant="icon" onClick={() => setOpenIndex(null)} aria-label={t("common:common.close")}>
                <X size={18} />
              </Button>
            </div>
          </div>
          <div className="share-set-viewer-body">
            {openIndex! > 0 && (
              <Button variant="bare" className="share-set-nav prev" onClick={() => setOpenIndex(openIndex! - 1)} aria-label={t("user:viewer.previous")}>
                <ChevronLeft size={26} />
              </Button>
            )}
            {open.kind === "video" ? (
              <video key={open.id} src={open.fileUrl} controls playsInline poster={open.previewUrl ?? undefined} />
            ) : (
              <img key={open.id} src={open.previewUrl ?? open.fileUrl} alt={open.title} />
            )}
            {openIndex! < items.length - 1 && (
              <Button variant="bare" className="share-set-nav next" onClick={() => setOpenIndex(openIndex! + 1)} aria-label={t("user:viewer.next")}>
                <ChevronRight size={26} />
              </Button>
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
  const { t } = useTranslation(["common", "user"]);
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
            <p className="share-shared-by">
              {t(asset.kind === "video" ? "user:sharePage.sharedVideoBy" : "user:sharePage.sharedPhotoBy", { name: share.sharedBy })}
            </p>
          )}
          <p className="share-authors">{asset.kind === "video" ? t("user:viewer.video") : t("user:viewer.photo")}</p>
        </div>

        <div className="share-actions">
          <a className="primary-button" href={downloadUrl} download>
            <Download size={16} /><span>{t("user:actions.download")}</span>
          </a>
        </div>

        {asset.description && <p className="share-description">{asset.description}</p>}

        <p className="share-footer muted">
          <ImageIcon size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 4 }} />
          {t("user:sharePage.footer", { date: new Date(share.expiresAt).toLocaleDateString() })}
        </p>
      </div>
    </div>
  );
}

// --- Ebook share: a landing card that opens the in-browser reader (EPUB) or the
// browser's native viewer (PDF). The whole file is delivered to read it, so Read
// and Download are peers — neither protects the content more than the other.
function EbookShareView({ token, payload }: { token: string; payload: EbookSharePayload }) {
  const { t } = useTranslation(["common", "user"]);
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
            <Button variant="primary" onClick={() => setReading(true)}>
              <BookOpen size={16} /><span>{t("common:home.read")}</span>
            </Button>
            <a className="secondary-button" href={downloadUrl} download>
              <Download size={16} /><span>{t("user:actions.download")}</span>
            </a>
          </div>

          {book.description && <p className="share-description">{book.description}</p>}

          <p className="share-footer muted">{t("user:sharePage.footer", { date: new Date(share.expiresAt).toLocaleDateString() })}</p>
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
                <Download size={15} /><span>{t("user:actions.download")}</span>
              </a>
              <Button variant="icon" onClick={() => setReading(false)} aria-label={t("common:common.close")}>
                <X size={18} />
              </Button>
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
  const { t } = useTranslation(["common", "user"]);
  const { book, share } = payload;
  // The element layer is the book player's own (features/audiobooks/usePlayback);
  // what a guest gets on top is simpler — each shared file is one chapter, and no
  // position, bookmark or lock-screen state is kept for them.
  const playback = usePlayback({ playErrorMessage: () => t("user:sharePage.audioFormatError") });
  const {
    audioRef, playing, setPlaying, currentTime, setCurrentTime, fileDuration, setFileDuration,
    playerError, setPlayerError, togglePlay, handleSeek, playbackRate, changeRate, volume, muted,
    toggleMute, handleVolumeChange, speedOpen, setSpeedOpen, sleepOpen, setSleepOpen, sleepMode, setSleepMode, chooseSleep
  } = playback;
  const autoPlayRef = useRef(false);

  const [fileIndex, setFileIndex] = useState(0);
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

  // A new src resets the element — put the volume and speed back after each load.
  useEffect(() => { playback.applySettings(); }, [fileIndex]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Close the speed / sleep / chapters menus on any outside click.
  useEffect(() => {
    if (!speedOpen && !sleepOpen && !chaptersOpen) return;
    const close = () => { setSpeedOpen(false); setSleepOpen(false); setChaptersOpen(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [speedOpen, sleepOpen, chaptersOpen]);

  const toggleSpeedMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSleepOpen(false);
    setChaptersOpen(false);
    setSpeedOpen((open) => !open);
  };
  const toggleSleepMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSpeedOpen(false);
    setChaptersOpen(false);
    setSleepOpen((open) => !open);
  };

  // Compact label for an armed timer: a live mm:ss countdown, or "Chapter".
  const sleepLabel = playback.sleepLabel(t("user:sharePage.chapter"));

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
          {book.narrators.length > 0 && <p className="share-narrators">{t("user:sharePage.narratedBy", { names: book.narrators.join(", ") })}</p>}
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
          onError={() => { setPlaying(false); setPlayerError(t("user:sharePage.audioFormatError")); }}
        />

        {currentFile && (
          <div className="share-chapter">
            <strong>{t("user:sharePage.chapterOf", { current: fileIndex + 1, total: files.length })}</strong>
            <span>{currentFile.chapterTitle || t("user:sharePage.chapterN", { n: fileIndex + 1 })}</span>
          </div>
        )}

        <div className="share-seek">
          <span className="player-time">{formatClock(currentTime)}</span>
          <input
            type="range"
            className="player-seekbar"
            min={0}
            max={fileDuration || 0}
            step={1}
            value={currentTime}
            onChange={handleSeek}
            aria-label={t("user:sharePage.seek")}
            style={{
              // Unplayed track uses a translucent --ink so it stays visible on light
              // themes (a hardcoded white was invisible against the light card).
              background: `linear-gradient(90deg, var(--mint), var(--gold) ${seekPct}%, var(--player-track-strong) ${seekPct}%)`
            }}
          />
          <span className="player-time">{formatClock(fileDuration)}</span>
        </div>

        <PlayerControls
          layout="share"
          playing={playing}
          onTogglePlay={togglePlay}
          onPrev={goToPrev}
          onNext={goToNext}
          onSkip={skip}
          prevDisabled={fileIndex === 0 && currentTime <= 3}
          nextDisabled={fileIndex >= files.length - 1}
          labels={{
            prev: t("user:sharePage.prevChapter"),
            next: t("user:sharePage.nextChapter"),
            back30: t("user:sharePage.back30"),
            forward30: t("user:sharePage.fwd30"),
            play: t("user:sharePage.play"),
            pause: t("user:sharePage.pause")
          }}
        />

        <div className="share-tools">
          <div className="share-vol">
            <Button variant="bare" className="player-vol-icon" onClick={toggleMute} aria-label={muted ? t("user:sharePage.unmute") : t("user:sharePage.mute")}>
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
              aria-label={t("user:sharePage.volume")}
            />
          </div>

          <div className="share-menu-anchor">
            <Button
              variant="bare"
              className={cx("share-tool-btn", speedOpen && "open")}
              onClick={toggleSpeedMenu}
              aria-expanded={speedOpen}
              aria-label={t("user:sharePage.speed")}
              title={t("user:sharePage.speed")}
            >
              <span>{rateLabel(playbackRate)}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
            {speedOpen && (
              <div className="share-menu" onClick={(e) => e.stopPropagation()}>
                {RATES.map((rate) => (
                  <Button
                    variant="bare"
                    key={rate}
                    className={cx("share-menu-option", playbackRate === rate && "active")}
                    onClick={() => changeRate(rate)}
                    aria-pressed={playbackRate === rate}
                  >
                    {rateLabel(rate)}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="share-menu-anchor">
            <Button
              variant="bare"
              className={cx("share-tool-btn", sleepOpen && "open", sleepMode !== "off" && "active")}
              onClick={toggleSleepMenu}
              aria-expanded={sleepOpen}
              aria-label={t("user:sharePage.sleepTimer")}
              title={t("user:sharePage.sleepTimer")}
            >
              <Moon size={15} aria-hidden="true" />
              <span>{sleepLabel ?? t("user:sharePage.sleep")}</span>
            </Button>
            {sleepOpen && (
              <div className="share-menu" onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="bare"
                  className={cx("share-menu-option", sleepMode === "off" && "active")}
                  onClick={() => chooseSleep("off")}
                  aria-pressed={sleepMode === "off"}
                >
                  {t("user:sharePage.off")}
                </Button>
                {SLEEP_MINUTES.map((min) => (
                  <Button
                    variant="bare"
                    key={min}
                    className={cx("share-menu-option", sleepMode === min && "active")}
                    onClick={() => chooseSleep(min)}
                    aria-pressed={sleepMode === min}
                  >
                    {t("user:sharePage.min", { count: min })}
                  </Button>
                ))}
                <Button
                  variant="bare"
                  className={cx("share-menu-option", sleepMode === "chapter" && "active")}
                  onClick={() => chooseSleep("chapter")}
                  aria-pressed={sleepMode === "chapter"}
                >
                  {t("user:sharePage.endOfChapter")}
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="share-actions">
          {files.length > 1 && (
            <div className="share-menu-anchor">
              <Button variant="secondary" onClick={toggleChapters} aria-expanded={chaptersOpen}>
                <List size={16} /><span>{t("user:sharePage.chapters")}</span>
              </Button>
              {chaptersOpen && (
                <div className="share-chapter-menu" onClick={(e) => e.stopPropagation()}>
                  {files.map((file, index) => (
                    <Button
                      variant="bare"
                      key={file.id}
                      className={cx("share-chapter-item", index === fileIndex && "active")}
                      onClick={() => jumpToChapter(index)}
                    >
                      <span className="share-chapter-num">{index + 1}</span>
                      <span className="share-chapter-name">{file.chapterTitle || t("user:sharePage.chapterN", { n: index + 1 })}</span>
                      {file.durationSeconds != null && (
                        <span className="share-chapter-dur">{formatClock(file.durationSeconds)}</span>
                      )}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
          <a className="secondary-button" href={`/api/share/${token}/download`} download>
            <Download size={16} /><span>{t("user:actions.download")}</span>
          </a>
        </div>

        {playerError && <p className="share-player-error">{playerError}</p>}

        {book.description && <p className="share-description">{book.description}</p>}

        <p className="share-footer muted">{t("user:sharePage.footer", { date: new Date(share.expiresAt).toLocaleDateString() })}</p>
      </div>
    </div>
  );
}
