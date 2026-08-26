import { useState } from "react";
import { CalendarClock, ImagePlus, Play, X } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryAsset } from "../gallery/types";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { useFamilyUploadTarget } from "./useFamilyUploadTarget";
import { PartialDateField } from "./PartialDateField";
import { EVENT_TYPE_OPTIONS, type FamilyEvent } from "./types";

// What goes in the label field, per type — the short "what happened".
const LABEL_HINTS: Record<FamilyEvent["type"], string> = {
  education: "School or university",
  graduation: "School or university",
  occupation: "Job title or employer",
  retirement: "e.g. Retired from the railway",
  residence: "e.g. Family home",
  military: "Unit or service",
  immigration: "e.g. Arrived by ship",
  emigration: "e.g. Left for work",
  naturalization: "e.g. Became a citizen",
  travel: "e.g. Trip to Italy",
  award: "Medal or honor",
  baptism: "Church or parish",
  burial: "Cemetery",
  custom: "What happened"
};

// Create or edit a timeline event. Dates are free-text partial dates — a year
// is the norm for "went to school 1971–1975", which native date inputs can't
// express; the server validates the YYYY[-MM[-DD]] shape.
//
// Photos are staged locally (picker adds to the list, ✕ removes) and only
// written on save — attach for new ids, detach for removed ones — so Cancel
// leaves the event untouched.
export function EventEditModal({
  personId,
  personName,
  facePerson = null,
  event: existing,
  onClose,
  onSaved
}: {
  personId: string;
  personName: string;
  /** The person's linked gallery person, so the picker can offer face matches —
      an event's photos are usually photos of the person it belongs to. */
  facePerson?: { id: string; name: string } | null;
  /** null = add a new event. */
  event: FamilyEvent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<FamilyEvent["type"]>(existing?.type ?? "education");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [date, setDate] = useState(existing?.date ?? "");
  const [endDate, setEndDate] = useState(existing?.endDate ?? "");
  const [place, setPlace] = useState(existing?.place ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [photos, setPhotos] = useState<GalleryAsset[]>(existing?.photos ?? []);
  const [pickerOpen, setPickerOpen] = useState(false);
  const uploadTo = useFamilyUploadTarget();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (formEvent: React.FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (type === "custom" && !label.trim()) {
      setError("Give this event a short label — it's what the timeline shows.");
      return;
    }
    setSaving(true);
    setError("");
    const body = {
      type,
      label: label.trim() || null,
      date: date.trim() || null,
      endDate: endDate.trim() || null,
      place: place.trim() || null,
      note: note.trim() || null
    };
    try {
      let eventId = existing?.id;
      if (existing) {
        await api(`/api/family-tree/events/${existing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        const created = await api<{ event: FamilyEvent }>(`/api/family-tree/persons/${personId}/events`, {
          method: "POST",
          body: JSON.stringify(body)
        });
        eventId = created.event.id;
      }
      const initialIds = new Set((existing?.photos ?? []).map((p) => p.id));
      const currentIds = new Set(photos.map((p) => p.id));
      const addedIds = [...currentIds].filter((id) => !initialIds.has(id));
      const removedIds = [...initialIds].filter((id) => !currentIds.has(id));
      if (addedIds.length > 0) {
        await api(`/api/family-tree/events/${eventId}/photos`, {
          method: "POST",
          body: JSON.stringify({ itemIds: addedIds })
        });
      }
      for (const itemId of removedIds) {
        await api(`/api/family-tree/events/${eventId}/photos/${itemId}`, { method: "DELETE" });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save this event");
      setSaving(false);
    }
  };

  return (
    <>
    <Modal
      variant="card"
      title={existing ? "Edit event" : `Add event for ${personName}`}
      icon={<CalendarClock size={18} />}
      className="ft-modal ft-person-form-modal"
      busy={saving}
      // While the photo picker is stacked on top, Escape must close only the
      // picker — both modals listen on document.
      onClose={() => { if (!pickerOpen) onClose(); }}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
      <div className="ft-form-grid">
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(event) => setType(event.target.value as FamilyEvent["type"])}>
            {EVENT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{type === "custom" ? "Label" : "Label (optional)"}</span>
          <input
            type="text"
            value={label}
            placeholder={LABEL_HINTS[type]}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <PartialDateField label="From" value={date} onChange={setDate} />
        <PartialDateField label="To (optional)" value={endDate} placeholder="1975" onChange={setEndDate} />
        <label className="field">
          <span>Place</span>
          <input type="text" value={place} onChange={(event) => setPlace(event.target.value)} />
        </label>
      </div>
      <label className="field ft-bio-field">
        <span>Notes</span>
        <textarea value={note} rows={3} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="field">
        <span>Photos</span>
        <div className="ft-event-photo-strip">
          {photos.map((photo) => (
            <span key={photo.id} className="ft-event-photo-thumb">
              {photo.coverUrl && <img src={photo.coverUrl} alt={photo.title} loading="lazy" />}
              {photo.kind === "video" && <Play size={12} className="ft-event-photo-play" aria-hidden="true" />}
              <Button
                variant="icon"
                danger
                className="ft-event-photo-remove"
                title={`Remove ${photo.title}`}
                aria-label={`Remove ${photo.title}`}
                onClick={() => setPhotos((prev) => prev.filter((p) => p.id !== photo.id))}
              >
                <X size={11} aria-hidden="true" />
              </Button>
            </span>
          ))}
          <Button
            variant="secondary"
            compact
            className="ft-event-photo-add"
            onClick={() => setPickerOpen(true)}
          >
            <ImagePlus size={15} aria-hidden="true" />
            Add photos
          </Button>
        </div>
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add event"}
        </Button>
      </div>

    </Modal>

    {pickerOpen && (
      <PhotoPicker
        title="Add photos to this event"
        existingIds={photos.map((p) => p.id)}
        facePerson={facePerson}
        uploadTo={uploadTo}
        onAttach={(_ids, assets) => {
          setPhotos((prev) => {
            const have = new Set(prev.map((p) => p.id));
            return [...prev, ...assets.filter((a) => !have.has(a.id))];
          });
          return Promise.resolve();
        }}
        onClose={() => setPickerOpen(false)}
      />
    )}
    </>
  );
}
