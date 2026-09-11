// Names read from paths: a folder's "Author - Title (Year) [Narrator]", part/disc
// folders, sort titles, and the name-list splitting the tag reader shares.

export function sortTitle(value: unknown): string {
  return String(value ?? "").replace(/^(the|a|an)\s+/i, "").trim();
}

// A folder that is one part of a book rather than a book: "CD 1", "Disc 2",
// "Part 1", "Часть 1", "Диск 2", also as a suffix — "Три товарища (Часть_1)",
// "Book - Part 2" — with spaces, underscores, dashes or brackets around the marker.
// Returns the part number so tracks can be ordered part by part.
const PART_FOLDER_RE = /(?:^|[\s_\-([])(?:cd|disc|disk|part|pt|часть|ч|диск)[\s_.\-]*(\d+)[)\]]?$/i;

export function discNumberFromFolderName(folderName: string) {
  const match = folderName.match(PART_FOLDER_RE);
  return match ? Number(match[1]) : null;
}

export interface ParsedFolderName {
  title: string;
  authors?: string[];
  narrators?: string[];
  year?: number;
}

/**
 * Decompose a book folder name following the common self-hosted convention
 * `Author - Title (Year) [Narrator]` (the trailing `(Year)`/`[Narrator]` tokens are
 * optional and may appear in either order). Author and narrator lists split on the
 * usual separators. When no ` - ` separator is present the whole name is the title.
 *
 * Folder names come off the filesystem as proper Unicode, so — unlike audio tags —
 * they never need mojibake repair.
 */
export function parseFolderName(rawName: string): ParsedFolderName {
  let name = rawName.trim();
  let narrators: string[] | undefined;
  let year: number | undefined;

  // Strip trailing [Narrator] and (Year) tokens, in any order, until neither matches.
  for (;;) {
    const bracket = name.match(/\s*\[([^\]]*)\]\s*$/);
    if (bracket) {
      const inner = splitNames([bracket[1]]);
      if (inner.length) narrators = narrators ?? inner;
      name = name.slice(0, bracket.index).trim();
      continue;
    }
    const paren = name.match(/\s*\((\d{4})\)\s*$/);
    if (paren) {
      year = year ?? Number(paren[1]);
      name = name.slice(0, paren.index).trim();
      continue;
    }
    break;
  }

  let authors: string[] | undefined;
  let title = name;
  const dash = name.match(/\s+-\s+/);
  if (dash?.index) {
    const left = name.slice(0, dash.index).trim();
    const right = name.slice(dash.index + dash[0].length).trim();
    if (right) {
      if (/\p{L}/u.test(left)) {
        // Left side has letters → an author name.
        authors = splitNames([left]);
        title = right;
      } else if (/^\d+\.?$/.test(left)) {
        // A bare leading number (e.g. "1 - Title") is an ordering prefix, not an author.
        title = right;
      }
    }
  }

  return {
    title: title || rawName.trim(),
    ...(authors?.length ? { authors } : {}),
    ...(narrators?.length ? { narrators } : {}),
    ...(year ? { year } : {})
  };
}

export function splitNames(values: Array<string | null | undefined>) {
  const names = values
    .flatMap((value) => (value ?? "").split(/\s*(?:,|;|\s+&\s+)\s*/))
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}
