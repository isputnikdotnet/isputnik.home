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
import { accessibleLibraryIds, canUserAccessBook } from "../library/shared/library-access.js";
import { visibleCollectionIds } from "../stories/collection-access.js";
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

interface AlbumRow {
  id: string;
  name: string;
  created_by: string;
  visible_count: number;
  cover_key: string | null;
}

// A gallery album. Three ways it can be visible, and all three have to be here:
//   • at least one photo in it is in a library you can browse (as listAlbums)
//   • it is yours, or you are an admin
//   • somebody granted you the album (module 'gallery_album'), which is what
//     Send to writes — that one opens the WHOLE album, including photos in
//     libraries you cannot otherwise browse, because that is what the grant is for
//
// The third was missing at first and the album tests caught it: a recipient was
// granted an album and then still could not open it, because the grant does not
// widen library access and this only looked at library access.
//
// Otherwise "can you open it" is "is any of it visible to you", which is also
// why sending an album is worth doing: each person sees their share of it.
function makeAlbumHydrator(): Hydrator {
  return (entityIds, user) => {
    const result = new Map<string, HydratedEntity>();
    if (entityIds.length === 0) return result;

    const libIds = [...accessibleLibraryIds(user.id, user.role, "gallery")];
    // No accessible gallery libraries still leaves creators/admins their own
    // albums, so query with a never-matching placeholder rather than bailing.
    const libArgs = libIds.length > 0 ? libIds : [""];
    const libIn = libArgs.map(() => "?").join(", ");
    const idIn = entityIds.map(() => "?").join(", ");

    const rows = db.prepare(`
      SELECT
        gallery_albums.id,
        gallery_albums.name,
        gallery_albums.created_by,
        (SELECT COUNT(*) FROM gallery_album_items
          JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
          WHERE gallery_album_items.album_id = gallery_albums.id
            AND library_items.library_id IN (${libIn})) AS visible_count,
        COALESCE(
          (SELECT item_metadata.cover_storage_key FROM library_items
            JOIN item_metadata ON item_metadata.item_id = library_items.id
            WHERE library_items.id = gallery_albums.cover_item_id AND library_items.deleted_at IS NULL
              AND library_items.library_id IN (${libIn})),
          (SELECT item_metadata.cover_storage_key FROM gallery_album_items
            JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
            JOIN item_metadata ON item_metadata.item_id = library_items.id
            WHERE gallery_album_items.album_id = gallery_albums.id
              AND library_items.library_id IN (${libIn})
              AND item_metadata.cover_storage_key IS NOT NULL
            ORDER BY gallery_album_items.position LIMIT 1)
        ) AS cover_key
      FROM gallery_albums
      WHERE gallery_albums.id IN (${idIn})
    `).all(...libArgs, ...libArgs, ...libArgs, ...entityIds) as AlbumRow[];

    // Albums granted to this account outright. Counted whole, and their cover
    // is not restricted to libraries the viewer can browse.
    const sharedRows = db.prepare(`
      SELECT
        shares.resource_id AS album_id,
        (SELECT COUNT(*) FROM gallery_album_items
          JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
          WHERE gallery_album_items.album_id = shares.resource_id) AS total_count,
        (SELECT item_metadata.cover_storage_key FROM gallery_album_items
          JOIN library_items ON library_items.id = gallery_album_items.item_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE gallery_album_items.album_id = shares.resource_id
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY gallery_album_items.position LIMIT 1) AS cover_key
      FROM shares
      WHERE shares.module = 'gallery_album'
        AND shares.user_id = ?
        AND shares.resource_id IN (${idIn})
        AND shares.revoked_at IS NULL
        AND (shares.expires_at IS NULL OR datetime(shares.expires_at) > datetime('now'))
    `).all(user.id, ...entityIds) as { album_id: string; total_count: number; cover_key: string | null }[];
    const shared = new Map(sharedRows.map((row) => [row.album_id, row]));

    for (const row of rows) {
      const grant = shared.get(row.id);
      const mine = user.role === "admin" || row.created_by === user.id;
      if (row.visible_count === 0 && !mine && !grant) continue;

      const count = grant && grant.total_count > row.visible_count ? grant.total_count : row.visible_count;
      const cover = row.cover_key ?? grant?.cover_key ?? null;
      result.set(row.id, {
        available: true,
        title: row.name,
        subtitle: `${count} ${count === 1 ? "photo" : "photos"}`,
        coverUrl: cover ? `/api/library/covers/${cover}` : null,
        durationSeconds: null,
        fileCount: count,
        href: `/gallery/albums/${row.id}`,
        playable: false
      });
    }
    return result;
  };
}

