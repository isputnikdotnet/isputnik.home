import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Mic, MoreVertical, Pause, Play, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { RecordVoiceNoteModal, formatSeconds, recordingSupported } from "./RecordVoiceNoteModal";
import type { VoiceNote } from "./types";
import { drawBars, peaksFromUrl } from "./voice-wave";

// Recordings on a photo (docs/photo-review-plan.md phase 4; docs/lightbox-panel.md
// phase 2). A row per recording — who, how long, when — and ONE player for all
// of them: pressing a row's play button loads it into the player above the
// list, and starting another pauses the first. The Record button opens
// RecordVoiceNoteModal; the list is the photo's own, so the caller passes what it
// has and gets told when it changes.
//
// Recording needs a secure context (https, or localhost) and a microphone;
// where either is missing the Record button simply is not offered, and the
// existing recordings still play.

export function VoiceNotes({
  assetId,
  notes,
  canEdit,
  onChanged,
  large = false,
  heading = true,
  thumbnailUrl
}: {
  assetId: string;
  notes: VoiceNote[];
  canEdit: boolean;
  onChanged: (notes: VoiceNote[]) => void;
  /** Review mode's big controls; the lightbox's panel uses the small ones. */
  large?: boolean;
  /** The section heading with the Record button. Off where the host draws its own. */
  heading?: boolean;
  /** The photo, for the recording dialog's header. */
  thumbnailUrl?: string | null;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [current, setCurrent] = useState<VoiceNote | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<VoiceNote | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The player's wave strip: the current recording's peaks, decoded once it is
  // chosen (null while decoding or when the browser cannot decode it — a flat
  // strip then, and the seek bar still works).
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  const supported = recordingSupported();

  useEffect(() => {
    setPeaks(null);
    if (!current) return;
    let alive = true;
    void peaksFromUrl(current.url).then((result) => { if (alive) setPeaks(result); });
    return () => { alive = false; };
  }, [current]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawBars(canvas, peaks ?? [], length > 0 ? time / length : null);
  }, [peaks, time, length, current]);

  // A recording that has gone (removed, or the photo changed under us) leaves the player.
  useEffect(() => {
    if (current && !notes.some((note) => note.id === current.id)) { setCurrent(null); setPlaying(false); }
  }, [notes, current]);

  // Loading a row into the player starts it; the audio element is the one source
  // of truth for playing/paused, mirrored here for the buttons.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    setTime(0);
    setLength(current.durationSeconds ?? 0);
    audio.load();
    void audio.play()?.catch?.(() => { /* autoplay refused: the play button still works */ });
  }, [current]);

  // The row menu closes on an outside click (Escape is the menu's own key below).
  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuFor(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuFor]);

  const play = (note: VoiceNote) => {
    const audio = audioRef.current;
    if (current?.id === note.id && audio) {
      if (audio.paused) void audio.play()?.catch?.(() => { /* interrupted */ });
      else audio.pause();
      return;
    }
    setCurrent(note);
  };

  const remove = async () => {
    if (!confirmRemove) return;
    setRemoving(true);
    setError("");
    try {
      const payload = await api<{ notes: VoiceNote[] }>(`/api/library/gallery/assets/${encodeURIComponent(assetId)}/voice-notes/${encodeURIComponent(confirmRemove.id)}`, { method: "DELETE" });
      onChanged(payload.notes);
      setConfirmRemove(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:voiceNotes.errors.remove"));
    } finally {
      setRemoving(false);
    }
  };

  const nameOf = (note: VoiceNote) => note.recordedBy || t("gallery:voiceNotes.unnamed");
  const whenOf = (note: VoiceNote) => new Date(note.createdAt).toLocaleDateString();
  const iconSize = large ? 22 : 18;

  const recordButton = canEdit && supported ? (
    large ? (
      <button type="button" className="review-chip" onClick={() => setRecordOpen(true)}>
        <Mic size={18} aria-hidden="true" /> {t("gallery:voiceNotes.record")}
      </button>
    ) : (
      <Button variant="primary" compact onClick={() => setRecordOpen(true)}>
        <Mic size={14} aria-hidden="true" /> {t("gallery:voiceNotes.record")}
      </Button>
    )
  ) : null;

  return (
    <div className={`voice-notes${large ? " is-large" : ""}`}>
      {heading && (
        <div className="lb-sec-h voice-notes-head">
          <Mic size={18} aria-hidden="true" />
          <h3>{t("gallery:voiceNotes.heading")}</h3>
          <span className="lb-grow" />
          {recordButton}
        </div>
      )}

      {current && (
        <div className="voice-player is-shared" aria-label={t("gallery:voiceNotes.playerAria", { name: nameOf(current) })}>
          <audio
            ref={audioRef}
            src={current.url}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
            onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) setLength(event.currentTarget.duration); }}
          />
          {/* The strip is the picture; the range under it is the control (keyboard
              and screen reader). A click on the strip seeks too. */}
          <div
            className="voice-record-wave voice-player-wave"
            aria-hidden="true"
            onClick={(event) => {
              const audio = audioRef.current;
              if (!audio || length <= 0) return;
              const box = event.currentTarget.getBoundingClientRect();
              audio.currentTime = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * length;
              setTime(audio.currentTime);
            }}
          >
            <canvas ref={canvasRef} width={760} height={144} />
          </div>
          <input
            type="range"
            className="voice-player-seek"
            min={0}
            max={Math.max(length, 1)}
            step={0.1}
            value={Math.min(time, Math.max(length, 1))}
            onChange={(event) => { const audio = audioRef.current; if (audio) { audio.currentTime = Number(event.target.value); setTime(audio.currentTime); } }}
            aria-label={t("gallery:voiceNotes.seekAria")}
          />
          <div className="voice-player-row">
            <button
              type="button"
              className="voice-player-play"
              onClick={() => play(current)}
              aria-label={playing ? t("gallery:voiceNotes.pause") : t("gallery:voiceNotes.play")}
            >
              {playing ? <Pause size={iconSize} aria-hidden="true" /> : <Play size={iconSize} aria-hidden="true" />}
            </button>
            <div className="voice-player-name">
              {nameOf(current)}
              <small>{whenOf(current)}</small>
            </div>
            <div className="voice-player-times">
              <span>{formatSeconds(time)}</span>
              <span className="muted"> / {formatSeconds(length)}</span>
            </div>
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <div className="voice-notes-list">
          {notes.map((note) => {
            const isCurrent = current?.id === note.id;
            const isPlaying = isCurrent && playing;
            return (
              <div key={note.id} className={`voice-note${isCurrent ? " is-current" : ""}`}>
                <button
                  type="button"
                  className="voice-player-play"
                  onClick={() => play(note)}
                  aria-label={isPlaying ? t("gallery:voiceNotes.pauseAria", { name: nameOf(note) }) : t("gallery:voiceNotes.playAria", { name: nameOf(note) })}
                  aria-pressed={isCurrent}
                >
                  {isPlaying ? <Pause size={iconSize} aria-hidden="true" /> : <Play size={iconSize} aria-hidden="true" />}
                </button>
                <div className="voice-note-who">{nameOf(note)}</div>
                <div className="voice-note-meta">
                  {[formatSeconds(note.durationSeconds), whenOf(note)].filter(Boolean).join(" · ")}
                </div>
                <div className="gallery-lightbox-menu-wrap voice-note-menu-wrap" ref={menuFor === note.id ? menuRef : undefined}>
                  <button
                    type="button"
                    className="voice-note-more"
                    onClick={() => setMenuFor((open) => open === note.id ? null : note.id)}
                    aria-haspopup="menu"
                    aria-expanded={menuFor === note.id}
                    aria-label={t("gallery:voiceNotes.menuAria", { name: nameOf(note) })}
                    title={t("gallery:voiceNotes.menuAria", { name: nameOf(note) })}
                  >
                    <MoreVertical size={iconSize} aria-hidden="true" />
                  </button>
                  {menuFor === note.id && (
                    <div
                      className="gallery-lightbox-menu"
                      role="menu"
                      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setMenuFor(null); } }}
                    >
                      <a role="menuitem" href={note.url} download onClick={() => setMenuFor(null)}>
                        <Download size={16} aria-hidden="true" />
                        <span>{t("gallery:voiceNotes.download")}</span>
                      </a>
                      {canEdit && (
                        <button type="button" role="menuitem" className="danger" onClick={() => { setMenuFor(null); setConfirmRemove(note); }}>
                          <Trash2 size={16} aria-hidden="true" />
                          <span>{t("gallery:voiceNotes.remove")}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!heading && recordButton && <div className="voice-note-record">{recordButton}</div>}

      {error && <MessageBox tone="error" title={t("gallery:voiceNotes.errors.title")}>{error}</MessageBox>}

      {recordOpen && (
        <RecordVoiceNoteModal
          assetId={assetId}
          thumbnailUrl={thumbnailUrl}
          large={large}
          onSaved={onChanged}
          onClose={() => setRecordOpen(false)}
        />
      )}

      {confirmRemove && (
        <ConfirmDialog
          title={t("gallery:voiceNotes.removeConfirmTitle")}
          confirmLabel={t("gallery:voiceNotes.removeConfirm")}
          busyLabel={t("gallery:voiceNotes.removing")}
          busy={removing}
          danger
          onConfirm={() => void remove()}
          onCancel={() => { if (!removing) setConfirmRemove(null); }}
        >
          {t("gallery:voiceNotes.removeConfirmBody")}
        </ConfirmDialog>
      )}
    </div>
  );
}
