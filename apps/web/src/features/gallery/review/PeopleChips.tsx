import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search, X } from "lucide-react";
import type { GalleryPerson, GalleryPersonTag } from "../types";
import { Button } from "../../../shared/Button";

// "Who is in it?": one search box, the people on this photo as chips with a
// cross, and the people the library already knows as suggestions, most-seen
// first. Typing narrows the suggestions; a name nobody has yet is offered as
// "Add …", and Enter takes the exact or only match, otherwise the new name. A new name is
// carried as a tag with a "new:" id until the save creates the person
// (docs/photo-review-plan.md, phase 2).

export const NEW_PERSON_PREFIX = "new:";

/** Suggestions shown before anything is typed. */
const IDLE_SUGGESTIONS = 8;
/** Matches shown while typing. */
const MATCHES = 12;

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
  const [query, setQuery] = useState("");

  const selectedIds = new Set(selected.map((person) => person.id));
  const known: GalleryPersonTag[] = suggestions
    .filter((person) => person.name)
    .map((person) => ({ id: person.id, name: person.name }));

  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const available = known.filter((person) => !selectedIds.has(person.id));
  const shown = needle
    ? available
      // Names that start with what she typed first, then names containing it.
      .filter((person) => person.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
      .slice(0, MATCHES)
    : available.slice(0, IDLE_SUGGESTIONS);
  const exact = [...known, ...selected].find((person) => person.name.toLowerCase() === needle);
  const canAddNew = Boolean(trimmed) && !exact;

  const add = (person: GalleryPersonTag) => {
    if (!selectedIds.has(person.id)) onChange([...selected, person]);
    setQuery("");
  };

  const addTyped = () => {
    if (!trimmed) return;
    if (exact) { add(exact); return; }
    // One person matches: that is who she means. Several: the name as typed,
    // unless she picks one of them — guessing between "Anna" and "Annushka" is not ours.
    if (shown.length === 1) { add(shown[0]); return; }
    add({ id: `${NEW_PERSON_PREFIX}${trimmed}`, name: trimmed });
  };

  return (
    <div className="review-people">
      <div className="review-search">
        <Search size={20} aria-hidden="true" />
        <input
          className="review-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); addTyped(); }
            if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); }
          }}
          placeholder={t("who.searchPlaceholder")}
          maxLength={120}
          disabled={disabled}
          aria-label={t("who.searchAria")}
        />
      </div>

      {selected.length > 0 && (
        <ul className="review-chips review-people-selected" aria-label={t("who.onPhotoAria")}>
          {selected.map((person) => (
            <li key={person.id} className="review-chip review-chip-person">
              <span>{person.name}</span>
              <Button
                variant="bare"
                className="review-chip-remove"
                onClick={() => onChange(selected.filter((p) => p.id !== person.id))}
                disabled={disabled}
                aria-label={t("who.removeAria", { name: person.name })}
                title={t("who.removeAria", { name: person.name })}
              >
                <X size={16} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(shown.length > 0 || canAddNew) && (
        <div className="review-suggest" role="group" aria-label={t("who.suggestions")}>
          {shown.length > 0 && <span className="review-suggest-label">{needle ? t("who.matches") : t("who.suggestions")}</span>}
          <div className="review-chips">
            {shown.map((person) => (
              <Button variant="chip" key={person.id} className="review-chip" onClick={() => add(person)} disabled={disabled}>
                {person.name}
              </Button>
            ))}
            {canAddNew && (
              <Button
                variant="chip"
                className="review-chip review-chip-plus"
                onClick={() => add({ id: `${NEW_PERSON_PREFIX}${trimmed}`, name: trimmed })}
                disabled={disabled}
              >
                <Plus size={18} aria-hidden="true" /> {t("who.addNamed", { name: trimmed })}
              </Button>
            )}
          </div>
        </div>
      )}

      {known.length === 0 && selected.length === 0 && !trimmed && <p className="review-hint">{t("who.nobodyYet")}</p>}
    </div>
  );
}
