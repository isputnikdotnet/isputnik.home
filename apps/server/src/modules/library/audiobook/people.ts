import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db, logActivity } from "../../../db.js";
import { parseBody } from "../../../core/shared.js";
import { thumbnailAbsolutePath, thumbnailStorageKey } from "../shared/thumbnail.js";
import { normalizeLibrarySettings } from "../shared/library-settings.js";
import { accessibleLibraryIds, canUserWriteLibrary, getAccessibleLibrary } from "../shared/library-access.js";
import { BOOK_LIBRARY_TYPES } from "../shared/library-types.js";
import { alphaFieldsFor } from "../shared/alphabet.js";
import { enrichPerson, lookupPersonByUrl, lookupPersonCandidates, lookupPersonPhotoCandidates, removeStoredPhotos, writePersonPhoto, type PersonLookupSource } from "./enrich.js";
import { MetadataLinkError } from "./providers/types.js";
import { sortTitle } from "./scanner.js";
import { partialDateSchema } from "../../familytree/persons.js";

type AuthorRow = {
  id: string;
  name: string;
  sort_name: string | null;
  bio: string | null;
  website: string | null;
  location: string | null;
  birth_date: string | null;
  death_date: string | null;
  country: string | null;
  occupation: string | null;
  wikipedia_url: string | null;
  cover_storage_key: string | null;
};

// Every column a profile is made of, in one place: the read, the save and the
// enrichment reply all hand back the same shape, and adding a field to a person
// should not mean remembering three column lists.
const PROFILE_COLUMNS = `
  SELECT id, name, sort_name, bio, website, location,
         birth_date, death_date, country, occupation, wikipedia_url,
         image_storage_key AS cover_storage_key
  FROM people WHERE name = ? LIMIT 1
`;

function personProfile(row: AuthorRow) {
  return {
    name: row.name,
    sortName: row.sort_name,
    bio: row.bio,
    website: row.website,
    location: row.location,
    // Partial dates — 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'. The web side formats
    // them; nothing here assumes a full date exists.
    birthDate: row.birth_date,
    deathDate: row.death_date,
    country: row.country,
    occupation: row.occupation,
    // The page these facts were read from, for the source link beside them.
    wikipediaUrl: row.wikipedia_url,
    photoUrl: photoUrl(row.cover_storage_key)
  };
}

