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
import { FAMILY_PERSON_ENTITY_TYPE } from "../../familytree/access.js";
import type { AccessSettingRow, AssignmentRow, GroupMemberRow, UserGalleryPersonRow } from "../../../db/rows.js";

export const PERSON_GRANT_OBJECT = "gallery_person";
/** Q2: a family-tree branch (a family tag) shared as photos — every tree member
 *  tagged with it who is linked to a gallery person, relatives added later too. */
export const BRANCH_GRANT_OBJECT = "gallery_branch";

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

/** The people granted to `user` or any of their groups — one by one, or as a
 *  branch of the family tree (Q2) — and themselves, when linked with "Show them
 *  photos of themselves" on (Q1), minus any person denied to either. Everyone-group rows don't count: a person shared with the whole
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
    const granted = rows.filter((row) => row.role !== "deny").map((row) => row.object_id);
    for (const tagId of branchGrantsReaching(user.id, groups)) granted.push(...branchPeople(tagId));
    const self = selfLinkOf(user.id);
    if (self?.showPhotos) granted.push(self.personId);
    return [...new Set(granted.filter((id) => !denied.has(id)))];
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

// ── Branches (Q2) ───────────────────────────────────────────────────────────

// A branch's gallery people: its tree members' linked face groups, named ones only.
const BRANCH_PEOPLE_SQL = `
  SELECT DISTINCT p.gallery_person_id AS person_id
  FROM family_tree_persons p
  JOIN taggables t ON t.entity_type = '${FAMILY_PERSON_ENTITY_TYPE}' AND t.entity_id = p.id
  JOIN gallery_people gp ON gp.id = p.gallery_person_id AND trim(gp.name) != ''
  WHERE t.tag_id = ?`;

/** The gallery people a branch shares, as of now. */
export function branchPeople(tagId: string): string[] {
  return (db.prepare(BRANCH_PEOPLE_SQL).all(tagId) as { person_id: string }[]).map((row) => row.person_id);
}

/** Branch grants on the user or their groups (not deny). */
function branchGrantsReaching(userId: string, groups: string[]): string[] {
  return (db.prepare(`
    SELECT DISTINCT object_id FROM assignments
    WHERE object_type = ? AND role != 'deny'
      AND ((subject_type = 'user' AND subject_id = ?)
        OR (subject_type = 'group' AND subject_id IN (SELECT value FROM json_each(?))))
  `).all(BRANCH_GRANT_OBJECT, userId, JSON.stringify(groups)) as Pick<AssignmentRow, "object_id">[]).map((row) => row.object_id);
}

/** Whether a tag is a branch of the tree (in use on a family member). */
export function isFamilyBranch(tagId: string): boolean {
  return db.prepare("SELECT 1 AS ok FROM taggables WHERE entity_type = ? AND tag_id = ? LIMIT 1").get(FAMILY_PERSON_ENTITY_TYPE, tagId) != null;
}

/** Share or stop sharing a branch's photos with a user or group. False when the
 *  tag is not a branch of the tree. */
