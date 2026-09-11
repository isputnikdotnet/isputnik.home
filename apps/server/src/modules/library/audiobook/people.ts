// People (authors and narrators) as the book libraries list them: every item a
// person is credited on, and the Authors / Narrators lists. The API over them is
// people-routes.ts.
import { db } from "../../../db.js";
import { accessibleLibraryIds } from "../shared/library-access.js";
import { alphaFieldsFor } from "../shared/alphabet.js";

export type PersonItem = {
  id: string;
  type: string;
  role: string;
  title: string;
  authors: string[];
  // Audiobook credits only; empty for ebooks. Read the same way `authors` is:
  // the item's OTHER credited people, for a row's "who else worked on this"
  // line (skip it when this person IS the narrator being shown).
  narrators: string[];
  durationSeconds: number | null;
  yearPublished: number | null;
  coverUrl: string | null;
};

// Every item a person is credited on, across ALL media types and every library
// the caller can access — the data behind the unified person page. People are
// global (one row per name, see schema.sql), so a single name can span
// audiobooks and ebooks; `role` says how they're credited on each item. The
// library_id filter is the entire permission story: an item in a library the
// user can't see simply never joins.
export function listPersonItems(name: string, userId: string, userRole: string): PersonItem[] {
  const libraryIds = [...accessibleLibraryIds(userId, userRole)];
  if (libraryIds.length === 0) return [];

  const placeholders = libraryIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      li.id                AS id,
      li.type              AS type,
      li.folder_path       AS folder_path,
      im.title             AS title,
      im.cover_storage_key AS cover_storage_key,
      im.year_published    AS year_published,
      ad.duration_seconds  AS duration_seconds,
      ip.role              AS role,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      GROUP_CONCAT(DISTINCT narrators.name) AS narrator_names
    FROM item_people ip
    JOIN people p              ON p.id = ip.person_id
    JOIN library_items li      ON li.id = ip.item_id
    LEFT JOIN item_metadata im ON im.item_id = li.id
    LEFT JOIN audiobook_details ad ON ad.item_id = li.id
    LEFT JOIN item_people author_credits ON author_credits.item_id = li.id AND author_credits.role = 'author'
    LEFT JOIN people authors   ON authors.id = author_credits.person_id
    LEFT JOIN item_people narrator_credits ON narrator_credits.item_id = li.id AND narrator_credits.role = 'narrator'
    LEFT JOIN people narrators ON narrators.id = narrator_credits.person_id
    WHERE p.name = ? COLLATE NOCASE
      AND li.deleted_at IS NULL
      AND li.library_id IN (${placeholders})
    GROUP BY li.id, ip.role
    ORDER BY
      CASE ip.role WHEN 'author' THEN 0 WHEN 'narrator' THEN 1 ELSE 2 END,
      ip.role,
      COALESCE(im.sort_title, im.title, li.folder_path) COLLATE NOCASE
  `).all(name, ...libraryIds) as {
    id: string; type: string; folder_path: string; title: string | null;
    cover_storage_key: string | null; role: string; author_names: string | null;
    narrator_names: string | null; year_published: number | null; duration_seconds: number | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    role: row.role,
    title: row.title ?? row.folder_path.split("/").pop() ?? row.folder_path,
    authors: row.author_names ? row.author_names.split(",").map((n) => n.trim()).filter(Boolean) : [],
    narrators: row.narrator_names ? row.narrator_names.split(",").map((n) => n.trim()).filter(Boolean) : [],
    durationSeconds: row.duration_seconds,
    yearPublished: row.year_published,
    coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null
  }));
}

export type AuthorSummary = {
  name: string;
  // The curated "file under" form, when someone has set one on the person's
  // profile. Usually "Surname, First" — the surname index below reads off it
  // rather than guessing from `name`.
  sortName: string | null;
  audiobookCount: number;
  ebookCount: number;
  libraryIds: string[];
  // The A–Z buckets and ordering keys for both ways the list can be indexed, so
  // the browse page never has to detect a script or fold a letter itself. See
  // shared/alphabet.ts — that logic exists once, here.
  alphaKey: string;
  alphaKeyLast: string;
  sortKey: string;
  sortKeyLast: string;
};

export type AuthorLibrary = { id: string; name: string; type: string };

export type PersonRole = "author" | "narrator";

// Generational and honorific suffixes: the last token of a name without ever
// being the surname, so a last-name index has to look past them.
const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "i", "ii", "iii", "iv", "v", "phd", "ph.d.", "md", "esq"]);

// The surname to file a person under. A curated sort name wins when it has one
// ("Tolkien, J. R. R." → Tolkien), since a person set it deliberately. Otherwise
// take the last word of the name, stepping back over any suffix.
function surnameOf(name: string, sortName: string | null): string {
  const curated = sortName?.trim();
  if (curated && curated.includes(",")) return curated.split(",")[0].trim();

  const words = name.trim().split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (!NAME_SUFFIXES.has(words[i].toLowerCase())) return words[i];
  }
  return name.trim();
}

// Every person in one credit role, across all accessible libraries, with how many
// audiobooks vs ebooks they have and which libraries they appear in — drives the
// unified Authors list (and the Narrators one) with its media-type, library and
// A–Z filters. Same global-people + access-filter shape as listPersonItems.
export function listPeopleByRole(userId: string, userRole: string, role: PersonRole): AuthorSummary[] {
  const libraryIds = [...accessibleLibraryIds(userId, userRole)];
  if (libraryIds.length === 0) return [];

  const placeholders = libraryIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      p.name AS name,
      p.sort_name AS sort_name,
      SUM(CASE WHEN li.type = 'audiobook' THEN 1 ELSE 0 END) AS audiobook_count,
      SUM(CASE WHEN li.type = 'ebook' THEN 1 ELSE 0 END) AS ebook_count,
      GROUP_CONCAT(DISTINCT li.library_id) AS library_ids
    FROM people p
    JOIN item_people ip   ON ip.person_id = p.id AND ip.role = ?
    JOIN library_items li ON li.id = ip.item_id
    WHERE li.deleted_at IS NULL
      AND li.library_id IN (${placeholders})
    GROUP BY p.id
    ORDER BY p.sort_name COLLATE NOCASE, p.name COLLATE NOCASE
  `).all(role, ...libraryIds) as {
    name: string;
    sort_name: string | null;
    audiobook_count: number;
    ebook_count: number;
    library_ids: string | null;
  }[];

  return rows.map((row) => {
    const byFirst = alphaFieldsFor(row.name);
    const byLast = alphaFieldsFor(surnameOf(row.name, row.sort_name));
    return {
      name: row.name,
      sortName: row.sort_name,
      audiobookCount: row.audiobook_count,
      ebookCount: row.ebook_count,
      // GROUP_CONCAT has no separator argument in the DISTINCT form, so it is
      // always a plain comma — library ids are nanoids and never contain one.
      libraryIds: row.library_ids ? row.library_ids.split(",").filter(Boolean) : [],
      alphaKey: byFirst.alphaKey,
      alphaKeyLast: byLast.alphaKey,
      sortKey: byFirst.sortKey,
      sortKeyLast: byLast.sortKey
    };
  });
}

export function listAuthors(userId: string, userRole: string): AuthorSummary[] {
  return listPeopleByRole(userId, userRole, "author");
}

// The libraries a role's list can be filtered by: accessible, and actually
// holding something with such a credit on it. Anything else would be a picker
// entry that can only ever return nothing.
export function listPeopleLibraries(userId: string, userRole: string, role: PersonRole): AuthorLibrary[] {
  const libraryIds = [...accessibleLibraryIds(userId, userRole)];
  if (libraryIds.length === 0) return [];

  const placeholders = libraryIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT DISTINCT l.id AS id, l.name AS name, l.type AS type
    FROM libraries l
    JOIN library_items li ON li.library_id = l.id AND li.deleted_at IS NULL
    JOIN item_people ip   ON ip.item_id = li.id AND ip.role = ?
    WHERE l.id IN (${placeholders})
    ORDER BY l.name COLLATE NOCASE
  `).all(role, ...libraryIds) as AuthorLibrary[];
}

export function listAuthorLibraries(userId: string, userRole: string): AuthorLibrary[] {
  return listPeopleLibraries(userId, userRole, "author");
}
