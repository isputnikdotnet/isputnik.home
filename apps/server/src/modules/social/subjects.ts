// The polymorphic subject resolver: given (entityType, entityId), what is this
// thing, and may this user see it?
//
// Every cross-content feature asks that one question — Collections, Send to,
// Notes, the family row — so it is answered in exactly one place. This started
// life as `modules/collections/hydrators.ts` and was promoted here when Send to
// needed the same answer over a wider set of types; Collections now imports it.
//
// Adding a type = one entry in SUBJECTS. No route or schema changes anywhere.
import path from "node:path";
import { db } from "../../db.js";
import { canUserAccessBook } from "../library/shared/library-access.js";
import type { BookLibraryType } from "../library/shared/library-types.js";

// Display data for one subject, independent of which entity type it is.
// `available` is false when the resource no longer exists or the user can't
// access it — callers keep the row and render it as unavailable rather than
// failing the page around it.
export interface HydratedEntity {
  available: boolean;
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  durationSeconds: number | null;
  fileCount: number;
  href: string;
  // Whether continuous playback applies to this type (time-based media).
  playable: boolean;
}

interface RequestUser {
  id: string;
  role: string;
}

// A hydrator turns a batch of entity ids of one type into display rows, applying
// the same access rules the rest of the app uses.
type Hydrator = (entityIds: string[], user: RequestUser) => Map<string, HydratedEntity>;

interface SubjectType {
  hydrate: Hydrator;
  // Whether this type may be put in a Collection. Narrower than the resolver on
  // purpose: a collection renders playback/file affordances that only make sense
  // for library media, so a family-tree person is sendable and note-able but not
  // collectable.
  collectable: boolean;
}

interface BookRow {
  id: string;
  folder_path: string;
  library_id: string;
  title: string | null;
  duration_seconds: number | null;
  cover_storage_key: string | null;
  author_names: string | null;
  file_count: number;
}

function splitNames(value: string | null) {
  return value ? value.split(",").map((name) => name.trim()).filter(Boolean) : [];
}

// Audiobooks and ebooks are both rows in `library_items`, told apart only by
// their library's type. One parameterized hydrator serves both — the differences
// are the file source (audio_files vs document_files), whether there's a
// duration, the detail href, and whether continuous playback applies. The
// `libraries.type` filter is load-bearing: it stops an id of the wrong type
// (e.g. an ebook stored with entity_type='audiobook') from resolving here and
// rendering as the wrong kind of media.
interface BookHydratorConfig {
  libraryType: BookLibraryType;
  durationSql: string;   // column expression, or "NULL" for non-timed media
  fileCountSql: string;  // scalar subquery counting the user-facing files
  hrefBase: string;      // detail-page base, e.g. "/audiobooks/books"
  playable: boolean;
}

function makeBookHydrator(config: BookHydratorConfig): Hydrator {
  return (entityIds, user) => {
    const result = new Map<string, HydratedEntity>();
    if (entityIds.length === 0) return result;

    const placeholders = entityIds.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT
        library_items.id,
        library_items.folder_path,
        library_items.library_id,
        item_metadata.title,
        ${config.durationSql} AS duration_seconds,
        item_metadata.cover_storage_key,
        GROUP_CONCAT(DISTINCT authors.name) AS author_names,
        (${config.fileCountSql}) AS file_count
      FROM library_items
      JOIN libraries ON libraries.id = library_items.library_id
      LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
      LEFT JOIN audiobook_details ON audiobook_details.item_id = library_items.id
      LEFT JOIN item_people ON item_people.item_id = library_items.id AND item_people.role = 'author'
      LEFT JOIN people AS authors ON authors.id = item_people.person_id
      WHERE library_items.id IN (${placeholders})
        AND library_items.deleted_at IS NULL
        AND libraries.type = ?
      GROUP BY library_items.id
    `).all(...entityIds, config.libraryType) as BookRow[];

    for (const row of rows) {
      // row.id is the ITEM id — access resolves by the library id.
      if (!canUserAccessBook(row.id, { id: row.library_id }, user.id, user.role, config.libraryType)) continue;
      const authors = splitNames(row.author_names);
      result.set(row.id, {
        available: true,
        title: row.title ?? path.basename(row.folder_path),
        subtitle: authors.length > 0 ? authors.join(", ") : null,
        coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
        durationSeconds: row.duration_seconds,
        fileCount: row.file_count,
        href: `${config.hrefBase}/${row.id}`,
        playable: config.playable
      });
    }

    return result;
  };
}

const hydrateAudiobooks = makeBookHydrator({
  libraryType: "audiobook",
  durationSql: "audiobook_details.duration_seconds",
  fileCountSql: "SELECT COUNT(*) FROM audio_files WHERE audio_files.item_id = library_items.id AND audio_files.status = 'available'",
  hrefBase: "/audiobooks/books",
  playable: true
});

// Ebooks: content is documents and there's no playback timeline, so they open in
// the reader (href) rather than the audio player.
const hydrateEbooks = makeBookHydrator({
  libraryType: "ebook",
  durationSql: "NULL",
  fileCountSql: "SELECT COUNT(*) FROM document_files WHERE document_files.item_id = library_items.id AND document_files.status = 'available'",
  hrefBase: "/ebooks/books",
  playable: false
});

// Gallery assets (photos/videos) are single files, not rows in a books-style
// detail table. One file = one item, so the title is the filename, the cover is
// the generated thumbnail, and "duration" only applies to video. Opens in the
// gallery lightbox (href).
const hydrateGallery: Hydrator = (entityIds, user) => {
  const result = new Map<string, HydratedEntity>();
  if (entityIds.length === 0) return result;

  const placeholders = entityIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      library_items.id,
      library_items.folder_path,
      library_items.library_id,
      item_metadata.title,
      item_metadata.cover_storage_key,
      gallery_details.duration_seconds
    FROM library_items
    JOIN libraries ON libraries.id = library_items.library_id
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    LEFT JOIN gallery_details ON gallery_details.item_id = library_items.id
    WHERE library_items.id IN (${placeholders})
      AND library_items.deleted_at IS NULL
      AND libraries.type = 'gallery'
  `).all(...entityIds) as (Omit<BookRow, "author_names" | "file_count"> & { duration_seconds: number | null })[];

  for (const row of rows) {
    if (!canUserAccessBook(row.id, { id: row.library_id }, user.id, user.role, "gallery")) continue;
    result.set(row.id, {
      available: true,
      title: row.title ?? path.basename(row.folder_path),
      subtitle: null,
      coverUrl: row.cover_storage_key ? `/api/library/covers/${row.cover_storage_key}` : null,
      durationSeconds: row.duration_seconds != null ? Math.round(row.duration_seconds) : null,
      fileCount: 1,
      href: `/gallery/assets/${row.id}`,
      playable: false
    });
  }
  return result;
};

