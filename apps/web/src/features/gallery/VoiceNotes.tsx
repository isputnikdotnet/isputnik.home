import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Square, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { MessageBox } from "../../shared/MessageBox";
import type { VoiceNote } from "./types";

// Voice notes on a photo (docs/photo-review-plan.md, phase 4): press to record,
// press to stop, and the recording is on the photo — playable by whoever can
// see the photo, removable by whoever can write on it. The list is the photo's
// own; the caller passes what it has and gets told when it changes.
//
// MediaRecorder needs a secure context (https, or localhost) and a microphone;
// where either is missing the record button simply is not offered, and the
// existing notes still play.

const MAX_SECONDS = 5 * 60;

function formatSeconds(total: number | null): string {
  if (total == null || !Number.isFinite(total)) return "";
  const s = Math.round(total);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function VoiceNotes({
  assetId,
  notes,
  canEdit,
  onChanged,
  large = false
}: {
  assetId: string;
  notes: VoiceNote[];
  canEdit: boolean;
  onChanged: (notes: VoiceNote[]) => void;
  /** Review mode's big controls; the lightbox's Info panel uses the small ones. */
  large?: boolean;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<VoiceNote | null>(null);
  const [removing, setRemoving] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const supported = typeof window !== "undefined"
    && window.isSecureContext
    && typeof window.MediaRecorder !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
    stopTracks();
  }, []);

  const upload = async (blob: Blob, ext: string) => {
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", blob, `voice-note.${ext}`);
      const payload = await api<{ notes: VoiceNote[] }>(`/api/library/gallery/assets/${encodeURIComponent(assetId)}/voice-notes`, {
        method: "POST",
        body: form
      });
      onChanged(payload.notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:voiceNotes.errors.save"));
    } finally {
      setUploading(false);
    }
  };

  const start = async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const ext = (recorder.mimeType || "").includes("ogg") ? "ogg" : (recorder.mimeType || "").includes("mp4") ? "m4a" : "webm";
        stopTracks();
        setRecording(false);
        if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; }
        if (blob.size > 0) void upload(blob, ext);
      };
      recorder.start();
      setRecording(true);
      setSeconds(0);
      timerRef.current = window.setInterval(() => {
        setSeconds((current) => {
          if (current + 1 >= MAX_SECONDS) recorderRef.current?.stop();
          return current + 1;
        });
      }, 1000);
    } catch {
      stopTracks();
      setError(t("gallery:voiceNotes.errors.microphone"));
    }
  };

  const stop = () => { recorderRef.current?.stop(); };

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

  const size = large ? 20 : 14;

  return (
    <div className={`voice-notes${large ? " is-large" : ""}`}>
      {notes.map((note) => (
        <div key={note.id} className="voice-note">
          <audio controls preload="none" src={note.url} className="voice-note-player" />
          <span className="voice-note-meta muted">
            {note.recordedBy ? t("gallery:voiceNotes.by", { name: note.recordedBy }) : ""}
            {note.durationSeconds != null ? ` · ${formatSeconds(note.durationSeconds)}` : ""}
          </span>
          {canEdit && (
            <Button variant="icon" danger compact title={t("gallery:voiceNotes.remove")} aria-label={t("gallery:voiceNotes.remove")} onClick={() => setConfirmRemove(note)} disabled={recording || uploading}>
              <Trash2 size={size} aria-hidden="true" />
            </Button>
          )}
        </div>
      ))}

      {canEdit && supported && (
        <div className="voice-note-record">
          {recording ? (
            <Button variant="danger" compact={!large} className={large ? "review-chip review-chip-record" : undefined} onClick={stop}>
              <Square size={size} aria-hidden="true" />
              <span>{t("gallery:voiceNotes.stop", { time: formatSeconds(seconds) })}</span>
            </Button>
          ) : (
            <Button variant="secondary" compact={!large} className={large ? "review-chip" : undefined} onClick={() => void start()} disabled={uploading}>
              <Mic size={size} aria-hidden="true" />
              <span>{uploading ? t("gallery:voiceNotes.saving") : notes.length > 0 ? t("gallery:voiceNotes.recordAnother") : t("gallery:voiceNotes.record")}</span>
            </Button>
          )}
        </div>
      )}

      {error && <MessageBox tone="error" title={t("gallery:voiceNotes.errors.title")}>{error}</MessageBox>}

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
