import { useState } from "react";
import { UserRound } from "lucide-react";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { GENDER_OPTIONS, type FamilyPerson } from "./types";

// Create or edit a family member's profile. Uses the standard field pattern:
// each control sits in a `.field` label, dropdowns are native <select>s, and
// Born/Died are native date inputs (calendar picker). Full dates only here; the
// server still accepts partial dates for imports.
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
  // Native date inputs need a full YYYY-MM-DD; a stored partial date (import)
  // simply shows blank until re-picked.
  const fullDate = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "");
  const [birthDate, setBirthDate] = useState(fullDate(person?.birthDate));
  const [deathDate, setDeathDate] = useState(fullDate(person?.deathDate));
  const [birthplace, setBirthplace] = useState(person?.birthplace ?? "");
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
      birthDate: birthDate || null,
      deathDate: deathDate || null,
      birthplace: birthplace.trim() || null,
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
        <label className="field">
          <span>Born</span>
          <input type="date" value={birthDate} max={deathDate || undefined} onChange={(event) => setBirthDate(event.target.value)} />
        </label>
        <label className="field">
          <span>Died</span>
          <input type="date" value={deathDate} min={birthDate || undefined} onChange={(event) => setDeathDate(event.target.value)} />
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
