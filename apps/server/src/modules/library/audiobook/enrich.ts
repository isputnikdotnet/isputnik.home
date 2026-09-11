// Optional online enrichment, gated by the "online_metadata" scan source.
// Fills metadata the local sources couldn't provide — narrator, description,
// cover art (LibriVox / Open Library) — and author photos & bios (Wikipedia /
// Open Library). Lookups only ever fill gaps; they never overwrite local or
// manual data.
//
// This file is the book lookup and the enrichment pass. The person sources are
// person-lookup.ts over providers/{wikipedia,wikidata,open-library-people,
// fantlab-people}.ts; the shared queue and matching are lookup-shared.ts.
import { db } from "../../../db.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { fetchLibrivoxById, resolveArchiveCoverUrl, searchLibrivox, searchLibrivoxByAuthor } from "./providers/librivox.js";
import { searchOpenLibrary } from "./providers/open-library.js";
import type { MetadataCandidate } from "./providers/types.js";
import { enqueueLookup, normalizeText, pickCandidate, simplifyTitle } from "./lookup-shared.js";
import { PERSON_FACT_COLUMNS, type PersonLookupResult } from "./person-facts.js";
import { lookupPersonInfo } from "./person-lookup.js";
import { writePersonPhoto } from "./person-photo.js";
import type { LibraryRow, PersonRow } from "../../../db/rows.js";

// Failed person lookups are retried, but not on every scan.
const PERSON_RETRY_DAYS = 30;
const MAX_AUTHORS_PER_RUN = 100;

// ── Book lookup ──────────────────────────────────────────────────────────────

export interface OnlineBookLookupInput {
  title: string;
  authors: string[];
  needCover: boolean;
}

async function lookupLibrivox(input: OnlineBookLookupInput): Promise<MetadataCandidate | null> {
  // searchLibrivox already retries with noise-stripped/article-stripped titles.
  const candidates = await searchLibrivox({ query: input.title, limit: 10 }).catch(() => []);
  const titleMatch = pickCandidate(candidates, input.title, input.authors);
  if (titleMatch) {
    return titleMatch;
  }

  // Exact-title search missed — list the author's catalogue (two pages max)
  // and score titles locally. Slim records; refetch the winner in full.
  const surname = input.authors
    .map((name) => normalizeText(name).split(" ").filter((token) => token.length >= 3).pop())
    .find(Boolean);
  if (!surname) {
    return null;
  }
  for (const offset of [0, 50]) {
    const page = await searchLibrivoxByAuthor(surname, offset).catch(() => []);
    const match = pickCandidate(page, input.title, input.authors);
    if (match?.librivoxId) {
      return await fetchLibrivoxById(match.librivoxId).catch(() => null) ?? match;
    }
    if (match || page.length < 50) {
      return match;
    }
  }
  return null;
}

export async function lookupOnlineBookMetadata(input: OnlineBookLookupInput): Promise<MetadataCandidate | null> {
  return enqueueLookup(async () => {
    // LibriVox first: it is the only source that knows the narrator, and these
    // libraries are mostly LibriVox rips.
    const librivoxMatch = await lookupLibrivox(input);
    if (librivoxMatch) {
      if (input.needCover && librivoxMatch.archiveId) {
        librivoxMatch.coverUrl = await resolveArchiveCoverUrl(librivoxMatch.archiveId) ?? librivoxMatch.coverUrl;
      }
      return librivoxMatch;
    }

    const candidates = await searchOpenLibrary({
      query: simplifyTitle(input.title),
      author: input.authors[0],
      limit: 8
    }).catch(() => []);
    return pickCandidate(candidates, input.title, input.authors);
  });
}

// ── Author enrichment pass ───────────────────────────────────────────────────

type AuthorToEnrich = Pick<PersonRow, "id" | "name" | "bio"> & { cover_storage_key: PersonRow["image_storage_key"] };

function bioWithAttribution(result: PersonLookupResult) {
  if (!result.bio) {
    return null;
  }
  const source = result.source === "wikipedia" ? "Wikipedia" : "Open Library";
  return `${result.bio}\n\nSource: ${source}${result.sourceUrl ? ` — ${result.sourceUrl}` : ""}`;
}

