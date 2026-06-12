// Library access — a thin shim over the unified engine in core/permissions.ts.
// Keeps the old function names/signatures so existing call sites are untouched while
// the codebase migrates. All role resolution now goes through `assignments`.
import { db } from "../../../db.js";
import { userHasItemShare } from "./share-access.js";
import {
  EVERYONE_GROUP_ID,
  resolveObjectRole,
  roleAllows as coreRoleAllows,
  libraryCapabilities as coreLibraryCapabilities,
  parsePolicy,
  deleteAssignmentsForSubject,
  deleteAssignmentsForObject,
  type AuthUser,
  type ObjectRole,
  type LibraryAction
} from "../../../core/permissions.js";

// The unified role set (was: viewer/subscriber/contributor/curator/admin).
export type LibraryRole = ObjectRole;

const asUser = (userId: string, userRole: string): AuthUser => ({ id: userId, role: userRole });

export interface LibraryRoleInput {
  id?: string;
  // Extra row fields callers may carry; unused for resolution (assignments only).
  owner_id?: string | null;
  owner_type?: string | null;
  policy_json?: string | null;
}

export interface LibraryAccessRow {
  id: string;
  owner_id: string | null;
  owner_type: "user" | "group" | null;
  policy_json: string;
  type: string;
}

function allows(library: LibraryRoleInput, userId: string, userRole: string, action: LibraryAction): boolean {
  if (!library.id) return false;
  return coreRoleAllows(resolveObjectRole("library", library.id, asUser(userId, userRole)), action);
}

export function canUserAccessLibrary(library: LibraryRoleInput, userId: string, userRole: string): boolean {
  return library.id ? resolveObjectRole("library", library.id, asUser(userId, userRole)) !== null : false;
}

// Library ids the user can access, resolved once. Use this to filter per-book result
// rows instead of calling canUserAccessLibrary per row — role resolution costs two
// queries per call, and there are only a handful of libraries.
export function accessibleLibraryIds(userId: string, userRole: string, type?: string): Set<string> {
  const rows = (type
    ? db.prepare("SELECT id FROM libraries WHERE type = ?").all(type)
    : db.prepare("SELECT id FROM libraries").all()) as { id: string }[];
  return new Set(rows.filter((row) => canUserAccessLibrary(row, userId, userRole)).map((row) => row.id));
}
export function canUserWriteLibrary(library: LibraryRoleInput, userId: string, userRole: string): boolean {
  return allows(library, userId, userRole, "edit");
}
function canUserDownloadLibrary(library: LibraryRoleInput, userId: string, userRole: string): boolean {
  return allows(library, userId, userRole, "download");
}
// "Curate" (series/structure) folds into the Contributor "edit" capability now.
export function canUserCurateLibrary(library: LibraryRoleInput, userId: string, userRole: string): boolean {
  return allows(library, userId, userRole, "edit");
}
export function canUserManageLibraryMembers(library: LibraryRoleInput, userId: string, userRole: string): boolean {
  return allows(library, userId, userRole, "manage");
}

export interface LibraryCapabilities {
  role: LibraryRole | null;
  canView: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canCurate: boolean;
  canManageMembers: boolean;
  canManageLibrary: boolean;
}

export function libraryCapabilities(library: LibraryRoleInput, userId: string, userRole: string): LibraryCapabilities {
  if (!library.id) {
    return { role: null, canView: false, canDownload: false, canUpload: false, canEdit: false, canDelete: false, canCurate: false, canManageMembers: false, canManageLibrary: false };
  }
  const caps = coreLibraryCapabilities(asUser(userId, userRole), library.id, parsePolicy(library.policy_json));
  return {
    role: caps.role,
    canView: caps.canView,
    canDownload: caps.canDownload,
    canUpload: caps.canUpload,
    canEdit: caps.canEdit,
    canDelete: caps.canDelete,
    canCurate: caps.canEdit,        // curate folded into contributor
    canManageMembers: caps.canManage,
    canManageLibrary: caps.canManage
  };
}

// Cleanup when a user/group is deleted — removes all their library assignments.
export function deleteLibraryMembersForSubject(subjectType: "user" | "group", subjectId: string) {
  deleteAssignmentsForSubject(subjectType, subjectId);
}

// --- Writing access (create / edit / delete) --------------------------------------