export function setBranchGrant(subject: Subject, tagId: string, granted: boolean, byUserId: string): boolean {
  if (granted) {
    if (!isFamilyBranch(tagId)) return false;
    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES (?, ?, ?, ?, 'member', ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = 'member'
    `).run(subject.subjectType, subject.subjectId, BRANCH_GRANT_OBJECT, tagId, byUserId);
  } else {
    db.prepare("DELETE FROM assignments WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND object_id = ?")
      .run(subject.subjectType, subject.subjectId, BRANCH_GRANT_OBJECT, tagId);
  }
  return true;
}

/** The branches shared with one subject directly. */
export function directBranchGrants(subject: Subject): string[] {
  return (db.prepare(`
    SELECT object_id FROM assignments
    WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND role != 'deny'
  `).all(subject.subjectType, subject.subjectId, BRANCH_GRANT_OBJECT) as Pick<AssignmentRow, "object_id">[])
    .map((row) => row.object_id);
}

/** Who sees a person through a branch: each branch the person's tree member is
 *  in that is shared, and with whom. For "Who can see photos of …". */
export function branchSubjectsOf(personId: string): { branchId: string; branchName: string; subject: Subject }[] {
  return (db.prepare(`
    SELECT DISTINCT tags.id AS branch_id, tags.display_name AS branch_name, a.subject_type, a.subject_id
    FROM family_tree_persons p
    JOIN taggables t ON t.entity_type = '${FAMILY_PERSON_ENTITY_TYPE}' AND t.entity_id = p.id
    JOIN tags ON tags.id = t.tag_id
    JOIN assignments a ON a.object_type = ? AND a.object_id = tags.id AND a.role != 'deny'
    WHERE p.gallery_person_id = ?
    ORDER BY tags.display_name COLLATE NOCASE
  `).all(BRANCH_GRANT_OBJECT, personId) as { branch_id: string; branch_name: string; subject_type: "user" | "group"; subject_id: string }[])
    .map((row) => ({ branchId: row.branch_id, branchName: row.branch_name, subject: { subjectType: row.subject_type, subjectId: row.subject_id } }));
}

// ── "This is them" (Q1) ─────────────────────────────────────────────────────

export interface SelfLink {
  personId: string;
  name: string;
  /** "Show them photos of themselves": counted like a grant when on. */
  showPhotos: boolean;
  /** When showPhotos was last turned on — where "new photos" start. */
  showSince: string | null;
}

/** The gallery person a user is linked to, or null. */
export function selfLinkOf(userId: string): SelfLink | null {
  const row = db.prepare(`
    SELECT l.person_id, l.show_photos, l.show_since, gp.name
    FROM user_gallery_person l JOIN gallery_people gp ON gp.id = l.person_id
    WHERE l.user_id = ?
  `).get(userId) as (Pick<UserGalleryPersonRow, "person_id" | "show_photos" | "show_since"> & { name: string }) | undefined;
  return row ? { personId: row.person_id, name: row.name, showPhotos: row.show_photos === 1, showSince: row.show_since } : null;
}

/** The account linked to a person, or null. */
export function selfLinkedUser(personId: string): { userId: string; showPhotos: boolean } | null {
  const row = db.prepare("SELECT user_id, show_photos FROM user_gallery_person WHERE person_id = ?")
    .get(personId) as Pick<UserGalleryPersonRow, "user_id" | "show_photos"> | undefined;
  return row ? { userId: row.user_id, showPhotos: row.show_photos === 1 } : null;
}

export type SetSelfLinkResult = "ok" | "no-person" | "taken";

/** Link a user to their gallery person (null unlinks). Only a named person; one
 *  that is someone else's already is refused. Turning showPhotos on stamps
 *  show_since, so For you counts what arrives after it, not what was there. */
export function setSelfLink(userId: string, personId: string | null, showPhotos: boolean, byUserId: string): SetSelfLinkResult {
  if (personId == null) {
    db.prepare("DELETE FROM user_gallery_person WHERE user_id = ?").run(userId);
    return "ok";
  }
  const person = db.prepare("SELECT name FROM gallery_people WHERE id = ?").get(personId) as { name: string } | undefined;
  if (!person || !person.name.trim()) return "no-person";
  const owner = selfLinkedUser(personId);
  if (owner && owner.userId !== userId) return "taken";
  const current = selfLinkOf(userId);
  const samePerson = current?.personId === personId;
  const since = showPhotos
    ? (samePerson && current?.showPhotos && current.showSince ? current.showSince : new Date().toISOString())
    : null;
  db.prepare(`
    INSERT INTO user_gallery_person (user_id, person_id, show_photos, show_since, linked_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET
      person_id = excluded.person_id, show_photos = excluded.show_photos, show_since = excluded.show_since,
      linked_by = CASE WHEN user_gallery_person.person_id = excluded.person_id THEN user_gallery_person.linked_by ELSE excluded.linked_by END,
      linked_at = CASE WHEN user_gallery_person.person_id = excluded.person_id THEN user_gallery_person.linked_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END
  `).run(userId, personId, showPhotos ? 1 : 0, since, byUserId);
  return "ok";
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
  // A deleted account is nobody in the gallery, or the tree, any more (Q1, D12).
  if (subjectType === "user") {
    db.prepare("DELETE FROM user_gallery_person WHERE user_id = ?").run(subjectId);
    db.prepare("DELETE FROM user_family_person WHERE user_id = ?").run(subjectId);
  }
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
  // "This is them" follows too — unless the target is already someone's, when the
  // link to the merged-away person goes (the row would point at nothing anyway).
  if (!selfLinkedUser(targetId)) {
    db.prepare("UPDATE user_gallery_person SET person_id = ? WHERE person_id = ?").run(targetId, sourceId);
  }
  db.prepare("DELETE FROM user_gallery_person WHERE person_id = ?").run(sourceId);
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

// ── New arrivals (For you) ──────────────────────────────────────────────────

/** For each person shared with `user`, when the grant first reached them: the
 *  direct grant's date, or a group grant's — or joining that group, when later —
 *  or when "Show them photos of themselves" went on. Photos confirmed before it
 *  are not news to them. */
export function sharedPeopleSince(user: AuthUser): Map<string, string> {
  const personIds = sharedPeopleFor(user);
  const since = new Map<string, string>();
  if (personIds.length === 0) return since;
  const rows = db.prepare(`
    SELECT a.object_id AS person_id,
      MIN(CASE WHEN a.subject_type = 'user' THEN a.created_at ELSE MAX(a.created_at, gm.joined_at) END) AS since
    FROM assignments a
    LEFT JOIN group_members gm ON a.subject_type = 'group' AND gm.group_id = a.subject_id AND gm.user_id = ?
    WHERE a.object_type = ? AND a.role != 'deny'
      AND a.object_id IN (SELECT value FROM json_each(?))
      AND ((a.subject_type = 'user' AND a.subject_id = ?) OR gm.user_id IS NOT NULL)
    GROUP BY a.object_id
  `).all(user.id, PERSON_GRANT_OBJECT, JSON.stringify(personIds), user.id) as { person_id: string; since: string }[];
  for (const row of rows) since.set(row.person_id, row.since);
  // Through a branch: from when the branch grant reached them (Q2).
  const groups = groupIdsOf(user.id);
  const branchRows = db.prepare(`
    SELECT a.object_id AS tag_id,
      MIN(CASE WHEN a.subject_type = 'user' THEN a.created_at ELSE MAX(a.created_at, gm.joined_at) END) AS since
    FROM assignments a
    LEFT JOIN group_members gm ON a.subject_type = 'group' AND gm.group_id = a.subject_id AND gm.user_id = ?
    WHERE a.object_type = ? AND a.role != 'deny'
      AND ((a.subject_type = 'user' AND a.subject_id = ?) OR (gm.user_id IS NOT NULL AND a.subject_id IN (SELECT value FROM json_each(?))))
    GROUP BY a.object_id
  `).all(user.id, BRANCH_GRANT_OBJECT, user.id, JSON.stringify(groups)) as { tag_id: string; since: string }[];
  for (const branch of branchRows) {
    for (const personId of branchPeople(branch.tag_id)) {
      if (!personIds.includes(personId)) continue;
      const other = since.get(personId);
      if (!other || branch.since < other) since.set(personId, branch.since);
    }
  }
  const self = selfLinkOf(user.id);
  if (self?.showPhotos && self.showSince && personIds.includes(self.personId)) {
    const other = since.get(self.personId);
    since.set(self.personId, other && other < self.showSince ? other : self.showSince);
  }
  return since;
}

export interface NewSharedPhotos {
  count: number;
  /** When the newest of them was confirmed. */
  newestAt: string;
  /** That photo's thumbnail. */
  coverStorageKey: string | null;
}

/** Photos a grant of `personId` shares whose face was confirmed after `since`
 *  (a face's updated_at is when it was last assigned or confirmed). Null when
 *  there are none. */
export function newSharedPhotosOf(personId: string, since: string): NewSharedPhotos | null {
  const where = `
    WHERE f.person_id = ? AND f.assignment = 'confirmed' AND f.updated_at > ?
      AND li.library_id NOT IN (SELECT value FROM json_each(?))
      AND f.item_id NOT IN (SELECT item_id FROM gallery_share_exclusions)`;
  const params = [personId, since, neverSharedLibraries()];
  const row = db.prepare(`
    SELECT COUNT(DISTINCT f.item_id) AS n, MAX(f.updated_at) AS newest
    FROM gallery_faces f
    JOIN library_items li ON li.id = f.item_id AND li.deleted_at IS NULL
    ${where}
  `).get(...params) as { n: number; newest: string | null };
  if (row.n === 0 || !row.newest) return null;
  const cover = db.prepare(`
    SELECT m.cover_storage_key AS cover
    FROM gallery_faces f
    JOIN library_items li ON li.id = f.item_id AND li.deleted_at IS NULL
    LEFT JOIN item_metadata m ON m.item_id = f.item_id
    ${where}
    ORDER BY f.updated_at DESC LIMIT 1
  `).get(...params) as { cover: string | null } | undefined;
  return { count: row.n, newestAt: row.newest, coverStorageKey: cover?.cover ?? null };
}