// Fills bio/photo/life facts for one person. People are identified by name
// across libraries (same model as the people routes), so updates apply by name
// and only to rows where the field is still empty.
export async function enrichPerson(name: string, languages: string[]): Promise<{ updatedBio: boolean; updatedPhoto: boolean; updatedFacts: boolean; result: PersonLookupResult | null }> {
  const rows = db.prepare(
    "SELECT id, name, bio, image_storage_key AS cover_storage_key FROM people WHERE name = ?"
  ).all(name) as AuthorToEnrich[];
  if (rows.length === 0) {
    return { updatedBio: false, updatedPhoto: false, updatedFacts: false, result: null };
  }

  const needsBio = rows.some((row) => !row.bio);
  const needsPhoto = rows.some((row) => !row.cover_storage_key);
  const result = await lookupPersonInfo(name, languages);
  db.prepare("UPDATE people SET enriched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?").run(name);
  if (!result) {
    return { updatedBio: false, updatedPhoto: false, updatedFacts: false, result: null };
  }

  let updatedBio = false;
  const bio = bioWithAttribution(result);
  if (needsBio && bio) {
    db.prepare("UPDATE people SET bio = ? WHERE name = ? AND (bio IS NULL OR bio = '')").run(bio, name);
    updatedBio = true;
  }

  let updatedPhoto = false;
  if (needsPhoto && result.photoUrl) {
    try {
      const storageKey = await writePersonPhoto(rows[0].id, result.photoUrl);
      db.prepare("UPDATE people SET image_storage_key = ? WHERE name = ? AND image_storage_key IS NULL").run(storageKey, name);
      updatedPhoto = true;
    } catch {
      // no photo is fine — the bio may still have landed
    }
  }

  // Life facts land one column at a time, and only into a column that is still
  // empty: a hand-typed birth year survives every later rescan, and a lookup
  // that only knows the dates doesn't blank out a country someone filled in.
  let updatedFacts = false;
  for (const [key, column] of PERSON_FACT_COLUMNS) {
    const value = result.facts[key];
    if (!value) continue;
    const changed = db.prepare(
      `UPDATE people SET ${column} = ? WHERE name = ? AND (${column} IS NULL OR ${column} = '')`
    ).run(value, name).changes;
    if (changed > 0) updatedFacts = true;
  }

  return { updatedBio, updatedPhoto, updatedFacts, result };
}

export interface EnrichAuthorsOptions {
  // Restrict to the people credited on one book (single-book rescan).
  bookId?: string;
  limit?: number;
  shouldCancel?: () => boolean;
  onProgress?: (processed: number, total: number) => void;
}

export async function enrichLibraryAuthors(libraryId: string, options: EnrichAuthorsOptions = {}) {
  const library = db.prepare("SELECT settings_json FROM libraries WHERE id = ?").get(libraryId) as Pick<LibraryRow, "settings_json"> | undefined;
  const defaultLanguage = library ? normalizeLibrarySettings("audiobook", library.settings_json).default_language ?? "en" : "en";

  const rows = db.prepare(`
    SELECT people.name
    FROM people
    JOIN item_people ON item_people.person_id = people.id
    JOIN library_items ON library_items.id = item_people.item_id
    WHERE library_items.library_id = ?
      ${options.bookId ? "AND item_people.item_id = ?" : ""}
      AND (people.bio IS NULL OR people.image_storage_key IS NULL OR people.birth_date IS NULL)
      AND (people.enriched_at IS NULL OR people.enriched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
    GROUP BY people.id
    ORDER BY people.enriched_at IS NOT NULL, people.name
    LIMIT ?
  `).all(
    ...(options.bookId ? [libraryId, options.bookId] : [libraryId]),
    `-${PERSON_RETRY_DAYS} days`,
    options.limit ?? MAX_AUTHORS_PER_RUN
  ) as Pick<PersonRow, "name">[];

  const names = Array.from(new Set(rows.map((row) => row.name)));
  let updated = 0;
  let processed = 0;

  for (const name of names) {
    if (options.shouldCancel?.()) {
      break;
    }
    try {
      const result = await enrichPerson(name, [defaultLanguage]);
      if (result.updatedBio || result.updatedPhoto || result.updatedFacts) {
        updated += 1;
      }
    } catch {
      // one bad lookup must not stop the pass
    }
    processed += 1;
    if (processed % 5 === 0 || processed === names.length) {
      options.onProgress?.(processed, names.length);
    }
  }

  return { attempted: names.length, updated };
}
