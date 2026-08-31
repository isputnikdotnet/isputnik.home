import { db } from "../../db.js";

// A story block references its content polymorphically (no FK to the resource
// table), so the owning module must remove the blocks when a resource is
// deleted or purged — the same contract as deleteCollectionItemsForResource and
// deleteSharesForResource.
//
// Reads already degrade a dangling block to an "unavailable" placeholder, so
// this is hygiene rather than safety: without it a story keeps an empty slot
// where the album used to be.
export function deleteStoryBlocksForResource(entityType: string, entityId: string) {
  db.prepare("DELETE FROM story_blocks WHERE entity_type = ? AND entity_id = ?").run(entityType, entityId);
}

// Drop every story block pointing at media in a library before the library is
// hard deleted (the items cascade away, but their blocks would orphan).
export function deleteStoryBlocksForLibrary(entityType: string, libraryId: string) {
  db.prepare(
    "DELETE FROM story_blocks WHERE entity_type = ? AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)"
  ).run(entityType, libraryId);
}
