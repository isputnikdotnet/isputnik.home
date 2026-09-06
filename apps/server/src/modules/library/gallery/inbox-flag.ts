// The Photo Inbox flag, and nothing else — `policy_json.inbox` on a gallery
// library. Kept apart from inbox.ts (the review itself) so the surfaces that must
// skip an Inbox — the scope resolver, the face scanner — can ask without pulling
// in the trash, the mover and the catalogue, which import them back.
import { db } from "../../../db.js";
import { parsePolicy } from "../../../core/permissions.js";

/** Every gallery library flagged as an Inbox, regardless of who may see it. */
export function photoInboxLibraryIds(): Set<string> {
  const rows = db.prepare("SELECT id, policy_json FROM libraries WHERE type = 'gallery'")
    .all() as { id: string; policy_json: string }[];
  return new Set(rows.filter((row) => parsePolicy(row.policy_json).inbox === true).map((row) => row.id));
}

export function isPhotoInboxLibrary(libraryId: string): boolean {
  const row = db.prepare("SELECT policy_json FROM libraries WHERE id = ? AND type = 'gallery'")
    .get(libraryId) as { policy_json: string } | undefined;
  return row != null && parsePolicy(row.policy_json).inbox === true;
}
