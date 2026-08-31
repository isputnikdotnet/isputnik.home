import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, MapPin, Mic, Pause, Play, Quote, UserRound, X } from "lucide-react";
import { GalleryMiniMap } from "../gallery/GalleryMiniMap";
import { StoryMarkdown } from "./StoryMarkdown";
import { formatPartialDate, formatPartialDateRange } from "../../shared/utils";
import {
  DEFAULT_PHOTO_SECONDS,
  slideSeconds,
  waitsForMedia,
  type PlayerSlide
} from "./story-player";

// Presentation mode: the story, full screen, advancing on its own. Built for a
// television or a tablet passed around the room, so the controls stay out of the
// way until the screen is touched and every one of them has a key as well.
//
// It sequences slides that story-player.ts prepared; it does not know whether
// they came from a signed-in page or a guest link.

/** Controls fade after this long without input, the way a video player's do. */
const IDLE_MS = 2600;

export function StoryPlayer({
  slides,
  title,
  photoSeconds = DEFAULT_PHOTO_SECONDS,
  onClose
}: {
  slides: PlayerSlide[];
  title: string;
  photoSeconds?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [idle, setIdle] = useState(false);
  const [done, setDone] = useState(false);
  const videoRef = useRef<HTMLMediaElement | null>(null);

  const slide = slides[index];
  const atEnd = index >= slides.length - 1;

  const go = useCallback((delta: number) => {
    setDone(false);
    setIndex((current) => {
      const next = current + delta;
      if (next < 0) return 0;
      if (next >= slides.length) return current;
      return next;
    });
  }, [slides.length]);

  // Advancing off the last slide ends the show rather than looping — a story has
  // a shape, and starting it over unasked is the wrong instinct for one.
  const advance = useCallback(() => {
    if (atEnd) { setDone(true); return; }
    go(1);
  }, [atEnd, go]);

  // The clock. A video is absent from it: it advances on `ended` instead, so a
  // clip is never cut off and never leaves the room waiting after it finishes.
  useEffect(() => {
    if (!slide || paused || done || waitsForMedia(slide)) return;
    const ms = slideSeconds(slide, photoSeconds) * 1000;
    const timer = window.setTimeout(advance, ms);
    return () => window.clearTimeout(timer);
  }, [slide, paused, done, photoSeconds, advance]);

  // Pausing the show pauses the clip that is playing, and vice versa.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) video.pause();
    else void video.play().catch(() => { /* autoplay refused; the viewer can tap */ });
  }, [paused, index]);

  // Preload the next photo so a slide change never shows an empty frame.
  useEffect(() => {
    const next = slides[index + 1];
    if (next?.kind === "media" && !next.isVideo) {
      const img = new Image();
      img.src = next.src;
    }
  }, [index, slides]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); advance(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
      else if (event.key === " ") { event.preventDefault(); setPaused((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, go, onClose]);

  // Controls retreat while the show runs and come back on any input.
  useEffect(() => {
    setIdle(false);
    if (paused || done) return;
    const timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [index, paused, done]);

  const wake = () => setIdle(false);

  if (!slide) return null;

  return createPortal(
    <div
      className={`story-player${idle ? " is-idle" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("stories:player.aria", { title })}
      onMouseMove={wake}
      onTouchStart={wake}
    >
      {/* Bar, stage, controls — in that order, because the stage takes the 1fr
          row and the two bars the auto rows around it. */}
      <div className="story-player-bar">
        <span className="story-player-title">{title}</span>
        <span className="story-player-count">{index + 1} / {slides.length}</span>
        <button className="icon-button" onClick={onClose} aria-label={t("stories:player.close")}>
          <X size={20} />
        </button>
      </div>

      <div className="story-player-stage" onClick={() => setPaused((p) => !p)}>
        {/* Keyed so React remounts on every slide — that is what restarts the
            fade, and what stops one video's element being reused by the next. */}
        <SlideView key={slide.id} slide={slide} videoRef={videoRef} onEnded={advance} />
      </div>

      {done && (
        <div className="story-player-end">
          <p>{t("stories:player.theEnd")}</p>
          <div className="story-player-end-actions">
            <button className="secondary-button" onClick={() => { setIndex(0); setDone(false); }}>
              {t("stories:player.again")}
            </button>
            <button className="primary-button" onClick={onClose}>
              {t("stories:player.close")}
            </button>
          </div>
        </div>
      )}

      <div className="story-player-controls">
        <button
          className="icon-button"
          onClick={() => go(-1)}
          disabled={index === 0}
          aria-label={t("stories:player.previous")}
        >
          <ChevronLeft size={22} />
        </button>
        <button
          className="icon-button"
          onClick={() => setPaused((p) => !p)}
          aria-label={paused ? t("stories:player.play") : t("stories:player.pause")}
        >
          {paused ? <Play size={22} /> : <Pause size={22} />}
        </button>
        <button
          className="icon-button"
          onClick={advance}
          disabled={done}
          aria-label={t("stories:player.next")}
        >
          <ChevronRight size={22} />
        </button>
      </div>

      {/* A quiet spine of where the show has got to. */}
      <div className="story-player-progress" aria-hidden="true">
        <span style={{ width: `${((index + 1) / slides.length) * 100}%` }} />
      </div>
    </div>,
    document.body
  );
}

function SlideView({
  slide,
  videoRef,
  onEnded
}: {
  slide: PlayerSlide;
  /** Shared by video and narration, so pausing the show pauses whichever is
   *  running without the player caring which it is. */
  videoRef: React.MutableRefObject<HTMLMediaElement | null>;
  onEnded: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);

  if (slide.kind === "chapter") {
    const dateText = slide.date
      ? (slide.endDate ? formatPartialDateRange(slide.date, slide.endDate) : formatPartialDate(slide.date))
      : "";
    const dateLabel = dateText && slide.dateApprox
      ? t("stories:chapter.approx", { date: dateText })
      : dateText;
    return (
      <div className="story-slide story-slide-chapter">
        {(dateLabel || slide.place) && (
          <p className="story-slide-dateline">
            {dateLabel}
            {dateLabel && slide.place && <span aria-hidden="true"> · </span>}
            {slide.place}
          </p>
        )}
        {slide.title && <h2>{slide.title}</h2>}
        {slide.description && <p className="story-slide-note">{slide.description}</p>}
      </div>
    );
  }

  if (slide.kind === "text") {
    return (
      <div className="story-slide story-slide-text">
        <StoryMarkdown source={slide.body} className="story-slide-prose" />
      </div>
    );
  }

  if (slide.kind === "media") {
    return (
      <figure className="story-slide story-slide-media">
        {slide.isVideo ? (
          <video
            ref={(el) => { videoRef.current = el; }}
            src={slide.src}
            poster={slide.poster ?? undefined}
            autoPlay
            playsInline
            onEnded={onEnded}
          />
        ) : (
          <img src={slide.src} alt={slide.title} />
        )}
        {slide.caption && <figcaption>{slide.caption}</figcaption>}
      </figure>
    );
  }

  // Narration takes the screen while it plays: a name, a microphone and the
  // clip running. Nothing to look at is the right answer — the point is to
  // listen.
  if (slide.kind === "audio") {
    return (
      <div className="story-slide story-slide-audio">
        <span className="story-slide-portrait" aria-hidden="true"><Mic size={40} /></span>
        {slide.title && <h2>{slide.title}</h2>}
        <audio
          ref={(el) => { videoRef.current = el; }}
          src={slide.src}
          autoPlay
          controls
          onEnded={onEnded}
        />
      </div>
    );
  }

  if (slide.kind === "map") {
    return (
      <div className="story-slide story-slide-map">
        <GalleryMiniMap
          lat={slide.lat}
          lng={slide.lng}
          zoom={slide.zoom}
          title={slide.label ?? t("stories:block.mapFallbackTitle")}
          className="story-player-map"
        />
        {slide.label && (
          <p className="story-slide-dateline">
            <MapPin size={15} aria-hidden="true" /> {slide.label}
          </p>
        )}
      </div>
    );
  }

  if (slide.kind === "person") {
    return (
      <div className="story-slide story-slide-person">
        <span className="story-slide-portrait" aria-hidden="true"><UserRound size={40} /></span>
        <h2>{slide.name}</h2>
        {slide.years && <p className="story-slide-dateline">{slide.years}</p>}
        {slide.caption && <p className="story-slide-note">{slide.caption}</p>}
      </div>
    );
  }

  return (
    <blockquote className="story-slide story-slide-quote">
      <Quote size={28} aria-hidden="true" />
      <p>{slide.text}</p>
      {slide.attribution && <footer>{slide.attribution}</footer>}
    </blockquote>
  );
}
