// Photos shared by person (docs/people-sharing-plan.md, phase 1).
//
// An admin grants a user or a group a gallery PERSON; from then on they see every
// photo where that person is a CONFIRMED face (a scan face someone assigned or
// confirmed, or a hand tag) — the ones there today and the ones confirmed tomorrow
// (D6, D7). The grant is an `assignments` row (object_type 'gallery_person'), so
// groups and deny work as they do for libraries (D8). A photo can be kept out of
// every person grant (gallery_share_exclusions), and the Photo Inbox and App files
// are never shared this way.
//
// Three things read the rule:
//   • the scope helper (app-files-access.ts → galleryScopeSql), through the rule
//     attached to a scope list by withSharedPeople — every list and count;
//   • canSeeThroughPeople — the one-photo checks (library-access.ts);
//   • peopleOnlyView — what a photo seen ONLY through a grant may show: no folder
//     path or library name, only the granted people's names and faces, and no
//     location unless the recipient's "Show where photos were taken" is on (D10).
import { db } from "../../../db.js";
import { EVERYONE_GROUP_ID, resolveObjectRole, type AuthUser } from "../../../core/permissions.js";
import { currentViewer, viewerMemo } from "../../../core/viewer-context.js";
import { galleryLibrariesLeftOutOfScope } from "./system-libraries.js";
import type { AccessSettingRow, AssignmentRow, GroupMemberRow } from "../../../db/rows.js";

export const PERSON_GRANT_OBJECT = "gallery_person";

type Subject = { subjectType: "user" | "group"; subjectId: string };

export interface PeopleRule {
  /** Gallery person ids granted to the viewer, directly or through a group. */
  personIds: string[];
  /** D10: whether photos seen only through the grant show where they were taken. */
  showLocation: boolean;
}

function groupIdsOf(userId: string): string[] {
  return (db.prepare("SELECT group_id FROM group_members WHERE user_id = ?").all(userId) as Pick<GroupMemberRow, "group_id">[])
    .map((row) => row.group_id)
    .filter((id) => id !== EVERYONE_GROUP_ID);
}

/** The people granted to `user` or any of their groups, minus any person denied
 *  to either. Everyone-group rows don't count: a person shared with the whole
 *  household is not a rule anyone needs. Once per request. */
export function sharedPeopleFor(user: AuthUser): string[] {
  return viewerMemo(`gallery.people:shared:${user.id}`, () => {
    const groups = groupIdsOf(user.id);
    const rows = db.prepare(`
      SELECT a.object_id, a.role FROM assignments a
      JOIN gallery_people gp ON gp.id = a.object_id
      WHERE a.object_type = ?
        AND ((a.subject_type = 'user' AND a.subject_id = ?)
          OR (a.subject_type = 'group' AND a.subject_id IN (SELECT value FROM json_each(?))))
    `).all(PERSON_GRANT_OBJECT, user.id, JSON.stringify(groups)) as Pick<AssignmentRow, "object_id" | "role">[];
    const denied = new Set(rows.filter((row) => row.role === "deny").map((row) => row.object_id));
    return [...new Set(rows.filter((row) => row.role !== "deny" && !denied.has(row.object_id)).map((row) => row.object_id))];
  });
}

/** D10 for `user`: on when their own settings or any of their groups' say so. */
export function showLocationFor(user: AuthUser): boolean {
  return viewerMemo(`gallery.people:location:${user.id}`, () => {
    const row = db.prepare(`
      SELECT MAX(show_location) AS on_ FROM access_settings
      WHERE (subject_type = 'user' AND subject_id = ?)
        OR (subject_type = 'group' AND subject_id IN (SELECT value FROM json_each(?)))
    `).get(user.id, JSON.stringify(groupIdsOf(user.id))) as { on_: number | null };
    return row.on_ === 1;
  });
}

/** The rule for `user`, or null when nobody was shared with them. */
export function peopleRuleFor(user: AuthUser): PeopleRule | null {
  const personIds = sharedPeopleFor(user);
  if (personIds.length === 0) return null;
  return { personIds, showLocation: showLocationFor(user) };
}

// ── The rule on a scope list ────────────────────────────────────────────────

const scopedRules = new WeakMap<readonly string[], PeopleRule>();

/** Attach `user`'s people rule to a scope list, so galleryScopeSql lets their
 *  shared photos through. A no-op without one. Returns the same array; copies do
 *  not carry the rule. */
