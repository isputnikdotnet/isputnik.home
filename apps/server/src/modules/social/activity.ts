// What the household has been up to — rendered as activity cards in the home
// feed (modules/home), which is now its only surface.
//
// DERIVED, never stored. A capped UNION over the tables that already record
// who did what and when, ordered by time and then filtered through the subject
// resolver. At household scale that is a few milliseconds, and it can never
// disagree with reality; a materialised feed table would be a cache to keep in
// step with five other tables, which is a bug generator, not a feature.
//
// NOT activity_logs. That table is the security audit trail — IP addresses,
// redaction rules, admin-facing — and mixing "Anna left a note on Dune" into it
// would wreck both.
//
// What is in it, and why so little:
//   • notes            — the conversation, and it lives nowhere else
//   • albums created   — somebody curated something
//   • slideshows made  — likewise
//   • people added     — the family tree growing is news
//
// What is deliberately NOT in it:
//   • new books and photos — Home already has a "Recently added" row; a second
//     one saying the same thing in sentences is noise, not information
//   • recommendations — "Dad sent Mum a book" is correspondence between two
//     people. The half that concerns you is already the "Sent to you" row
//   • your own actions — you know what you did, and at five people your own
//     activity would crowd out everybody else's
import { db } from "../../db.js";
import { hydrateEntities, type HydratedEntity } from "./subjects.js";

export type ActivityKind = "note" | "album" | "slideshow" | "person";

interface ActivityRow {
  kind: ActivityKind;
  id: string;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
  /** What the event is ABOUT, for the resolver. */
  entity_type: string;
  entity_id: string;
  /** A note's text; null for everything else. */
  body: string | null;
}

// Over-fetch, because access filtering happens after the query: a viewer who can
// see little of the library would otherwise get a short page made of the few rows
// that survived out of `limit`, rather than `limit` rows they can actually see.
const OVERFETCH = 4;

function loadRows(viewerId: string, limit: number): ActivityRow[] {
  return db.prepare(`
    SELECT * FROM (
      SELECT
        'note' AS kind, notes.id AS id,
        notes.user_id AS actor_id,
        COALESCE(notes.author_name, users.display_name) AS actor_name,
        notes.created_at AS created_at,
        notes.entity_type AS entity_type, notes.entity_id AS entity_id,
        notes.body AS body
      FROM notes
      LEFT JOIN users ON users.id = notes.user_id
      WHERE notes.deleted_at IS NULL AND (notes.user_id IS NULL OR notes.user_id != ?)

      UNION ALL

      SELECT
        'album', gallery_albums.id,
        gallery_albums.created_by,
        users.display_name,
        gallery_albums.created_at,
        'gallery_album', gallery_albums.id,
        NULL
      FROM gallery_albums
      LEFT JOIN users ON users.id = gallery_albums.created_by
      WHERE gallery_albums.created_by != ?

      UNION ALL

      SELECT
        'slideshow', gallery_slideshows.id,
        gallery_slideshows.created_by,
        users.display_name,
        gallery_slideshows.created_at,
        'gallery_slideshow', gallery_slideshows.id,
        NULL
      FROM gallery_slideshows
      LEFT JOIN users ON users.id = gallery_slideshows.created_by
      WHERE gallery_slideshows.created_by != ?

      UNION ALL

      SELECT
        'person', family_tree_persons.id,
        family_tree_persons.created_by,
        users.display_name,
        family_tree_persons.created_at,
        'family_tree_person', family_tree_persons.id,
        NULL
      FROM family_tree_persons
      LEFT JOIN users ON users.id = family_tree_persons.created_by
      WHERE family_tree_persons.created_by IS NULL OR family_tree_persons.created_by != ?
    )
    ORDER BY datetime(created_at) DESC
    LIMIT ?
  `).all(viewerId, viewerId, viewerId, viewerId, limit * OVERFETCH) as ActivityRow[];
}

function view(row: ActivityRow, subject: HydratedEntity) {
  return {
    id: `${row.kind}:${row.id}`,
    kind: row.kind,
    actorName: row.actor_name ?? "Someone",
    createdAt: row.created_at,
    // The note's own words are the point of a note in a feed; a title alone
    // tells you an event happened without telling you anything.
    body: row.body,
    title: subject.title,
    subtitle: subject.subtitle,
    coverUrl: subject.coverUrl,
    href: subject.href
  };
}

/** The feed, already filtered to what this account may see. */
export function loadActivity(user: { id: string; role: string }, limit: number) {
  const rows = loadRows(user.id, limit);
  if (rows.length === 0) return [];

  // One batched hydrate for the lot, then drop anything the viewer cannot see.
  // This is the whole access story: an event is visible exactly when the thing
  // it happened to is.
  const hydrated = hydrateEntities(
    rows.map((row) => ({ entityType: row.entity_type, entityId: row.entity_id })),
    user
  );

  const out: ReturnType<typeof view>[] = [];
  for (const row of rows) {
    // Absence IS the access check: the resolver leaves out what the viewer
    // cannot see rather than marking it unavailable, and a feed line about a
    // thing you cannot open is worth nothing anyway — unlike an inbox card,
    // there is no decision pending on it.
    const subject = hydrated.get(`${row.entity_type}:${row.entity_id}`);
    if (!subject) continue;
    out.push(view(row, subject));
    if (out.length >= limit) break;
  }
  return out;
}
