import { db } from "../../db.js";
import { GALLERY_ENTITY_TYPE } from "./stories.js";

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
  // A photo group holds its members in story_block_items, so a purged photo is
  // dropped FROM the group rather than taking the block with it — the other
  // photos on that plate are still the page the author made. A group left with
  // nothing has no plate to draw, so then it does go.
  if (entityType === GALLERY_ENTITY_TYPE) {
    db.prepare("DELETE FROM story_block_items WHERE item_id = ?").run(entityId);
    deleteEmptyPhotoGroups();
  }
}

// Drop every story block pointing at media in a library before the library is
// hard deleted (the items cascade away, but their blocks would orphan).
export function deleteStoryBlocksForLibrary(entityType: string, libraryId: string) {
  db.prepare(
    "DELETE FROM story_blocks WHERE entity_type = ? AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)"
  ).run(entityType, libraryId);
  if (entityType === GALLERY_ENTITY_TYPE) {
    db.prepare(
      "DELETE FROM story_block_items WHERE item_id IN (SELECT id FROM library_items WHERE library_id = ?)"
    ).run(libraryId);
    deleteEmptyPhotoGroups();
  }
}

/** Photo groups whose every member has just been purged. Kept private: an
 *  empty group is only ever the residue of a deletion — the editor deletes the
 *  block when its last photo is taken out by hand. */
function deleteEmptyPhotoGroups() {
  db.prepare(`
    DELETE FROM story_blocks WHERE kind = 'photos'
      AND NOT EXISTS (SELECT 1 FROM story_block_items WHERE story_block_items.block_id = story_blocks.id)
  `).run();
}
