import { useEffect, useMemo, useState } from "react";
import { Plus, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../api";
import { Button } from "../../shared/Button";
import { MarkdownEditor } from "../../shared/MarkdownEditor";
import { MessageBox } from "../../shared/MessageBox";
import { Modal } from "../../shared/Modal";
import { PartialDateInput } from "../../shared/PartialDateInput";
import { TagEditor } from "../../shared/tags/TagEditor";
import type { TagSuggestion } from "../../shared/tags/useTagSuggestions";
import { PlaceField, type PlacePin } from "../../shared/PlaceField";
import { SelectField } from "../../shared/SelectField";
import { loadFamilyPlaces, searchFamilyPlacesOnline } from "./familyPlaces";
import { GENDER_OPTIONS, genderOptionLabel, type FamilyPerson, type FamilyPersonName, type FamilyTag } from "./types";

// Create or edit a family member's profile. Names up top (with the name as
// written in other languages), then Birth and Death as two panels of Date ·
// Place. Dates are partial (Day · Month · Year, any leading part optional) —
// imported data is mostly year-only. Places are typed freely or picked from the
// places search, which also pins them.

/** Languages offered for another name, most likely first for this house; any
 *  code a person already carries is offered too. */
const NAME_LANGUAGES = [
  "ru", "uk", "be", "en", "pl", "de", "yi", "he", "lt", "lv", "et", "fr", "es", "it", "cs", "sk", "hu", "ro",
  "bg", "sr", "hr", "el", "tr", "ka", "hy", "az", "kk", "uz", "ar", "fa", "zh", "ja", "ko", "pt", "nl", "sv", "fi"
];

type NameRow = FamilyPersonName & { key: number };

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
  const { t, i18n } = useTranslation(["common", "family"]);
  const [name, setName] = useState(person?.name ?? "");
  const [maidenName, setMaidenName] = useState(person?.maidenName ?? "");
  const [otherNames, setOtherNames] = useState<NameRow[]>(
    () => (person?.otherNames ?? []).map((entry, index) => ({ ...entry, key: index }))
  );
  // The row just added takes focus, so she can type the name straight away.
  const [addedKey, setAddedKey] = useState<number | null>(null);
  // "" = no selection: a new person starts unanswered and is saved as unknown.
  const [gender, setGender] = useState<FamilyPerson["gender"] | "">(
    person && person.gender !== "other" ? person.gender : ""
  );
  const [birthDate, setBirthDate] = useState(person?.birthDate ?? "");
  const [deathDate, setDeathDate] = useState(person?.deathDate ?? "");
  const [birthplace, setBirthplace] = useState(person?.birthplace ?? "");
  const [birthPin, setBirthPin] = useState<PlacePin | null>(person?.birthPin ?? null);
  const [deathPlace, setDeathPlace] = useState(person?.deathPlace ?? "");
  const [deathPin, setDeathPin] = useState<PlacePin | null>(person?.deathPin ?? null);
  const [bio, setBio] = useState(person?.bio ?? "");
  const [tags, setTags] = useState<string[]>(person?.tags ?? []);
  const [tagSuggestions, setTagSuggestions] = useState<TagSuggestion[]>([]);
  const [activeTab, setActiveTab] = useState<"details" | "notes" | "tags">("details");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!showTags) return;
    api<{ tags: FamilyTag[] }>("/api/family-tree/tags")
      .then((payload) => setTagSuggestions(payload.tags.map((tag) => ({ name: tag.name, uses: tag.count }))))
      .catch(() => {});
  }, [showTags]);

  const languageOptions = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([i18n.language], { type: "language" });
    } catch {
      // No display names: the codes themselves.
    }
    const label = (code: string) => {
      const text = names?.of(code) ?? code;
      return text.charAt(0).toLocaleUpperCase(i18n.language) + text.slice(1);
    };
    const codes = [...new Set([...NAME_LANGUAGES, ...otherNames.map((row) => row.language)])];
    return codes
      .map((code) => ({ value: code, label: label(code) }))
      .sort((a, b) => a.label.localeCompare(b.label, i18n.language));
  }, [i18n.language, otherNames]);

  const addOtherName = () => {
    const used = new Set(otherNames.map((row) => row.language));
    // The likeliest second spelling is the other script: Russian beside a name
    // written in Latin letters, English beside a Cyrillic one.
    const preferred = /\p{Script=Cyrillic}/u.test(name) ? ["en", "uk", "be"] : ["ru", "uk", "be"];
    const language = [...preferred, ...NAME_LANGUAGES].find((code) => !used.has(code)) ?? "ru";
    const key = otherNames.reduce((max, row) => Math.max(max, row.key), -1) + 1;
    setOtherNames([...otherNames, { key, language, name: "" }]);
    setAddedKey(key);
  };

  const changeOtherName = (key: number, patch: Partial<FamilyPersonName>) =>
    setOtherNames((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    const body = {
      name: name.trim(),
      maidenName: maidenName.trim() || null,
      otherNames: otherNames
        .map(({ language, name: text }) => ({ language, name: text.trim() }))
        .filter((entry) => entry.name),
      // Omit when unselected: create → server default (unknown); edit → unchanged.
      ...(gender ? { gender } : {}),
      birthDate: birthDate.trim() || null,
      deathDate: deathDate.trim() || null,
      birthplace: birthplace.trim() || null,
      birthPin: birthplace.trim() ? birthPin : null,
      deathPlace: deathPlace.trim() || null,
      deathPin: deathPlace.trim() ? deathPin : null,
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

  const languageName = (code: string) => languageOptions.find((option) => option.value === code)?.label ?? code;

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
      <div className="modal-tabs ft-person-form-tabs" role="tablist">
        <Button
          variant="tab"
          className="modal-tab"
          selected={activeTab === "details"}
          onClick={() => setActiveTab("details")}
        >
          {t("family:personEdit.tabDetails")}
        </Button>
        <Button
          variant="tab"
          className="modal-tab"
          selected={activeTab === "notes"}
          onClick={() => setActiveTab("notes")}
        >
          {t("family:personEdit.tabNotes")}
        </Button>
        {showTags && (
          <Button
            variant="tab"
            className="modal-tab"
            selected={activeTab === "tags"}
            onClick={() => setActiveTab("tags")}
          >
            {t("family:personEdit.tabTags")}
          </Button>
        )}
      </div>

      <div className="ft-person-form-body">
      {/* Hidden, not unmounted: a half-typed date keeps its parts, and its
          validity still stops the form from submitting from another tab — which
          brings this tab back, so she sees what to fix. */}
      <div
        className="ft-person-details"
        hidden={activeTab !== "details"}
        onInvalidCapture={() => setActiveTab("details")}
      >
        <div className="ft-form-grid">
          <label className="field">
            <span>{t("family:personEdit.fieldName")}</span>
            <input type="text" value={name} onChange={(event) => setName(event.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span>{t("family:personEdit.fieldMaidenName")}</span>
            <input type="text" value={maidenName} onChange={(event) => setMaidenName(event.target.value)} />
          </label>

          <div className="field ft-field-span ft-other-names" role="group" aria-labelledby="ft-other-names-label">
            <span id="ft-other-names-label">{t("family:personEdit.otherNames")}</span>
            {otherNames.map((row) => (
              <div className="ft-other-name-row" key={row.key}>
                <SelectField
                  className="ft-other-name-language"
                  label={t("family:personEdit.otherNameLanguage")}
                  hideLabel
                  value={row.language}
                  options={languageOptions}
                  onChange={(language) => changeOtherName(row.key, { language })}
                />
                <input
                  type="text"
                  value={row.name}
                  maxLength={120}
                  autoFocus={row.key === addedKey}
                  aria-label={t("family:personEdit.otherNameIn", { language: languageName(row.language) })}
                  onChange={(event) => changeOtherName(row.key, { name: event.target.value })}
                />
                <Button
                  variant="icon"
                  aria-label={t("family:personEdit.removeOtherName", { language: languageName(row.language) })}
                  title={t("family:personEdit.removeOtherName", { language: languageName(row.language) })}
                  onClick={() => setOtherNames((rows) => rows.filter((other) => other.key !== row.key))}
                >
                  <X size={18} />
                </Button>
              </div>
            ))}
            <Button variant="text" className="ft-other-name-add" onClick={addOtherName}>
              <Plus size={16} aria-hidden="true" />
              {t("family:personEdit.addOtherName")}
            </Button>
          </div>

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
        </div>

        <fieldset className="ft-life-panel">
          <legend>{t("family:personEdit.birth")}</legend>
          <div className="ft-life-panel-grid">
            <PartialDateInput label={t("family:personEdit.date")} value={birthDate} onChange={setBirthDate} />
            <PlaceField
              label={t("family:personEdit.place")}
              value={birthplace}
              pin={birthPin}
              load={loadFamilyPlaces}
              searchOnline={searchFamilyPlacesOnline}
              onChange={(place, pin) => { setBirthplace(place); setBirthPin(pin); }}
            />
          </div>
        </fieldset>

        <fieldset className="ft-life-panel">
          <legend>{t("family:personEdit.death")}</legend>
          <div className="ft-life-panel-grid">
            <PartialDateInput label={t("family:personEdit.date")} value={deathDate} onChange={setDeathDate} />
            <PlaceField
              label={t("family:personEdit.place")}
              value={deathPlace}
              pin={deathPin}
              load={loadFamilyPlaces}
              searchOnline={searchFamilyPlacesOnline}
              onChange={(place, pin) => { setDeathPlace(place); setDeathPin(pin); }}
            />
          </div>
        </fieldset>
      </div>

      {activeTab === "notes" && (
        <div className="field ft-bio-field">
          <span>{t("family:personEdit.tabNotes")}</span>
          {/* Markdown, like a story's text: the buttons type the marks, the
              profile renders them, and GEDCOM export takes them off again. */}
          <MarkdownEditor
            value={bio}
            onChange={setBio}
            maxLength={4000}
            rows={14}
            ariaLabel={t("family:personEdit.tabNotes")}
            placeholder={t("family:personEdit.bioPlaceholder")}
            autoFocus
          />
        </div>
      )}

      {activeTab === "tags" && showTags && (
        <div className="field">
          <span>{t("family:person.meta.familyTags")}</span>
          <TagEditor
            tags={tags}
            suggestions={tagSuggestions}
            alwaysOpen
            onAdd={(tag) => setTags((current) => [...current, tag])}
            onRemove={(tag) => setTags((current) => current.filter((other) => other !== tag))}
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
