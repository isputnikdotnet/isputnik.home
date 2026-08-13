// The alphabets the A–Z strip can show. Display only: which letters a script
// offers and what to call it. Deciding which bucket a title or name falls in is
// the server's job (apps/server/src/modules/library/shared/alphabet.ts) — it
// ships the letters back as facets, and this file just draws them.
//
// See docs/alphabet-approach-proposal.md. Adding a script here is half the work;
// the other half is teaching the server's detection about it.

export type AlphabetId = "latin" | "cyrillic";

export interface AlphabetDef {
  id: AlphabetId;
  /** Native name — the toggle's accessible name and tooltip. */
  label: string;
  /** What the toggle actually prints. A full alphabet is a long row already. */
  short: string;
  letters: string[];
}

// Digits, symbols, and anything in a script this build has no strip for.
export const OTHER_BUCKET = "#";

export const ALPHABETS: AlphabetDef[] = [
  { id: "latin", label: "English", short: "EN", letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("") },
  // Ё is a letter of its own here even though it sorts as Е — a reader looking
  // for Ёжик expects a Ё button.
  { id: "cyrillic", label: "Русский", short: "RU", letters: "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ".split("") }
];

export function alphabetOf(letter: string): AlphabetDef | null {
  return ALPHABETS.find((alphabet) => alphabet.letters.includes(letter)) ?? null;
}
