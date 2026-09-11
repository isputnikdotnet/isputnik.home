import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Music, Pause, Play, Trash2, UploadCloud, VolumeX } from "lucide-react";
import { api, csrfToken } from "../../api";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";
import type { GalleryMusicTrack } from "./types";
import { CLIP_LENGTH, formatClock } from "../../shared/formatClock";
import { Button } from "../../shared/Button";

// Choose the music for a slideshow: the user's uploaded tracks, with in-place
// preview, upload, and delete (own uploads / admin). Selecting a track (or "No
// music") calls onSelect; the parent persists it. Modeled on AddToAlbumModal.
export function MusicPicker({
  selectedId,
  onSelect,
  onClose
}: {
  selectedId: string | null;
  onSelect: (trackId: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(["common", "gallery"]);
  const [tracks, setTracks] = useState<GalleryMusicTrack[] | null>(null);
  const [error, setError] = useState("");
  // What was left out of an upload, and why — a skip is not a failure, so it says
  // so beside the list rather than in the error box.
  const [notice, setNotice] = useState("");
  const [uploading, setUploading] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  // The track waiting on "Delete?" — an upload is the user's own file, so one
  // click on the bin only asks.
  const [pendingDelete, setPendingDelete] = useState<GalleryMusicTrack | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = () =>
    api<{ tracks: GalleryMusicTrack[] }>("/api/library/gallery/music")
      .then((payload) => setTracks(payload.tracks))
      .catch((err) => setError(err instanceof Error ? err.message : t("gallery:musicPicker.errors.load")));

  useEffect(() => { void load(); }, []);

  // Stop any preview when the dialog unmounts.
  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const togglePreview = (track: GalleryMusicTrack) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (previewingId === track.id) {
      audio.pause();
      setPreviewingId(null);
      return;
    }
    audio.src = track.url;
    audio.currentTime = 0;
    void audio.play().then(() => setPreviewingId(track.id)).catch(() => setError(t("gallery:musicPicker.errors.play")));
  };

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setError("");
    setNotice("");
    try {
      // One request for the whole selection: the server streams each part, so a
      // dozen beds cost one round trip rather than a dozen.
      const form = new FormData();
      for (const file of files) form.append("file", file);
      const token = csrfToken();
      const res = await fetch("/api/library/gallery/music", {
        method: "POST",
        credentials: "include",
        headers: token ? { "X-CSRF-Token": token } : undefined,
        body: form
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || t("gallery:musicPicker.errors.uploadGeneric"));
      }
      const { tracks: added, skipped } = (await res.json()) as {
        tracks: GalleryMusicTrack[];
        skipped: string[];
      };
      await load();
      // Auto-select what was just added, as a single upload always did. With
      // several, the first is the sensible one to land on.
      if (added.length > 0) onSelect(added[0].id);
      if (skipped.length > 0) {
        setNotice(
          t("gallery:musicPicker.skippedNotice", { list: skipped.join(", ") }) +
            (added.length === 0 ? "" : t("gallery:musicPicker.addedSuffix", { count: added.length }))
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gallery:musicPicker.errors.upload"));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (track: GalleryMusicTrack) => {
    setDeleting(true);
    setDeleteError("");
    setError("");
    try {
      if (previewingId === track.id) { audioRef.current?.pause(); setPreviewingId(null); }
      await api(`/api/library/gallery/music/${track.id}`, { method: "DELETE" });
      if (selectedId === track.id) onSelect(null);
      setPendingDelete(null);
      await load();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t("gallery:musicPicker.errors.delete"));
    } finally {
      setDeleting(false);
    }
  };

  const uploads = tracks ?? [];

  const row = (track: GalleryMusicTrack) => (
    <li key={track.id} className={`music-row${selectedId === track.id ? " is-selected" : ""}`}>
      <Button
        variant="bare"
        className="music-row-preview"
        onClick={() => togglePreview(track)}
        aria-label={previewingId === track.id ? t("gallery:musicPicker.stopPreviewAria", { title: track.title }) : t("gallery:musicPicker.previewAria", { title: track.title })}
        title={previewingId === track.id ? t("gallery:musicPicker.stopPreview") : t("gallery:musicPicker.preview")}
      >
        {previewingId === track.id ? <Pause size={16} /> : <Play size={16} />}
      </Button>
      <Button variant="bare" className="music-row-main" onClick={() => onSelect(track.id)}>
        <span className="music-row-title">{track.title}</span>
        <span className="music-row-meta">
          {t("gallery:musicPicker.yourUpload")}{track.durationSeconds != null ? ` · ${formatClock(track.durationSeconds, CLIP_LENGTH)}` : ""}
        </span>
      </Button>
      {selectedId === track.id && <Check size={18} className="music-row-check" aria-label={t("gallery:musicPicker.selectedAria")} />}
      <Button variant="bare" className="music-row-delete" onClick={() => { setDeleteError(""); setPendingDelete(track); }} aria-label={t("gallery:musicPicker.deleteTrackAria", { title: track.title })} title={t("gallery:musicPicker.deleteTrackTitle")}>
        <Trash2 size={15} />
      </Button>
    </li>
  );

  return (
    // Busy while the confirmation is up, so its Escape or backdrop click dismisses
    // only the question and not the picker underneath it.
    <Modal variant="panel" title={t("gallery:musicPicker.modalTitle")} icon={<Music size={20} />} className="music-picker-modal" busy={pendingDelete !== null} onClose={onClose}>
      <div className="add-to-album-head">
        {error && <MessageBox tone="error" title={t("gallery:musicPicker.errorTitle")}>{error}</MessageBox>}
        {notice && <MessageBox tone="info" title={t("gallery:musicPicker.skippedTitle")}>{notice}</MessageBox>}
        <div className="music-picker-actions">
          <Button variant="secondary" compact onClick={() => fileRef.current?.click()} disabled={uploading}>
            <UploadCloud size={16} aria-hidden="true" /> {uploading ? t("gallery:musicPicker.uploading") : t("gallery:musicPicker.uploadTracks")}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.flac"
            multiple
            hidden
            onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }}
          />
        </div>
      </div>

      <div className="modal-tab-content music-picker-body">
        <ul className="music-list">
          <li className={`music-row${selectedId == null ? " is-selected" : ""}`}>
            <span className="music-row-preview is-static" aria-hidden="true"><VolumeX size={16} /></span>
            <Button variant="bare" className="music-row-main" onClick={() => onSelect(null)}>
              <span className="music-row-title">{t("gallery:musicPicker.noMusic")}</span>
              <span className="music-row-meta">{t("gallery:musicPicker.playSilent")}</span>
            </Button>
            {selectedId == null && <Check size={18} className="music-row-check" aria-label={t("gallery:musicPicker.selectedAria")} />}
          </li>
        </ul>

        <h4 className="music-group-heading">{t("gallery:musicPicker.yourUploads")}</h4>
        {uploads.length > 0 ? (
          <ul className="music-list">{uploads.map(row)}</ul>
        ) : (
          <p className="management-empty">{t("gallery:musicPicker.emptyUploads")}</p>
        )}

        {tracks === null && <p className="management-empty">{t("gallery:common.loading")}</p>}
      </div>

      {/* One shared element drives every row's preview. Loops so a short bed keeps
          playing while you decide. */}
      <audio ref={audioRef} loop onEnded={() => setPreviewingId(null)} />

      {pendingDelete && (
        <ConfirmDialog
          title={t("gallery:musicPicker.deleteTrackConfirmTitle", { title: pendingDelete.title })}
          confirmLabel={t("gallery:musicPicker.deleteTrackTitle")}
          busyLabel={t("gallery:common.deleting")}
          confirmIcon={<Trash2 size={15} aria-hidden="true" />}
          danger
          busy={deleting}
          error={deleteError}
          onConfirm={() => void remove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        >
          {t("gallery:musicPicker.deleteTrackConfirmBody")}
        </ConfirmDialog>
      )}
    </Modal>
  );
}
