// Removing a gallery library's row and everything that points at it, without
// touching its files on disk (thumbnails excepted: they are the app's own and
// regenerate). The library route's Delete and App storage's Off share it.
import { db } from "../../../db.js";
import { deleteLibraryAccess } from "../shared/library-access.js";
import { deleteSharesForLibrary } from "../shared/share-access.js";
import { deleteCollectionItemsForLibrary } from "../../collections/cleanup.js";
import { deleteStoryBlocksForLibrary } from "../../stories/cleanup.js";
import { removeThumbnailsForLibrary } from "../shared/thumbnail.js";

export function deleteGalleryLibraryRecord(id: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM taggables WHERE entity_type = 'library_item' AND entity_id IN (SELECT id FROM library_items WHERE library_id = ?)").run(id);
    deleteSharesForLibrary("gallery", id);
    deleteCollectionItemsForLibrary("gallery", id);
    deleteStoryBlocksForLibrary("gallery", id);
    deleteLibraryAccess(id);
    db.prepare("DELETE FROM libraries WHERE id = ?").run(id);
  })();
  removeThumbnailsForLibrary(id);
}
