import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Upload } from "lucide-react";
import { Button } from "../Button";
import { ConfirmDialog } from "../ConfirmDialog";
import { MessageBox } from "../MessageBox";
import { Modal } from "../Modal";
import { AudioPlayer } from "./AudioPlayer";
import { drawBars, formatSeconds, recordingSupported, STRIP_HEIGHT, STRIP_WIDTH } from "./wave";

// The one recording dialog (docs/lightbox-panel.md, phases 2 and 3). A photo's
// recording and a story's narration are the same act, so they share it; the
// host says what it is called, how long it may run, whether a file may be
// uploaded instead, and what to do with the take.
//
// Three states behind one big button:
//   ready     — press to start; the microphone is asked for then, not before.
//   recording — the button is Stop; the waveform is drawn from the microphone
//               through an analyser, so silence looks like silence.
//   done      — listen back, then Save, Record again, or Discard. Nothing is
//               handed to the host until Save: a take that caught the dog is
//               not the one that goes on the photo.
//
// An uploaded file becomes a take too, and goes through the same listen-back.
// Closing is blocked while recording or saving (Modal's `busy`). Cancel, the
// close cross, Discard and Record again all ask first once a take exists — a
// story told once is not told twice.

// One waveform bar per this many milliseconds of microphone time.
const BAR_MS = 60;

type Phase = "ready" | "recording" | "done" | "saving";
type Confirm = "discard" | "again" | "close";

export interface Take {
  blob: Blob;
  /** File extension the blob should be saved with. */
  ext: string;
  /** The picked file's own name, when the take was uploaded rather than recorded. */
  fileName?: string;
}

export function RecordAudioModal({
  title,
  subtitle,
  thumbnailUrl,
  maxSeconds,
  allowUpload = false,
  large = false,
  onSave,
  onClose
}: {
  title: string;
  subtitle?: string;
  /** The thing being spoken about, small, in the dialog's header. */
  thumbnailUrl?: string | null;
  maxSeconds: number;
  /** Offer "Upload a recording" as the other way in. */
  allowUpload?: boolean;
  /** Review mode's larger controls. */
  large?: boolean;
  /** Store the take. Throw to show the message and keep the take. */
  onSave: (take: Take) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  const [phase, setPhase] = useState<Phase>("ready");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [take, setTake] = useState<(Take & { url: string; amps: number[] | null }) | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ampsRef = useRef<number[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastBarRef = useRef(0);

  const supported = recordingSupported();

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

  // The live strip while recording; the player draws the finished one.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas) drawBars(canvas, ampsRef.current, null);
  }, []);
  useEffect(() => { if (phase !== "done") redraw(); }, [phase, redraw]);

  // Named, and re-scheduled under its own name: a frame loop that reached back for
  // the `sample` binding would be reading a value this render has not finished
  // making.
  const sample = useCallback(function sampleFrame() {
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
      redraw();
    }
    frameRef.current = requestAnimationFrame(sampleFrame);
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
          setTake({ blob, ext, url: URL.createObjectURL(blob), amps: ampsRef.current.slice() });
          setPhase("done");
        } else {
          setPhase("ready");
        }
      };
      ampsRef.current = [];
      lastBarRef.current = 0;
      setSeconds(0);
      recorder.start();
      setPhase("recording");
      frameRef.current = requestAnimationFrame(sample);
      timerRef.current = window.setInterval(() => {
        setSeconds((current) => {
          if (current + 1 >= maxSeconds) recorderRef.current?.stop();
          return current + 1;
        });
      }, 1000);
    } catch {
      stopEverything();
      setError(t("audio.microphone"));
    }
  };

  const stop = () => { recorderRef.current?.stop(); };

  // A file someone already has: it becomes the take, and is listened back to
  // like a fresh one. Its length is read by the player from the file itself.
  const pickFile = (file: File | undefined) => {
    if (!file) return;
    const dot = file.name.lastIndexOf(".");
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "webm";
    setError("");
    setSeconds(0);
    setTake({ blob: file, ext, fileName: file.name, url: URL.createObjectURL(file), amps: null });
    setPhase("done");
  };

  const discardTake = () => {
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
      await onSave({ blob: take.blob, ext: take.ext, fileName: take.fileName });
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("audio.saveFailed"));
      setPhase("done");
    }
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

  const hint = phase === "ready"
    ? (supported ? (allowUpload ? t("audio.readyHintUpload") : t("audio.readyHint")) : t("audio.noRecorder"))
    : phase === "recording"
      ? t("audio.recordingHint")
      : t("audio.doneHint");

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      icon={thumbnailUrl ? <img className="audio-record-thumb" src={thumbnailUrl} alt="" /> : <Mic size={20} aria-hidden="true" />}
      busy={busy}
      onClose={requestClose}
      className={`audio-record-modal${large ? " is-large" : ""}`}
    >
      <div className="audio-record-body">
        {phase !== "done" && phase !== "saving" ? (
          <>
            <div className="audio-wave" aria-hidden="true">
              <canvas ref={canvasRef} width={STRIP_WIDTH} height={STRIP_HEIGHT} />
            </div>
            <div className="audio-record-time">
              <span>{formatSeconds(seconds)}</span>
              <small>{t("audio.upTo", { time: formatSeconds(maxSeconds) })}</small>
            </div>
            {supported && (
              <div className="audio-record-big">
                <button
                  type="button"
                  className={`audio-record-button${phase === "recording" ? " is-recording" : ""}`}
                  onClick={() => { if (phase === "ready") void start(); else stop(); }}
                  aria-label={phase === "recording" ? t("audio.stop") : t("audio.record")}
                >
                  {phase === "recording" ? <span className="audio-record-square" /> : <Mic size={large ? 40 : 34} aria-hidden="true" />}
                </button>
                <span>{phase === "recording" ? t("audio.stop") : t("audio.record")}</span>
              </div>
            )}
          </>
        ) : take && (
          <AudioPlayer
            src={take.url}
            wave={take.amps ?? "decode"}
            durationSeconds={take.amps ? seconds : null}
            title={take.fileName ?? formatSeconds(seconds)}
            large={large}
            disabled={phase === "saving"}
          />
        )}

        <p className="audio-record-hint" aria-live="polite">{hint}</p>

        {allowUpload && phase === "ready" && (
          <label className="audio-record-upload">
            <input ref={fileRef} type="file" accept="audio/*" onChange={(event) => pickFile(event.target.files?.[0])} />
            <span className="secondary-button compact-button">
              <Upload size={16} aria-hidden="true" />
              <span>{t("audio.upload")}</span>
            </span>
          </label>
        )}

        {error && <MessageBox tone="error" title={t("audio.errorTitle")}>{error}</MessageBox>}
      </div>

      <div className="modal-actions audio-record-actions">
        {take && phase === "done" && (
          <>
            {supported && <Button variant="secondary" onClick={() => setConfirm("again")}>{t("audio.recordAgain")}</Button>}
            <Button variant="text" danger onClick={() => setConfirm("discard")}>{t("audio.discard")}</Button>
          </>
        )}
        <span className="audio-record-actions-gap" />
        <Button variant="secondary" onClick={requestClose} disabled={busy}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => void save()} disabled={!take || busy}>
          {phase === "saving" ? t("audio.saving") : t("audio.save")}
        </Button>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm === "again" ? t("audio.againTitle") : t("audio.discardTitle")}
          confirmLabel={confirm === "again" ? t("audio.recordAgain") : t("audio.discard")}
          danger
          onConfirm={runConfirm}
          onCancel={() => setConfirm(null)}
        >
          {confirm === "again" ? t("audio.againBody") : t("audio.discardBody")}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
