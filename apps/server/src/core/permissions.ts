// Unified access model — one mechanism for every object (libraries today,
// collections/etc. later). See docs/permissions.md.
//
//   allowed(action) = roleAllows(user's role on object, action)
//                     AND policyAllows(object policy, action)
//
// Roles (assignments) say what a *user* may do; policies (library mode) say what is
// allowed on the *object* at all. Both must pass.
import { db } from "../db.js";

// Built-in groups. Everyone is virtual (no member rows — it matches every signed-in
// user); System Admins membership is real (reserved for the upcoming auth swap).
export const EVERYONE_GROUP_ID = "grp-everyone";
export const SYSTEM_ADMINS_GROUP_ID = "grp-system-admins";

// Ordered weakest → strongest. `deny` is stored in assignments but is NOT a tier — it
// is an explicit block handled separately, so it is not part of this rank.
export type ObjectRole = "viewer" | "member" | "contributor" | "manager";
const ROLE_RANK: Record<ObjectRole, number> = { viewer: 0, member: 1, contributor: 2, manager: 3 };

export type LibraryAction =
  | "view"      // browse, stream, read in-app
  | "download"  // export a file
  | "upload"    // add files to the source (write — policy-gated)
  | "edit"      // edit metadata/organization (app DB only, never touches source)
  | "delete"    // remove source files (write — policy-gated)
  | "manage";   // members, settings, take ownership

// Minimum role each action needs.
const ACTION_MIN_ROLE: Record<LibraryAction, ObjectRole> = {
  view: "viewer",
  download: "member",
  upload: "contributor",
  edit: "contributor",
  delete: "manager",
  manage: "manager"
};

export interface AuthUser {
  id: string;
  role: string; // global account role; admin = super-user (auth swap to System Admins later)
}

// TODO(auth-swap): replace with "is member of System Admins group".
function isServerAdmin(user: AuthUser): boolean {
  return user.role === "admin";
}

export function roleAllows(role: ObjectRole | null, action: LibraryAction): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[ACTION_MIN_ROLE[action]];
}

const strongest = (roles: ObjectRole[]): ObjectRole =>
  roles.reduce((best, r) => (ROLE_RANK[r] > ROLE_RANK[best] ? r : best));

interface AssignmentRow {
  subject_type: "user" | "group";
  subject_id: string;
  role: ObjectRole | "deny";
}

// Resolve the effective role a user holds on one object, or null for no access.
//
// - Server admins act as `manager` on everything EXCEPT a private object (no Everyone
//   grant) they have no grant on — that stays off-limits until they take ownership.
//   `deny` does not affect admins.
// - For everyone else: a `deny` (theirs or a group's) blocks outright; otherwise the
//   strongest explicit grant wins and overrides the Everyone baseline.
export function resolveObjectRole(objectType: string, objectId: string, user: AuthUser): ObjectRole | null {
  const groupIds = (db.prepare("SELECT group_id FROM group_members WHERE user_id = ?").all(user.id) as { group_id: string }[])
    .map((g) => g.group_id);
  const subjectGroupIds = [...groupIds, EVERYONE_GROUP_ID];
  const placeholders = subjectGroupIds.map(() => "?").join(", ");

  const rows = db.prepare(`
    SELECT subject_type, subject_id, role FROM assignments
    WHERE object_type = ? AND object_id = ?
      AND (
        (subject_type = 'user' AND subject_id = ?)
        OR (subject_type = 'group' AND subject_id IN (${placeholders}))
      )
  `).all(objectType, objectId, user.id, ...subjectGroupIds) as AssignmentRow[];

  const isEveryone = (r: AssignmentRow) => r.subject_type === "group" && r.subject_id === EVERYONE_GROUP_ID;
  const everyoneGrant = rows.find((r) => isEveryone(r) && r.role !== "deny");
  const explicit = rows.filter((r) => !isEveryone(r));

  if (isServerAdmin(user)) {
    // Public object, or admin has an explicit grant → manager. Private + no grant → null.
    if (everyoneGrant || explicit.some((r) => r.role !== "deny")) return "manager";
    return null;
  }

  // Non-admin: an explicit deny (own or via a group) blocks everything.
  if (rows.some((r) => r.role === "deny")) return null;

  const explicitRoles = explicit.filter((r) => r.role !== "deny").map((r) => r.role as ObjectRole);
  if (explicitRoles.length > 0) return strongest(explicitRoles);
  if (everyoneGrant) return everyoneGrant.role as ObjectRole;
  return null;
}