interface FamilyPersonRow {
  id: string;
  name: string;
  maiden_name: string | null;
  birth_date: string | null;
  death_date: string | null;
  updated_at: string;
  portrait_storage_key: string | null;
  portrait_item_cover: string | null;
}

// Family-tree persons. Reads are open to every signed-in user (the tag scoping
// in familytree/access.ts governs EDITING only, and the schema says as much), so
// there is no per-person access check to apply here — the plugin's authenticate
// preHandler is the whole gate. The portrait is either an uploaded image or the
// cover of a chosen gallery item, mirroring familytree/persons.ts.
const hydrateFamilyPersons: Hydrator = (entityIds) => {
  const result = new Map<string, HydratedEntity>();
  if (entityIds.length === 0) return result;

  const placeholders = entityIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      p.id, p.name, p.maiden_name, p.birth_date, p.death_date, p.updated_at,
      p.portrait_storage_key,
      cover.cover_storage_key AS portrait_item_cover
    FROM family_tree_persons AS p
    LEFT JOIN item_metadata AS cover ON cover.item_id = p.portrait_item_id
    WHERE p.id IN (${placeholders})
  `).all(...entityIds) as FamilyPersonRow[];

  for (const row of rows) {
    const version = `?v=${encodeURIComponent(row.updated_at)}`;
    const coverKey = row.portrait_storage_key ?? row.portrait_item_cover;
    // "1904 – 1971", "b. 1962", or nothing — the same shorthand the tree uses.
    const years = [row.birth_date?.slice(0, 4), row.death_date?.slice(0, 4)].filter(Boolean);
    let subtitle: string | null = null;
    if (years.length === 2) subtitle = `${years[0]} – ${years[1]}`;
    else if (row.birth_date) subtitle = `b. ${years[0]}`;
    else if (row.maiden_name) subtitle = `née ${row.maiden_name}`;

    result.set(row.id, {
      available: true,
      title: row.name,
      subtitle,
      coverUrl: coverKey ? `/api/library/covers/${coverKey}${version}` : null,
      durationSeconds: null,
      fileCount: 0,
      href: `/family/people/${row.id}`,
      playable: false
    });
  }
  return result;
};

const SUBJECTS: Record<string, SubjectType> = {
  audiobook: { hydrate: hydrateAudiobooks, collectable: true },
  ebook: { hydrate: hydrateEbooks, collectable: true },
  gallery: { hydrate: hydrateGallery, collectable: true },
  family_tree_person: { hydrate: hydrateFamilyPersons, collectable: false }
};

/** Everything the resolver can describe — the valid range of `entity_type`. */
export const SUBJECT_ENTITY_TYPES = Object.keys(SUBJECTS);

/** The subset a Collection accepts. Narrower than the above; see SubjectType. */
export const COLLECTABLE_ENTITY_TYPES = Object.entries(SUBJECTS)
  .filter(([, type]) => type.collectable)
  .map(([name]) => name);

export function isSubjectEntityType(value: string): boolean {
  return Object.hasOwn(SUBJECTS, value);
}

// Hydrate a mixed list of (entityType, entityId) pairs, grouping by type so each
// hydrator runs a single batched query. Returns a lookup keyed "type:id".
export function hydrateEntities(
  refs: { entityType: string; entityId: string }[],
  user: RequestUser
): Map<string, HydratedEntity> {
  const byType = new Map<string, string[]>();
  for (const ref of refs) {
    if (!SUBJECTS[ref.entityType]) continue;
    const list = byType.get(ref.entityType) ?? [];
    list.push(ref.entityId);
    byType.set(ref.entityType, list);
  }

  const out = new Map<string, HydratedEntity>();
  for (const [entityType, ids] of byType) {
    const hydrated = SUBJECTS[entityType].hydrate(ids, user);
    for (const [entityId, view] of hydrated) {
      out.set(`${entityType}:${entityId}`, view);
    }
  }
  return out;
}

/** One subject, or null when it does not exist or the user may not see it. */
export function hydrateOne(
  entityType: string,
  entityId: string,
  user: RequestUser
): HydratedEntity | null {
  return hydrateEntities([{ entityType, entityId }], user).get(`${entityType}:${entityId}`) ?? null;
}
