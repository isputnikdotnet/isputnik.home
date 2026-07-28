import { useState } from "react";
import { UserRound } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PartialDateField } from "./PartialDateField";
import { GENDER_OPTIONS, type FamilyPerson } from "./types";

// Create or edit a family member's profile. Uses the standard field pattern:
// each control sits in a `.field` label, dropdowns are native <select>s, and
// Born/Died are free-text partial dates (see PartialDateField) — imported data
// is mostly year-only, which a native date input would blank out and erase on
// save.
export function PersonEditModal({
  person,
  onClose,
  onSaved
}: {
  /** null = create a new person. */
  person: FamilyPerson | null;
  onClose: () => void;
  onSaved: (person: FamilyPerson) => void;
}) {
  const [name, setName] = useState(person?.name ?? "");
  const [maidenName, setMaidenName] = useState(person?.maidenName ?? "");
  // "" = no selection. New people start unselected; existing people show their
  // gender only when it's one of the two offered values.
  const [gender, setGender] = useState<"female" | "male" | "">(
    person?.gender === "male" || person?.gender === "female" ? person.gender : ""
  );
  const [birthDate, setBirthDate] = useState(person?.birthDate ?? "");
  const [deathDate, setDeathDate] = useState(person?.deathDate ?? "");
  const [birthplace, setBirthplace] = useState(person?.birthplace ?? "");
  const [deathPlace, setDeathPlace] = useState(person?.deathPlace ?? "");
  const [bio, setBio] = useState(person?.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    const body = {
      name: name.trim(),
      maidenName: maidenName.trim() || null,
      // Omit when unselected: create → server default; edit → leave unchanged.
      ...(gender ? { gender } : {}),
      birthDate: birthDate.trim() || null,
      deathDate: deathDate.trim() || null,
      birthplace: birthplace.trim() || null,
      deathPlace: deathPlace.trim() || null,
      bio: bio.trim() || null
    };
    try {
      const payload = person
        ? await api<{ person: FamilyPerson }>(`/api/family-tree/persons/${person.id}`, {
            method: "PATCH",
            body: JSON.stringify(body)
          })
        : await api<{ person: FamilyPerson }>("/api/family-tree/persons", {
            method: "POST",
            body: JSON.stringify(body)
          });
      onSaved(payload.person);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save this person");
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={person ? `Edit ${person.name}` : "Add family member"}
      icon={<UserRound size={18} />}
      className="ft-modal ft-person-form-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title="Unable to save">{error}</MessageBox>}
      <div className="ft-form-grid">
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>Maiden name</span>
          <input type="text" value={maidenName} onChange={(event) => setMaidenName(event.target.value)} />
        </label>
        <div className="field">
          <span>Gender</span>
          <div className="ft-gender-radios" role="radiogroup" aria-label="Gender">
            {GENDER_OPTIONS.map((option) => (
              <label key={option.value} className="ft-radio">
                <input
                  type="radio"
                  name="ft-gender"
                  value={option.value}
                  checked={gender === option.value}
                  onChange={() => setGender(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="field">
          <span>Birthplace</span>
          <input type="text" value={birthplace} onChange={(event) => setBirthplace(event.target.value)} />
        </label>
        <PartialDateField label="Born" value={birthDate} onChange={setBirthDate} />
        <PartialDateField label="Died" value={deathDate} placeholder="2024 or 2024-03-15" onChange={setDeathDate} />
        <label className="field">
          <span>Place of death</span>
          <input type="text" value={deathPlace} onChange={(event) => setDeathPlace(event.target.value)} />
        </label>
      </div>
      <label className="field ft-bio-field">
        <span>Bio / notes</span>
        <textarea value={bio} rows={5} onChange={(event) => setBio(event.target.value)} />
      </label>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving || !name.trim()}>
          {saving ? "Saving…" : person ? "Save changes" : "Add person"}
        </Button>
      </div>
    </Modal>
  );
}
