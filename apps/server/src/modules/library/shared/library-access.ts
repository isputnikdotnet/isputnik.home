import { db } from "../../../db.js";
import { userHasItemShare } from "./share-access.js";

// Per-library roles, ordered weakest → strongest. Each role grants its own
// capability plus every capability below it. The owning user and app-admins are
// implicit "admin" on a library and are never stored as grants.
export const LIBRARY_ROLES = ["viewer", "subscriber", "contributor", "curator", "admin"] as const;
export type LibraryRole = (typeof LIBRARY_ROLES)[number];

export type LibraryCapability =
  | "view"            // browse + stream/read in-app
  | "download"        // export/download files
  | "upload"          // add new books/files
  | "edit"            // edit an item's metadata, cover, organization
  | "curate"          // bulk edit, delete books, manage library structure (series/categories)
  | "manage_members"  // grant/revoke library roles
  | "manage_library"; // edit library settings, owner, visibility, source path, delete library

const ROLE_RANK: Record<LibraryRole, number> = {
  viewer: 0,
  subscriber: 1,
  contributor: 2,
  curator: 3,
  admin: 4
};

// The minimum role that unlocks each capability.
const CAPABILITY_MIN_ROLE: Record<LibraryCapability, LibraryRole> = {
  view: "viewer",
  download: "subscriber",
  upload: "contributor",
  edit: "contributor",
  curate: "curator",
  manage_members: "admin",
  manage_library: "admin"
};

export function roleAllows(role: LibraryRole | null, capability: LibraryCapability): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[CAPABILITY_MIN_ROLE[capability]];
}

interface LibraryRoleInput {
  // id is needed to resolve explicit per-library grants. Callers that build a
  // library object by hand (e.g. stream endpoints) should include the library id.
  id?: string;
  owner_id: string | null;
  owner_type: string | null;
  visibility: string;
  // The role granted to all signed-in users on a public library ('viewer' or
  // 'subscriber'). Defaults to 'subscriber' when absent for back-compat.
  public_role?: string | null;
}

// Resolve the effective role a user holds on a library, or null for no access.
//
// Explicit assignments — ownership (user owner = admin; owning-group manager =
// curator, member = subscriber) and per-library user/group grants — are
// AUTHORITATIVE: when any apply, the strongest of them is the user's role and it
// OVERRIDES the public baseline. This lets an admin cap a user/group below public
// (e.g. grant Viewer on a public library to make a group view-only). The public
// baseline (Subscriber) only applies to users with no explicit assignment.
export function resolveLibraryRole(
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): LibraryRole | null {
  if (userRole === "admin") return "admin";

  const explicit: LibraryRole[] = [];

  if (library.owner_type === "user" && library.owner_id === userId) {
    explicit.push("admin");
  } else if (library.owner_type === "group" && library.owner_id) {
    const membership = db.prepare("SELECT role FROM group_members WHERE group_id = ? AND user_id = ?")
      .get(library.owner_id, userId) as { role: string } | undefined;
    if (membership) explicit.push(membership.role === "manager" ? "curator" : "subscriber");
  }

  if (library.id) {
    const grants = db.prepare(`
      SELECT role FROM library_members
      WHERE library_id = ?
        AND (
          (subject_type = 'user' AND subject_id = ?)
          OR (subject_type = 'group' AND subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
        )
    `).all(library.id, userId, userId) as { role: LibraryRole }[];
    for (const grant of grants) explicit.push(grant.role);
  }

  // An explicit assignment defines the role and overrides the public baseline.
  if (explicit.length > 0) {
    return explicit.reduce((best, role) => (ROLE_RANK[role] > ROLE_RANK[best] ? role : best));
  }

  if (library.visibility === "public") {
    return library.public_role === "viewer" ? "viewer" : "subscriber";
  }
  return null;
}

export interface LibraryAccessRow {
  id: string;
  owner_id: string | null;
  owner_type: "user" | "group" | null;
  visibility: "private" | "public";
  public_role: "viewer" | "subscriber" | null;
  type: string;
}

export function canUserAccessLibrary(
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): boolean {
  return resolveLibraryRole(library, userId, userRole) !== null;
}

export function canUserWriteLibrary(
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): boolean {
  return roleAllows(resolveLibraryRole(library, userId, userRole), "edit");
}

export function canUserDownloadLibrary(
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): boolean {
  return roleAllows(resolveLibraryRole(library, userId, userRole), "download");
}

export function canUserCurateLibrary(
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): boolean {
  return roleAllows(resolveLibraryRole(library, userId, userRole), "curate");
}

export function canUserManageLibraryMembers(
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): boolean {
  return roleAllows(resolveLibraryRole(library, userId, userRole), "manage_members");
}

export interface LibraryCapabilities {
  role: LibraryRole | null;
  canView: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canEdit: boolean;
  canCurate: boolean;
  canManageMembers: boolean;
  canManageLibrary: boolean;
}

// The full capability set for a user on a library — handed to the client so it
// can show/hide download, edit, manage, etc. Server routes still enforce each
// capability independently; this is for UI gating only.
export function libraryCapabilities(
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): LibraryCapabilities {
  const role = resolveLibraryRole(library, userId, userRole);
  return {
    role,
    canView: roleAllows(role, "view"),
    canDownload: roleAllows(role, "download"),
    canUpload: roleAllows(role, "upload"),
    canEdit: roleAllows(role, "edit"),
    canCurate: roleAllows(role, "curate"),
    canManageMembers: roleAllows(role, "manage_members"),
    canManageLibrary: roleAllows(role, "manage_library")
  };
}

// Remove every per-library grant for a user or group — call when the account or
// group is deleted, since subject_id has no FK to clean it up automatically.
export function deleteLibraryMembersForSubject(subjectType: "user" | "group", subjectId: string) {
  db.prepare("DELETE FROM library_members WHERE subject_type = ? AND subject_id = ?").run(subjectType, subjectId);
}

// Validate a library's logical owner before it is written. owner_id/owner_type
// are polymorphic (no FK), so SQLite cannot enforce them — every create/update
// path must call this. Checks the owner exists (and is an active user), and that
// the owner does not already own another library of the same type. Returns an
// error to send (status + message) or null when the owner is valid/absent.
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
    SELECT id, owner_id, owner_type, visibility, public_role, type
    FROM libraries
    WHERE id = ? ${typeClause}
  `).get(...params) as LibraryAccessRow | undefined;

  if (!library) return null;
  if (!canUserAccessLibrary(library, userId, userRole)) return null;
  return library;
}

// Book-level read access: granted by ordinary library access (any role), OR by an
// explicit user-to-user share of this single book even when its library is private.
export function canUserAccessBook(
  bookId: string,
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): boolean {
  if (canUserAccessLibrary(library, userId, userRole)) return true;
  return userHasItemShare("audiobook", bookId, userId);
}

// Book-level download: requires the Subscriber+ download capability on the
// library, OR an explicit user share (shared items are downloadable by design).
export function canUserDownloadBook(
  bookId: string,
  library: LibraryRoleInput,
  userId: string,
  userRole: string
): boolean {
  if (canUserDownloadLibrary(library, userId, userRole)) return true;
  return userHasItemShare("audiobook", bookId, userId);
}

export function getLibraryForBook(bookId: string): LibraryAccessRow | null {
  return db.prepare(`
    SELECT libraries.id, libraries.owner_id, libraries.owner_type, libraries.visibility, libraries.public_role, libraries.type
    FROM books
    JOIN libraries ON libraries.id = books.library_id
    WHERE books.id = ? AND books.deleted_at IS NULL
  `).get(bookId) as LibraryAccessRow | null;
}
