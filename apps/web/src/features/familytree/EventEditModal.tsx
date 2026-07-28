import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PartialDateField } from "./PartialDateField";
import { EVENT_TYPE_OPTIONS, type FamilyEvent } from "./types";

// What goes in the label field, per type — the short "what happened".
const LABEL_HINTS: Record<FamilyEvent["type"], string> = {
  education: "School or university",
  occupation: "Job title or employer",
  residence: "e.g. Family home",
  military: "Unit or service",
  immigration: "e.g. Arrived by ship",
  emigration: "e.g. Left for work",
  burial: "Cemetery",
  custom: "What happened"
};

// Create or edit a timeline event. Dates are free-text partial dates — a year
// is the norm for "went to school 1971–1975", which native date inputs can't
// express; the server validates the YYYY[-MM[-DD]] shape.
export function EventEditModal({
  personId,
  personName,
  event: existing,
  onClose,
  onSaved
}: {
  personId: string;
  personName: string;
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
      if (existing) {
        await api(`/api/family-tree/events/${existing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api(`/api/family-tree/persons/${personId}/events`, { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save this event");
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={existing ? "Edit event" : `Add event for ${personName}`}
      icon={<CalendarClock size={18} />}
      className="ft-modal ft-person-form-modal"
      busy={saving}
      onClose={onClose}
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
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : existing ? "Save changes" : "Add event"}
        </Button>
      </div>
    </Modal>
  );
}
