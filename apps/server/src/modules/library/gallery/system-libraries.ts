// System libraries — docs/system-data-plan.md, phase 1. The Photo Inbox and App
// files are gallery libraries the app keeps for itself, marked by
// `libraries.role` (one of each at most; a unique index holds that). Their items
// are ordinary gallery assets; what makes them different is only where they show.
//
// Kept apart from inbox.ts (the review itself) and house-library.ts (where the
// app's own files land) so the surfaces that must skip them — the scope
// resolvers, the face scanner — can ask without pulling in the trash, the mover
// and the catalogue, which import them back.
import { db } from "../../../db.js";
import type { LibraryRow } from "../../../db/rows.js";

export type SystemLibraryRole = NonNullable<LibraryRow["role"]>;

export const SYSTEM_LIBRARY_ROLES: readonly SystemLibraryRole[] = ["inbox", "app-files"];

/** The id of the gallery library holding `role`, or null. */
export function systemLibraryId(role: SystemLibraryRole): string | null {
  const row = db.prepare("SELECT id FROM libraries WHERE role = ? AND type = 'gallery'").get(role) as Pick<LibraryRow, "id"> | undefined;
  return row?.id ?? null;
}

/** The role a library holds, or null for an ordinary library (or none at all). */
export function libraryRole(libraryId: string): SystemLibraryRole | null {
  const row = db.prepare("SELECT role FROM libraries WHERE id = ?").get(libraryId) as Pick<LibraryRow, "role"> | undefined;
  return row?.role ?? null;
}

/** Give `role` to one gallery library (taking it from whichever held it), or
 *  clear it when `libraryId` is null. A library holds one role at most, so giving
 *  a library the Inbox takes App files from it and the other way round. */
export function setSystemLibraryRole(role: SystemLibraryRole, libraryId: string | null): void {
  db.transaction(() => {
    db.prepare("UPDATE libraries SET role = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE role = ?").run(role);
    if (libraryId) {
      db.prepare("UPDATE libraries SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND type = 'gallery'")
        .run(role, libraryId);
    }
  })();
}

/** The Photo Inbox, as a set so the scope resolvers can filter by it. */
export function photoInboxLibraryIds(): Set<string> {
  const id = systemLibraryId("inbox");
  return new Set(id ? [id] : []);
}

/** Every gallery library the gallery leaves out of a BROWSING scope: both system
 *  libraries — the Inbox (photos nobody has kept yet) and App files (what the app
 *  keeps for itself: story recordings, voice notes, family-tree uploads, rendered
 *  movies, music). Each is reached through what made it, or by naming it in the
 *  library filter. */
export function galleryLibrariesLeftOutOfScope(): Set<string> {
  const rows = db.prepare("SELECT id FROM libraries WHERE type = 'gallery' AND role IS NOT NULL").all() as Pick<LibraryRow, "id">[];
  return new Set(rows.map((row) => row.id));
}

export function isPhotoInboxLibrary(libraryId: string): boolean {
  return libraryRole(libraryId) === "inbox";
}
