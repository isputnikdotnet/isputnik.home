// Photo Inbox reviewers — docs/system-data-plan.md, phase 4 (decision 21).
//
// The Inbox is a library under the hood, but who may look at it is not a library
// question: no owner, no visibility, no member list. Admins always review; anyone
// else reviews because an admin named them (a person, a group, or everyone) at
// one of two levels:
//
//   details — dates, places, notes, people and voice notes (the edit right)
//   keep    — all of that, plus Keep, Discard and drop links (the delete right)
//
// The list is stored in `assignments` under its own object, so deleting a user or
// a group cleans it up like any grant, and it outlives the library: switching App
// storage off and on again makes a new Inbox with the same reviewers. The levels
// map onto contributor and manager, and the override in system-library-access.ts
// answers every library check on the Inbox from this list, so the review, the
// viewer, the stream, uploads and drop links all ask the same thing.
import { db } from "../../../db.js";
import {
  EVERYONE_GROUP_ID,
  strongestGrantedRole,
  type AuthUser,
  type ObjectRole
} from "../../../core/permissions.js";
import type { AssignmentRow, UserGroupRow, UserRow } from "../../../db/rows.js";

export const INBOX_REVIEWERS_OBJECT_TYPE = "photo_inbox";
export const INBOX_REVIEWERS_OBJECT_ID = "reviewers";

export type ReviewerLevel = "details" | "keep";
export const REVIEWER_LEVELS: readonly ReviewerLevel[] = ["details", "keep"];

const LEVEL_ROLE: Record<ReviewerLevel, ObjectRole> = { details: "contributor", keep: "manager" };

function levelOf(role: string): ReviewerLevel {
  return role === "manager" ? "keep" : "details";
}

/** What a library grant becomes as a reviewer: managing the library was the delete
 *  right, which is keeping and discarding; any lesser grant becomes adding details,
 *  so nobody who could see the Inbox loses it (the owner's call, 2026-09-12). */
export function reviewerLevelForLibraryRole(role: string): ReviewerLevel | null {
  if (role === "deny") return null;
  return role === "manager" ? "keep" : "details";
}

/** The role `user` holds on the Inbox: manager for admins, otherwise their reviewer
 *  level, or null. */
export function inboxRoleFor(user: AuthUser): ObjectRole | null {
  if (user.role === "admin") return "manager";
  return strongestGrantedRole(INBOX_REVIEWERS_OBJECT_TYPE, INBOX_REVIEWERS_OBJECT_ID, user);
}

export interface InboxReviewer {
  subjectType: "user" | "group";
  subjectId: string;
  name: string;
  email: string | null;
  level: ReviewerLevel;
  /** The user or group is gone; removing the row still works. */
  missing: boolean;
}

export interface InboxReviewersView {
  reviewers: InboxReviewer[];
  /** The level every signed-in member reviews at, or null. */
  everyone: ReviewerLevel | null;
  candidates: { users: { id: string; name: string }[]; groups: { id: string; name: string }[] };
}

export function inboxReviewersView(): InboxReviewersView {
  const rows = db.prepare(`
    SELECT a.subject_type, a.subject_id, a.role,
      CASE a.subject_type WHEN 'user' THEN u.display_name ELSE g.name END AS name,
      u.email AS email,
      CASE WHEN a.subject_type = 'user' AND u.id IS NULL THEN 1
           WHEN a.subject_type = 'group' AND g.id IS NULL THEN 1 ELSE 0 END AS missing
    FROM assignments a
    LEFT JOIN users u ON a.subject_type = 'user' AND u.id = a.subject_id
    LEFT JOIN user_groups g ON a.subject_type = 'group' AND g.id = a.subject_id
    WHERE a.object_type = ? AND a.object_id = ? AND a.role != 'deny'
  `).all(INBOX_REVIEWERS_OBJECT_TYPE, INBOX_REVIEWERS_OBJECT_ID) as (Pick<AssignmentRow, "subject_type" | "subject_id" | "role">
    & { name: string | null; email: UserRow["email"] | null; missing: number })[];

  const everyoneRow = rows.find((row) => row.subject_type === "group" && row.subject_id === EVERYONE_GROUP_ID);
  const reviewers = rows
    .filter((row) => row !== everyoneRow)
    .map((row) => ({
      subjectType: row.subject_type as "user" | "group",
      subjectId: row.subject_id,
      name: row.name ?? row.subject_id,
      email: row.email,
      level: levelOf(row.role),
      missing: row.missing === 1
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const users = db.prepare("SELECT id, display_name AS name FROM users WHERE deleted_at IS NULL AND is_active = 1 AND role != 'admin' ORDER BY display_name COLLATE NOCASE")
    .all() as (Pick<UserRow, "id"> & { name: UserRow["display_name"] })[];
  const groups = db.prepare("SELECT id, name FROM user_groups WHERE id != ? ORDER BY name COLLATE NOCASE")
    .all(EVERYONE_GROUP_ID) as Pick<UserGroupRow, "id" | "name">[];

  return { reviewers, everyone: everyoneRow ? levelOf(everyoneRow.role) : null, candidates: { users, groups } };
}

/** How many people and groups review besides the admins (Everyone counts as one). */
export function inboxReviewerCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE object_type = ? AND object_id = ? AND role != 'deny'")
    .get(INBOX_REVIEWERS_OBJECT_TYPE, INBOX_REVIEWERS_OBJECT_ID) as { n: number }).n;
}

export class InboxReviewersError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "InboxReviewersError";
  }
}

