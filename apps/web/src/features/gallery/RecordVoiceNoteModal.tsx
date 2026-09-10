import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Pause, Play } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { VoiceNote } from "./types";
import { drawBars } from "./voice-wave";

// Recording a voice memory onto a photo (docs/lightbox-panel.md, phase 2).
//
// One dialog, three states behind one big button:
//   ready     — press to start; the microphone is asked for then, not before.
//   recording — the button is Stop; the waveform is drawn from the microphone
//               through an analyser, so silence looks like silence.
//   done      — listen back, then Save, Record again, or Discard. Nothing is
//               uploaded until Save: a take that caught the dog is not the one
//               that goes on the photo.
//
// Closing is blocked while recording or saving (Modal's `busy`). Cancel, the
// close cross, Discard and Record again all ask first once a take exists — a
// story told once is not told twice.

const MAX_SECONDS = 5 * 60;
// One waveform bar per this many milliseconds of microphone time.
const BAR_MS = 60;

export function formatSeconds(total: number | null | undefined): string {
  if (total == null || !Number.isFinite(total)) return "";
  const s = Math.round(total);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** True where MediaRecorder can run: a secure context with a microphone API. */
export function recordingSupported(): boolean {
  return typeof window !== "undefined"
    && window.isSecureContext
    && typeof window.MediaRecorder !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia);
}

type Phase = "ready" | "recording" | "done" | "saving";
type Confirm = "discard" | "again" | "close";

