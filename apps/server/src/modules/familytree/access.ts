// Tag-scoped edit rights for the family tree. Tags on persons double as
// permission scopes: an assignment (object_type 'family_tree_tag', object_id =
// tags.id) grants a user or group edit rights over every person carrying that
// tag. Admins edit everything; untagged persons stay admin-only. Because tags
// are the boundary, assigning tags to persons is itself an admin-only action
// (enforced at the route layer).
import { db } from "../../db.js";
import { EVERYONE_GROUP_ID, roleAllows, type AuthUser, type ObjectRole } from "../../core/permissions.js";

export const FAMILY_TAG_OBJECT_TYPE = "family_tree_tag";
export const FAMILY_PERSON_ENTITY_TYPE = "family_tree_person";

export interface FamilyTag {
  id: string;
  name: string;
  key: string;
}

interface TagAssignmentRow {
  object_id: string;
  subject_type: "user" | "group";
  subject_id: string;
  role: ObjectRole | "deny";
}

// All family-tree tags the user may edit through, resolved with the same
// semantics as resolveObjectRole (deny blocks outright, strongest explicit
// grant beats the Everyone baseline) but across every tag in one query.
// Admins are handled by the callers ("all tags") and never reach this.
function editableTagsForSubjects(user: AuthUser): FamilyTag[] {
  const groupIds = (db.prepare("SELECT group_id FROM group_members WHERE user_id = ?").all(user.id) as { group_id: string }[])
    .map((g) => g.group_id);
  const subjectGroupIds = [...groupIds, EVERYONE_GROUP_ID];
  const placeholders = subjectGroupIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT a.object_id, a.subject_type, a.subject_id, a.role
    FROM assignments a
    WHERE a.object_type = '${FAMILY_TAG_OBJECT_TYPE}'
      AND (
        (a.subject_type = 'user' AND a.subject_id = ?)
        OR (a.subject_type = 'group' AND a.subject_id IN (${placeholders}))
      )
  `).all(user.id, ...subjectGroupIds) as TagAssignmentRow[];

  const byTag = new Map<string, TagAssignmentRow[]>();
  for (const row of rows) {
    const list = byTag.get(row.object_id) ?? [];
    list.push(row);
    byTag.set(row.object_id, list);
  }

  const editableIds: string[] = [];
  for (const [tagId, tagRows] of byTag) {
    if (tagRows.some((r) => r.role === "deny")) continue;
    const isEveryone = (r: TagAssignmentRow) => r.subject_type === "group" && r.subject_id === EVERYONE_GROUP_ID;
    const explicit = tagRows.filter((r) => !isEveryone(r));
    const pool = explicit.length > 0 ? explicit : tagRows;
    if (pool.some((r) => roleAllows(r.role as ObjectRole, "edit"))) editableIds.push(tagId);
  }
  if (editableIds.length === 0) return [];

  const idPlaceholders = editableIds.map(() => "?").join(", ");
  return db.prepare(
    `SELECT id, display_name AS name, key FROM tags WHERE id IN (${idPlaceholders}) ORDER BY display_name COLLATE NOCASE`
  ).all(...editableIds) as FamilyTag[];
}

// "all" means unrestricted (admin); otherwise the concrete tag list (may be empty).
export function getEditableTags(user: AuthUser): "all" | FamilyTag[] {
  if (user.role === "admin") return "all";
  return editableTagsForSubjects(user);
}

export function canEditTree(user: AuthUser): boolean {
  const editable = getEditableTags(user);
  return editable === "all" || editable.length > 0;
}

export function canEditPerson(user: AuthUser, personId: string): boolean {
  const editable = getEditableTags(user);
  if (editable === "all") return true;
  if (editable.length === 0) return false;
  const placeholders = editable.map(() => "?").join(", ");
  return db.prepare(`
    SELECT 1 FROM taggables
    WHERE entity_type = '${FAMILY_PERSON_ENTITY_TYPE}' AND entity_id = ? AND tag_id IN (${placeholders})
  `).get(personId, ...editable.map((t) => t.id)) != null;
}

// A union is editable when the user can edit at least one involved person —
// that is what "add relatives" means: attach a spouse or child to your branch.
export function canEditAnyPerson(user: AuthUser, personIds: (string | null | undefined)[]): boolean {
  const ids = personIds.filter((id): id is string => Boolean(id));
  if (user.role === "admin") return true;
  return ids.some((id) => canEditPerson(user, id));
}

// Bulk-attach `tags` and `canEdit` to person payloads (list, tree, profile) in
// two queries — the tree endpoint decorates hundreds of persons at once.
export function decoratePersons<T extends { id: string }>(
  user: AuthUser,
  persons: T[]
): (T & { tags: string[]; canEdit: boolean })[] {
  const editable = getEditableTags(user);
  const editableIds = editable === "all" ? null : new Set(editable.map((t) => t.id));

  const tagRows = db.prepare(`
    SELECT taggables.entity_id AS person_id, tags.id AS tag_id, tags.display_name AS name
    FROM taggables
    JOIN tags ON tags.id = taggables.tag_id
    WHERE taggables.entity_type = '${FAMILY_PERSON_ENTITY_TYPE}'
    ORDER BY tags.display_name COLLATE NOCASE
  `).all() as { person_id: string; tag_id: string; name: string }[];
  const tagsByPerson = new Map<string, { tagIds: string[]; names: string[] }>();
  for (const row of tagRows) {
    const entry = tagsByPerson.get(row.person_id) ?? { tagIds: [], names: [] };
    entry.tagIds.push(row.tag_id);
    entry.names.push(row.name);
    tagsByPerson.set(row.person_id, entry);
  }

  return persons.map((person) => {
    const entry = tagsByPerson.get(person.id);
    const canEdit = editableIds === null
      ? true
      : (entry?.tagIds.some((id) => editableIds.has(id)) ?? false);
    return { ...person, tags: entry?.names ?? [], canEdit };
  });
}

// Tags in use on family persons, with usage counts — feeds the person-edit
// autocomplete and the people-page filter. The library tag browse only counts
// library_item taggables, so family tags need their own listing.
export function listFamilyTags(): { id: string; name: string; count: number; editorCount: number }[] {
  return db.prepare(`
    SELECT tags.id, tags.display_name AS name, COUNT(*) AS count,
      (SELECT COUNT(*) FROM assignments a
        WHERE a.object_type = '${FAMILY_TAG_OBJECT_TYPE}' AND a.object_id = tags.id) AS editorCount
    FROM taggables
    JOIN tags ON tags.id = taggables.tag_id
    WHERE taggables.entity_type = '${FAMILY_PERSON_ENTITY_TYPE}'
    GROUP BY tags.id
    ORDER BY name COLLATE NOCASE
  `).all() as { id: string; name: string; count: number; editorCount: number }[];
}
