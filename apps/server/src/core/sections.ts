import { z } from "zod";
import { db } from "../db.js";
import type { AppSettingRow } from "../db/rows.js";

// Which of the app's sections this household uses: the admin switches them on
// and off for everyone (Control panel → Settings → Appearance → Sections). A
// section that is off is gone from the menu, the phone sheet, the home feed and
// the book feeds, and a direct link to it lands on the home page; the Control
// panel still shows every library, so nothing is lost and a section comes back
// with one click. Every section starts on — an upgrade changes nobody's menu.
//
// Games is one of the six, on top of the gateway being configured: an install
// without a games container has no Games entry whatever this says.

export const SECTION_KEYS = ["audiobooks", "ebooks", "gallery", "familyTree", "stories", "games"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type Sections = Record<SectionKey, boolean>;

export const SECTIONS_KEY = "sections";

export const ALL_SECTIONS_ON: Sections = {
  audiobooks: true,
  ebooks: true,
  gallery: true,
  familyTree: true,
  stories: true,
  games: true
};

export const sectionsSchema = z.object({
  audiobooks: z.boolean(),
  ebooks: z.boolean(),
  gallery: z.boolean(),
  familyTree: z.boolean(),
  stories: z.boolean(),
  games: z.boolean()
});

export function getSections(): Sections {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SECTIONS_KEY) as Pick<AppSettingRow, "value"> | undefined;
  if (!row) return { ...ALL_SECTIONS_ON };
  try {
    const parsed = sectionsSchema.partial().safeParse(JSON.parse(row.value));
    return parsed.success ? { ...ALL_SECTIONS_ON, ...parsed.data } : { ...ALL_SECTIONS_ON };
  } catch {
    return { ...ALL_SECTIONS_ON };
  }
}

/** The menu never empties: at least one section stays on. */
export function anySectionOn(sections: Sections): boolean {
  return SECTION_KEYS.some((key) => sections[key]);
}

export function setSections(next: Sections, updatedBy: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(SECTIONS_KEY, JSON.stringify(next), updatedBy);
}

/** The book-library types (libraries.type) whose section is on. */
export function bookTypesOn(sections: Sections = getSections()): ("audiobook" | "ebook")[] {
  const types: ("audiobook" | "ebook")[] = [];
  if (sections.audiobooks) types.push("audiobook");
  if (sections.ebooks) types.push("ebook");
  return types;
}