interface SlideshowRow {
  id: string;
  name: string;
  created_by: string;
  visible_count: number;
  cover_key: string | null;
}

// A slideshow is scoped exactly like an album, and an earlier version of this
// hydrator got that wrong: it described EVERY slideshow to EVERY account, which
// leaked the name and a cover thumbnail of photos the viewer had no access to.
// The real rule is listSlideshows() and the detail route, which is explicit
// about it — "a member who can't see any of the items shouldn't learn the
// slideshow exists" — so this mirrors them: visible when at least one of its
// photos is in a library you can browse, or it is yours.
//
// What a slideshow does NOT have is a grant. There is no slideshow share, so
// nobody can widen access to one; that is why it is send-only rather than
// send-and-give.
const hydrateSlideshows: Hydrator = (entityIds, user) => {
  const result = new Map<string, HydratedEntity>();
  if (entityIds.length === 0) return result;

  const libIds = [...accessibleLibraryIds(user.id, user.role, "gallery")];
  // No accessible gallery libraries still leaves creators/admins their own, so
  // query with a never-matching placeholder rather than bailing.
  const libArgs = libIds.length > 0 ? libIds : [""];
  const libIn = libArgs.map(() => "?").join(", ");
  const idIn = entityIds.map(() => "?").join(", ");

  const rows = db.prepare(`
    SELECT
      gallery_slideshows.id,
      gallery_slideshows.name,
      gallery_slideshows.created_by,
      (SELECT COUNT(*) FROM gallery_slideshow_items
        JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
        WHERE gallery_slideshow_items.slideshow_id = gallery_slideshows.id
          AND library_items.library_id IN (${libIn})) AS visible_count,
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = gallery_slideshows.cover_item_id AND library_items.deleted_at IS NULL
            AND library_items.library_id IN (${libIn})),
        (SELECT item_metadata.cover_storage_key FROM gallery_slideshow_items
          JOIN library_items ON library_items.id = gallery_slideshow_items.item_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE gallery_slideshow_items.slideshow_id = gallery_slideshows.id
            AND library_items.library_id IN (${libIn})
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY gallery_slideshow_items.position LIMIT 1)
      ) AS cover_key
    FROM gallery_slideshows
    WHERE gallery_slideshows.id IN (${idIn})
  `).all(...libArgs, ...libArgs, ...libArgs, ...entityIds) as SlideshowRow[];

  for (const row of rows) {
    const mine = user.role === "admin" || row.created_by === user.id;
    if (row.visible_count === 0 && !mine) continue;
    result.set(row.id, {
      available: true,
      title: row.name,
      subtitle: `Slideshow · ${row.visible_count} ${row.visible_count === 1 ? "photo" : "photos"}`,
      coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
      durationSeconds: null,
      fileCount: row.visible_count,
      href: `/gallery/slideshows/${row.id}`,
      playable: false
    });
  }
  return result;
};

interface QuoteSubjectRow {
  id: string;
  text: string;
  source_title: string | null;
  source_author: string | null;
  person_name: string | null;
  live_person_name: string | null;
  item_title: string | null;
}

/** How much of a quote a collection row shows before it is cut short. */
const QUOTE_TITLE_LENGTH = 120;