export function withSharedPeople<T extends string[]>(user: AuthUser, libIds: T): T {
  const rule = peopleRuleFor(user);
  if (rule) scopedRules.set(libIds, rule);
  return libIds;
}

export function peopleRuleForScope(libIds: readonly string[]): PeopleRule | undefined {
  return scopedRules.get(libIds);
}

// The items a set of people shares. Params, in order: person ids (JSON), the
// libraries that are never shared this way (JSON).
const PEOPLE_SHARED_ITEMS_SQL = `
  SELECT ps_f.item_id FROM gallery_faces ps_f
  JOIN library_items ps_li ON ps_li.id = ps_f.item_id AND ps_li.deleted_at IS NULL
  WHERE ps_f.person_id IN (SELECT value FROM json_each(?)) AND ps_f.assignment = 'confirmed'
    AND ps_li.library_id NOT IN (SELECT value FROM json_each(?))
    AND ps_f.item_id NOT IN (SELECT item_id FROM gallery_share_exclusions)`;

function neverSharedLibraries(): string {
  return JSON.stringify([...galleryLibrariesLeftOutOfScope()]);
}

export interface PeopleSqlOptions {
  /** A gallery_faces alias in the query: its faces count on a shared photo only
   *  when they are a granted person's (the People list, the people facet). */
  faceAlias?: string;
}

/** The WHERE fragment "this row's item is shared with the rule's viewer by person". */
export function peopleSharedSql(rule: PeopleRule, alias: string, options: PeopleSqlOptions = {}): { sql: string; params: unknown[] } {
  const people = JSON.stringify(rule.personIds);
  let sql = `${alias}.id IN (${PEOPLE_SHARED_ITEMS_SQL})`;
  const params: unknown[] = [people, neverSharedLibraries()];
  if (options.faceAlias) {
    sql += ` AND ${options.faceAlias}.person_id IN (SELECT value FROM json_each(?))`;
    params.push(people);
  }
  return { sql: `(${sql})`, params };
}

/** One photo, checked for `user`: shared with them by person. */
export function canSeeThroughPeople(user: AuthUser, itemId: string): boolean {
  const rule = peopleRuleFor(user);
  if (!rule) return false;
  return db.prepare(`SELECT 1 AS ok WHERE ? IN (${PEOPLE_SHARED_ITEMS_SQL})`)
    .get(itemId, JSON.stringify(rule.personIds), neverSharedLibraries()) != null;
}

// ── What a photo seen only through a grant may show ─────────────────────────

export interface PeopleOnlyView {
  showLocation: boolean;
  /** The only people whose names and faces this viewer may see on the photo. */
  personIds: Set<string>;
}

/** For the current viewer: when this photo is theirs ONLY through a person grant
 *  — not a library they can open, not App files, not an album or item sent to
 *  them — how it must be shown. Null for everything else, and outside a request. */
export function peopleOnlyViewOf(itemId: string, libraryId: string): PeopleOnlyView | null {
  const viewer = currentViewer();
  if (!viewer || viewer.role === "admin") return null;
  const rule = peopleRuleFor(viewer);
  if (!rule) return null;
  const reachable = viewerMemo(`gallery.people:reach:${viewer.id}:${libraryId}`,
    () => resolveObjectRole("library", libraryId, viewer) !== null);
  if (reachable || galleryLibrariesLeftOutOfScope().has(libraryId)) return null;
  const sharedOtherwise = viewerMemo(`gallery.people:othershare:${viewer.id}:${itemId}`, () => db.prepare(`
    SELECT 1 AS ok FROM shares
    WHERE user_id = ? AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      AND ((module = 'gallery' AND resource_id = ?)
        OR (module = 'gallery_album' AND resource_id IN (SELECT album_id FROM gallery_album_items WHERE item_id = ?)))
    LIMIT 1
  `).get(viewer.id, itemId, itemId) != null);
  if (sharedOtherwise) return null;
  return { showLocation: rule.showLocation, personIds: new Set(rule.personIds) };
}

/** A thumbnail (cover, preview or face crop), checked for `user` through the
 *  people shared with them: a photo's own thumbnails when the photo is shared, a
 *  face crop only when it is a SHARED person's face on such a photo — the other
 *  guests' faces stay out. For the covers route, which is addressed by key. */
