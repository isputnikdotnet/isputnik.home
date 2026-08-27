import { useState } from "react";
import { CalendarClock, ImagePlus, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import type { GalleryAsset } from "../gallery/types";
import { PhotoPicker } from "../gallery/PhotoPicker";
import { useFamilyUploadTarget } from "./useFamilyUploadTarget";
import { PartialDateField } from "./PartialDateField";
import { EVENT_TYPE_OPTIONS, eventLabelHint, eventTypeLabel, type FamilyEvent } from "./types";

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
  const { t } = useTranslation(["common", "family"]);

  const submit = async (formEvent: React.FormEvent<HTMLFormElement>) => {
    formEvent.preventDefault();
    if (type === "custom" && !label.trim()) {
      setError(t("family:event.errors.labelRequired"));
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
      setError(err instanceof Error ? err.message : t("family:event.errors.default"));
      setSaving(false);
    }
  };

  return (
    <>
    <Modal
      variant="card"
      title={existing ? t("family:event.titleEdit") : t("family:event.titleAdd", { name: personName })}
      icon={<CalendarClock size={18} />}
      className="ft-modal ft-person-form-modal"
      busy={saving}
      // While the photo picker is stacked on top, Escape must close only the
      // picker — both modals listen on document.
      onClose={() => { if (!pickerOpen) onClose(); }}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title={t("errors.unableToSave")}>{error}</MessageBox>}
      <div className="ft-form-grid">
        <label className="field">
          <span>{t("family:event.typeLabel")}</span>
          <select value={type} onChange={(event) => setType(event.target.value as FamilyEvent["type"])}>
            {EVENT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{eventTypeLabel(option.value)}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{type === "custom" ? t("family:event.labelFieldRequired") : t("family:event.labelFieldOptional")}</span>
          <input
            type="text"
            value={label}
            placeholder={eventLabelHint(type)}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <PartialDateField label={t("family:event.fromLabel")} value={date} onChange={setDate} />
        <PartialDateField
          label={t("family:event.toOptionalLabel")}
          value={endDate}
          placeholder={t("family:partialDate.example.endYear")}
          onChange={setEndDate}
        />
        <label className="field">
          <span>{t("family:event.placeLabel")}</span>
          <input type="text" value={place} onChange={(event) => setPlace(event.target.value)} />
        </label>
      </div>
      <label className="field ft-bio-field">
        <span>{t("family:common.notes")}</span>
        <textarea value={note} rows={3} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="field">
        <span>{t("family:event.photosLabel")}</span>
        <div className="ft-event-photo-strip">
          {photos.map((photo) => (
            <span key={photo.id} className="ft-event-photo-thumb">
              {photo.coverUrl && <img src={photo.coverUrl} alt={photo.title} loading="lazy" />}
              {photo.kind === "video" && <Play size={12} className="ft-event-photo-play" aria-hidden="true" />}
              <Button
                variant="icon"
                danger
                className="ft-event-photo-remove"
                title={t("family:event.removePhotoAria", { title: photo.title })}
                aria-label={t("family:event.removePhotoAria", { title: photo.title })}
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
            {t("family:common.addPhotos")}
          </Button>
        </div>
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? t("family:common.saving") : existing ? t("family:common.saveChanges") : t("family:event.submit")}
        </Button>
      </div>

    </Modal>

    {pickerOpen && (
      <PhotoPicker
        title={t("family:event.addPhotosToEventTitle")}
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
