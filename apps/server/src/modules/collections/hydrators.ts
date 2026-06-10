import path from "node:path";
import { db } from "../../db.js";
import { canUserAccessBook } from "../library/shared/library-access.js";

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

interface AudiobookRow {
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

const hydrateAudiobooks: Hydrator = (entityIds, user) => {
  const result = new Map<string, HydratedEntity>();
  if (entityIds.length === 0) return result;

  const placeholders = entityIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      books.id,
      books.folder_path,
      books.library_id,
      book_metadata.title,
      book_metadata.duration_seconds,
      book_metadata.cover_storage_key,
      GROUP_CONCAT(DISTINCT authors.name) AS author_names,
      (
        SELECT COUNT(*) FROM book_files
        WHERE book_files.book_id = books.id AND book_files.status = 'available'
      ) AS file_count
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    LEFT JOIN book_metadata ON book_metadata.book_id = books.id
    LEFT JOIN book_authors ON book_authors.book_id = books.id AND book_authors.role = 'author'
    LEFT JOIN authors ON authors.id = book_authors.author_id
    WHERE books.id IN (${placeholders}) AND books.deleted_at IS NULL
    GROUP BY books.id
  `).all(...entityIds) as AudiobookRow[];

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
      href: `/audiobooks/books/${row.id}`,
      playable: true
    });
  }

  return result;
};

const HYDRATORS: Record<string, Hydrator> = {
  audiobook: hydrateAudiobooks
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