export function canSeeThumbnailThroughPeople(user: AuthUser, storageKey: string): boolean {
  const shared = sharedPeopleFor(user);
  if (shared.length === 0) return false;
  const face = db.prepare("SELECT item_id, person_id FROM gallery_faces WHERE thumb_storage_key = ? LIMIT 1")
    .get(storageKey) as { item_id: string; person_id: string | null } | undefined;
  if (face) {
    return face.person_id != null && shared.includes(face.person_id) && canSeeThroughPeople(user, face.item_id);
  }
  const item = db.prepare(`
    SELECT li.id FROM library_items li
    LEFT JOIN item_metadata m ON m.item_id = li.id
    LEFT JOIN gallery_details g ON g.item_id = li.id
    WHERE li.deleted_at IS NULL AND (m.cover_storage_key = ? OR g.preview_storage_key = ?)
    LIMIT 1
  `).get(storageKey, storageKey) as { id: string } | undefined;
  return item != null && canSeeThroughPeople(user, item.id);
}

// ── Managing grants (admin) ─────────────────────────────────────────────────

/** Grant or withdraw one person for a user or group. Only a named person can be
 *  shared: clustering deletes unnamed groups on its own. Returns false when the
 *  person is unknown or unnamed. */
export function setPersonGrant(subject: Subject, personId: string, granted: boolean, byUserId: string): boolean {
  const person = db.prepare("SELECT name FROM gallery_people WHERE id = ?").get(personId) as { name: string } | undefined;
  if (!person || !person.name.trim()) return false;
  if (granted) {
    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES (?, ?, ?, ?, 'member', ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = 'member'
    `).run(subject.subjectType, subject.subjectId, PERSON_GRANT_OBJECT, personId, byUserId);
  } else {
    db.prepare("DELETE FROM assignments WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND object_id = ?")
      .run(subject.subjectType, subject.subjectId, PERSON_GRANT_OBJECT, personId);
  }
  return true;
}

/** Who a person is shared with, directly (users and groups, not deny). */
export function personGrantSubjects(personId: string): Subject[] {
  return (db.prepare(`
    SELECT subject_type, subject_id FROM assignments
    WHERE object_type = ? AND object_id = ? AND role != 'deny'
    ORDER BY subject_type, subject_id
  `).all(PERSON_GRANT_OBJECT, personId) as Pick<AssignmentRow, "subject_type" | "subject_id">[])
    .map((row) => ({ subjectType: row.subject_type, subjectId: row.subject_id }));
}

/** The people granted to one subject directly. */
export function directPersonGrants(subject: Subject): string[] {
  return (db.prepare(`
    SELECT object_id FROM assignments
    WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND role != 'deny'
  `).all(subject.subjectType, subject.subjectId, PERSON_GRANT_OBJECT) as Pick<AssignmentRow, "object_id">[])
    .map((row) => row.object_id);
}

export function accessSettingsOf(subject: Subject): { showLocation: boolean; showLivingDetails: boolean } {
  const row = db.prepare("SELECT show_location, show_living_details FROM access_settings WHERE subject_type = ? AND subject_id = ?")
    .get(subject.subjectType, subject.subjectId) as Pick<AccessSettingRow, "show_location" | "show_living_details"> | undefined;
  return { showLocation: row?.show_location === 1, showLivingDetails: row?.show_living_details === 1 };
}

export function setShowLocation(subject: Subject, on: boolean): void {
  db.prepare(`
    INSERT INTO access_settings (subject_type, subject_id, show_location) VALUES (?, ?, ?)
    ON CONFLICT (subject_type, subject_id) DO UPDATE SET show_location = excluded.show_location,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(subject.subjectType, subject.subjectId, on ? 1 : 0);
}

/** A user or group is gone: its settings row goes with it (its assignments are
 *  cleared by the caller, as for every grant). */
export function deleteAccessSettingsForSubject(subjectType: "user" | "group", subjectId: string): void {
  db.prepare("DELETE FROM access_settings WHERE subject_type = ? AND subject_id = ?").run(subjectType, subjectId);
}

/** A merge folds one person into another: their grants follow, deduplicated —
 *  a deny on either side survives, since nobody said to lift it. */
export function movePersonGrants(sourceId: string, targetId: string): void {
  const rows = db.prepare("SELECT subject_type, subject_id, role, created_by FROM assignments WHERE object_type = ? AND object_id = ?")
    .all(PERSON_GRANT_OBJECT, sourceId) as Pick<AssignmentRow, "subject_type" | "subject_id" | "role" | "created_by">[];
  const upsert = db.prepare(`
    INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET
      role = CASE WHEN assignments.role = 'deny' OR excluded.role = 'deny' THEN 'deny' ELSE assignments.role END
  `);
  for (const row of rows) upsert.run(row.subject_type, row.subject_id, PERSON_GRANT_OBJECT, targetId, row.role, row.created_by);
  deletePersonGrants(sourceId);
}

export function deletePersonGrants(personId: string): void {
  db.prepare("DELETE FROM assignments WHERE object_type = ? AND object_id = ?").run(PERSON_GRANT_OBJECT, personId);
}

// ── "Don't share this photo" ────────────────────────────────────────────────

export function setShareExcluded(itemId: string, excluded: boolean, byUserId: string): void {
  if (excluded) {
    db.prepare("INSERT OR IGNORE INTO gallery_share_exclusions (item_id, created_by) VALUES (?, ?)").run(itemId, byUserId);
  } else {
    db.prepare("DELETE FROM gallery_share_exclusions WHERE item_id = ?").run(itemId);
  }
}

export function isShareExcluded(itemId: string): boolean {
  return db.prepare("SELECT 1 AS ok FROM gallery_share_exclusions WHERE item_id = ?").get(itemId) != null;
}

// ── Counts and review (D6) ──────────────────────────────────────────────────

export interface PersonShareCounts {
  /** Photos a grant of this person shares now: a confirmed face, not excluded. */
  shared: number;
  /** Photos where they are matched only automatically — what "Review N" offers. */
  toReview: number;
  /** Photos with a confirmed face that "Don't share this photo" keeps out. */
  excluded: number;
}

// A person's photos in libraries a grant can reach, by how they are matched.
const PERSON_ITEMS_SQL = `
  SELECT f.item_id,
    MAX(f.assignment = 'confirmed') AS confirmed,
    MAX(f.assignment IN ('auto', 'suggested')) AS matched,
    (SELECT 1 FROM gallery_share_exclusions x WHERE x.item_id = f.item_id) AS excluded
  FROM gallery_faces f
  JOIN library_items li ON li.id = f.item_id AND li.deleted_at IS NULL
  WHERE f.person_id = ? AND f.assignment != 'rejected'
    AND li.library_id NOT IN (SELECT value FROM json_each(?))
  GROUP BY f.item_id`;

export function personShareCounts(personId: string): PersonShareCounts {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(confirmed = 1 AND excluded IS NULL), 0) AS shared,
      COALESCE(SUM(confirmed = 0 AND matched = 1 AND excluded IS NULL), 0) AS to_review,
      COALESCE(SUM(confirmed = 1 AND excluded = 1), 0) AS excluded
    FROM (${PERSON_ITEMS_SQL})
  `).get(personId, neverSharedLibraries()) as { shared: number; to_review: number; excluded: number };
  return { shared: row.shared, toReview: row.to_review, excluded: row.excluded };
}

/** The photos "Review N" shows: this person matched only automatically, newest first. */
export function personReviewItemIds(personId: string, limit: number, offset: number): { itemIds: string[]; total: number } {
  const base = `
    FROM (${PERSON_ITEMS_SQL}) p
    JOIN gallery_details gd ON gd.item_id = p.item_id
    WHERE p.confirmed = 0 AND p.matched = 1 AND p.excluded IS NULL`;
  const params = [personId, neverSharedLibraries()];
  const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...params) as { n: number }).n;
  const itemIds = (db.prepare(`SELECT p.item_id ${base} ORDER BY gd.taken_at DESC, p.item_id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as { item_id: string }[]).map((row) => row.item_id);
  return { itemIds, total };
}

/** Photos a person is shared through for one subject: the distinct photos its
 *  own grants reach now. What "Michael sees N photos" counts before his groups. */
export function sharedPhotoCount(personIds: string[]): number {
  if (personIds.length === 0) return 0;
  return (db.prepare(`SELECT COUNT(DISTINCT item_id) AS n FROM (${PEOPLE_SHARED_ITEMS_SQL})`)
    .get(JSON.stringify(personIds), neverSharedLibraries()) as { n: number }).n;
}
