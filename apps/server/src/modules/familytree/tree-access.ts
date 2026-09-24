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
// marked deceased, and not born more than 100 years ago; no dates at all counts
// as living, which is what the "Deceased (date unknown)" mark is for.
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
 *  100 years ago. Partial dates compare as text ("1925" < "1925-09-24"), so a
 *  bare year of that year reads as older, which is the safe side for an ancestor. */
export function livingCutoff(now = new Date()): string {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - 100, now.getUTCMonth(), now.getUTCDate()));
  return cutoff.toISOString().slice(0, 10);
}

/** D16 on one person's dates. */
export function isLiving(person: { deathDate: string | null; deceased: boolean; birthDate: string | null }, now = new Date()): boolean {
  if (person.deathDate || person.deceased) return false;
  return person.birthDate == null || person.birthDate >= livingCutoff(now);
}
