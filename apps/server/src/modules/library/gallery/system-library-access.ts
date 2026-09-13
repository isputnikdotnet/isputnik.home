// Library checks on the two system libraries — docs/system-data-plan.md, phase 4.
//
// Neither has access rules of its own (decision 20). An override registered with
// core/permissions.ts answers every library check on them, so the scopes, the
// viewer, streams, uploads and the review all ask the same thing without each
// knowing about system libraries:
//
//   Photo Inbox  admins manage; anyone else holds their reviewer level, or nothing
//                (inbox-reviewers.ts)
//   App files    admins manage; anyone else holds nothing at library level, and
//                sees single files through what owns them (app-files-access.ts)
//
// Every other library falls through to its own assignments. Imported for its side
// effect by system-libraries.ts and shared/library-access.ts, so any code that can
// ask a library question has registered it.
import { db } from "../../../db.js";
import { registerObjectRoleOverride } from "../../../core/permissions.js";
import { inboxRoleFor } from "./inbox-reviewers.js";
import type { LibraryRow } from "../../../db/rows.js";

registerObjectRoleOverride("library", (libraryId, user) => {
  const row = db.prepare("SELECT role FROM libraries WHERE id = ?").get(libraryId) as Pick<LibraryRow, "role"> | undefined;
  if (row?.role === "inbox") return inboxRoleFor(user);
  if (row?.role === "app-files") return user.role === "admin" ? "manager" : null;
  return undefined;
});