/** Name a person or group as a reviewer, or change their level. */
export function setInboxReviewer(subjectType: "user" | "group", subjectId: string, level: ReviewerLevel, createdBy: string): void {
  if (subjectType === "user") {
    const user = db.prepare("SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1").get(subjectId) as Pick<UserRow, "id" | "role"> | undefined;
    if (!user) throw new InboxReviewersError("No such member.", 404);
    if (user.role === "admin") throw new InboxReviewersError("Admins always review the Photo Inbox.", 409);
  } else {
    if (subjectId === EVERYONE_GROUP_ID) throw new InboxReviewersError("Everyone is set on its own row.", 400);
    if (!db.prepare("SELECT id FROM user_groups WHERE id = ?").get(subjectId)) throw new InboxReviewersError("No such group.", 404);
  }
  grant(subjectType, subjectId, level, createdBy);
}

/** The level every signed-in member reviews at; null takes it away. */
export function setInboxEveryone(level: ReviewerLevel | null, createdBy: string): void {
  if (level === null) {
    db.prepare("DELETE FROM assignments WHERE object_type = ? AND object_id = ? AND subject_type = 'group' AND subject_id = ?")
      .run(INBOX_REVIEWERS_OBJECT_TYPE, INBOX_REVIEWERS_OBJECT_ID, EVERYONE_GROUP_ID);
    return;
  }
  grant("group", EVERYONE_GROUP_ID, level, createdBy);
}

export function removeInboxReviewer(subjectType: "user" | "group", subjectId: string): boolean {
  return db.prepare("DELETE FROM assignments WHERE object_type = ? AND object_id = ? AND subject_type = ? AND subject_id = ?")
    .run(INBOX_REVIEWERS_OBJECT_TYPE, INBOX_REVIEWERS_OBJECT_ID, subjectType, subjectId).changes > 0;
}

function grant(subjectType: "user" | "group", subjectId: string, level: ReviewerLevel, createdBy: string | null): void {
  db.prepare(`
    INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role
  `).run(subjectType, subjectId, INBOX_REVIEWERS_OBJECT_TYPE, INBOX_REVIEWERS_OBJECT_ID, LEVEL_ROLE[level], createdBy);
}

/** A library becoming the Inbox gives up its own access rules: each grant on it
 *  becomes a reviewer (never lowering one already named), and the library's
 *  assignments and owner go. Used when App storage adopts an existing library. */
export function carryLibraryGrantsToReviewers(libraryId: string): void {
  db.transaction(() => {
    const grants = db.prepare("SELECT subject_type, subject_id, role, created_by FROM assignments WHERE object_type = 'library' AND object_id = ?")
      .all(libraryId) as Pick<AssignmentRow, "subject_type" | "subject_id" | "role" | "created_by">[];
    for (const row of grants) {
      const level = reviewerLevelForLibraryRole(row.role);
      if (!level) continue;
      if (row.subject_type === "user") {
        const user = db.prepare("SELECT role FROM users WHERE id = ?").get(row.subject_id) as Pick<UserRow, "role"> | undefined;
        if (!user || user.role === "admin") continue;
      }
      const current = db.prepare("SELECT role FROM assignments WHERE object_type = ? AND object_id = ? AND subject_type = ? AND subject_id = ?")
        .get(INBOX_REVIEWERS_OBJECT_TYPE, INBOX_REVIEWERS_OBJECT_ID, row.subject_type, row.subject_id) as Pick<AssignmentRow, "role"> | undefined;
      if (current?.role === "manager") continue;
      grant(row.subject_type as "user" | "group", row.subject_id, level, row.created_by ?? null);
    }
    db.prepare("DELETE FROM assignments WHERE object_type = 'library' AND object_id = ?").run(libraryId);
    db.prepare("UPDATE libraries SET owner_id = NULL, owner_type = NULL WHERE id = ?").run(libraryId);
  })();
}
