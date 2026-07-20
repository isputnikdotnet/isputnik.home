import { useEffect, useRef, useState } from "react";
import { Check, Music, Pause, Play, Trash2, UploadCloud, VolumeX, X } from "lucide-react";
import { api, csrfToken } from "../../api";
import { Modal } from "../../shared/Modal";
import { MessageBox } from "../../shared/MessageBox";
import type { GalleryMusicTrack } from "./types";

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Choose the music bed for a slideshow: built-in ambient beds + the user's uploads,
// with in-place preview, upload, and delete (own uploads / admin). Selecting a track
// (or "No music") calls onSelect; the parent persists it. Modeled on AddToAlbumModal.
export function MusicPicker({
  selectedId,
  onSelect,
  onClose
}: {
  selectedId: string | null;
  onSelect: (trackId: string | null) => void;
  onClose: () => void;
}) {
  const [tracks, setTracks] = useState<GalleryMusicTrack[] | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = () =>
    api<{ tracks: GalleryMusicTrack[] }>("/api/library/gallery/music")
      .then((payload) => setTracks(payload.tracks))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load music"));

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
    void audio.play().then(() => setPreviewingId(track.id)).catch(() => setError("Couldn’t play this track."));
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const token = csrfToken();
      const res = await fetch("/api/library/gallery/music", {
        method: "POST",
        credentials: "include",
        headers: token ? { "X-CSRF-Token": token } : undefined,
        body: form
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || "Upload failed");
      }
      const { track } = (await res.json()) as { track: GalleryMusicTrack };
      await load();
      onSelect(track.id); // auto-select the just-uploaded track
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload the track");
    } finally {
      setUploading(false);
    }
  };

  const remove = async (track: GalleryMusicTrack) => {
    setError("");
    try {
      if (previewingId === track.id) { audioRef.current?.pause(); setPreviewingId(null); }
      await api(`/api/library/gallery/music/${track.id}`, { method: "DELETE" });
      if (selectedId === track.id) onSelect(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete the track");
    }
  };

  const builtins = (tracks ?? []).filter((t) => t.builtin);
  const uploads = (tracks ?? []).filter((t) => !t.builtin);

  const row = (track: GalleryMusicTrack) => (
    <li key={track.id} className={`music-row${selectedId === track.id ? " is-selected" : ""}`}>
      <button
        type="button"
        className="music-row-preview"
        onClick={() => togglePreview(track)}
        aria-label={previewingId === track.id ? `Stop preview of ${track.title}` : `Preview ${track.title}`}
        title={previewingId === track.id ? "Stop preview" : "Preview"}
      >
        {previewingId === track.id ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button type="button" className="music-row-main" onClick={() => onSelect(track.id)}>
        <span className="music-row-title">{track.title}</span>
        <span className="music-row-meta">
          {track.builtin ? "Built-in" : "Your upload"}{track.durationSeconds != null ? ` · ${formatDuration(track.durationSeconds)}` : ""}
        </span>
      </button>
      {selectedId === track.id && <Check size={18} className="music-row-check" aria-label="Selected" />}
      {!track.builtin && (
        <button type="button" className="music-row-delete" onClick={() => void remove(track)} aria-label={`Delete ${track.title}`} title="Delete track">
          <Trash2 size={15} />
        </button>
      )}
    </li>
  );

  return (
    <Modal variant="panel" title="Slideshow music" icon={<Music size={20} />} className="music-picker-modal" onClose={onClose}>
      <div className="add-to-album-head">
        {error && <MessageBox tone="error" title="Music error">{error}</MessageBox>}
        <div className="music-picker-actions">
          <button type="button" className="secondary-button compact-button" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <UploadCloud size={16} aria-hidden="true" /> {uploading ? "Uploading…" : "Upload track"}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.mp3,.m4a,.aac,.ogg,.oga,.opus,.wav,.flac"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }}
          />
        </div>
      </div>

      <div className="modal-tab-content music-picker-body">
        <ul className="music-list">
          <li className={`music-row${selectedId == null ? " is-selected" : ""}`}>
            <span className="music-row-preview is-static" aria-hidden="true"><VolumeX size={16} /></span>
            <button type="button" className="music-row-main" onClick={() => onSelect(null)}>
              <span className="music-row-title">No music</span>
              <span className="music-row-meta">Play the slideshow silent</span>
            </button>
            {selectedId == null && <Check size={18} className="music-row-check" aria-label="Selected" />}
          </li>
        </ul>

        {builtins.length > 0 && (
          <>
            <h4 className="music-group-heading">Built-in beds</h4>
            <ul className="music-list">{builtins.map(row)}</ul>
          </>
        )}

        <h4 className="music-group-heading">Your uploads</h4>
        {uploads.length > 0 ? (
          <ul className="music-list">{uploads.map(row)}</ul>
        ) : (
          <p className="management-empty">No uploaded tracks yet — add your own above.</p>
        )}

        {tracks === null && <p className="management-empty">Loading…</p>}
      </div>

      {/* One shared element drives every row's preview. Loops so a short bed keeps
          playing while you decide. */}
      <audio ref={audioRef} loop onEnded={() => setPreviewingId(null)} />
    </Modal>
  );
}
