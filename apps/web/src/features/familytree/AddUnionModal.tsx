import { useState } from "react";
import { Heart } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonPickerModal } from "./PersonPickerModal";
import { UNION_STATUS_OPTIONS, type FamilyPerson, type FamilyUnion } from "./types";

// Add a spouse/partner union for `person`: pick the partner (or create them),
// set the status and dates. Partner is optional — omitting one records a
// single-parent family children can hang off.
export function AddUnionModal({
  person,
  onClose,
  onAdded
}: {
  person: FamilyPerson;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [partner, setPartner] = useState<FamilyPerson | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState<FamilyUnion["status"]>("married");
  const [marriedDate, setMarriedDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api("/api/family-tree/unions", {
        method: "POST",
        body: JSON.stringify({
          person1Id: person.id,
          person2Id: partner?.id ?? null,
          status,
          marriedDate: marriedDate || null
        })
      });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add the union");
      setSaving(false);
    }
  };

  if (pickerOpen) {
    return (
      <PersonPickerModal
        title={`Partner of ${person.name}`}
        excludeIds={[person.id]}
        onPick={(picked) => { setPartner(picked); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    );
  }

  return (
    <Modal
      variant="card"
      title={`Add partner for ${person.name}`}
      icon={<Heart size={18} />}
      className="ft-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title="Unable to add">{error}</MessageBox>}
      <div className="ft-partner-pick">
        {partner ? (
          <button type="button" className="ft-picker-row" onClick={() => setPickerOpen(true)} disabled={saving}>
            <PersonAvatar person={partner} size={36} />
            <span className="ft-picker-row-name"><strong>{partner.name}</strong><small>Change partner</small></span>
          </button>
        ) : (
          <Button variant="secondary" onClick={() => setPickerOpen(true)} disabled={saving}>
            Choose partner…
          </Button>
        )}
        {partner && (
          <Button variant="text" compact onClick={() => setPartner(null)} disabled={saving}>
            No partner (single parent)
          </Button>
        )}
      </div>
      <div className="ft-field-stack">
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as FamilyUnion["status"])}>
            {UNION_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Married / together since</span>
          <input type="date" value={marriedDate} onChange={(event) => setMarriedDate(event.target.value)} />
        </label>
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Adding…" : "Add union"}
        </Button>
      </div>
    </Modal>
  );
}
