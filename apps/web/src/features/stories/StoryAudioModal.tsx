import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square, Upload } from "lucide-react";
import { csrfToken } from "../../api";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";
import { Button } from "../../shared/Button";

// Add narration to a story: record it here, or upload a file that already
// exists. Recording is the point — the research is unanimous that recorded
// voice is what families actually want out of a storytelling tool — but a
// phone recording someone already made must be just as welcome.
//
// MediaRecorder needs a secure context (https, or localhost). Where it isn't
// available the record half simply doesn't appear and upload carries it, rather
// than showing a button that can't work.

const MAX_SECONDS = 15 * 60;

export function StoryAudioModal({
  storyId,
  onAdded,
  onClose
}: {
  storyId: string;
  /** The stored clip's id, ready to hang a block on. */
  onAdded: (audioId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "stories"]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const canRecord = typeof window !== "undefined"
    && typeof window.MediaRecorder !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia);

  // Leaving with the microphone still open would keep the recording light on.
  useEffect(() => () => stopTracks(), []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setSeconds((current) => {
        if (current + 1 >= MAX_SECONDS) stop();
        return current + 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  function stopTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  const upload = async (blob: Blob, filename: string) => {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", blob, filename);
      // Not the api() helper: this is multipart, so the browser must set the
      // Content-Type boundary itself. The CSRF header still has to be sent by
      // hand — every state-changing request is rejected without it.
      const token = csrfToken();
      const response = await fetch(`/api/stories/${storyId}/audio`, {
        method: "POST",
        body: form,
        credentials: "same-origin",
        headers: token ? { "X-CSRF-Token": token } : undefined
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || t("stories:audio.uploadFailed"));
      onAdded(payload.audio.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stories:audio.uploadFailed"));
      setBusy(false);
    }
  };

  const start = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopTracks();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        // The extension has to match what the server accepts; MediaRecorder
        // gives webm or ogg depending on the browser.
        const ext = (recorder.mimeType || "").includes("ogg") ? "ogg" : "webm";
        void upload(blob, `recording.${ext}`);
      };
      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setRecording(true);
    } catch {
      setError(t("stories:audio.micRefused"));
    }
  };

  function stop() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    void upload(file, file.name);
  };

  return (
    <Modal
      variant="panel"
      title={t("stories:audio.title")}
      icon={<Mic size={20} />}
      busy={busy || recording}
      onClose={() => { stop(); stopTracks(); onClose(); }}
    >
      <div className="modal-tab-content story-audio-modal">
        {error && <MessageBox tone="error" title={t("stories:audio.errorTitle")}>{error}</MessageBox>}

        <p className="muted">{t("stories:audio.intro")}</p>

        {canRecord && (
          <div className="story-audio-record">
            {recording ? (
              <>
                <span className="story-audio-pulse" aria-hidden="true" />
                <span className="story-audio-timer">{formatClock(seconds)}</span>
                <Button variant="danger" onClick={stop}>
                  <Square size={16} aria-hidden="true" />
                  <span>{t("stories:audio.stop")}</span>
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => void start()} disabled={busy}>
                <Mic size={16} aria-hidden="true" />
                <span>{busy ? t("stories:audio.saving") : t("stories:audio.record")}</span>
              </Button>
            )}
          </div>
        )}

        <label className="story-audio-upload">
          <input
            type="file"
            accept="audio/*"
            disabled={busy || recording}
            onChange={(event) => pickFile(event.target.files?.[0])}
          />
          <span className="secondary-button">
            <Upload size={16} aria-hidden="true" />
            <span>{t("stories:audio.upload")}</span>
          </span>
        </label>

        {!canRecord && <p className="muted">{t("stories:audio.noRecorder")}</p>}
      </div>
    </Modal>
  );
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
