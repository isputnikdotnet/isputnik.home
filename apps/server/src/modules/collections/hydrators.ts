import path from "node:path";
import { db } from "../../db.js";
import { canUserAccessBook } from "../library/shared/library-access.js";
import type { BookLibraryType } from "../library/shared/library-types.js";

// Display data for one collection member, independent of which entity type it
// is. `available` is false when the resource no longer exists or the user can't
// access it — the item stays in the collection but renders as unavailable.
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
// the same access rules the rest of the app uses. New library types (ebook,
// photo, …) and Notes register a hydrator here — no route or schema changes.
type Hydrator = (entityIds: string[], user: RequestUser) => Map<string, HydratedEntity>;

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

// Audiobooks and ebooks are both rows in `books`, told apart only by their
// library's type. One parameterized hydrator serves both — the differences are
// the file source (book_files vs book_documents), whether there's a duration,
// the detail href, and whether continuous playback applies. The `libraries.type`
// filter is load-bearing: it stops an id of the wrong type (e.g. an ebook added
// with entity_type='audiobook') from resolving here and rendering as the wrong
// kind of media.
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
      // row.id is the BOOK id — access resolves by the library id.
      if (!canUserAccessBook(row.id, { id: row.library_id }, user.id, user.role)) continue;
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

// Ebooks: content is documents and there's no playback timeline, so they're
// collectable but open in the reader (href) rather than the audio player.
const hydrateEbooks = makeBookHydrator({
  libraryType: "ebook",
  durationSql: "NULL",
  fileCountSql: "SELECT COUNT(*) FROM document_files WHERE document_files.item_id = library_items.id AND document_files.status = 'available'",
  hrefBase: "/ebooks/books",
  playable: false
});

const HYDRATORS: Record<string, Hydrator> = {
  audiobook: hydrateAudiobooks,
  ebook: hydrateEbooks
};

export const COLLECTABLE_ENTITY_TYPES = Object.keys(HYDRATORS);

// Hydrate a mixed list of (entityType, entityId) pairs, grouping by type so each
// hydrator runs a single batched query. Returns a lookup keyed "type:id".
export function hydrateEntities(
  refs: { entityType: string; entityId: string }[],
  user: RequestUser
): Map<string, HydratedEntity> {
  const byType = new Map<string, string[]>();
  for (const ref of refs) {
    if (!HYDRATORS[ref.entityType]) continue;
    const list = byType.get(ref.entityType) ?? [];
    list.push(ref.entityId);
    byType.set(ref.entityType, list);
  }

  const out = new Map<string, HydratedEntity>();
  for (const [entityType, ids] of byType) {
    const hydrated = HYDRATORS[entityType](ids, user);
    for (const [entityId, view] of hydrated) {
      out.set(`${entityType}:${entityId}`, view);
    }
  }
  return out;
}
