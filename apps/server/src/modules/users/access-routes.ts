// Everything one user or group can reach, in one read — the Access dialog
// (docs/people-sharing-plan.md, phase 2, D13). Access is set in many places, each
// from the object's side; this answers "what can Michael see?" from his.
//
// Read only. The dialog writes through the per-object routes that already exist
// (a library's members, a collection's access, a branch's editors, Inbox
// reviewers, person grants, shares), so both sides always edit the same rows.
//
// For every grantable object it returns the DIRECT grant (what the dialog may
// change) and what the subject gets from elsewhere — each of a user's groups, and
// the household's Everyone baseline — so an inherited right is shown with its
// source instead of being changed as a side effect.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { EVERYONE_GROUP_ID, resolveObjectRole, type AuthUser } from "../../core/permissions.js";
import { listFamilyTags, FAMILY_TAG_OBJECT_TYPE } from "../familytree/access.js";
import { INBOX_REVIEWERS_OBJECT_ID, INBOX_REVIEWERS_OBJECT_TYPE } from "../library/gallery/inbox-reviewers.js";
import { photoInboxLibraryIds } from "../library/gallery/system-libraries.js";
import { canSeeTree, myTreePersonId, showLivingDetailsFor, TREE_OBJECT_ID, TREE_OBJECT_TYPE } from "../familytree/tree-access.js";
import type { AssignmentRow, UserGroupRow, UserRow } from "../../db/rows.js";

type SubjectType = "user" | "group";
type Role = AssignmentRow["role"];

const subjectParams = z.object({
  subjectType: z.enum(["user", "group"]),
  subjectId: z.string().trim().min(1).max(64)
});

export interface InheritedGrant {
  /** "group": one of the user's groups; "everyone": the household baseline. */
  via: "group" | "everyone";
  groupId?: string;
  groupName?: string;
  role: Role;
}

export interface GrantView {
  direct: Role | null;
  inherited: InheritedGrant[];
  /** What a USER ends up with (resolveObjectRole); null for a group. */
  effective: Exclude<Role, "deny"> | null;
}

function grantView(
  objectType: string,
  objectId: string,
  subject: { subjectType: SubjectType; subjectId: string },
  groups: Pick<UserGroupRow, "id" | "name">[],
  user: AuthUser | null
): GrantView {
  const rows = db.prepare(`
    SELECT subject_type, subject_id, role FROM assignments
    WHERE object_type = ? AND object_id = ?
  `).all(objectType, objectId) as Pick<AssignmentRow, "subject_type" | "subject_id" | "role">[];
  const direct = rows.find((row) => row.subject_type === subject.subjectType && row.subject_id === subject.subjectId)?.role ?? null;
  const inherited: InheritedGrant[] = [];
  for (const group of groups) {
    const row = rows.find((r) => r.subject_type === "group" && r.subject_id === group.id);
    if (row) inherited.push({ via: "group", groupId: group.id, groupName: group.name, role: row.role });
  }
  const everyone = rows.find((row) => row.subject_type === "group" && row.subject_id === EVERYONE_GROUP_ID);
  if (everyone && !(subject.subjectType === "group" && subject.subjectId === EVERYONE_GROUP_ID)) {
    inherited.push({ via: "everyone", role: everyone.role });
  }
  const effective = user ? resolveObjectRole(objectType, objectId, user) : null;
  return { direct, inherited, effective };
}

const shareTitleSql = `
  CASE s.module
    WHEN 'gallery_album' THEN (SELECT name FROM gallery_albums WHERE id = s.resource_id)
    WHEN 'gallery_slideshow' THEN (SELECT name FROM gallery_slideshows WHERE id = s.resource_id)
    WHEN 'story' THEN (SELECT title FROM stories WHERE id = s.resource_id)
    WHEN 'gallery_set' THEN NULL
    ELSE (SELECT COALESCE(m.title, li.folder_path) FROM library_items li
          LEFT JOIN item_metadata m ON m.item_id = li.id WHERE li.id = s.resource_id)
  END`;