// Seed the access assignments for a library: the Everyone grant (public) and the
// owner's manager grant. Called on create and re-sync on edit. publicRole maps the
// old 'subscriber' onto the new 'member'.
export function setLibraryAccess(libraryId: string, opts: {
  visibility: "public" | "private";
  publicRole?: "viewer" | "member" | "contributor" | "subscriber" | null;
  ownerType?: "user" | "group" | null;
  ownerId?: string | null;
  createdBy: string;
}): void {
  const everyoneRole: ObjectRole =
    opts.publicRole === "viewer" ? "viewer" : opts.publicRole === "contributor" ? "contributor" : "member";
  if (opts.visibility === "public") {
    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES ('group', ?, 'library', ?, ?, ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role
    `).run(EVERYONE_GROUP_ID, libraryId, everyoneRole, opts.createdBy);
  } else {
    db.prepare("DELETE FROM assignments WHERE subject_type = 'group' AND subject_id = ? AND object_type = 'library' AND object_id = ?")
      .run(EVERYONE_GROUP_ID, libraryId);
  }
  if (opts.ownerId && opts.ownerType) {
    db.prepare(`
      INSERT INTO assignments (subject_type, subject_id, object_type, object_id, role, created_by)
      VALUES (?, ?, 'library', ?, 'manager', ?)
      ON CONFLICT (subject_type, subject_id, object_type, object_id) DO UPDATE SET role = excluded.role
    `).run(opts.ownerType, opts.ownerId, libraryId, opts.createdBy);
  }
}

export function deleteLibraryAccess(libraryId: string): void {
  deleteAssignmentsForObject("library", libraryId);
}

// Validate a library's logical owner before it is written (still uses the legacy
// owner columns for the one-library-per-owner rule during the transition).
export function validateLibraryOwner(
  ownerId: string | null,
  ownerType: "user" | "group" | null,
  type: string,
  excludeLibraryId?: string
): { status: number; error: string } | null {
  if (!ownerId) return null;

  if (ownerType === "user") {
    const ownerExists = db.prepare(
      "SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND is_active = 1"
    ).get(ownerId);
    if (!ownerExists) return { status: 400, error: "Owner user not found." };
  } else if (ownerType === "group") {
    const groupExists = db.prepare("SELECT id FROM user_groups WHERE id = ?").get(ownerId);
    if (!groupExists) return { status: 400, error: "Owner group not found." };
  }

  const sql = `SELECT id FROM libraries WHERE type = ? AND owner_id = ? AND owner_type = ?${
    excludeLibraryId ? " AND id != ?" : ""
  }`;
  const params = excludeLibraryId ? [type, ownerId, ownerType, excludeLibraryId] : [type, ownerId, ownerType];
  const duplicate = db.prepare(sql).get(...params);
  if (duplicate) {
    const noun = ownerType === "group" ? "group" : "user";
    return {
      status: 409,
      error: `This ${noun} already owns ${excludeLibraryId ? "another" : "an"} ${type} library.`
    };
  }

  return null;
}

export function getAccessibleLibrary(
  id: string,
  userId: string,
  userRole: string,
  type?: string
): LibraryAccessRow | null {
  const typeClause = type ? "AND type = ?" : "";
  const params = type ? [id, type] : [id];
  const library = db.prepare(`
    SELECT id, owner_id, owner_type, policy_json, type
    FROM libraries
    WHERE id = ? ${typeClause}
  `).get(...params) as LibraryAccessRow | undefined;

  if (!library) return null;
  if (!canUserAccessLibrary(library, userId, userRole)) return null;
  return library;
}

// Book-level read access: library access (any role), OR an explicit user-to-user
// share of this single book even when its library is private.
export function canUserAccessBook(bookId: string, library: LibraryRoleInput, userId: string, userRole: string): boolean {
  if (canUserAccessLibrary(library, userId, userRole)) return true;
  return userHasItemShare("audiobook", bookId, userId);
}

// Book-level download: needs the Member+ download capability, OR a user share.
export function canUserDownloadBook(bookId: string, library: LibraryRoleInput, userId: string, userRole: string): boolean {
  if (canUserDownloadLibrary(library, userId, userRole)) return true;
  return userHasItemShare("audiobook", bookId, userId);
}

export function getLibraryForBook(bookId: string): LibraryAccessRow | null {
  return db.prepare(`
    SELECT libraries.id, libraries.owner_id, libraries.owner_type, libraries.policy_json, libraries.type
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    WHERE books.id = ? AND books.deleted_at IS NULL
  `).get(bookId) as LibraryAccessRow | null;
}