// People (authors/narrators) are global — one row shared across every book
// library that credits them — so editing a profile isn't library-scoped. Gate the
// profile-write routes on the user being able to write SOME book library, the way
// gallery person management gates on canWriteAnyGallery. Anyone who curates books
// may curate the people in them; a viewer-only member must not be able to rename,
// re-bio, or re-photo an author whose books sit in a library they can't touch.
function canWriteAnyBookLibrary(user: { id: string; role: string }): boolean {
  if (user.role === "admin") return true;
  const placeholders = BOOK_LIBRARY_TYPES.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM libraries WHERE type IN (${placeholders})`)
    .all(...BOOK_LIBRARY_TYPES) as Parameters<typeof canUserWriteLibrary>[0][];
  return rows.some((row) => canUserWriteLibrary(row, user.id, user.role));
}

function photoUrl(storageKey: string | null) {
  return storageKey ? `/api/library/covers/${storageKey}` : null;
}

const personProfileSchema = z.object({
  name: z.string().trim().min(1).max(240).optional(),
  bio: z.string().trim().max(10000).nullable().optional(),
  sortName: z.string().trim().max(240).nullable().optional(),
  // Free text, not a validated URL: displayed as a link (the web side adds a
  // protocol if one is missing) rather than fetched, so "agriddle.com" is a
  // legitimate value someone should be able to type as-is.
  website: z.string().trim().max(300).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  // Same partial-date rule the family tree uses — an author's dates are as
  // often a bare year as a full one, and a native date input can't say "1899".
  birthDate: partialDateSchema.nullable().optional(),
  deathDate: partialDateSchema.nullable().optional(),
  // Free text, both of them: "Russian Empire" is a real answer, and so is
  // "Novelist, journalist".
  country: z.string().trim().max(120).nullable().optional(),
  occupation: z.string().trim().max(200).nullable().optional(),
  // Where the facts came from, handed back by the Find info dialog when their
  // result is applied. Rendered as a link, so the host is pinned to the one
  // source that can produce these facts rather than trusted as free text.
  wikipediaUrl: z.string().trim().max(500).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && (url.hostname === "wikipedia.org" || url.hostname.endsWith(".wikipedia.org"));
    } catch {
      return false;
    }
  }, "Must be an https Wikipedia link").nullable().optional()
});

const createPersonSchema = z.object({
  name: z.string().trim().min(1).max(240),
  // Optional: people are global rows, so a library here is only the permission
  // to create one. The Narrators page names the library it was opened from;
  // the cross-type Authors browse has no single library to name, and falls back
  // to "may this user write ANY book library" — the same gate the profile-edit
  // routes use.
  libraryId: z.string().trim().min(1).optional(),
  bio: z.string().trim().max(10000).nullable().optional(),
  sortName: z.string().trim().max(240).nullable().optional()
});

// Wikipedia language hints for a person: the default languages of the
// libraries they appear in (e.g. ru Wikipedia for a Russian library), then
// English.
function personLookupLanguages(name: string) {
  const rows = db.prepare(`
    SELECT DISTINCT libraries.settings_json AS settings_json
    FROM libraries
    JOIN library_items ON library_items.library_id = libraries.id
    JOIN item_people ON item_people.item_id = library_items.id
    JOIN people ON people.id = item_people.person_id
    WHERE people.name = ?
  `).all(name) as { settings_json: string }[];
  return rows
    .map((row) => normalizeLibrarySettings("audiobook", row.settings_json).default_language)
    .filter((lang): lang is string => Boolean(lang));
}

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

export async function audiobookPeoplePlugin(app: FastifyInstance) {
  // The photo upload below takes raw image bytes, so this plugin needs its own
  // image parser. Fastify scopes addContentTypeParser to the encapsulation
  // context it runs in, and this plugin is a SIBLING of audiobookBooksPlugin
  // (see audiobook/index.ts) rather than a child — so the identical parser
  // registered there does not reach here. Without this the PUT is rejected
  // with 415 before the handler is ever called.
  app.addContentTypeParser(["image/jpeg", "image/png", "image/webp"], { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/api/library/people/by-name", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }

    const row = db.prepare(PROFILE_COLUMNS).get(name) as AuthorRow | undefined;

    return reply.send({ person: row ? personProfile(row) : null });
  });

  // Photos for all people that have one, keyed by name — lets the authors/
  // narrators list pages show avatars without a request per person.
  app.get("/api/library/people/photos", { preHandler: app.authenticate }, async (_request, reply) => {
    const rows = db.prepare(`
      SELECT name, image_storage_key AS cover_storage_key
      FROM people
      WHERE image_storage_key IS NOT NULL
      ORDER BY rowid ASC
    `).all() as { name: string; cover_storage_key: string }[];

    // First row per name wins, matching the by-name endpoints.
    const photos: Record<string, string> = {};
    for (const row of rows) {
      photos[row.name] ??= `/api/library/covers/${row.cover_storage_key}`;
    }
    return reply.send({ photos });
  });

  // The unified person page's data: everything this person made, across types
  // and every accessible library. See listPersonItems above.
  app.get("/api/library/people/by-name/items", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }
    return reply.send({ items: listPersonItems(name, request.user!.id, request.user!.role) });
  });

  // Flat list of every person name (global) — feeds the merge picker on the
  // person page, which no longer derives candidates from a bulk book load.
  app.get("/api/library/people/names", { preHandler: app.authenticate }, async (_request, reply) => {
    const rows = db.prepare("SELECT name FROM people ORDER BY name COLLATE NOCASE").all() as { name: string }[];
    return reply.send({ names: rows.map((row) => row.name) });
  });

  // The unified Authors browse: every author across types, with per-type counts,
  // and the libraries its filter can offer. Both come from one request because
  // the page can't render its toolbar until it has the pair.
  app.get("/api/library/people/authors", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    return reply.send({
      authors: listAuthors(user.id, user.role),
      libraries: listAuthorLibraries(user.id, user.role),
      canCreate: canWriteAnyBookLibrary(user)
    });
  });

  // The Narrators browse, same payload shape as /authors. It exists so that page
  // can stop deriving its list by downloading every book of every library.
  app.get("/api/library/people/narrators", { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    return reply.send({
      narrators: listPeopleByRole(user.id, user.role, "narrator"),
      libraries: listPeopleLibraries(user.id, user.role, "narrator")
    });
  });

  app.patch("/api/library/people/by-name", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyBookLibrary(request.user!)) {
      return reply.code(403).send({ error: "Write access to a book library is required to edit people." });
    }
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }

    const parsed = parseBody(personProfileSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid profile data", details: parsed.error });
    }

    db.prepare(`
      UPDATE people
      SET name = COALESCE(?, name), bio = ?, sort_name = ?, website = ?, location = ?,
          birth_date = ?, death_date = ?, country = ?, occupation = ?, wikipedia_url = ?
      WHERE name = ?
    `).run(
      parsed.data.name ?? null,
      parsed.data.bio ?? null,
      parsed.data.sortName ?? null,
      parsed.data.website ?? null,
      parsed.data.location ?? null,
      parsed.data.birthDate ?? null,
      parsed.data.deathDate ?? null,
      parsed.data.country ?? null,
      parsed.data.occupation ?? null,
      parsed.data.wikipediaUrl ?? null,
      name
    );

    return reply.send({ updated: true });
  });

  // Look the person up online (Wikipedia, then Open Library) and fill their
  // biography and photo — empty fields only; existing data is never replaced.
  app.post("/api/library/people/by-name/enrich", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyBookLibrary(request.user!)) {
      return reply.code(403).send({ error: "Write access to a book library is required to edit people." });
    }
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }

    const exists = db.prepare("SELECT 1 FROM people WHERE name = ? LIMIT 1").get(name);
    if (!exists) {
      return reply.code(404).send({ error: "Person not found" });
    }

    try {
      const { updatedBio, updatedPhoto, updatedFacts, result } = await enrichPerson(name, personLookupLanguages(name));
      const row = db.prepare(PROFILE_COLUMNS).get(name) as AuthorRow | undefined;

      return reply.send({
        found: Boolean(result),
        updatedBio,
        updatedPhoto,
        updatedFacts,
        source: result?.source ?? null,
        person: row ? personProfile(row) : null
      });
    } catch {
      return reply.code(502).send({ error: "Online lookup failed. Check the server's internet access and try again." });
    }
  });

  // Preview a person's online profiles (Wikipedia / Open Library) without writing
  // anything: by name, or from a specific pasted author link (?url=). Both answer
  // with a LIST — the by-name search because several pages can share a name, the
  // pasted link with its single result — so the modal always renders one shape:
  // pick a result, compare it field by field, apply what you want on Save.
  app.get("/api/library/people/by-name/lookup", { preHandler: app.authenticate }, async (request, reply) => {
    const q = request.query as { name?: string; url?: string; q?: string; source?: string };
    const name = String(q.name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }

    // `name` identifies the person (and picks the Wikipedia languages their
    // libraries speak); `q` is what to actually search for, which the dialog
    // lets someone edit — a stored "Twain, Mark" finds nothing typed verbatim.
    const search = String(q.q ?? "").trim() || name;
    const named = ["wikipedia", "openlibrary", "fantlab"] as const;
    const source: PersonLookupSource = named.find((candidate) => candidate === q.source) ?? "all";

    const url = q.url?.trim();
    try {
      const candidates = url
        ? [await lookupPersonByUrl(url)].filter((candidate) => candidate !== null)
        : await lookupPersonCandidates(search, personLookupLanguages(name), source);
      return reply.send({ candidates });
    } catch (err) {
      const status = err instanceof MetadataLinkError ? err.status : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : "Online lookup failed" });
    }
  });

  // Create a person manually (profile-only): a people row with name + optional
  // sort name and bio. The row is GLOBAL, not library-scoped — libraryId, when
  // given, only says which library's write access is being claimed. It becomes a
  // book-edit suggestion immediately and shows on the browse page once a book
  // credits them. Role isn't stored (it lives on item_people), so "author" and
  // "narrator" create the same kind of row.
  app.post("/api/library/people", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = parseBody(createPersonSchema, request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid person data", details: parsed.error });
    }
    const { name, libraryId, bio, sortName } = parsed.data;

    if (libraryId) {
      const lib = getAccessibleLibrary(libraryId, request.user!.id, request.user!.role);
      if (!lib || !BOOK_LIBRARY_TYPES.includes(lib.type as (typeof BOOK_LIBRARY_TYPES)[number])
        || !canUserWriteLibrary(lib, request.user!.id, request.user!.role)) {
        return reply.code(403).send({ error: "Write access to the library is required to add people." });
      }
    } else if (!canWriteAnyBookLibrary(request.user!)) {
      return reply.code(403).send({ error: "Write access to a book library is required to add people." });
    }

    const existing = db.prepare("SELECT id FROM people WHERE name = ?").get(name);
    if (existing) {
      return reply.code(409).send({ error: "A person with that name already exists." });
    }

    const resolvedSortName = sortName?.trim() || sortTitle(name);
    db.prepare("INSERT INTO people (id, name, sort_name, bio) VALUES (?, ?, ?, ?)")
      .run(nanoid(16), name, resolvedSortName, bio?.trim() || null);

    logActivity({
      event: "library.person.created",
      actorUserId: request.user!.id,
      targetType: "person",
      targetId: name,
      detail: `Created person "${name}".`,
      ipAddress: request.ip
    });

    const row = db.prepare(PROFILE_COLUMNS).get(name) as AuthorRow | undefined;
    return reply.send({ person: row ? personProfile(row) : null });
  });

  // Photo candidates the user can pick from (Wikipedia per language, Open
  // Library author records). Lookup only — nothing is applied here.
  app.get("/api/library/people/by-name/photo-candidates", { preHandler: app.authenticate }, async (request, reply) => {
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }

    const exists = db.prepare("SELECT 1 FROM people WHERE name = ? LIMIT 1").get(name);
    if (!exists) {
      return reply.code(404).send({ error: "Person not found" });
    }

    try {
      const candidates = await lookupPersonPhotoCandidates(name, personLookupLanguages(name));
      return reply.send({ candidates });
    } catch {
      return reply.code(502).send({ error: "Online lookup failed. Check the server's internet access and try again." });
    }
  });

  // Apply a picked candidate: download (SSRF-guarded), normalise to webp, and
  // set it as the person's photo — an explicit choice, so it replaces any
  // existing photo.
  app.post("/api/library/people/by-name/photo-from-url", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyBookLibrary(request.user!)) {
      return reply.code(403).send({ error: "Write access to a book library is required to edit people." });
    }
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }

    const parsed = parseBody(z.object({ url: z.string().trim().pipe(z.url().max(2000)) }), request.body);
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid photo URL", details: parsed.error });
    }

    const rows = db.prepare(
      "SELECT id, image_storage_key AS cover_storage_key FROM people WHERE name = ?"
    ).all(name) as { id: string; cover_storage_key: string | null }[];
    if (rows.length === 0) {
      return reply.code(404).send({ error: "Person not found" });
    }

    try {
      const storageKey = await writePersonPhoto(rows[0].id, parsed.data.url);
      db.prepare("UPDATE people SET image_storage_key = ? WHERE name = ?").run(storageKey, name);
      removeStoredPhotos(rows.map((row) => row.cover_storage_key).filter((key) => key !== storageKey));
      return reply.send({ updated: true, photoUrl: `/api/library/covers/${storageKey}` });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "Unable to download the photo." });
    }
  });

  // Merge one person into another: record a variant -> canonical alias (so it
  // survives rescans), then repoint this person's book links to the target and
  // delete the now-orphaned author rows. Covers authors and narrators alike,
  // since both live in the authors table (role is on the book_authors link).
  // destructive: merge permanently deletes the merged-from person row and its
  // credit links — refused from untrusted networks under the deletions-only
  // policy, consistent with tags/prune and the single-DELETE person routes.
  app.post("/api/library/people/merge", { preHandler: app.requireAdmin, config: { destructive: true } }, async (request, reply) => {
    const parsed = parseBody(
      z.object({ from: z.string().trim().min(1).max(240), into: z.string().trim().min(1).max(240) }),
      request.body
    );
    if (parsed.error) {
      return reply.code(400).send({ error: "Invalid merge data", details: parsed.error });
    }
    const { from, into } = parsed.data;
    if (from.toLowerCase() === into.toLowerCase()) {
      return reply.code(400).send({ error: "Choose a different person to merge into." });
    }

    const sourceExists = db.prepare("SELECT 1 FROM people WHERE name = ? LIMIT 1").get(from);
    if (!sourceExists) {
      return reply.code(404).send({ error: "Person not found" });
    }

    db.transaction(() => {
      // Record the alias, and re-point any existing aliases that pointed at `from`.
      db.prepare(`
        INSERT INTO person_aliases (id, alias, canonical_name, created_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET canonical_name = excluded.canonical_name
      `).run(nanoid(16), from, into, request.user!.id);
      db.prepare("UPDATE person_aliases SET canonical_name = ? WHERE canonical_name = ?").run(into, from);

      // People are global: fold the single `from` person into the `into` person.
      const fromRow = db.prepare(`
        SELECT id, sort_name, bio, website, location, birth_date, death_date, country,
               occupation, wikipedia_url, image_storage_key
        FROM people WHERE name = ?
      `).get(from) as {
        id: string; sort_name: string | null; bio: string | null;
        website: string | null; location: string | null;
        birth_date: string | null; death_date: string | null;
        country: string | null; occupation: string | null;
        wikipedia_url: string | null; image_storage_key: string | null;
      } | undefined;
      if (!fromRow) return;

      let intoRow = db.prepare("SELECT id FROM people WHERE name = ?").get(into) as { id: string } | undefined;
      if (!intoRow) {
        const id = nanoid(16);
        db.prepare(`
          INSERT INTO people (id, name, sort_name, bio, website, location, birth_date, death_date,
                              country, occupation, wikipedia_url, image_storage_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, into, fromRow.sort_name, fromRow.bio, fromRow.website, fromRow.location,
          fromRow.birth_date, fromRow.death_date, fromRow.country, fromRow.occupation,
          fromRow.wikipedia_url, fromRow.image_storage_key
        );
        intoRow = { id };
      }
      if (intoRow.id !== fromRow.id) {
        // Repoint item credits, de-duplicating on (item_id, person_id, role).
        db.prepare(`
          INSERT OR IGNORE INTO item_people (item_id, person_id, role, sort_order)
          SELECT item_id, ?, role, sort_order FROM item_people WHERE person_id = ?
        `).run(intoRow.id, fromRow.id);
        db.prepare("DELETE FROM item_people WHERE person_id = ?").run(fromRow.id);
        db.prepare("DELETE FROM people WHERE id = ?").run(fromRow.id);
      }
    })();

    logActivity({
      event: "library.person.merged",
      actorUserId: request.user!.id,
      targetType: "person",
      targetId: into,
      detail: `Merged "${from}" into "${into}".`,
      ipAddress: request.ip
    });
    return reply.send({ merged: true, into });
  });

  app.put("/api/library/people/by-name/photo", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyBookLibrary(request.user!)) {
      return reply.code(403).send({ error: "Write access to a book library is required to edit people." });
    }
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }

    const contentType = request.headers["content-type"]?.split(";")[0]?.toLowerCase();
    if (!contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      return reply.code(415).send({ error: "Upload a JPEG, PNG, or WebP image." });
    }

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      return reply.code(400).send({ error: "Photo is required." });
    }
    if (body.byteLength > 10 * 1024 * 1024) {
      return reply.code(400).send({ error: "Photo is too large (max 10 MB)." });
    }

    const authorRows = db.prepare(
      "SELECT id, image_storage_key AS cover_storage_key FROM people WHERE name = ?"
    ).all(name) as { id: string; cover_storage_key: string | null }[];

    if (authorRows.length === 0) {
      return reply.code(404).send({ error: "Person not found" });
    }

    const ext = contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
    // Versioned file name so the replaced photo isn't masked by browser cache.
    const storageKey = thumbnailStorageKey("people", authorRows[0].id, `${authorRows[0].id}-photo-${Date.now()}${ext}`);
    const absolutePath = thumbnailAbsolutePath(storageKey);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, body as Buffer);

    db.prepare("UPDATE people SET image_storage_key = ? WHERE name = ?").run(storageKey, name);
    removeStoredPhotos(authorRows.map((row) => row.cover_storage_key).filter((key) => key !== storageKey));

    return reply.send({ updated: true, photoUrl: `/api/library/covers/${storageKey}` });
  });

  // Clear a person's photo — the edit dialog's "Remove photo". The stored file
  // goes with it: a person has exactly one photo at a time (every write path
  // above unlinks the one it replaces), so nothing else can reference it.
  app.delete("/api/library/people/by-name/photo", { preHandler: app.authenticate }, async (request, reply) => {
    if (!canWriteAnyBookLibrary(request.user!)) {
      return reply.code(403).send({ error: "Write access to a book library is required to edit people." });
    }
    const name = String((request.query as { name?: string }).name ?? "").trim();
    if (!name) {
      return reply.code(400).send({ error: "Name is required" });
    }

    const rows = db.prepare(
      "SELECT id, image_storage_key AS cover_storage_key FROM people WHERE name = ?"
    ).all(name) as { id: string; cover_storage_key: string | null }[];
    if (rows.length === 0) {
      return reply.code(404).send({ error: "Person not found" });
    }

    db.prepare("UPDATE people SET image_storage_key = NULL WHERE name = ?").run(name);
    removeStoredPhotos(rows.map((row) => row.cover_storage_key));

    return reply.send({ removed: true });
  });
}
