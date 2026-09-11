import { FastForward, Pause, Play, Rewind, SkipBack, SkipForward } from "lucide-react";

export interface PlayerControlLabels {
  prev: string;
  next: string;
  back30: string;
  forward30: string;
  play: string;
  pause: string;
}

// The transport row every audio player wears: previous, back 30 s, play/pause,
// forward 30 s, next. Three layouts, one per surface:
//   bar    — the book page's inline player: the 30 s skips at the ends.
//   popup  — the pop-out player window: the skips as circles beside Play.
//   share  — the guest share page: the popup's order, in its own card.
// Labels come in already translated; each surface keeps its own wording.
export function PlayerControls({
  layout,
  playing,
  onTogglePlay,
  onPrev,
  onNext,
  onSkip,
  prevDisabled,
  nextDisabled,
  labels
}: {
  layout: "bar" | "popup" | "share";
  playing: boolean;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Seconds to move the playhead by: -30 or 30. */
  onSkip: (seconds: number) => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
  labels: PlayerControlLabels;
}) {
  const playLabel = playing ? labels.pause : labels.play;

  if (layout === "bar") {
    return (
      <div className="player-controls">
        <button className="player-btn player-btn-skip" onClick={() => onSkip(-30)} aria-label={labels.back30}>
          <Rewind size={17} />
          <span>30</span>
        </button>
        <button className="player-btn" onClick={onPrev} disabled={prevDisabled} aria-label={labels.prev}>
          <SkipBack size={20} />
        </button>
        <button className="player-btn player-btn-primary" onClick={onTogglePlay} aria-label={playLabel}>
          {playing ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button className="player-btn" onClick={onNext} disabled={nextDisabled} aria-label={labels.next}>
          <SkipForward size={20} />
        </button>
        <button className="player-btn player-btn-skip" onClick={() => onSkip(30)} aria-label={labels.forward30}>
          <FastForward size={17} />
          <span>30</span>
        </button>
      </div>
    );
  }

  const popup = layout === "popup";
  const navClass = popup ? "player-btn player-btn-nav" : "player-btn";
  const navSize = popup ? 18 : 20;
  const playSize = popup ? 21 : 22;

  return (
    <div className={popup ? "player-controls player-controls--popup" : "share-controls"}>
      <button className={navClass} onClick={onPrev} disabled={prevDisabled} aria-label={labels.prev}>
        <SkipBack size={navSize} />
      </button>
      <button className="player-btn player-btn-circle" onClick={() => onSkip(-30)} aria-label={labels.back30}>
        <Rewind size={15} />
        <span>30</span>
      </button>
      <button
        className="player-btn player-btn-primary"
        onClick={onTogglePlay}
        aria-label={playLabel}
        data-label={popup ? playLabel : undefined}
      >
        {playing ? <Pause size={playSize} /> : <Play size={playSize} />}
      </button>
      <button className="player-btn player-btn-circle" onClick={() => onSkip(30)} aria-label={labels.forward30}>
        <FastForward size={15} />
        <span>30</span>
      </button>
      <button className={navClass} onClick={onNext} disabled={nextDisabled} aria-label={labels.next}>
        <SkipForward size={navSize} />
      </button>
    </div>
  );
}
