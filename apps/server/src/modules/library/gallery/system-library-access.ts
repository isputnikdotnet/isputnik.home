// Library checks on the system libraries — docs/system-data-plan.md, phase 4 — and on
// personal libraries — docs/photo-sync-plan.md, phase 1.
//
// None of them has access rules of its own (decision 20; photo-sync decision 3). An
// override registered with core/permissions.ts answers every library check on them,
// so the scopes, the viewer, streams, uploads and the review all ask the same thing
// without each knowing about system or personal libraries:
//
//   Photo Inbox  admins manage; anyone else holds their reviewer level, or nothing
//                (inbox-reviewers.ts)
//   App files    admins manage; anyone else holds nothing at library level, and
//                sees single files through what owns them (app-files-access.ts)
//   Personal     its member manages; everyone else holds nothing — admins included,
//                and an admin previewing as that member. Orphaned (the member was
//                removed): nobody.
//
// Every other library falls through to its own assignments. Imported for its side
// effect by system-libraries.ts and shared/library-access.ts, so any code that can
// ask a library question has registered it.
import { db } from "../../../db.js";
import { registerObjectRoleOverride } from "../../../core/permissions.js";
import { isPreviewing } from "../../../core/viewer-context.js";
import { inboxRoleFor } from "./inbox-reviewers.js";
// Keeps personal libraries' photos out of the shared activity log (registers on import).
import "./personal/activity-gate.js";
import type { LibraryRow } from "../../../db/rows.js";

type Row = Pick<LibraryRow, "role" | "personal_user_id" | "personal_orphaned_at">;

registerObjectRoleOverride("library", (libraryId, user) => {
  const row = db.prepare("SELECT role, personal_user_id, personal_orphaned_at FROM libraries WHERE id = ?").get(libraryId) as Row | undefined;
  if (row?.personal_user_id) {
    return !row.personal_orphaned_at && row.personal_user_id === user.id && !isPreviewing() ? "manager" : null;
  }
  if (row?.role === "inbox") return inboxRoleFor(user);
  if (row?.role === "app-files") return user.role === "admin" ? "manager" : null;
  return undefined;
});
