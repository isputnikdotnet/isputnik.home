import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ALPHABETS, OTHER_BUCKET, alphabetOf, type AlphabetId } from "./alphabets";

// The A–Z index that sits in the second row of LibraryPageToolbar. One letter at
// a time, "All" to clear it, "#" for everything that isn't a letter of the
// shown alphabet (digits, symbols, other scripts).
//
// `available` is the set of buckets the current scope actually holds, straight
// from the server's facets. Letters outside it are disabled rather than hidden:
// a row that reflowed as the scope changed would move the letter out from under
// the pointer.
//
// The script toggle (English | Русский) appears only when the scope has titles
// in both — a library with nothing but Latin titles gets the letters alone.
export function AlphabetBar({
  available,
  value,
  onChange,
  ariaLabel
}: {
  available: string[];
  value: string | null;
  onChange: (letter: string | null) => void;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const has = useMemo(() => new Set(available), [available]);
  const scripts = useMemo(
    () => ALPHABETS.filter((alphabet) => alphabet.letters.some((letter) => has.has(letter))),
    [has]
  );
  const [picked, setPicked] = useState<AlphabetId | null>(null);

  // A chosen letter always wins: landing on ?letter=Д has to show the Cyrillic
  // row whatever the toggle last said.
  const fromValue = value ? alphabetOf(value)?.id ?? null : null;
  const active = ALPHABETS.find((alphabet) => alphabet.id === (fromValue ?? picked)) ?? scripts[0];

  // Nothing indexed yet (an empty or still-scanning library): no strip at all.
  if (!active || available.length === 0) return null;

  const pickScript = (id: AlphabetId) => {
    setPicked(id);
    // The active letter belongs to the alphabet being left, so it can't stay.
    if (value && !ALPHABETS.find((alphabet) => alphabet.id === id)?.letters.includes(value)) onChange(null);
  };

  const letterButton = (letter: string, label?: string) => (
    <button
      key={letter}
      type="button"
      className={value === letter ? "is-active" : ""}
      disabled={!has.has(letter)}
      aria-pressed={value === letter}
      aria-label={label}
      onClick={() => onChange(value === letter ? null : letter)}
    >
      {letter}
    </button>
  );

  return (
    <div className="alphabet-bar" role="group" aria-label={ariaLabel ?? t("alphabet.label")}>
      {scripts.length > 1 && (
        <div className="alphabet-scripts" role="group" aria-label={t("alphabet.scripts")}>
          {scripts.map((alphabet) => (
            <button
              key={alphabet.id}
              type="button"
              className={active.id === alphabet.id ? "is-active" : ""}
              aria-pressed={active.id === alphabet.id}
              aria-label={alphabet.label}
              title={alphabet.label}
              onClick={() => pickScript(alphabet.id)}
            >
              {alphabet.short}
            </button>
          ))}
        </div>
      )}
      <div className="alphabet-letters">
        <button
          type="button"
          className={value === null ? "is-active" : ""}
          aria-pressed={value === null}
          onClick={() => onChange(null)}
        >
          {t("alphabet.all")}
        </button>
        {active.letters.map((letter) => letterButton(letter))}
        {letterButton(OTHER_BUCKET, t("alphabet.other"))}
      </div>
    </div>
  );
}
