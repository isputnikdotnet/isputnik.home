// Who may see the family tree, and how much of a living relative
// (docs/people-sharing-plan.md, "Family tree access", D14–D17).
//
// Seeing the tree: open to every signed-in member unless someone blocked it for
// them — a `deny` on the tree object for the user, one of their groups, or the
// Everyone group (D14). Admins always see it. Nothing is stored for the open
// default, so an upgrade and a fresh install behave the same.
//
// Living relatives (D15, D16): for a viewer who does not edit that person's
// branch, a LIVING person shows their name, place in the tree and portrait only,
// unless the viewer — or one of their groups — has "Show details of living
// relatives" (access_settings.show_living_details). Living = no death date, not
// marked deceased, not born more than 100 years ago, and no child born more than
// 85 years ago; someone with no dates on them or their children counts as
// living, which is what the "Deceased (date unknown)" mark is for.
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db.js";
import { EVERYONE_GROUP_ID, type AuthUser } from "../../core/permissions.js";
import { viewerMemo } from "../../core/viewer-context.js";
import type { GroupMemberRow } from "../../db/rows.js";

export const TREE_OBJECT_TYPE = "family_tree";
export const TREE_OBJECT_ID = "tree";

function groupIdsOf(userId: string): string[] {
  return (db.prepare("SELECT group_id FROM group_members WHERE user_id = ?").all(userId) as Pick<GroupMemberRow, "group_id">[])
    .map((row) => row.group_id);
}

/** Whether `user` may see the family tree at all (D14). */
export function canSeeTree(user: AuthUser): boolean {
  if (user.role === "admin") return true;
  return viewerMemo(`familytree:see:${user.id}`, () => db.prepare(`
    SELECT 1 AS ok FROM assignments
    WHERE object_type = ? AND object_id = ? AND role = 'deny'
      AND ((subject_type = 'user' AND subject_id = ?)
        OR (subject_type = 'group' AND subject_id IN (SELECT value FROM json_each(?))))
    LIMIT 1
  `).get(TREE_OBJECT_TYPE, TREE_OBJECT_ID, user.id, JSON.stringify([...groupIdsOf(user.id), EVERYONE_GROUP_ID])) == null);
}

/** A preHandler after authenticate: the tree's routes answer 403 to someone it is blocked for. */
export async function requireTreeView(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = request.user;
  if (!user || canSeeTree(user)) return;
  await reply.code(403).send({ error: "The family tree isn't shared with you." });
}

