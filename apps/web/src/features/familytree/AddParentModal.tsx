import { useState } from "react";
import { UsersRound } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PersonAvatar } from "./PersonAvatar";
import { PersonPickerModal } from "./PersonPickerModal";
import { CHILD_RELATION_OPTIONS, type FamilyChildLink, type FamilyPerson, type FamilyPersonProfile } from "./types";

// Add a parent for `person`. With no parents recorded this creates a new
// single-parent union and hangs the person under it; with one parent recorded
// it fills the empty partner slot of the existing parent union — which also
// makes the new parent a parent of the person's siblings, as families work.
export function AddParentModal({
  person,
  parentUnionId,
  onClose,
  onAdded
}: {
  person: FamilyPersonProfile;
  /** The union `person` hangs off, when one parent is already recorded. */
  parentUnionId: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const addingSecond = parentUnionId != null && person.parents.length === 1;
  const [parent, setParent] = useState<FamilyPerson | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [relation, setRelation] = useState<FamilyChildLink["relation"]>(person.parentRelation ?? "biological");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const excludeIds = [
    person.id,
    ...person.parents.map((p) => p.id),
    ...person.unions.flatMap((u) => [u.partner?.id, ...u.children.map((c) => c.id)]).filter((id): id is string => id != null)
  ];

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!parent) return;
    setSaving(true);
    setError("");
    try {
      if (addingSecond) {
        await api(`/api/family-tree/unions/${parentUnionId}`, {
          method: "PATCH",
          body: JSON.stringify({ person2Id: parent.id })
        });
      } else {
        const created = await api<{ union: { id: string } }>("/api/family-tree/unions", {
          method: "POST",
          body: JSON.stringify({ person1Id: parent.id, person2Id: null })
        });
        await api(`/api/family-tree/unions/${created.union.id}/children`, {
          method: "POST",
          body: JSON.stringify({ childId: person.id, relation })
        });
      }
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add the parent");
      setSaving(false);
    }
  };

  if (pickerOpen) {
    return (
      <PersonPickerModal
        title={`Parent of ${person.name}`}
        excludeIds={excludeIds}
        onPick={(picked) => { setParent(picked); setPickerOpen(false); }}
        onClose={() => setPickerOpen(false)}
      />
    );
  }

  return (
    <Modal
      variant="card"
      title={addingSecond ? `Add ${person.name}'s other parent` : `Add parent of ${person.name}`}
      icon={<UsersRound size={18} />}
      className="ft-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title="Unable to add">{error}</MessageBox>}
      {addingSecond && (
        <p className="ft-modal-hint">
          Joins {person.parents[0].name}'s family — siblings in it get this parent too.
        </p>
      )}
      <div className="ft-partner-pick">
        {parent ? (
          <button type="button" className="ft-picker-row" onClick={() => setPickerOpen(true)} disabled={saving}>
            <PersonAvatar person={parent} size={36} />
            <span className="ft-picker-row-name"><strong>{parent.name}</strong><small>Change parent</small></span>
          </button>
        ) : (
          <Button variant="secondary" onClick={() => setPickerOpen(true)} disabled={saving}>
            Choose parent…
          </Button>
        )}
      </div>
      {!addingSecond && (
        <div className="ft-field-stack">
          <label className="field">
            <span>Relation</span>
            <select value={relation} onChange={(event) => setRelation(event.target.value as FamilyChildLink["relation"])}>
              {CHILD_RELATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving || !parent}>
          {saving ? "Adding…" : "Add parent"}
        </Button>
      </div>
    </Modal>
  );
}
