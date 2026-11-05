// Personal libraries — docs/photo-sync-plan.md, phase 1 (decisions 3, 4, 11).
//
// A personal library is an ordinary gallery library marked with
// `libraries.personal_user_id`. Only that member can open it: the access override in
// system-library-access.ts makes them `manager` and everyone else — admins
// included, and an admin previewing as the member — nothing. Every scope, stream and
// viewer check goes through that override, so this file only answers "which
// libraries are personal, and whose", for the few places that list libraries
// without asking access (admin housekeeping pages, the Access dialog, people
// sharing).
//
// Kept free of routes and the catalogue so the scope helpers can import it.
import { db } from "../../../../db.js";
import { currentViewer, viewerMemo } from "../../../../core/viewer-context.js";
import type { LibraryRow } from "../../../../db/rows.js";

export type PersonalMarker = Pick<LibraryRow, "personal_user_id" | "personal_orphaned_at">;

/** The marker of one library, or null for an ordinary library (or none at all). */
export function personalMarkerOf(libraryId: string): PersonalMarker | null {
  const row = db.prepare("SELECT personal_user_id, personal_orphaned_at FROM libraries WHERE id = ?")
    .get(libraryId) as PersonalMarker | undefined;
  return row?.personal_user_id ? row : null;
}

export function isPersonalLibrary(libraryId: string): boolean {
  return personalMarkerOf(libraryId) != null;
}

/** The member's live (not orphaned) personal library id, or null. */
export function personalLibraryIdOf(userId: string): string | null {
  const row = db.prepare(
    "SELECT id FROM libraries WHERE personal_user_id = ? AND personal_orphaned_at IS NULL"
  ).get(userId) as Pick<LibraryRow, "id"> | undefined;
  return row?.id ?? null;
}

/** Every personal library, orphaned ones too. */
export function personalLibraryIds(): Set<string> {
  const rows = db.prepare("SELECT id FROM libraries WHERE personal_user_id IS NOT NULL").all() as Pick<LibraryRow, "id">[];
  return new Set(rows.map((row) => row.id));
}

/** The personal libraries `userId` may not see: all of them but their own live one.
 *  For lists that are not built from access checks (admin housekeeping pages). */
export function personalLibrariesHiddenFrom(userId: string | null | undefined): Set<string> {
  const own = userId ? personalLibraryIdOf(userId) : null;
  const all = personalLibraryIds();
  if (own) all.delete(own);
  return all;
}

/** The same, for the current request's viewer, once per request. With no request
 *  (a job, a script) every personal library is hidden. */
export function personalLibrariesHiddenFromViewer(): Set<string> {
  const viewer = currentViewer();
  return viewerMemo(`gallery.personal:hidden:${viewer?.id ?? "-"}`, () => personalLibrariesHiddenFrom(viewer?.id));
}

/** A SQL fragment keeping rows of `column` (a library id) out of the hidden set, with
 *  its one param. `column` is written by the caller, never taken from a request. */
export function notHiddenPersonalSql(column: string, userId: string | null | undefined): { sql: string; params: unknown[] } {
  return {
    sql: `${column} NOT IN (SELECT value FROM json_each(?))`,
    params: [JSON.stringify([...personalLibrariesHiddenFrom(userId)])]
  };
}
