// Access to story collections: `assignments` rows with object_type
// 'story_collection', resolved with the same semantics as libraries
// (resolveObjectRole — deny wins, strongest explicit grant beats the Everyone
// baseline). Role meaning here: viewer sees the collection and its stories,
// contributor may create stories in it and edit their own, manager edits every
// story in it and the access itself. Admins always have full access — a
// collection has an author-shaped ownership story, unlike a library, so there
// is no take-ownership dance.
//
// Deliberately dependency-light (db + core/permissions only): the subjects
// hydrator imports this for story visibility, and anything heavier would risk
// an import cycle through the stories module.
//
// Decided 2026-09-01 and recorded in docs/stories-v2-proposal.md: collection
// access OVERRIDES member visibility — a story in a restricted collection is
// invisible to non-members everywhere (lists, tags, back-links, send-to) —
// with one carve-out: a story's own author always sees it, or they could
// lose their own writing to someone else's access change.
import { db } from "../../db.js";
import {
  EVERYONE_GROUP_ID,
  deleteAssignmentsForObject,
  resolveObjectRole,
  roleAllows,
  type AuthUser,
  type ObjectRole
} from "../../core/permissions.js";

export const STORY_COLLECTION_OBJECT_TYPE = "story_collection";

type RequestUser = { id: string; role: string };

export function collectionRole(user: RequestUser, collectionId: string): ObjectRole | null {
  if (user.role === "admin") return "manager";
  return resolveObjectRole(STORY_COLLECTION_OBJECT_TYPE, collectionId, user as AuthUser);
}

export function canViewCollection(user: RequestUser, collectionId: string): boolean {
  return collectionRole(user, collectionId) != null;
}

/** Contributor and up: may create stories in the collection, edit their own. */
export function canContributeToCollection(user: RequestUser, collectionId: string): boolean {
  return roleAllows(collectionRole(user, collectionId), "edit");
}

/** Manager and up: edits every story in it and the access itself. */
export function canManageCollection(user: RequestUser, collectionId: string): boolean {
  return roleAllows(collectionRole(user, collectionId), "manage");
}

/** Every collection id this user may see — the story-visibility filter.
 *  null = unrestricted (admin), so callers skip the SQL clause entirely. */
export function visibleCollectionIds(user: RequestUser): string[] | null {
  if (user.role === "admin") return null;
  const ids = (db.prepare("SELECT id FROM story_collections").all() as { id: string }[]).map((row) => row.id);
  return ids.filter((id) => resolveObjectRole(STORY_COLLECTION_OBJECT_TYPE, id, user as AuthUser) != null);
}

/** A new collection: its creator manages it, and Everyone starts as viewer so
 *  an unrestricted collection behaves exactly like the flat story list.
 *  Removing that Everyone row is what restricts it. */
export function seedCollectionAccess(collectionId: string, creatorId: string): void {
  const upsert = db.prepare(`
    INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role
  `);
  upsert.run("user", creatorId, STORY_COLLECTION_OBJECT_TYPE, collectionId, "manager");
  upsert.run("group", EVERYONE_GROUP_ID, STORY_COLLECTION_OBJECT_TYPE, collectionId, "viewer");
}

export function deleteCollectionAccess(collectionId: string): void {
  deleteAssignmentsForObject(STORY_COLLECTION_OBJECT_TYPE, collectionId);
}