/** Block or unblock the tree for one user or group. */
export function setTreeBlocked(subject: { subjectType: "user" | "group"; subjectId: string }, blocked: boolean, byUserId: string): void {
  if (blocked) {
    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES (?, ?, ?, ?, 'deny', ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = 'deny'
    `).run(subject.subjectType, subject.subjectId, TREE_OBJECT_TYPE, TREE_OBJECT_ID, byUserId);
  } else {
    db.prepare("DELETE FROM assignments WHERE subject_type = ? AND subject_id = ? AND object_type = ? AND object_id = ?")
      .run(subject.subjectType, subject.subjectId, TREE_OBJECT_TYPE, TREE_OBJECT_ID);
  }
}

/** D15 for `user`: admins always; anyone else when their own settings, or one of
 *  their groups', say so. */
export function showLivingDetailsFor(user: AuthUser): boolean {
  if (user.role === "admin") return true;
  return viewerMemo(`familytree:living:${user.id}`, () => {
    const row = db.prepare(`
      SELECT MAX(show_living_details) AS on_ FROM access_settings
      WHERE (subject_type = 'user' AND subject_id = ?)
        OR (subject_type = 'group' AND subject_id IN (SELECT value FROM json_each(?)))
    `).get(user.id, JSON.stringify(groupIdsOf(user.id))) as { on_: number | null };
    return row.on_ === 1;
  });
}

export function setShowLivingDetails(subject: { subjectType: "user" | "group"; subjectId: string }, on: boolean): void {
  db.prepare(`
    INSERT INTO access_settings (subject_type, subject_id, show_living_details) VALUES (?, ?, ?)
    ON CONFLICT (subject_type, subject_id) DO UPDATE SET show_living_details = excluded.show_living_details,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(subject.subjectType, subject.subjectId, on ? 1 : 0);
}

// ── Who they are in the tree (D12) ──────────────────────────────────────────

/** The tree person a user is linked to, or null. Once per request. */
export function myTreePersonId(userId: string): string | null {
  return viewerMemo(`familytree:me:${userId}`, () => {
    const row = db.prepare("SELECT person_id FROM user_family_person WHERE user_id = ?").get(userId) as { person_id: string } | undefined;
    return row?.person_id ?? null;
  });
}

/** The account linked to a tree person, or null. */
export function treePersonAccount(personId: string): string | null {
  const row = db.prepare("SELECT user_id FROM user_family_person WHERE person_id = ?").get(personId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

/** Link a user to their tree person (null unlinks). A person already linked to
 *  another account is refused. */
export function setMyTreePerson(userId: string, personId: string | null, byUserId: string): "ok" | "no-person" | "taken" {
  if (personId == null) {
    db.prepare("DELETE FROM user_family_person WHERE user_id = ?").run(userId);
    return "ok";
  }
  if (!db.prepare("SELECT 1 AS ok FROM family_tree_persons WHERE id = ?").get(personId)) return "no-person";
  const owner = treePersonAccount(personId);
  if (owner && owner !== userId) return "taken";
  db.prepare(`
    INSERT INTO user_family_person (user_id, person_id, linked_by) VALUES (?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET person_id = excluded.person_id, linked_by = excluded.linked_by,
      linked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE user_family_person.person_id != excluded.person_id
  `).run(userId, personId, byUserId);
  return "ok";
}

/** The first day someone may have been born and still count as living: today,
 *  100 years ago. */
export function livingCutoff(now = new Date()): string {
  return daysAgo(100, now);
}

/** A child born this long ago (or longer) says their parent is not living: the
 *  parent is at least about fifteen years older, which puts them past the
 *  hundred-year rule. Most ancestors have no dates of their own, but their
 *  children usually do, so this spares the "Deceased (date unknown)" mark for
 *  the majority of a tree and keeps their details readable. */
export const CHILD_BIRTH_CUTOFF_YEARS = 85;

function daysAgo(years: number, now: Date): string {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return cutoff.toISOString().slice(0, 10);
}

/** The LAST day a partial date may stand for: "1926" is any day of 1926, so it
 *  reads as 1926-12-31. Someone born "1926" may be 99 today, which is the
 *  side privacy has to take — the bare year must not count as older than it is. */
function latestDayOf(partial: string): string {
  if (partial.length === 4) return `${partial}-12-31`;
  if (partial.length === 7) return `${partial}-31`;
  return partial;
}

/** D16 on one person's dates, plus their children's (`earliestChildBirth`: the
 *  earliest birth date among their children, when known). */
export function isLiving(
  person: { deathDate: string | null; deceased: boolean; birthDate: string | null },
  now = new Date(),
  earliestChildBirth: string | null = null
): boolean {
  if (person.deathDate || person.deceased) return false;
  if (person.birthDate != null && latestDayOf(person.birthDate) < livingCutoff(now)) return false;
  if (earliestChildBirth != null && latestDayOf(earliestChildBirth) < daysAgo(CHILD_BIRTH_CUTOFF_YEARS, now)) return false;
  return true;
}

/** Earliest known birth date of each person's children, for `isLiving`, in one
 *  query — the tree endpoint decides for hundreds of persons at once. */
export function earliestChildBirthByParent(): Map<string, string> {
  const rows = db.prepare(`
    SELECT parent_id, MIN(c.birth_date) AS earliest
    FROM (
      SELECT u.person1_id AS parent_id, ch.child_id FROM family_tree_children ch JOIN family_tree_unions u ON u.id = ch.union_id
      UNION ALL
      SELECT u.person2_id AS parent_id, ch.child_id FROM family_tree_children ch JOIN family_tree_unions u ON u.id = ch.union_id
      WHERE u.person2_id IS NOT NULL
    ) AS links
    JOIN family_tree_persons c ON c.id = links.child_id
    WHERE c.birth_date IS NOT NULL
    GROUP BY parent_id
  `).all() as { parent_id: string; earliest: string }[];
  return new Map(rows.map((row) => [row.parent_id, row.earliest]));
}

/** The same for one person. */
export function earliestChildBirthOf(personId: string): string | null {
  const row = db.prepare(`
    SELECT MIN(c.birth_date) AS earliest
    FROM family_tree_unions u
    JOIN family_tree_children ch ON ch.union_id = u.id
    JOIN family_tree_persons c ON c.id = ch.child_id
    WHERE (u.person1_id = ? OR u.person2_id = ?) AND c.birth_date IS NOT NULL
  `).get(personId, personId) as { earliest: string | null };
  return row.earliest;
}