export async function accessRoutesPlugin(app: FastifyInstance) {
  app.get("/api/access/:subjectType/:subjectId", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = subjectParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid subject" });
    const subject = parsed.data;

    let user: AuthUser | null = null;
    let groups: Pick<UserGroupRow, "id" | "name">[] = [];
    let header: Record<string, unknown>;
    if (subject.subjectType === "user") {
      const row = db.prepare("SELECT id, display_name, email, role, is_active FROM users WHERE id = ? AND deleted_at IS NULL")
        .get(subject.subjectId) as Pick<UserRow, "id" | "display_name" | "email" | "role" | "is_active"> | undefined;
      if (!row) return reply.code(404).send({ error: "User not found" });
      user = { id: row.id, role: row.role };
      groups = db.prepare(`
        SELECT g.id, g.name FROM group_members m JOIN user_groups g ON g.id = m.group_id
        WHERE m.user_id = ? AND g.id != ? ORDER BY g.name COLLATE NOCASE
      `).all(row.id, EVERYONE_GROUP_ID) as Pick<UserGroupRow, "id" | "name">[];
      header = { subjectType: "user", subjectId: row.id, name: row.display_name, email: row.email, role: row.role, isActive: row.is_active === 1 };
    } else {
      const row = db.prepare("SELECT id, name, kind FROM user_groups WHERE id = ?").get(subject.subjectId) as Pick<UserGroupRow, "id" | "name" | "kind"> | undefined;
      if (!row) return reply.code(404).send({ error: "Group not found" });
      const members = db.prepare(`
        SELECT u.id, u.display_name AS name, u.email FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = ? AND u.deleted_at IS NULL ORDER BY u.display_name COLLATE NOCASE
      `).all(row.id) as { id: string; name: string; email: string }[];
      header = { subjectType: "group", subjectId: row.id, name: row.name, system: row.kind === "system", members };
    }

    // Every library (D20), system ones aside — the Inbox is its own row below and
    // App files follows what owns each file.
    const libraries = (db.prepare("SELECT id, name, type FROM libraries WHERE role IS NULL ORDER BY type, name COLLATE NOCASE").all() as { id: string; name: string; type: string }[])
      .map((library) => ({ ...library, ...grantView("library", library.id, subject, groups, user) }));

    const branches = listFamilyTags()
      .map((tag) => ({ id: tag.id, name: tag.name, people: tag.count, ...grantView(FAMILY_TAG_OBJECT_TYPE, tag.id, subject, groups, user) }));

    const collections = (db.prepare("SELECT id, title FROM story_collections ORDER BY title COLLATE NOCASE").all() as { id: string; title: string }[])
      .map((collection) => ({ id: collection.id, name: collection.title, ...grantView("story_collection", collection.id, subject, groups, user) }));

    const inbox = photoInboxLibraryIds().size > 0
      ? grantView(INBOX_REVIEWERS_OBJECT_TYPE, INBOX_REVIEWERS_OBJECT_ID, subject, groups, user)
      : null;

    // What was sent to this person directly (D21): albums, slideshows, books,
    // photos, stories. Groups receive none.
    const shares = subject.subjectType === "user"
      ? (db.prepare(`
          SELECT s.id, s.module, s.resource_id, s.permission, s.created_at, s.expires_at,
            u.display_name AS from_name, ${shareTitleSql} AS title
          FROM shares s LEFT JOIN users u ON u.id = s.created_by
          WHERE s.user_id = ? AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ORDER BY s.created_at DESC
        `).all(subject.subjectId) as { id: string; module: string; resource_id: string; permission: string; created_at: string; expires_at: string | null; from_name: string | null; title: string | null }[])
          .map((row) => ({
            id: row.id, module: row.module, resourceId: row.resource_id, permission: row.permission,
            createdAt: row.created_at, expiresAt: row.expires_at, from: row.from_name,
            title: row.title ? row.title.split("/").pop() ?? row.title : null
          }))
      : [];

    // The tree is open unless blocked (D14); living details follow a setting (D15).
    const treeGrant = grantView(TREE_OBJECT_TYPE, TREE_OBJECT_ID, subject, groups, user);
    const tree = {
      blocked: treeGrant.direct === "deny",
      blockedBy: treeGrant.inherited.filter((g) => g.role === "deny").map((g) => (g.via === "everyone" ? null : g.groupName ?? null)),
      canSee: user ? canSeeTree(user) : treeGrant.direct !== "deny",
      seesLivingDetails: user ? showLivingDetailsFor(user) : null,
      // Who they are in the tree (D12), and that person's gallery face, if any.
      me: (() => {
        const personId = user ? myTreePersonId(user.id) : null;
        if (!personId) return null;
        const row = db.prepare("SELECT name, gallery_person_id FROM family_tree_persons WHERE id = ?").get(personId) as { name: string; gallery_person_id: string | null } | undefined;
        return row ? { personId, name: row.name, galleryPersonId: row.gallery_person_id } : null;
      })()
    };

    return reply.send({ subject: header, groups, libraries, branches, collections, inbox, shares, tree });
  });
}