export function RecordVoiceNoteModal({
  assetId,
  thumbnailUrl,
  large = false,
  onSaved,
  onClose
}: {
  assetId: string;
  /** The photo, small, in the dialog's header — the story stays tied to the picture. */
  thumbnailUrl?: string | null;
  /** Review mode's larger controls. */
  large?: boolean;
  onSaved: (notes: VoiceNote[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [phase, setPhase] = useState<Phase>("ready");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // The take: its blob (for upload), object URL (for listening back) and extension.
  const [take, setTake] = useState<{ blob: Blob; url: string; ext: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playTime, setPlayTime] = useState(0);
  const [playLength, setPlayLength] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const ampsRef = useRef<number[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastBarRef = useRef(0);

  const stopEverything = useCallback(() => {
    if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
    if (frameRef.current) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => { /* already closed */ });
    contextRef.current = null;
    analyserRef.current = null;
  }, []);

  // Leaving the dialog releases the microphone and the take's object URL.
  useEffect(() => () => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    stopEverything();
  }, [stopEverything]);
  useEffect(() => () => { if (take) URL.revokeObjectURL(take.url); }, [take]);

  // The waveform: a bar per BAR_MS of microphone while recording; the finished
  // trace with a playback cursor afterwards.
  const redraw = useCallback((cursor: number | null) => {
    const canvas = canvasRef.current;
    if (canvas) drawBars(canvas, ampsRef.current, cursor);
  }, []);
  useEffect(() => { redraw(phase === "done" && playLength > 0 ? playTime / playLength : null); }, [phase, playTime, playLength, redraw]);

  const sample = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const now = performance.now();
    if (now - lastBarRef.current >= BAR_MS) {
      lastBarRef.current = now;
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      ampsRef.current.push(Math.sqrt(sum / data.length));
      redraw(null);
    }
    frameRef.current = requestAnimationFrame(sample);
  }, [redraw]);

  const start = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      // The analyser only listens; the recorder gets the raw stream.
      const context = new AudioContext();
      contextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const mime = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mime });
        const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "webm";
        stopEverything();
        if (blob.size > 0) {
          setTake({ blob, url: URL.createObjectURL(blob), ext });
          setPhase("done");
        } else {
          setPhase("ready");
        }
      };
      ampsRef.current = [];
      lastBarRef.current = 0;
      setSeconds(0);
      setPlayTime(0);
      setPlayLength(0);
      setPlaying(false);
      recorder.start();
      setPhase("recording");
      frameRef.current = requestAnimationFrame(sample);
      timerRef.current = window.setInterval(() => {
        setSeconds((current) => {
          if (current + 1 >= MAX_SECONDS) recorderRef.current?.stop();
          return current + 1;
        });
      }, 1000);
    } catch {
      stopEverything();
      setError(t("gallery:voiceNotes.errors.microphone"));
    }
  };

  const stop = () => { recorderRef.current?.stop(); };

  const discardTake = () => {
    audioRef.current?.pause();
    setPlaying(false);
    setTake(null);
    ampsRef.current = [];
    setSeconds(0);
    setPhase("ready");
  };

  const save = async () => {
    if (!take || phase === "saving") return;
    setPhase("saving");
    setError("");
    try {
      const form = new FormData();
      form.append("file", take.blob, `voice-note.${take.ext}`);
      const payload = await api<{ notes: VoiceNote[] }>(`/api/library/gallery/assets/${encodeURIComponent(assetId)}/voice-notes`, {
        method: "POST",
        body: form
      });
      onSaved(payload.notes);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:voiceNotes.errors.save"));
      setPhase("done");
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play()?.catch?.(() => { /* interrupted */ });
    else audio.pause();
  };

  // Closing with a take on hand asks first; while recording or saving it is blocked.
  const busy = phase === "recording" || phase === "saving";
  const requestClose = () => {
    if (busy) return;
    if (take) setConfirm("close");
    else onClose();
  };

  const runConfirm = () => {
    if (confirm === "close") { setConfirm(null); onClose(); return; }
    discardTake();
    setConfirm(null);
    if (confirm === "again") void start();
  };

  const upTo = t("gallery:voiceNotes.upTo", { time: formatSeconds(MAX_SECONDS) });
  const hint = phase === "ready"
    ? t("gallery:voiceNotes.readyHint")
    : phase === "recording"
      ? t("gallery:voiceNotes.recordingHint")
      : t("gallery:voiceNotes.doneHint");

  return (
    <Modal
      title={t("gallery:voiceNotes.dialogTitle")}
      subtitle={t("gallery:voiceNotes.dialogSubtitle")}
      icon={thumbnailUrl ? <img className="voice-record-thumb" src={thumbnailUrl} alt="" /> : <Mic size={20} aria-hidden="true" />}
      busy={busy}
      onClose={requestClose}
      className={`voice-record-modal${large ? " is-large" : ""}`}
    >
      <div className="voice-record-body">
        <div className="voice-record-wave" aria-hidden="true">
          <canvas ref={canvasRef} width={760} height={144} />
        </div>
        <div className="voice-record-time">
          <span>{formatSeconds(seconds)}</span>
          {phase !== "done" && <small>{upTo}</small>}
        </div>

        {phase !== "done" && phase !== "saving" && (
          <div className="voice-record-big">
            <button
              type="button"
              className={`voice-record-button${phase === "recording" ? " is-recording" : ""}`}
              onClick={() => { if (phase === "ready") void start(); else stop(); }}
              aria-label={phase === "recording" ? t("gallery:voiceNotes.stop") : t("gallery:voiceNotes.record")}
            >
              {phase === "recording" ? <span className="voice-record-square" /> : <Mic size={large ? 40 : 34} aria-hidden="true" />}
            </button>
            <span>{phase === "recording" ? t("gallery:voiceNotes.stop") : t("gallery:voiceNotes.record")}</span>
          </div>
        )}

        <p className="voice-record-hint" aria-live="polite">{hint}</p>

        {take && (
          <div className="voice-player">
            <audio
              ref={audioRef}
              src={take.url}
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(event) => setPlayTime(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) => setPlayLength(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : seconds)}
              onDurationChange={(event) => { if (Number.isFinite(event.currentTarget.duration)) setPlayLength(event.currentTarget.duration); }}
            />
            <button
              type="button"
              className="voice-player-play"
              onClick={togglePlay}
              aria-label={playing ? t("gallery:voiceNotes.pause") : t("gallery:voiceNotes.play")}
              disabled={phase === "saving"}
            >
              {playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
            </button>
            <div className="voice-player-track">
              <input
                type="range"
                className="voice-player-seek"
                min={0}
                max={Math.max(playLength, seconds, 1)}
                step={0.1}
                value={Math.min(playTime, Math.max(playLength, seconds, 1))}
                onChange={(event) => { const audio = audioRef.current; if (audio) { audio.currentTime = Number(event.target.value); setPlayTime(audio.currentTime); } }}
                aria-label={t("gallery:voiceNotes.seekAria")}
              />
              <div className="voice-player-times">
                <span>{formatSeconds(playTime)}</span>
                <span>{formatSeconds(playLength || seconds)}</span>
              </div>
            </div>
          </div>
        )}

        {error && <MessageBox tone="error" title={t("gallery:voiceNotes.errors.title")}>{error}</MessageBox>}
      </div>

      <div className="modal-actions voice-record-actions">
        {take && phase === "done" && (
          <>
            <Button variant="secondary" onClick={() => setConfirm("again")}>{t("gallery:voiceNotes.recordAgain")}</Button>
            <Button variant="text" danger onClick={() => setConfirm("discard")}>{t("gallery:voiceNotes.discard")}</Button>
          </>
        )}
        <span className="voice-record-actions-gap" />
        <Button variant="secondary" onClick={requestClose} disabled={busy}>{t("common:common.cancel")}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={!take || busy}>
          {phase === "saving" ? t("gallery:voiceNotes.saving") : t("gallery:common.save")}
        </Button>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm === "again" ? t("gallery:voiceNotes.againTitle") : t("gallery:voiceNotes.discardTitle")}
          confirmLabel={confirm === "again" ? t("gallery:voiceNotes.recordAgain") : t("gallery:voiceNotes.discard")}
          danger
          onConfirm={runConfirm}
          onCancel={() => setConfirm(null)}
        >
          {confirm === "again" ? t("gallery:voiceNotes.againBody") : t("gallery:voiceNotes.discardBody")}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
