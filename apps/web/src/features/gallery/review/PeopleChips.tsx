import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { GalleryPerson, GalleryPersonTag } from "../types";
import { Button } from "../../../shared/Button";

// "Who is in it?" as chips: the people the library already knows, most-seen
// first, the ones on this photo filled in; a dashed chip adds a name. A new name
// is carried as a tag with a "new:" id until the save creates the person
// (docs/photo-review-plan.md, phase 2).

export const NEW_PERSON_PREFIX = "new:";

export function PeopleChips({
  suggestions,
  selected,
  onChange,
  disabled
}: {
  suggestions: GalleryPerson[];
  selected: GalleryPersonTag[];
  onChange: (next: GalleryPersonTag[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("galleryReview");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const selectedIds = new Set(selected.map((person) => person.id));
  // Everyone known plus the names on this photo the list does not carry (a
  // person tagged only in this Inbox, or one just added here).
  const known = new Map<string, GalleryPersonTag>();
  for (const person of suggestions) if (person.name) known.set(person.id, { id: person.id, name: person.name });
  for (const person of selected) known.set(person.id, person);

  const toggle = (person: GalleryPersonTag) => {
    if (selectedIds.has(person.id)) onChange(selected.filter((p) => p.id !== person.id));
    else onChange([...selected, person]);
  };

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) { setAdding(false); return; }
    const existing = Array.from(known.values()).find((person) => person.name.toLowerCase() === trimmed.toLowerCase());
    const person = existing ?? { id: `${NEW_PERSON_PREFIX}${trimmed}`, name: trimmed };
    if (!selectedIds.has(person.id)) onChange([...selected, person]);
    setName("");
    setAdding(false);
  };

  return (
    <div className="review-chips" role="group" aria-label={t("who.heading")}>
      {Array.from(known.values()).map((person) => (
        <Button
          variant="chip"
          key={person.id}
          className="review-chip"
          aria-pressed={selectedIds.has(person.id)}
          onClick={() => toggle(person)}
          disabled={disabled}
        >
          {person.name}
        </Button>
      ))}
      {adding ? (
        <form
          className="review-chip-add"
          onSubmit={(event) => { event.preventDefault(); commitName(); }}
        >
          <input
            className="review-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("who.addNamePlaceholder")}
            maxLength={120}
            autoFocus
            onKeyDown={(event) => { if (event.key === "Escape") { setAdding(false); setName(""); } }}
          />
          <Button variant="chip" type="submit" className="review-chip" aria-pressed={false}>{t("who.addNameConfirm")}</Button>
          <Button variant="chip" className="review-chip review-chip-quiet" onClick={() => { setAdding(false); setName(""); }}>{t("who.addNameCancel")}</Button>
        </form>
      ) : (
        <Button variant="chip" className="review-chip review-chip-plus" onClick={() => setAdding(true)} disabled={disabled}>
          <Plus size={18} aria-hidden="true" /> {t("who.addName")}
        </Button>
      )}
      {known.size === 0 && !adding && <p className="review-hint">{t("who.nobodyYet")}</p>}
    </div>
  );
}
