import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PeopleCombobox } from "../audiobooks/PeopleCombobox";
import { PartialDateField } from "./PartialDateField";
import { GENDER_OPTIONS, genderOptionLabel, type FamilyPerson, type FamilyTag } from "./types";

// Create or edit a family member's profile. Uses the standard field pattern:
// each control sits in a `.field` label, dropdowns are native <select>s, and
// Born/Died are free-text partial dates (see PartialDateField) — imported data
// is mostly year-only, which a native date input would blank out and erase on
// save.
export function PersonEditModal({
  person,
  showTags = false,
  onClose,
  onSaved
}: {
  /** null = create a new person. */
  person: FamilyPerson | null;
  /** Admin-only: family tags double as the edit-permission scope. */
  showTags?: boolean;
  onClose: () => void;
  onSaved: (person: FamilyPerson) => void;
}) {
  const { t } = useTranslation(["common", "family"]);
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
  const [tags, setTags] = useState<string[]>(person?.tags ?? []);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<"details" | "notes" | "tags">("details");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!showTags) return;
    api<{ tags: FamilyTag[] }>("/api/family-tree/tags")
      .then((payload) => setTagSuggestions(payload.tags.map((t) => t.name)))
      .catch(() => {});
  }, [showTags]);

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
      bio: bio.trim() || null,
      // Tags are admin-only on the server; non-admin editors never send them.
      ...(showTags ? { tags } : {})
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
      setError(err instanceof Error ? err.message : t("family:personEdit.errors.default"));
      setSaving(false);
    }
  };

  return (
    <Modal
      variant="card"
      title={person ? t("family:personEdit.titleEdit", { name: person.name }) : t("family:personEdit.titleAdd")}
      icon={<UserRound size={18} />}
      className="ft-modal ft-person-form-modal"
      busy={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      {error && <MessageBox tone="error" title={t("errors.unableToSave")}>{error}</MessageBox>}
      <div className="modal-tabs ft-person-form-tabs">
        <button
          type="button"
          className={`modal-tab${activeTab === "details" ? " active" : ""}`}
          onClick={() => setActiveTab("details")}
        >
          {t("family:personEdit.tabDetails")}
        </button>
        <button
          type="button"
          className={`modal-tab${activeTab === "notes" ? " active" : ""}`}
          onClick={() => setActiveTab("notes")}
        >
          {t("family:personEdit.tabNotes")}
        </button>
        {showTags && (
          <button
            type="button"
            className={`modal-tab${activeTab === "tags" ? " active" : ""}`}
            onClick={() => setActiveTab("tags")}
          >
            {t("family:personEdit.tabTags")}
          </button>
        )}
      </div>

      <div className="ft-person-form-body">
      {activeTab === "details" && (
        <div className="ft-form-grid">
          <label className="field">
            <span>{t("family:personEdit.fieldName")}</span>
            <input type="text" value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span>{t("family:personEdit.fieldMaidenName")}</span>
            <input type="text" value={maidenName} onChange={(event) => setMaidenName(event.target.value)} />
          </label>
          <div className="field ft-field-span">
            <span>{t("family:person.meta.gender")}</span>
            <div className="ft-gender-radios" role="radiogroup" aria-label={t("family:person.meta.gender")}>
              {GENDER_OPTIONS.map((option) => (
                <label key={option.value} className="ft-radio">
                  <input
                    type="radio"
                    name="ft-gender"
                    value={option.value}
                    checked={gender === option.value}
                    onChange={() => setGender(option.value)}
                  />
                  <span>{genderOptionLabel(option.value)}</span>
                </label>
              ))}
            </div>
          </div>
          <PartialDateField label={t("family:person.meta.born")} value={birthDate} onChange={setBirthDate} />
          <label className="field">
            <span>{t("family:person.meta.birthplace")}</span>
            <input type="text" value={birthplace} onChange={(event) => setBirthplace(event.target.value)} />
          </label>
          <PartialDateField
            label={t("family:person.meta.died")}
            value={deathDate}
            placeholder={t("family:partialDate.example.death")}
            onChange={setDeathDate}
          />
          <label className="field">
            <span>{t("family:personEdit.fieldDeathPlace")}</span>
            <input type="text" value={deathPlace} onChange={(event) => setDeathPlace(event.target.value)} />
          </label>
        </div>
      )}

      {activeTab === "notes" && (
        <label className="field ft-bio-field">
          <span>{t("family:personEdit.tabNotes")}</span>
          <textarea value={bio} onChange={(event) => setBio(event.target.value)} />
        </label>
      )}

      {activeTab === "tags" && showTags && (
        <div className="field">
          <span>{t("family:person.meta.familyTags")}</span>
          <PeopleCombobox
            value={tags}
            onChange={setTags}
            suggestions={tagSuggestions}
            placeholder={t("family:personEdit.tagsPlaceholder")}
          />
          <small className="ft-modal-hint">{t("family:personEdit.tagsHint")}</small>
        </div>
      )}
      </div>
      <div className="modal-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={saving || !name.trim()}>
          {saving ? t("family:common.saving") : person ? t("family:common.saveChanges") : t("family:common.addPerson")}
        </Button>
      </div>
    </Modal>
  );
}