// --- Library policy (mode + write gates) ------------------------------------------

export interface LibraryPolicy {
  mode?: "managed" | "external";
  allowUpload?: boolean;
  allowDelete?: boolean;
  allowedExtensions?: string[];
  maxUploadMB?: number;
}

export function parsePolicy(policyJson: string | null | undefined): LibraryPolicy {
  if (!policyJson) return {};
  try {
    return JSON.parse(policyJson) as LibraryPolicy;
  } catch {
    return {};
  }
}

// Policies only gate write actions that touch source files. Reads, downloads, and
// metadata edits (app DB only) are never blocked by policy.
function policyAllows(policy: LibraryPolicy, action: LibraryAction): boolean {
  if (action !== "upload" && action !== "delete") return true;
  if ((policy.mode ?? "managed") === "external") return false; // external = read-only
  if (action === "upload" && policy.allowUpload === false) return false;
  if (action === "delete" && policy.allowDelete === false) return false;
  return true;
}

// --- The single entry point --------------------------------------------------------

export interface AccessObject {
  objectType: string;
  objectId: string;
  policy?: LibraryPolicy; // for libraries; omit for objects without write policies
}

export function can(user: AuthUser, object: AccessObject, action: LibraryAction): boolean {
  const role = resolveObjectRole(object.objectType, object.objectId, user);
  if (!roleAllows(role, action)) return false;
  if (object.policy && !policyAllows(object.policy, action)) return false;
  return true;
}

// Capability bundle for the client (UI gating only — the server still enforces each).
export interface ObjectCapabilities {
  role: ObjectRole | null;
  canView: boolean;
  canDownload: boolean;
  canUpload: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canManage: boolean;
}

export function libraryCapabilities(user: AuthUser, objectId: string, policy: LibraryPolicy): ObjectCapabilities {
  const role = resolveObjectRole("library", objectId, user);
  const allow = (a: LibraryAction) => roleAllows(role, a) && policyAllows(policy, a);
  return {
    role,
    canView: allow("view"),
    canDownload: allow("download"),
    canUpload: allow("upload"),
    canEdit: allow("edit"),
    canDelete: allow("delete"),
    canManage: allow("manage")
  };
}

// Remove every assignment for a user or group (account/group deletion cleanup), and
// every assignment on an object (object deletion cleanup). subject_id/object_id have
// no FK, so app code must clean them.
export function deleteAssignmentsForSubject(subjectType: "user" | "group", subjectId: string): void {
  db.prepare("DELETE FROM assignments WHERE subject_type = ? AND subject_id = ?").run(subjectType, subjectId);
}

export function deleteAssignmentsForObject(objectType: string, objectId: string): void {
  db.prepare("DELETE FROM assignments WHERE object_type = ? AND object_id = ?").run(objectType, objectId);
}

// The role the Everyone group holds on an object, or null when it has none (= the
// object is private). This is the source of truth for "public access".
export function getEveryoneRole(objectType: string, objectId: string): ObjectRole | null {
  const row = db.prepare(
    "SELECT role FROM assignments WHERE subject_type = 'group' AND subject_id = ? AND object_type = ? AND object_id = ? AND role != 'deny'"
  ).get(EVERYONE_GROUP_ID, objectType, objectId) as { role: ObjectRole } | undefined;
  return row?.role ?? null;
}