// Quotes in a collection — "Things the kids said", "Toasts for the next
// birthday". The row is deliberately plain: no cover, no duration, not playable,
// because a quote is words. The detail page guards each of those, so it renders
// as title + attribution rather than an empty media tile.
//
// Visibility is the rule every quote surface uses: yours, plus whatever the
// family shares. A quote that is gone OR private to someone else simply does not
// come back, and the caller renders that row as unavailable.
const hydrateQuotes: Hydrator = (entityIds, user) => {
  const result = new Map<string, HydratedEntity>();
  if (entityIds.length === 0) return result;

  const placeholders = entityIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT
      q.id, q.text, q.source_title, q.source_author, q.person_name,
      speaker.name AS live_person_name,
      item_metadata.title AS item_title
    FROM quotes q
    LEFT JOIN family_tree_persons AS speaker ON speaker.id = q.family_tree_person_id
    LEFT JOIN library_items ON library_items.id = q.item_id AND library_items.deleted_at IS NULL
    LEFT JOIN item_metadata ON item_metadata.item_id = library_items.id
    WHERE q.id IN (${placeholders}) AND (q.user_id = ? OR q.visibility = 'family')
  `).all(...entityIds, user.id) as QuoteSubjectRow[];

  for (const row of rows) {
    // A quote may carry newlines; a collection row is one line.
    const text = row.text.trim().replace(/\s+/g, " ");
    // Who said it, then what it came from. Prefer the live person over the
    // snapshot, exactly as the Quotes page does.
    const attribution = row.live_person_name
      ?? row.person_name
      ?? row.source_author
      ?? row.item_title
      ?? row.source_title;

    result.set(row.id, {
      available: true,
      title: text.length > QUOTE_TITLE_LENGTH
        ? `${text.slice(0, QUOTE_TITLE_LENGTH - 1).trimEnd()}…`
        : text,
      subtitle: attribution,
      coverUrl: null,
      durationSeconds: null,
      fileCount: 0,
      // Opens the Quotes page scrolled to this one.
      href: `/quotes?quote=${row.id}`,
      playable: false
    });
  }
  return result;
};

// A story is a narrative page over content the library already holds. Same
// visibility rule the stories module applies everywhere: published to every
// member, drafts to their author (and admins). The cover falls back to the
// first visible photo a media block points at, exactly as the story index does.
//
// Not collectable, for the same reason albums and slideshows aren't: a
// collection renders playback/file affordances, and a story has neither. It is
// send-able and note-able, which is what sharing a story with someone means
// before real story shares land.
const hydrateStories: Hydrator = (entityIds, user) => {
  const result = new Map<string, HydratedEntity>();
  if (entityIds.length === 0) return result;

  const libIds = [...accessibleLibraryIds(user.id, user.role, "gallery")];
  const libArgs = libIds.length > 0 ? libIds : [""];
  const libIn = libArgs.map(() => "?").join(", ");
  const idIn = entityIds.map(() => "?").join(", ");
  // Collection access overrides member visibility (stories v2): a story on a
  // restricted shelf hydrates only for that shelf's members — author aside.
  const visibleCollections = visibleCollectionIds(user);
  const collectionClause = visibleCollections === null
    ? ""
    : `AND (stories.collection_id IS NULL OR stories.created_by = ?
        ${visibleCollections.length > 0 ? `OR stories.collection_id IN (${visibleCollections.map(() => "?").join(", ")})` : ""})`;

  const rows = db.prepare(`
    SELECT
      stories.id,
      stories.title,
      stories.subtitle,
      stories.status,
      stories.created_by,
      (SELECT COUNT(*) FROM story_blocks
        JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
        WHERE story_chapters.story_id = stories.id) AS block_count,
      COALESCE(
        (SELECT item_metadata.cover_storage_key FROM library_items
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE library_items.id = stories.cover_item_id AND library_items.deleted_at IS NULL
            AND library_items.library_id IN (${libIn})),
        (SELECT item_metadata.cover_storage_key FROM story_blocks
          JOIN story_chapters ON story_chapters.id = story_blocks.chapter_id
          JOIN library_items ON library_items.id = story_blocks.entity_id AND library_items.deleted_at IS NULL
          JOIN item_metadata ON item_metadata.item_id = library_items.id
          WHERE story_chapters.story_id = stories.id
            AND story_blocks.entity_type = 'gallery'
            AND library_items.library_id IN (${libIn})
            AND item_metadata.cover_storage_key IS NOT NULL
          ORDER BY story_chapters.position, story_blocks.position LIMIT 1)
      ) AS cover_key
    FROM stories
    WHERE stories.id IN (${idIn})
      AND (stories.status = 'published' OR stories.created_by = ? OR ? = 'admin')
      ${collectionClause}
  `).all(
    ...libArgs, ...libArgs, ...entityIds, user.id, user.role,
    ...(collectionClause ? [user.id, ...(visibleCollections ?? [])] : [])
  ) as {
    id: string; title: string; subtitle: string | null; status: string;
    created_by: string; block_count: number; cover_key: string | null;
  }[];

  for (const row of rows) {
    result.set(row.id, {
      available: true,
      title: row.title,
      subtitle: row.subtitle,
      coverUrl: row.cover_key ? `/api/library/covers/${row.cover_key}` : null,
      durationSeconds: null,
      fileCount: row.block_count,
      href: `/stories/${row.id}`,
      playable: false
    });
  }
  return result;
};

const SUBJECTS: Record<string, SubjectType> = {
  audiobook: { hydrate: hydrateAudiobooks, collectable: true },
  ebook: { hydrate: hydrateEbooks, collectable: true },
  gallery: { hydrate: hydrateGallery, collectable: true },
  quote: { hydrate: hydrateQuotes, collectable: true },
  family_tree_person: { hydrate: hydrateFamilyPersons, collectable: false },
  gallery_album: { hydrate: makeAlbumHydrator(), collectable: false },
  gallery_slideshow: { hydrate: hydrateSlideshows, collectable: false },
  story: { hydrate: hydrateStories, collectable: false }
};

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
