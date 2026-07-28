import { useState } from "react";
import { Heart } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PartialDateField } from "./PartialDateField";
import { UNION_STATUS_OPTIONS, type FamilyUnionDetail } from "./types";

// Edit an existing union's status and dates. The divorce date is what marks a
// partner as "former" on the profile, so entering one nudges the status to
// match (the user can still override the select afterwards).
export function UnionEditModal({
  union,
  personName,
  onClose,
  onSaved
}: {
  union: FamilyUnionDetail;
  personName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState(union.status);
  const [marriedDate, setMarriedDate] = useState(union.marriedDate ?? "");
  const [marriedPlace, setMarriedPlace] = useState(union.marriedPlace ?? "");
  const [divorcedDate, setDivorcedDate] = useState(union.divorcedDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const changeDivorcedDate = (value: string) => {
    setDivorcedDate(value);
    if (value.trim() && status !== "divorced" && status !== "widowed") setStatus("divorced");
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/api/family-tree/unions/${union.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          marriedDate: marriedDate.trim() || null,
          marriedPlace: marriedPlace.trim() || null,
          divorcedDate: divorcedDate.trim() || null
        })
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save the relationship");
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={union.partner ? `${personName} & ${union.partner.name}` : `${personName}'s single-parent family`}
      icon={<Heart size={18} />}
      className="ft-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
      <div className="ft-field-stack">
        <label className="field">
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as FamilyUnionDetail["status"])}>
            {UNION_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <PartialDateField
          label={status === "partners" ? "Together since" : "Married"}
          value={marriedDate}
          placeholder="2010 or 2010-06-12"
          onChange={setMarriedDate}
        />
        <label className="field">
          <span>Place of marriage</span>
          <input type="text" value={marriedPlace} onChange={(event) => setMarriedPlace(event.target.value)} />
        </label>
        <PartialDateField
          label="Divorced / separated"
          value={divorcedDate}
          placeholder="2015 or 2015-03-01"
          onChange={changeDivorcedDate}
        />
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </Modal>
  );
}
