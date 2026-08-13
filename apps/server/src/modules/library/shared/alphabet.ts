// The alphabet index behind the A–Z strip (docs/alphabet-approach-proposal.md).
//
// Two jobs, deliberately separate:
//   * alphaKey — which letter button a title/name files under. Ё is its own bucket.
//   * sortKey  — what the list orders by. Ё folds into Е here, because Russian
//     collation treats them as the same letter at the primary level.
//
// It lives on the server and only on the server: SQLite's UPPER() is ASCII-only
// and better-sqlite3 exposes no custom-collation API, so neither bucketing nor
// Cyrillic ordering can be done in SQL. Items store the result (see
// item_metadata.alpha_key); the whole-list people endpoints compute it per
// response. The web ships only the display definitions (which letters a script
// shows), never a second copy of this logic.

export type AlphaScript = "latin" | "cyrillic" | "other";

// Everything that isn't a letter of a known alphabet indexes here: digits,
// punctuation, and scripts this build has no strip for.
export const OTHER_BUCKET = "#";

export const LATIN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
export const CYRILLIC_LETTERS = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ".split("");

// Letters NFD can't decompose (the stroke/ligature ones) mapped to the bucket a
// reader would look under. Without these, Łem and Øst fall into "#".
const LATIN_FOLDS: Record<string, string> = {
  "Ł": "L", "Ø": "O", "Đ": "D", "Ð": "D", "Æ": "A", "Œ": "O", "Þ": "T", "ß": "S", "İ": "I", "Ħ": "H"
};

// Cyrillic letters outside the Russian alphabet — Ukrainian and Belarusian ones
// mostly — folded onto their nearest Russian bucket, since Russian is the only
// Cyrillic strip this build offers. They stay findable instead of collapsing
// into "#" alongside the digits.
const CYRILLIC_FOLDS: Record<string, string> = {
  "І": "И", "Ї": "И", "Є": "Е", "Ґ": "Г", "Ў": "У", "Ђ": "Д", "Ј": "Й", "Љ": "Л", "Њ": "Н", "Ћ": "Ч", "Џ": "Ц"
};

const LATIN_SET = new Set(LATIN_LETTERS);
const CYRILLIC_SET = new Set(CYRILLIC_LETTERS);

const stripMarks = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "");

// Uppercase, folded to a letter this build has a bucket for. Accents are removed
// (Ángela files under A) — but only outside Cyrillic, because there Ё and Й are
// letters in their own right and NFD would quietly turn them into Е and И.
function foldChar(char: string): string {
  const upper = char.toUpperCase();
  const folded = LATIN_FOLDS[upper] ?? CYRILLIC_FOLDS[upper] ?? upper;
  return CYRILLIC_SET.has(folded) ? folded : stripMarks(folded);
}

function normalize(value: string): string {
  let out = "";
  for (const char of value) out += foldChar(char);
  return out.replace(/\s+/g, " ").trim();
}

// The first character that means anything for filing: a letter or a digit.
// Leading quotes, brackets and dashes are stepped over, so «Война и мир» files
// under В rather than "#".
function firstMeaningful(normalized: string): string {
  for (const char of normalized) {
    if (/[\p{L}\p{N}]/u.test(char)) return char;
  }
  return "";
}

export function scriptOf(letter: string): AlphaScript {
  if (LATIN_SET.has(letter)) return "latin";
  if (CYRILLIC_SET.has(letter)) return "cyrillic";
  return "other";
}

export interface AlphaFields {
  alphaKey: string;
  alphaScript: AlphaScript;
  sortKey: string;
}

// The index fields for one title or name. `value` is the already-curated sort
// form where there is one (item_metadata.sort_title, people.sort_name), because
// that is what the list is ordered by.
export function alphaFieldsFor(value: string | null | undefined): AlphaFields {
  const normalized = normalize(String(value ?? ""));
  const first = firstMeaningful(normalized);
  const script = scriptOf(first);
  return {
    alphaKey: script === "other" ? OTHER_BUCKET : first,
    alphaScript: script,
    // Ё sorts as Е (Ёлка belongs between Егор and Жук, not above Абрамов, which
    // is where its U+0401 code point would put it). Punctuation ahead of the
    // first meaningful character is dropped for the same reason.
    sortKey: normalized.slice(normalized.indexOf(first)).replace(/Ё/g, "Е")
  };
}
