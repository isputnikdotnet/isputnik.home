// The Photo Inbox flag, and nothing else — `policy_json.inbox` on a gallery
// library. Kept apart from inbox.ts (the review itself) so the surfaces that must
// skip an Inbox — the scope resolver, the face scanner — can ask without pulling
// in the trash, the mover and the catalogue, which import them back.
import { isInsideAppStorage } from "../../../core/app-storage.js";
import { db } from "../../../db.js";
import { parsePolicy } from "../../../core/permissions.js";

/** Every gallery library flagged as an Inbox, regardless of who may see it. */
export function photoInboxLibraryIds(): Set<string> {
  const rows = db.prepare("SELECT id, policy_json FROM libraries WHERE type = 'gallery'")
    .all() as { id: string; policy_json: string }[];
  return new Set(rows.filter((row) => parsePolicy(row.policy_json).inbox === true).map((row) => row.id));
}

/** Every gallery library the gallery leaves out of an implicit scope: an Inbox
 *  (photos nobody has kept yet) and any library inside App storage (the Photo
 *  Inbox and Made in the app rooms — what the app keeps for itself: story
 *  recordings, voice notes, family-tree uploads, rendered movies, music). Each
 *  is reached through what made it, or by naming it in the library filter. */
export function galleryLibrariesLeftOutOfScope(): Set<string> {
  const rows = db.prepare("SELECT id, source_path, policy_json FROM libraries WHERE type = 'gallery'")
    .all() as { id: string; source_path: string; policy_json: string }[];
  return new Set(rows
    .filter((row) => parsePolicy(row.policy_json).inbox === true || isInsideAppStorage(row.source_path))
    .map((row) => row.id));
}

export function isPhotoInboxLibrary(libraryId: string): boolean {
  const row = db.prepare("SELECT policy_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as { policy_json: string } | undefined;
  return row != null && parsePolicy(row.policy_json).inbox === true;
}
