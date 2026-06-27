import { useState } from "react";
import { Pencil } from "lucide-react";
import { api } from "../../api";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { Button } from "../../shared/Button";
import type { GalleryAsset } from "./types";

// ISO → value for <input type="datetime-local"> (local wall-clock, minute precision).
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Edit a photo/video's caption, description, date taken, and tags. Technical
// fields (dimensions, size, camera, GPS) stay read-only — see the Info panel.
export function GalleryEditModal({
  asset,
  onClose,
  onSaved
}: {
  asset: GalleryAsset;
  onClose: () => void;
  onSaved: (asset: GalleryAsset) => void;
}) {
  const [title, setTitle] = useState(asset.title);
  const [description, setDescription] = useState(asset.description ?? "");
  const [takenAt, setTakenAt] = useState(toLocalInput(asset.takenAt));
  const [tags, setTags] = useState(asset.tags.join(", "));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError("");
    try {
      const tagList = Array.from(new Set(
        tags.split(",").map((tag) => tag.trim()).filter(Boolean)
      ));
      const payload = await api<{ asset: GalleryAsset }>(`/api/library/gallery/assets/${asset.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: trimmed,
          description: description.trim() || null,
          takenAt: takenAt ? new Date(takenAt).toISOString() : null,
          tags: tagList
        })
      });
      onSaved(payload.asset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save changes");
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="panel"
      title="Edit details"
      icon={<Pencil size={20} />}
      className="gallery-edit-modal"
      busy={saving}
      onClose={onClose}
    >
      <form className="modal-tab-content" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}

        <label className="field">
          <span>Title</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={300} />
        </label>

        <label className="field">
          <span>Description <small className="muted">(optional)</small></span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={5000} />
        </label>

        <label className="field">
          <span>Date taken <small className="muted">(drives the timeline)</small></span>
          <input type="datetime-local" value={takenAt} onChange={(event) => setTakenAt(event.target.value)} />
        </label>

        <label className="field">
          <span>Tags <small className="muted">(comma-separated)</small></span>
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="e.g. vacation, family" />
        </label>

        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={saving || !title.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
